import { useState } from 'react';
import { Alert, Linking } from 'react-native';
import { router } from 'expo-router';
import { Camera } from 'expo-camera';
import { api, ApiError, errorMessage } from '../../lib/api/client';
import type { Assignment, SessionStatus } from '../../lib/api/types';
import { qk, queryClient } from '../../lib/queryClient';
import { flush, sendFreshFix, stopTracking } from '../../lib/tracking/runtime';
import { Button, ReasonModal } from '../ui';

/**
 * Ends the shift: flush what is queued, POST end (with the end-of-shift selfie when there is
 * one), stop updates, then show the summary. Offline, the employee can stop tracking on the phone.
 */
export async function finishShift(status: SessionStatus, photoId?: string | null): Promise<void> {
  try {
    await flush().catch(() => undefined);
    const closed = await api<SessionStatus>(`/tracking/sessions/${status.session.id}/end`, { method: 'POST', body: photoId ? { photoId } : {} });
    await stopTracking({ reason: 'You ended your shift.', notify: false, byUser: true });
    queryClient.setQueryData(qk.status, null);
    void queryClient.invalidateQueries({ queryKey: qk.assignment });
    void queryClient.invalidateQueries({ queryKey: qk.history });
    router.replace({
      pathname: '/completed',
      params: { endedAt: closed.session.endedAt ?? new Date().toISOString(), recordedAt: closed.attendance?.recordedAt ?? '', shiftName: closed.session.shiftName },
    });
  } catch (e) {
    const offline = e instanceof ApiError && e.isNetwork;
    await new Promise<void>((resolve) =>
      Alert.alert(
        'Could not end the shift',
        offline
          ? 'The server cannot be reached. You can retry, or stop tracking on this phone now — the server will mark updates as interrupted and close the shift at the end of its window.'
          : errorMessage(e),
        offline
          ? [
              { text: 'Retry', onPress: () => void finishShift(status, photoId).then(resolve) },
              {
                text: 'Stop tracking on this phone',
                style: 'destructive',
                onPress: async () => {
                  await stopTracking({ reason: 'You stopped tracking on this phone while offline.', notify: false, byUser: true });
                  router.replace({ pathname: '/completed', params: { endedAt: new Date().toISOString(), offline: '1', shiftName: status.session.shiftName } });
                  resolve();
                },
              },
            ]
          : [{ text: 'OK', onPress: () => resolve() }],
      ),
    );
  }
}

/**
 * End shift. With an enrolled face and recorded attendance, the end-of-shift selfie is taken first.
 * On overtime this is "End overtime", and the selfie is always taken: it is the proof that overtime ended.
 */
export function EndShiftButton({ status }: { status: SessionStatus }) {
  const [busy, setBusy] = useState(false);
  const assignment = queryClient.getQueryData<Assignment>(qk.assignment);
  const overtime = status.overtime?.status === 'RUNNING';
  const selfie = overtime || (!!status.attendance && !!assignment?.faceEnrollment?.enrolled);
  if (overtime) {
    return (
      <Button
        title="End overtime"
        variant="danger"
        onPress={() =>
          Alert.alert('End overtime?', 'Take a selfie to confirm you have finished. Location tracking then stops and your overtime goes to your manager for approval.', [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Take selfie', onPress: () => router.push('/end-shift') },
          ])
        }
        accessibilityHint="Takes a selfie, ends overtime and stops location tracking"
      />
    );
  }
  const run = async () => {
    setBusy(true);
    try {
      await finishShift(status);
    } finally {
      setBusy(false);
    }
  };
  const confirm = () =>
    Alert.alert(
      'End shift?',
      status.attendance
        ? selfie
          ? 'Take a quick selfie to confirm it is you, then location tracking stops and the shift is closed.'
          : 'Location tracking stops now and the shift is closed.'
        : 'Attendance has NOT been recorded for this shift. Ending now closes the shift without attendance. Location tracking stops.',
      [
        { text: 'Cancel', style: 'cancel' },
        selfie ? { text: 'Take selfie', onPress: () => router.push('/end-shift') } : { text: 'End shift', style: 'destructive', onPress: () => void run() },
      ],
    );
  return <Button title="End shift" variant="danger" onPress={confirm} loading={busy} accessibilityHint="Stops location tracking and closes this shift" />;
}

/** Opens the break screen. Offered only while present — the break must start inside the area. */
export function TakeBreakButton({ status }: { status: SessionStatus }) {
  if (!status.canStartBreak) return null;
  return <Button title="Take a break" variant="secondary" onPress={() => router.push('/break')} accessibilityHint="Record a break before leaving the workplace area" />;
}

