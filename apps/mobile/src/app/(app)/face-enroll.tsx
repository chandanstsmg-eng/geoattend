/**
 * One-time face enrollment: five guided photos (front, left, right, chin up, chin down).
 *
 * They become the employee's primary face; every start- and end-of-shift photo is compared
 * with them on the server. Each pose is uploaded to its own private slot, then all five are
 * submitted together. If the server refuses one pose (no face, two faces, not the same
 * person), only that pose is taken again.
 */
import { useRef, useState } from 'react';
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { File, UploadType } from 'expo-file-system';
import { api, ApiError, errorMessage } from '../../lib/api/client';
import type { Assignment, IntentResponse } from '../../lib/api/types';
import { qk, queryClient } from '../../lib/queryClient';
import { startShift } from '../../lib/start-shift';
import { colors, font, radius, space } from '../../lib/theme';
import { Body, Button, Card, H2, Muted, Screen } from '../../components/ui';

const POSES = [
  { key: 'FRONT', title: 'Look straight at the camera', hint: 'Face the camera, eyes open, neutral expression.' },
  { key: 'LEFT', title: 'Turn your head slightly left', hint: 'About a quarter turn — keep both eyes visible.' },
  { key: 'RIGHT', title: 'Turn your head slightly right', hint: 'About a quarter turn — keep both eyes visible.' },
  { key: 'UP', title: 'Lift your chin a little', hint: 'Tilt your head back slightly.' },
  { key: 'DOWN', title: 'Lower your chin a little', hint: 'Tilt your head down slightly, keep looking at the camera.' },
] as const;
type PoseKey = (typeof POSES)[number]['key'];

interface Shot {
  uri: string;
  size: number;
  photoId: string | null; // set once uploaded
}

async function shrink(uri: string, width: number, height: number) {
  let ctx = ImageManipulator.manipulate(uri);
  if (Math.max(width, height) > 1280) ctx = ctx.resize(width >= height ? { width: 1280 } : { height: 1280 });
  const out = await (await ctx.renderAsync()).saveAsync({ compress: 0.7, format: SaveFormat.JPEG });
  return { uri: out.uri, size: new File(out.uri).size ?? 0 };
}

