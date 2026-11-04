/**
 * End-of-shift selfie, then end the shift. The photo is compared with the enrolled face on the
 * server. If the photo cannot be sent, the employee can still end the shift without it (the manager
 * sees that no end photo was checked), and without a connection the end time is saved and sent later.
 */
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { File, UploadType } from 'expo-file-system';
import { api, errorMessage } from '../../lib/api/client';
import type { IntentResponse, SessionStatus } from '../../lib/api/types';
import { qk, queryClient } from '../../lib/queryClient';
import { colors, font, radius, space } from '../../lib/theme';
import { Button } from '../../components/ui';
import { finishShift } from '../../components/shift/actions';

export default function EndShiftScreen() {
  const [status] = useState(() => queryClient.getQueryData<SessionStatus | null>(qk.status) ?? null);
  const [perm, requestPerm] = useCameraPermissions();
  const cam = useRef<CameraView>(null);
  const [ready, setReady] = useState(false);
  const [photo, setPhoto] = useState<{ uri: string; size: number } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!status) router.replace('/shift');
  }, [status]);

  if (!status) return null;
  // On overtime the selfie is the proof that overtime ended (the manager approves it).
  const what = status.overtime?.status === 'RUNNING' ? 'overtime' : 'shift';
  if (perm && !perm.granted) {
    return (
      <SafeAreaView style={st.dark}>
        <View style={st.center}>
          <Text style={st.title}>Camera needed</Text>
          <Text style={st.text}>Allow the camera to take your end-of-{what} selfie.</Text>
          <Button title="Allow camera" onPress={() => void requestPerm()} />
          <Button title={`End ${what} without a photo`} variant="secondary" onPress={() => void finishShift(status)} />
        </View>
      </SafeAreaView>
    );
  }

  const shoot = async () => {
    if (!cam.current || !ready) return;
    setBusy('Saving…');
    try {
      const pic = await cam.current.takePictureAsync({ quality: 0.85, exif: false });
      let ctx = ImageManipulator.manipulate(pic.uri);
      if (Math.max(pic.width, pic.height) > 1280) ctx = ctx.resize(pic.width >= pic.height ? { width: 1280 } : { height: 1280 });
      const out = await (await ctx.renderAsync()).saveAsync({ compress: 0.7, format: SaveFormat.JPEG });
      setPhoto({ uri: out.uri, size: new File(out.uri).size ?? 0 });
    } catch (e) {
      Alert.alert('Could not take the photo', errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const end = async () => {
    if (!photo) return;
    try {
      setBusy('Sending photo…');
      const slot = await api<IntentResponse>(`/tracking/sessions/${status.session.id}/end-photo`, { method: 'POST', body: { contentType: 'image/jpeg', sizeBytes: photo.size } });
      const put = await new File(photo.uri).upload(slot.upload.url, { httpMethod: 'PUT', uploadType: UploadType.BINARY_CONTENT, headers: slot.upload.headers });
      if (put.status < 200 || put.status >= 300) throw new Error(`Photo upload failed (${put.status}).`);
      setBusy(`Ending ${what}…`);
      await finishShift(status, slot.photoId);
    } catch (e) {
      setBusy(null);
      Alert.alert('Photo not sent', `${errorMessage(e)} You can try again, or end the ${what} without the photo${what === 'overtime' ? ' (your manager sees that it is missing)' : ''}.`, [
        { text: 'Try again', style: 'cancel' },
        { text: 'End without photo', style: 'destructive', onPress: () => void finishShift(status) },
      ]);
    }
  };

  if (photo) {
    return (
      <SafeAreaView style={st.dark} edges={['top', 'bottom']}>
        <View style={{ flex: 1, padding: space.lg, gap: space.md }}>
          <Text style={st.title}>End your {what} with this photo?</Text>
          <Image source={{ uri: photo.uri }} style={st.preview} resizeMode="contain" accessibilityLabel={`End-of-${what} selfie`} />
          <Button title={busy ?? `End ${what}`} variant="danger" onPress={() => void end()} loading={!!busy} />
          <Button title="Retake" variant="secondary" onPress={() => { setPhoto(null); setReady(false); }} disabled={!!busy} />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <View style={st.dark}>
      <CameraView ref={cam} style={StyleSheet.absoluteFill} facing="front" mode="picture" onCameraReady={() => setReady(true)} animateShutter />
      <SafeAreaView style={st.overlay} edges={['top', 'bottom']}>
        <View style={st.topBar}>
          <Pressable onPress={() => router.back()} style={st.iconBtn} accessibilityRole="button" accessibilityLabel="Cancel">
            <Text style={st.iconText}>✕</Text>
          </Pressable>
          <Text style={st.topTitle}>End-of-{what} selfie</Text>
          <View style={st.iconBtn} />
        </View>
        <View style={st.guide} pointerEvents="none" />
        <Text style={st.hint}>Look straight at the camera</Text>
        <View style={st.bottomBar}>
          {busy ? <ActivityIndicator size="large" color={colors.white} /> : <Pressable onPress={shoot} disabled={!ready} style={[st.shutter, !ready && { opacity: 0.4 }]} accessibilityRole="button" accessibilityLabel="Take selfie" />}
        </View>
      </SafeAreaView>
    </View>
  );
}

const st = StyleSheet.create({
  dark: { flex: 1, backgroundColor: '#0B0F1E' },
  overlay: { flex: 1, justifyContent: 'space-between' },
  center: { flex: 1, justifyContent: 'center', padding: space.xl, gap: space.md },
  topBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: space.lg, paddingTop: space.sm },
  topTitle: { color: colors.white, fontSize: font.lg, fontWeight: '700' },
  iconBtn: { width: 52, height: 52, borderRadius: 26, backgroundColor: 'rgba(0,0,0,0.45)', alignItems: 'center', justifyContent: 'center' },
  iconText: { color: colors.white, fontSize: 22, fontWeight: '700' },
  guide: { alignSelf: 'center', width: '68%', aspectRatio: 0.78, borderRadius: 999, borderWidth: 3, borderColor: 'rgba(255,255,255,0.75)' },
  hint: { color: colors.white, textAlign: 'center', fontSize: font.md, textShadowColor: '#000', textShadowRadius: 4 },
  bottomBar: { alignItems: 'center', paddingBottom: space.xl, minHeight: 110, justifyContent: 'center' },
  shutter: { width: 78, height: 78, borderRadius: 39, backgroundColor: colors.white, borderWidth: 6, borderColor: colors.orange },
  title: { color: colors.white, fontSize: font.xl, fontWeight: '800' },
  text: { color: '#E5E7EF', fontSize: font.md, lineHeight: 22 },
  preview: { flex: 1, borderRadius: radius.lg, backgroundColor: '#000' },
});