export function EndBreakButton({ status }: { status: SessionStatus }) {
  const [busy, setBusy] = useState(false);
  if (!status.break) return null;
  return (
    <Button
      title="End break"
      loading={busy}
      onPress={async () => {
        setBusy(true);
        try {
          await flush().catch(() => undefined);
          const s = await api<SessionStatus>(`/tracking/sessions/${status.session.id}/breaks/current/end`, { method: 'POST' });
          queryClient.setQueryData(qk.status, s.tracking.shouldTrack ? s : null);
        } catch (e) {
          Alert.alert('Could not end the break', errorMessage(e));
        } finally {
          setBusy(false);
        }
      }}
    />
  );
}

export function RequestReviewButton({ status, variant = 'secondary' }: { status: SessionStatus; variant?: 'primary' | 'secondary' }) {
  const [open, setOpen] = useState(false);
  if (!status.canRequestReview) return null;
  return (
    <>
      <Button title="Request manual review" variant={variant} onPress={() => setOpen(true)} />
      <ReasonModal
        visible={open}
        title="Request manual review"
        description="An administrator will review your attendance for this shift. Explain the problem (for example: weak GPS inside the building)."
        submitLabel="Send request"
        onCancel={() => setOpen(false)}
        onSubmit={async (reason) => {
          const s = await api<SessionStatus>(`/tracking/sessions/${status.session.id}/review-request`, { method: 'POST', body: { reason } });
          queryClient.setQueryData(qk.status, s.tracking.shouldTrack ? s : null);
          setOpen(false);
          Alert.alert('Review requested', 'Your administrator has been notified.');
        }}
      />
    </>
  );
}

export function CancelReviewButton({ status }: { status: SessionStatus }) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      title="Cancel review request"
      variant="secondary"
      loading={busy}
      onPress={async () => {
        setBusy(true);
        try {
          const s = await api<SessionStatus>(`/tracking/sessions/${status.session.id}/review-request`, { method: 'DELETE' });
          queryClient.setQueryData(qk.status, s.tracking.shouldTrack ? s : null);
        } catch (e) {
          Alert.alert('Could not cancel', errorMessage(e));
        } finally {
          setBusy(false);
        }
      }}
    />
  );
}

export function FreshFixButton({ status, title = 'Retry fresh fix' }: { status: SessionStatus; title?: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      title={title}
      loading={busy}
      onPress={async () => {
        setBusy(true);
        try {
          const r = await sendFreshFix(status);
          if (r.status && r.status.session.lastClassification === 'INSUFFICIENT_ACCURACY') {
            Alert.alert('Still not accurate enough', `This fix was ±${Math.round(r.accuracyM)} m. ±${status.tracking.maxAccuracyM} m or better is needed. Move to an open area or near a window.`);
          }
        } catch (e) {
          Alert.alert('Location not sent', errorMessage(e));
        } finally {
          setBusy(false);
        }
      }}
    />
  );
}

/** Asks for camera permission only now, when the employee chose to capture. */
export async function openCaptureFlow(status: SessionStatus) {
  if (!status.attendanceAvailable) {
    Alert.alert('Attendance is locked', 'Attendance is not available yet. Reach the workplace area and wait for verification.');
    return;
  }
  // Explain first, in plain words, before the system dialog appears (only while it has not been answered).
  const current = await Camera.getCameraPermissionsAsync();
  if (!current.granted && current.canAskAgain) {
    const go = await new Promise<boolean>((resolve) =>
      Alert.alert(
        'Take your attendance photo',
        'Next, your phone asks to let GeoAttend use the camera. It is used only to take one photo of you for this attendance record, and only when you tap capture.',
        [{ text: 'Not now', style: 'cancel', onPress: () => resolve(false) }, { text: 'Continue', onPress: () => resolve(true) }],
        { cancelable: true, onDismiss: () => resolve(false) },
      ),
    );
    if (!go) return;
  }
  const perm = current.granted ? current : await Camera.requestCameraPermissionsAsync();
  if (!perm.granted) {
    Alert.alert(
      'Camera permission needed',
      'GeoAttend needs the camera to take your attendance photo. The photo is used only for this attendance record.',
      perm.canAskAgain ? [{ text: 'OK' }] : [{ text: 'Cancel', style: 'cancel' }, { text: 'Open settings', onPress: () => void Linking.openSettings() }],
    );
    return;
  }
  router.push('/capture');
}