export default function FaceEnrollScreen() {
  const { next, shiftId } = useLocalSearchParams<{ next?: string; shiftId?: string }>();
  const [perm, requestPerm] = useCameraPermissions();
  const cam = useRef<CameraView>(null);
  const [ready, setReady] = useState(false);
  const [shots, setShots] = useState<Partial<Record<PoseKey, Shot>>>({});
  const [step, setStep] = useState<number | null>(null); // index of the pose on camera, null = overview
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const allTaken = POSES.every((p) => shots[p.key]);

  const shoot = async () => {
    if (!cam.current || !ready || step == null) return;
    try {
      setBusy('Saving…');
      const pic = await cam.current.takePictureAsync({ quality: 0.85, exif: false });
      const out = await shrink(pic.uri, pic.width, pic.height);
      const key = POSES[step]!.key;
      setShots((s) => ({ ...s, [key]: { ...out, photoId: null } }));
      // Move on to the next pose not yet taken, or back to the overview.
      const nextIdx = POSES.findIndex((p, i) => i > step && !shots[p.key]);
      setReady(false);
      setStep(nextIdx >= 0 ? nextIdx : null);
    } catch (e) {
      setProblem(errorMessage(e));
      setStep(null);
    } finally {
      setBusy(null);
    }
  };

  const open = async (idx: number) => {
    if (!perm?.granted && !(await requestPerm()).granted) {
      setProblem('Allow camera access for GeoAttend to take the enrollment photos.');
      return;
    }
    setProblem(null);
    setReady(false);
    setStep(idx);
  };

  const submit = async () => {
    setProblem(null);
    try {
      const current = { ...shots };
      for (const [i, p] of POSES.entries()) {
        const s = current[p.key]!;
        if (s.photoId) continue;
        setBusy(`Uploading photo ${i + 1} of ${POSES.length}…`);
        const slot = await api<IntentResponse>('/faces/me/photos', { method: 'POST', body: { pose: p.key, contentType: 'image/jpeg', sizeBytes: s.size } });
        let put;
        try {
          put = await new File(s.uri).upload(slot.upload.url, { httpMethod: 'PUT', uploadType: UploadType.BINARY_CONTENT, headers: slot.upload.headers });
        } catch {
          throw new ApiError(0, 'NETWORK_ERROR', 'A photo upload did not complete. Check your connection and try again.');
        }
        if (put.status < 200 || put.status >= 300) throw new Error(`Photo upload failed (${put.status}). Try again.`);
        current[p.key] = { ...s, photoId: slot.photoId };
        setShots({ ...current });
      }
      setBusy('Checking your photos…');
      await api('/faces/me/enroll', { method: 'POST', body: { photos: POSES.map((p) => ({ pose: p.key, photoId: current[p.key]!.photoId })) }, timeoutMs: 60_000 });
      await queryClient.invalidateQueries({ queryKey: qk.assignment });
      const a = queryClient.getQueryData<Assignment>(qk.assignment);
      if (next === 'start' && shiftId && a) startShift({ ...a, faceEnrollment: { required: true, enrolled: true } }, shiftId, 'replace');
      else router.replace('/');
    } catch (e) {
      if (e instanceof ApiError && e.code === 'ALREADY_ENROLLED') {
        await queryClient.invalidateQueries({ queryKey: qk.assignment });
        router.replace('/');
        return;
      }
      const pose = e instanceof ApiError ? ((e.details as any)?.pose as PoseKey | undefined) : undefined;
      if (pose) setShots((s) => ({ ...s, [pose]: undefined })); // retake only that pose
      setProblem(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  // ── camera for one pose ──
  if (step != null) {
    const pose = POSES[step]!;
    return (
      <View style={st.dark}>
        <CameraView ref={cam} style={StyleSheet.absoluteFill} facing="front" mode="picture" onCameraReady={() => setReady(true)} animateShutter />
        <SafeAreaView style={st.overlay} edges={['top', 'bottom']}>
          <View style={st.topBar}>
            <Pressable onPress={() => setStep(null)} style={st.iconBtn} accessibilityRole="button" accessibilityLabel="Close camera">
              <Text style={st.iconText}>✕</Text>
            </Pressable>
            <Text style={st.topTitle}>
              Photo {step + 1} of {POSES.length}
            </Text>
            <View style={st.iconBtn} />
          </View>
          <View style={st.guide} pointerEvents="none" />
          <View style={st.instruction} accessibilityLiveRegion="polite">
            <Text style={st.instructionTitle}>{pose.title}</Text>
            <Text style={st.instructionHint}>{pose.hint}</Text>
          </View>
          <View style={st.bottomBar}>
            {busy ? <ActivityIndicator size="large" color={colors.white} /> : <Pressable onPress={shoot} disabled={!ready} style={[st.shutter, !ready && { opacity: 0.4 }]} accessibilityRole="button" accessibilityLabel={`Take photo: ${pose.title}`} />}
          </View>
        </SafeAreaView>
      </View>
    );
  }

  // ── overview ──
  return (
    <Screen>
      <Card>
        <H2>Set up your face</H2>
        <Body>Take five photos of your face, once. At the start and end of each shift your photo is compared with these, so attendance cannot be marked by someone else.</Body>
        <Muted>Use good light, remove sunglasses, cap or mask, and make sure only you are in the picture.</Muted>
      </Card>

      <View style={st.grid}>
        {POSES.map((p, i) => {
          const s = shots[p.key];
          return (
            <Pressable key={p.key} onPress={() => void open(i)} style={st.tile} accessibilityRole="button" accessibilityLabel={`${s ? 'Retake' : 'Take'} photo: ${p.title}`}>
              {s ? <Image source={{ uri: s.uri }} style={st.thumb} accessibilityIgnoresInvertColors /> : <View style={[st.thumb, st.empty]}><Text style={st.emptyNum}>{i + 1}</Text></View>}
              <Text style={st.tileLabel} numberOfLines={2}>{p.title}</Text>
            </Pressable>
          );
        })}
      </View>

      {problem ? (
        <Card tone="danger">
          <Body color={colors.danger}>{problem}</Body>
        </Card>
      ) : null}

      {allTaken ? (
        <Button title={busy ?? 'Save my face'} onPress={() => void submit()} loading={!!busy} accessibilityHint="Uploads the five photos and checks them" />
      ) : (
        <Button title={Object.keys(shots).length ? 'Take the next photo' : 'Start'} onPress={() => void open(POSES.findIndex((p) => !shots[p.key]))} />
      )}
      <Muted>Only your company’s administrators can see these photos, and every view is recorded. Shift photos that match are deleted straight away.</Muted>
    </Screen>
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
  instruction: { alignSelf: 'center', backgroundColor: 'rgba(11,15,30,0.8)', borderRadius: radius.md, paddingHorizontal: space.lg, paddingVertical: space.sm, alignItems: 'center', marginHorizontal: space.lg },
  instructionTitle: { color: colors.white, fontSize: font.xl, fontWeight: '800', textAlign: 'center' },
  instructionHint: { color: '#E5E7EF', fontSize: font.sm, textAlign: 'center' },
  bottomBar: { alignItems: 'center', paddingBottom: space.xl, minHeight: 110, justifyContent: 'center' },
  shutter: { width: 78, height: 78, borderRadius: 39, backgroundColor: colors.white, borderWidth: 6, borderColor: colors.orange },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  tile: { width: '31%', gap: 4 },
  thumb: { width: '100%', aspectRatio: 3 / 4, borderRadius: radius.md, backgroundColor: colors.navySoft },
  empty: { alignItems: 'center', justifyContent: 'center', borderWidth: 1.5, borderStyle: 'dashed', borderColor: colors.border },
  emptyNum: { fontSize: font.xxl, fontWeight: '800', color: colors.textFaint },
  tileLabel: { fontSize: font.sm, color: colors.text },
});
