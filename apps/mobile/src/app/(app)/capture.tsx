/**
 * Screen 11: camera capture & confirm, then submission.
 *
 * Opened only from the attendance-ready screen after the employee tapped
 * "Capture Attendance Photo" (which requested camera permission at that moment).
 * No gallery picker. One idempotency key per capture attempt, reused on every
 * retry of that attempt so a network retry can never create a duplicate.
 *
 * Submission order: reserve upload (intent) → PUT JPEG → FRESH high-accuracy
 * fix → POST /attendance. "Attendance recorded" is shown only after the server
 * answered 200/201.
 */
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { CameraView, useCameraPermissions, type CameraType } from 'expo-camera';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { File, UploadType } from 'expo-file-system';
import * as Location from 'expo-location';
import { randomUUID } from 'expo-crypto';
import { api, ApiError, errorMessage } from '../../lib/api/client';
import type { AttendanceResponse, IntentResponse, SessionStatus } from '../../lib/api/types';
import { deviceMeta } from '../../lib/device';
import { qk, queryClient } from '../../lib/queryClient';
import { bestFix, toReading } from '../../lib/tracking/runtime';
import { loadMeta } from '../../lib/tracking/store';
import { toWire } from '../../lib/tracking/queue-core';
import { colors, font, radius, space } from '../../lib/theme';
import { Button } from '../../components/ui';

const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
/** Aim for small uploads on slow mobile data; 960 px still leaves the face check plenty of detail. */
const TARGET_BYTES = 200 * 1024;
const TARGET_EDGE = 960;

type Phase = 'camera' | 'processing' | 'preview' | 'submitting' | 'failed';
type Step = 'upload' | 'location' | 'verify';

interface Attempt {
  idempotencyKey: string;
  uri: string;
  sizeBytes: number;
  photoId: string | null;
  uploaded: boolean;
}

interface Failure {
  title: string;
  message: string;
  /** What the employee can do next. */
  action: 'retry' | 'retake' | 'back';
}

function describe(err: unknown): Failure {
  if (err instanceof ApiError) {
    switch (err.code) {
      case 'EVIDENCE_STALE':
        return { title: 'Location fix too old', message: `${err.message} Tap Retry — a new fix will be taken.`, action: 'retry' };
      case 'GPS_ACCURACY_INSUFFICIENT':
        return { title: 'GPS accuracy too low', message: err.message, action: 'retry' };
      case 'EVIDENCE_NOT_INSIDE':
        return { title: 'Location not confirmed', message: err.message, action: 'retry' };
      case 'EVIDENCE_INVALID':
        return { title: 'Location rejected', message: err.message, action: 'retry' };
      case 'MOCK_LOCATION':
        return { title: 'Mock location detected', message: err.message, action: 'back' };
      case 'NOT_ELIGIBLE':
        return { title: 'Attendance locked again', message: err.message, action: 'back' };
      case 'ATTENDANCE_LOCKED':
        return { title: 'Attendance is locked', message: err.message, action: 'back' };
      case 'DUPLICATE_SUBMISSION':
      case 'ALREADY_RECORDED':
        return { title: 'Already recorded', message: 'Attendance is already recorded for this shift. Open your shift to see the recorded time.', action: 'back' };
      case 'SESSION_CLOSED':
        return { title: 'Shift closed', message: err.message, action: 'back' };
      case 'PHOTO_EXPIRED':
      case 'PHOTO_MISSING':
        return { title: 'Photo upload expired', message: `${err.message} Tap Retry to upload the same photo again.`, action: 'retry' };
      case 'PHOTO_INVALID':
      case 'PHOTO_TOO_LARGE':
        return { title: 'Photo not accepted', message: `${err.message} Please retake the photo.`, action: 'retake' };
    }
    if (err.isNetwork) return { title: 'Not sent — connection problem', message: `${err.message} Your attendance is NOT recorded yet. Tap Retry; the same submission is reused, so it cannot be counted twice.`, action: 'retry' };
    return { title: 'Submission failed', message: err.message, action: 'retry' };
  }
  return { title: 'Submission failed', message: errorMessage(err), action: 'retry' };
}

