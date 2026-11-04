/**
 * Screen 7: tracking activation.
 * notice acknowledged → (explanation shown) → foreground permission → background
 * permission (optional; Android shows a settings page) → POST /tracking/sessions →
 * POST permissions report → start OS location updates.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Linking, Platform, StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import * as Location from 'expo-location';
import { qk, queryClient } from '../../lib/queryClient';
import { Banner, Body, Button, Card, H1, H2, Muted, Screen } from '../../components/ui';
import { api, ApiError, errorMessage } from '../../lib/api/client';
import type { Assignment, SessionStatus } from '../../lib/api/types';
import { requestNotificationPermission } from '../../lib/notifications';
import { getDeviceId } from '../../lib/secure';
import { readPermissionSnapshot, rememberPermissionReport, reportPermissionsIfChanged, startTracking } from '../../lib/tracking/runtime';
import { colors, font, space } from '../../lib/theme';
import { isExpoGo } from '../../lib/phone-health';

type Phase = 'foreground' | 'fgDenied' | 'servicesOff' | 'imprecise' | 'bgAsk' | 'bgDenied' | 'starting' | 'error';
type StepKey = 'foreground' | 'background' | 'session' | 'report' | 'start';
type StepState = 'todo' | 'active' | 'done' | 'warn' | 'error';

const STEP_LABELS: Record<StepKey, string> = {
  foreground: 'Location while using the app',
  background: 'Background location',
  session: 'Start shift on the server',
  report: 'Report permission status',
  start: 'Start location updates',
};

export default function ActivateScreen() {
  const { shiftId, resume } = useLocalSearchParams<{ shiftId?: string; resume?: string }>();
  const [phase, setPhase] = useState<Phase>('foreground');
  const [steps, setSteps] = useState<Record<StepKey, StepState>>({ foreground: 'active', background: 'todo', session: 'todo', report: 'todo', start: 'todo' });
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);
  const starting = useRef(false);
  const mark = (k: StepKey, v: StepState) => setSteps((s) => ({ ...s, [k]: v }));
  // Company rules (also enforced by the server): "Allow all the time" and precise location.
  const rules = queryClient.getQueryData<Assignment>(qk.assignment)?.locationRules;
  const needBackground = rules?.requireBackground ?? false;
  const needPrecise = rules?.requirePrecise ?? false;

  const runStart = useCallback(
    async (backgroundGranted: boolean) => {
      // The button and the return-from-Settings listener can both fire (MOB-02): start once.
      if (starting.current) return;
      starting.current = true;
      setPhase('starting');
      mark('background', backgroundGranted ? 'done' : 'warn');
      await requestNotificationPermission().catch(() => false);
      try {
        if (!shiftId) throw new ApiError(400, 'NO_SHIFT', 'No shift selected. Go back and choose your shift.');
        mark('session', 'active');
        let status = await api<SessionStatus>('/tracking/sessions', { method: 'POST', body: { shiftId, deviceId: await getDeviceId() } });
        mark('session', 'done');
        mark('report', 'active');
        const { report, status: afterReport } = await reportPermissionsIfChanged(status.session.id, true);
        if (afterReport) status = afterReport;
        mark('report', 'done');
        if (!status.tracking.shouldTrack) throw new ApiError(409, 'SESSION_CLOSED', 'This shift session is already closed.');
        mark('start', 'active');
        await startTracking(status);
        await rememberPermissionReport(status.session.id, report);
        mark('start', 'done');
        queryClient.setQueryData(qk.status, status);
        void queryClient.invalidateQueries({ queryKey: qk.assignment });
        router.replace('/shift');
      } catch (e) {
        if (e instanceof ApiError && e.code === 'NOTICE_ACK_REQUIRED') {
          router.replace({ pathname: '/privacy', params: { next: 'start', shiftId: shiftId ?? '' } });
          return;
        }
        if (e instanceof ApiError && e.code === 'FACE_ENROLLMENT_REQUIRED') {
          router.replace({ pathname: '/face-enroll', params: { next: 'start', shiftId: shiftId ?? '' } });
          return;
        }
        setSteps((s) => {
          const n = { ...s };
          (Object.keys(n) as StepKey[]).forEach((k) => {
            if (n[k] === 'active') n[k] = 'error';
          });
          return n;
        });
        let msg = errorMessage(e);
        if (e instanceof ApiError && e.code === 'OUTSIDE_SHIFT_WINDOW') {
          const d = e.details as { nextWindowOpensAt?: string } | undefined;
          if (d?.nextWindowOpensAt) msg += ` The next window opens ${new Date(d.nextWindowOpensAt).toLocaleString()}.`;
        }
        setError(msg);
        setPhase('error');
      } finally {
        starting.current = false;
      }
    },
    [shiftId],
  );

  const runForeground = useCallback(async () => {
    setError(null);
    setPhase('foreground');
    mark('foreground', 'active');
    let fg = await Location.getForegroundPermissionsAsync();
    if (fg.status !== 'granted' && fg.canAskAgain) fg = await Location.requestForegroundPermissionsAsync();
    if (fg.status !== 'granted') {
      mark('foreground', 'error');
      setPhase('fgDenied');
      return;
    }
    if (!(await Location.hasServicesEnabledAsync())) {
      mark('foreground', 'warn');
      setPhase('servicesOff');
      return;
    }
    // Approximate location is hundreds of metres off: attendance could never be checked fairly (MOB-05).
    const precise = Platform.OS === 'android' ? fg.android?.accuracy !== 'coarse' : fg.ios?.accuracy !== 'reduced';
    if (needPrecise && !precise) {
      mark('foreground', 'error');
      setPhase('imprecise');
      return;
    }
    mark('foreground', 'done');
    const bg = await Location.getBackgroundPermissionsAsync();
    if (bg.status === 'granted') {
      await runStart(true);
      return;
    }
    mark('background', 'active');
    setPhase('bgAsk');
  }, [runStart, needPrecise]);

  const askBackground = async () => {
    // Expo Go cannot run location in the background at all; asking would fail or hang.
    if (isExpoGo) {
      setPhase('bgDenied');
      return;
    }
    try {
      const r = await Location.requestBackgroundPermissionsAsync();
      if (r.status === 'granted') await runStart(true);
      // iOS shows "Change to Always Allow" only once; afterwards it must be changed in Settings.
      else setPhase('bgDenied');
    } catch {
      setPhase('bgDenied');
    }
  };

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void runForeground();
  }, [runForeground]);

  // Returning from the Settings app: re-check what changed.
  useEffect(() => {
    const sub = AppState.addEventListener('change', async (s) => {
      if (s !== 'active') return;
      if (phase === 'fgDenied' || phase === 'servicesOff' || phase === 'imprecise') void runForeground();
      if (phase === 'bgDenied' || phase === 'bgAsk') {
        const snap = await readPermissionSnapshot();
        if (snap.background === 'granted') void runStart(true);
      }
    });
    return () => sub.remove();
  }, [phase, runForeground, runStart]);

  return (
    <Screen>
      <H1>{resume ? 'Resuming tracking' : 'Starting your shift'}</H1>
      <Card>
        {(Object.keys(STEP_LABELS) as StepKey[]).map((k) => (
          <StepRow key={k} label={STEP_LABELS[k]} state={steps[k]} />
        ))}
      </Card>

      {phase === 'fgDenied' ? (
        <Card tone="danger">
          <H2 color={colors.danger}>Location permission is required</H2>
          <Body>Attendance cannot be verified without location access during your shift. Allow location for GeoAttend in Settings, then come back.</Body>
          <Button title="Open settings" onPress={() => void Linking.openSettings()} />
          <Button title="Try again" variant="secondary" onPress={() => void runForeground()} />
          <Button title="Cancel" variant="ghost" onPress={() => router.replace('/')} />
        </Card>
      ) : null}

      {phase === 'servicesOff' ? (
        <Card tone="warning">
          <H2 color={colors.warning}>Turn on location services</H2>
          <Body>Your phone’s location (GPS) is switched off. Turn it on, then try again.</Body>
          {Platform.OS === 'android' ? (
            <Button title="Turn on location" onPress={() => void Location.enableNetworkProviderAsync().then(() => runForeground(), () => Linking.openSettings())} />
          ) : null}
          <Button title="Try again" variant={Platform.OS === 'android' ? 'secondary' : 'primary'} onPress={() => void runForeground()} />
          <Button title="Cancel" variant="ghost" onPress={() => router.replace('/')} />
        </Card>
      ) : null}

      {phase === 'imprecise' ? (
        <Card tone="danger">
          <H2 color={colors.danger}>Turn on precise location</H2>
          <Body>
            {Platform.OS === 'android'
              ? 'GeoAttend has only approximate location, which can be hundreds of metres off. Settings → Apps → GeoAttend → Location → turn on “Use precise location”.'
              : 'GeoAttend has only approximate location, which can be hundreds of metres off. Settings → GeoAttend → Location → turn on “Precise Location”.'}
          </Body>
          <Button title="Open settings" onPress={() => void Linking.openSettings()} />
          <Button title="Try again" variant="secondary" onPress={() => void runForeground()} />
          <Button title="Cancel" variant="ghost" onPress={() => router.replace('/')} />
        </Card>
      ) : null}

      {phase === 'bgAsk' ? (
        <Card tone="info">
          <H2 color={colors.info}>Allow background location</H2>
          <Body>
            {Platform.OS === 'android'
              ? 'Next, Android opens the location permission page. Choose “Allow all the time” so your shift keeps updating while the screen is locked. Then press Back to return here.'
              : 'Next, choose “Change to Always Allow” so your shift keeps updating while the screen is locked.'}
          </Body>
          <Button title={Platform.OS === 'android' ? 'Open permission page' : 'Continue'} onPress={() => void askBackground()} />
          {needBackground ? (
            <Muted>Your company requires this: without it, attendance cannot be tracked during your shift.</Muted>
          ) : (
            <Button title="Skip — updates only while the app is open" variant="ghost" onPress={() => void runStart(false)} />
          )}
        </Card>
      ) : null}

      {phase === 'bgDenied' && isExpoGo ? (
        <Card tone={needBackground ? 'danger' : 'warning'}>
          <H2 color={needBackground ? colors.danger : colors.warning}>Expo Go can’t track in the background</H2>
          <Body>
            {needBackground
              ? 'You are running GeoAttend inside Expo Go, which cannot keep location on when the app is closed or the phone is locked — so your company’s “Allow all the time” rule can never be met here. Install the GeoAttend app build, or ask the owner to set Settings → Tracking → “Allow all the time” to Optional.'
              : 'You are running GeoAttend inside Expo Go: location is shared only while the app is open on screen. Keep it open during attendance. For locked-screen tracking, install the GeoAttend app build.'}
          </Body>
          {needBackground ? null : <Button title="Continue — keep the app open" onPress={() => void runStart(false)} />}
          <Button title="Cancel" variant="ghost" onPress={() => router.replace('/')} />
        </Card>
      ) : phase === 'bgDenied' ? (
        <Card tone={needBackground ? 'danger' : 'warning'}>
          <H2 color={needBackground ? colors.danger : colors.warning}>{needBackground ? '“Allow all the time” is required' : 'Background location not allowed'}</H2>
          <Body>
            {needBackground
              ? `Your company requires location “Allow all the time” during shifts, so tracking does not stop when the phone is locked. ${Platform.OS === 'android' ? 'Settings → Apps → GeoAttend → Location → Allow all the time.' : 'Open Settings → Location → choose “Always” (keep “Precise Location” on).'} Then come back — the shift starts automatically.`
              : 'You can continue, but location updates will stop whenever GeoAttend is not on screen. Your administrator will see gaps in tracking.'}
          </Body>
          {needBackground ? null : <Button title="Continue with app-open updates" onPress={() => void runStart(false)} />}
          <Button title="Open settings" variant={needBackground ? 'primary' : 'secondary'} onPress={() => void Linking.openSettings()} />
          <Button title="Cancel" variant="ghost" onPress={() => router.replace('/')} />
        </Card>
      ) : null}

      {phase === 'starting' ? <Muted center>Starting… keep the app open.</Muted> : null}

      {phase === 'error' && error ? (
        <>
          <Banner tone="danger" title="Could not start tracking" message={error} />
          <Button title="Try again" onPress={() => void runForeground()} />
          <Button title="Back to home" variant="ghost" onPress={() => router.replace('/')} />
        </>
      ) : null}
    </Screen>
  );
}

const ICON: Record<StepState, { ch: string; color: string; label: string }> = {
  todo: { ch: '○', color: colors.textFaint, label: 'waiting' },
  active: { ch: '◔', color: colors.info, label: 'in progress' },
  done: { ch: '✓', color: colors.success, label: 'done' },
  warn: { ch: '!', color: colors.warning, label: 'limited' },
  error: { ch: '✕', color: colors.danger, label: 'failed' },
};

function StepRow({ label, state }: { label: string; state: StepState }) {
  const i = ICON[state];
  return (
    <View style={st.step} accessibilityLabel={`${label}: ${i.label}`}>
      <Text style={[st.icon, { color: i.color }]}>{i.ch}</Text>
      <Text style={[st.stepText, state === 'todo' && { color: colors.textFaint }]}>{label}</Text>
    </View>
  );
}

const st = StyleSheet.create({
  step: { flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: 36 },
  icon: { width: 22, fontSize: font.lg, fontWeight: '800', textAlign: 'center' },
  stepText: { fontSize: font.md, color: colors.text },
});