async function compress(uri: string, width: number, height: number): Promise<{ uri: string; size: number }> {
  // Step the quality down until the photo is under TARGET_BYTES; if a very detailed photo never
  // gets there, the smallest version is still sent (the server accepts up to MAX_PHOTO_BYTES).
  let best: { uri: string; size: number } | null = null;
  for (const quality of [0.7, 0.55, 0.4, 0.3]) {
    let ctx = ImageManipulator.manipulate(uri);
    if (Math.max(width, height) > TARGET_EDGE) ctx = ctx.resize(width >= height ? { width: TARGET_EDGE } : { height: TARGET_EDGE });
    const img = await ctx.renderAsync();
    const out = await img.saveAsync({ compress: quality, format: SaveFormat.JPEG });
    const size = new File(out.uri).size ?? 0;
    if (size > 0 && (!best || size < best.size)) best = { uri: out.uri, size };
    if (size > 0 && size <= TARGET_BYTES) return { uri: out.uri, size };
  }
  if (best && best.size <= MAX_PHOTO_BYTES) return best;
  throw new Error('The photo is too large even after compression. Please retake it.');
}

export default function CaptureScreen() {
  // Snapshot at open: the session id and evidence rules for this attempt. The server re-checks eligibility on submit.
  const [status] = useState(() => queryClient.getQueryData<SessionStatus | null>(qk.status) ?? null);
  const [perm] = useCameraPermissions();
  const cam = useRef<CameraView>(null);
  const [ready, setReady] = useState(false);
  const [facing, setFacing] = useState<CameraType>('front');
  const [phase, setPhase] = useState<Phase>('camera');
  const [step, setStep] = useState<Step>('upload');
  const [fixAccuracy, setFixAccuracy] = useState<number | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const attempt = useRef<Attempt | null>(null);
  const [previewUri, setPreviewUri] = useState<string | null>(null);

  useEffect(() => {
    // Safety net: never show the camera unless the server says attendance is available.
    if (!status?.attendanceAvailable) router.replace('/shift');
  }, [status?.attendanceAvailable]);

  if (!status?.attendanceAvailable) return null;
  if (perm && !perm.granted) {
    return (
      <SafeAreaView style={st.dark}>
        <View style={st.centerBox}>
          <Text style={st.whiteTitle}>Camera permission needed</Text>
          <Text style={st.whiteText}>Allow camera access for GeoAttend to take your attendance photo.</Text>
          <Button title="Back" variant="secondary" onPress={() => router.back()} />
        </View>
      </SafeAreaView>
    );
  }

  const shoot = async () => {
    if (!cam.current || !ready) return;
    try {
      setPhase('processing');
      const pic = await cam.current.takePictureAsync({ quality: 0.85, exif: false });
      const out = await compress(pic.uri, pic.width, pic.height);
      attempt.current = null; // a new photo means a new attempt (new idempotency key on confirm)
      setPreviewUri(out.uri);
      attempt.current = { idempotencyKey: '', uri: out.uri, sizeBytes: out.size, photoId: null, uploaded: false };
      setPhase('preview');
    } catch (e) {
      setFailure({ title: 'Could not take the photo', message: errorMessage(e), action: 'retake' });
      setPhase('failed');
    }
  };

  const retake = () => {
    attempt.current = null;
    setPreviewUri(null);
    setFailure(null);
    setReady(false);
    setPhase('camera');
  };

  const submit = async () => {
    const a = attempt.current;
    if (!a) return retake();
    if (!a.idempotencyKey) a.idempotencyKey = `att-${randomUUID()}`; // one key per capture attempt, reused on retries
    setFailure(null);
    setPhase('submitting');
    try {
      const sessionId = status.session.id;
      if (!a.photoId || !a.uploaded) {
        setStep('upload');
        const intent = await api<IntentResponse>('/attendance/intents', {
          method: 'POST',
          body: { sessionId, idempotencyKey: a.idempotencyKey, contentType: 'image/jpeg', sizeBytes: a.sizeBytes },
        });
        a.photoId = intent.photoId;
        a.uploaded = false;
        let put;
        try {
          put = await new File(a.uri).upload(intent.upload.url, { httpMethod: 'PUT', uploadType: UploadType.BINARY_CONTENT, headers: intent.upload.headers });
        } catch {
          throw new ApiError(0, 'NETWORK_ERROR', 'The photo upload did not complete.');
        }
        if (put.status === 409 && put.body.includes('ALREADY_UPLOADED')) {
          // A previous try already stored this slot.
        } else if (put.status < 200 || put.status >= 300) {
          let code = `UPLOAD_${put.status}`;
          let message = `The photo upload failed (${put.status}).`;
          try {
            const b = JSON.parse(put.body);
            code = b?.error?.code ?? code;
            message = b?.error?.message ?? message;
          } catch {
            /* S3 XML or empty body */
          }
          if (put.status === 413 || code === 'TOO_LARGE' || code === 'NOT_AN_IMAGE' || code === 'WRONG_TYPE') throw new ApiError(422, 'PHOTO_INVALID', message);
          if (code === 'SLOT_CLOSED' || put.status === 403) throw new ApiError(422, 'PHOTO_EXPIRED', 'The upload slot expired.');
          throw new ApiError(put.status >= 500 ? 0 : put.status, code, message);
        }
        a.uploaded = true;
      }

      // Fresh, high-accuracy fix taken right before submitting (the server rejects old evidence).
      setStep('location');
      setFixAccuracy(null);
      const meta = await loadMeta();
      const maxAge = status.tracking.evidenceMaxAgeSec || meta.evidenceMaxAgeSec || 60;
      // Wait (up to ~20 s) for a fix within the company's accuracy limit instead of sending the
      // phone's first, coarse one — which the server would refuse as too inaccurate.
      let fix = await bestFix(status.tracking.maxAccuracyM, { onProgress: setFixAccuracy });
      if ((Date.now() - fix.timestamp) / 1000 > maxAge / 2) fix = await bestFix(status.tracking.maxAccuracyM, { settleMs: 10_000, onProgress: setFixAccuracy });
      const reading = toReading(fix, 'FOREGROUND');
      if (!reading) throw new Error('The phone returned a location without accuracy information. Retry.');

      setStep('verify');
      const res = await api<AttendanceResponse>('/attendance', {
        method: 'POST',
        body: {
          sessionId,
          photoId: a.photoId,
          idempotencyKey: a.idempotencyKey,
          evidence: toWire(reading),
          device: await deviceMeta({ cameraFacing: facing, photoBytes: a.sizeBytes, backgroundLocation: meta.backgroundGranted ?? null }),
        },
        timeoutMs: 45_000,
      });
      void queryClient.invalidateQueries({ queryKey: qk.status });
      void queryClient.invalidateQueries({ queryKey: qk.history });
      void queryClient.invalidateQueries({ queryKey: qk.assignment });
      router.replace({
        pathname: '/success',
        params: {
          ref: res.attendance.id,
          recordedAt: res.attendance.recordedAt,
          isLate: res.attendance.isLate ? '1' : '',
          lateBy: String(res.attendance.lateByMinutes ?? 0),
          verification: res.attendance.verificationStatus,
          replay: res.replay ? '1' : '',
        },
      });
    } catch (e) {
      const f = describe(e);
      if (e instanceof ApiError && (e.code === 'PHOTO_EXPIRED' || e.code === 'PHOTO_MISSING')) {
        a.photoId = null;
        a.uploaded = false;
      }
      setFailure(f);
      setPhase('failed');
    }
  };

  // ── camera ──
  if (phase === 'camera' || phase === 'processing') {
    return (
      <View style={st.dark}>
        <CameraView ref={cam} style={StyleSheet.absoluteFill} facing={facing} mode="picture" onCameraReady={() => setReady(true)} animateShutter />
        <SafeAreaView style={st.overlay} edges={['top', 'bottom']}>
          <View style={st.topBar}>
            <Pressable onPress={() => router.back()} style={st.iconBtn} accessibilityRole="button" accessibilityLabel="Close camera">
              <Text style={st.iconText}>✕</Text>
            </Pressable>
            <Text style={st.topTitle}>Attendance photo</Text>
            <Pressable
              onPress={() => {
                setReady(false);
                setFacing((f) => (f === 'front' ? 'back' : 'front'));
              }}
              style={st.iconBtn}
              accessibilityRole="button"
              accessibilityLabel={`Switch to ${facing === 'front' ? 'back' : 'front'} camera`}
            >
              <Text style={st.iconText}>⇄</Text>
            </Pressable>
          </View>
          <View style={st.guide} pointerEvents="none" />
          {status.attendanceChallenge ? (
            <View style={st.challenge} accessibilityLiveRegion="polite">
              <Text style={st.challengeTitle}>{status.attendanceChallenge.en}</Text>
              <Text style={st.challengeSub}>{status.attendanceChallenge.hi} · keep your face in the frame</Text>
            </View>
          ) : (
            <Text style={st.hint}>Position your face inside the frame</Text>
          )}
          <View style={st.bottomBar}>
            {phase === 'processing' ? (
              <ActivityIndicator size="large" color={colors.white} />
            ) : (
              <Pressable onPress={shoot} disabled={!ready} style={[st.shutter, !ready && { opacity: 0.4 }]} accessibilityRole="button" accessibilityLabel="Take photo" />
            )}
          </View>
        </SafeAreaView>
      </View>
    );
  }

  // ── preview / submit / failure ──
  return (
    <SafeAreaView style={st.dark} edges={['top', 'bottom']}>
      <View style={{ flex: 1, padding: space.lg, gap: space.md }}>
        <Text style={st.whiteTitle}>{phase === 'preview' ? 'Use this photo?' : phase === 'submitting' ? 'Submitting attendance…' : failure?.title ?? 'Not recorded'}</Text>
        {previewUri ? <Image source={{ uri: previewUri }} style={st.preview} resizeMode="contain" accessibilityLabel="Captured attendance photo" /> : null}
        {phase === 'preview' ? (
          <>
            <Button title="Confirm and submit" onPress={submit} accessibilityHint="Uploads the photo with a fresh GPS fix" />
            <Button title="Retake" variant="secondary" onPress={retake} />
          </>
        ) : null}
        {phase === 'submitting' ? (
          <View style={st.steps}>
            <StepLine label="Uploading photo" state={step === 'upload' ? 'active' : 'done'} />
            <StepLine label={step === 'location' && fixAccuracy != null ? `Getting a precise location (±${fixAccuracy} m, need ±${status.tracking.maxAccuracyM} m)` : 'Getting a fresh precise location'} state={step === 'location' ? 'active' : step === 'verify' ? 'done' : 'todo'} />
            <StepLine label="Server verification" state={step === 'verify' ? 'active' : 'todo'} />
            <Text style={st.whiteText}>Attendance is not recorded until the server confirms it. Keep the app open.</Text>
          </View>
        ) : null}
        {phase === 'failed' && failure ? (
          <>
            <View style={st.failBox}>
              <Text style={st.failText}>{failure.message}</Text>
              <Text style={st.failNote}>Attendance has NOT been recorded.</Text>
            </View>
            {failure.action === 'retry' && attempt.current ? <Button title="Retry" onPress={submit} /> : null}
            {failure.action !== 'back' ? <Button title="Retake photo" variant="secondary" onPress={retake} /> : null}
            <Button title="Back to shift" variant={failure.action === 'back' ? 'primary' : 'ghost'} onPress={() => router.replace('/shift')} />
          </>
        ) : null}
      </View>
    </SafeAreaView>
  );
}

function StepLine({ label, state }: { label: string; state: 'todo' | 'active' | 'done' }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: 32 }}>
      {state === 'active' ? <ActivityIndicator color={colors.orange} /> : <Text style={{ color: state === 'done' ? '#4ADE80' : '#8A90A0', fontSize: 18, width: 20 }}>{state === 'done' ? '✓' : '○'}</Text>}
      <Text style={[st.whiteText, state === 'todo' && { color: '#8A90A0' }]}>{label}</Text>
    </View>
  );
}

const st = StyleSheet.create({
  dark: { flex: 1, backgroundColor: '#0B0F1E' },
  overlay: { flex: 1, justifyContent: 'space-between' },
  topBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: space.lg, paddingTop: space.sm },
  topTitle: { color: colors.white, fontSize: font.lg, fontWeight: '700' },
  iconBtn: { width: 52, height: 52, borderRadius: 26, backgroundColor: 'rgba(0,0,0,0.45)', alignItems: 'center', justifyContent: 'center' },
  iconText: { color: colors.white, fontSize: 22, fontWeight: '700' },
  guide: { alignSelf: 'center', width: '68%', aspectRatio: 0.78, borderRadius: 999, borderWidth: 3, borderColor: 'rgba(255,255,255,0.75)' },
  hint: { color: colors.white, textAlign: 'center', fontSize: font.md, textShadowColor: '#000', textShadowRadius: 4 },
  challenge: { alignSelf: 'center', backgroundColor: 'rgba(234,88,12,0.92)', borderRadius: 12, paddingHorizontal: space.lg, paddingVertical: space.sm, alignItems: 'center' },
  challengeTitle: { color: colors.white, fontSize: font.xl, fontWeight: '800' },
  challengeSub: { color: colors.white, fontSize: font.sm },
  bottomBar: { alignItems: 'center', paddingBottom: space.xl, minHeight: 110, justifyContent: 'center' },
  shutter: { width: 78, height: 78, borderRadius: 39, backgroundColor: colors.white, borderWidth: 6, borderColor: colors.orange },
  preview: { flex: 1, borderRadius: radius.lg, backgroundColor: '#000' },
  centerBox: { flex: 1, justifyContent: 'center', padding: space.xl, gap: space.md },
  whiteTitle: { color: colors.white, fontSize: font.xl, fontWeight: '800' },
  whiteText: { color: '#E5E7EF', fontSize: font.md, lineHeight: 22 },
  steps: { gap: space.sm, backgroundColor: 'rgba(255,255,255,0.06)', padding: space.lg, borderRadius: radius.lg },
  failBox: { backgroundColor: '#3B1414', borderRadius: radius.md, padding: space.md, gap: 4 },
  failText: { color: '#FECACA', fontSize: font.md, lineHeight: 22 },
  failNote: { color: colors.white, fontWeight: '700' },
});
