/**
 * Take a break: break type, optional note, selfie, then a fresh GPS fix.
 *
 * Must be done BEFORE leaving the workplace area — the server accepts the break only while the
 * employee is present and the fix is inside the area. Order: reserve upload → PUT JPEG → fresh
 * high-accuracy fix → POST /breaks. The break exists only once the server answered.
 */
import { useRef, useState } from 'react';
import { Alert, Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { File, UploadType } from 'expo-file-system';
import * as Location from 'expo-location';
import { Badge, Body, Button, Card, Field, H2, Loading, Muted, Screen } from '../../components/ui';
import { api, ApiError, errorMessage } from '../../lib/api/client';
import type { IntentResponse, SessionStatus } from '../../lib/api/types';
import { useStatus } from '../../lib/hooks';
import { qk, queryClient } from '../../lib/queryClient';
import { bestFix, toReading } from '../../lib/tracking/runtime';
import { toWire } from '../../lib/tracking/queue-core';
import { colors, font, radius, space } from '../../lib/theme';

const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

async function shrink(uri: string, width: number, height: number) {
  for (const quality of [0.6, 0.4]) {
    let ctx = ImageManipulator.manipulate(uri);
    if (Math.max(width, height) > 1280) ctx = ctx.resize(width >= height ? { width: 1280 } : { height: 1280 });
    const out = await (await ctx.renderAsync()).saveAsync({ compress: quality, format: SaveFormat.JPEG });
    const size = new File(out.uri).size ?? 0;
    if (size > 0 && size <= MAX_PHOTO_BYTES) return { uri: out.uri, size };
  }
  throw new Error('The photo is too large even after compression. Please retake it.');
}

function explain(e: unknown): string {
  if (e instanceof ApiError) {
    switch (e.code) {
      case 'BREAK_OUTSIDE':
      case 'GPS_ACCURACY_INSUFFICIENT':
      case 'EVIDENCE_STALE':
      case 'BREAK_NOT_ALLOWED':
      case 'PHOTO_INVALID':
      case 'PHOTO_MISSING':
        return e.message;
    }
    if (e.isNetwork) return `${e.message} Your break has NOT started. Try again.`;
  }
  return errorMessage(e);
}

export default function BreakScreen() {
  const statusQ = useStatus();
  const [perm, requestPerm] = useCameraPermissions();
  const cam = useRef<CameraView>(null);
  const [camera, setCamera] = useState(false);
  const [ready, setReady] = useState(false);
  const [photo, setPhoto] = useState<{ uri: string; size: number } | null>(null);
  const [typeKey, setTypeKey] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  if (statusQ.isPending) return <Loading label="Loading…" />;
  const status = statusQ.data ?? null;
  if (!status?.canStartBreak) {
    return (
      <Screen>
        <Card>
          <H2>{status?.break ? 'You are already on a break' : 'A break cannot be started now'}</H2>
          <Body>You can start a break only while you are marked present inside the workplace area.</Body>
        </Card>
        <Button title="Back to shift" onPress={() => router.replace('/shift')} />
      </Screen>
    );
  }
  const { types, requirePhoto } = status.breakOptions;
  const chosen = types.find((t) => t.key === typeKey) ?? null;

  const openCamera = async () => {
    if (!perm?.granted && !(await requestPerm()).granted) {
      Alert.alert('Camera needed', 'Allow camera access to take your break selfie.');
      return;
    }
    setReady(false);
    setCamera(true);
  };
  const shoot = async () => {
    if (!cam.current || !ready) return;
    try {
      const pic = await cam.current.takePictureAsync({ quality: 0.8, exif: false });
      setPhoto(await shrink(pic.uri, pic.width, pic.height));
      setCamera(false);
    } catch (e) {
      Alert.alert('Could not take the photo', errorMessage(e));
    }
  };

  const submit = async () => {
    if (!chosen) return Alert.alert('Choose a break', 'Pick the kind of break you are taking.');
    if (requirePhoto && !photo) return Alert.alert('Selfie needed', 'Take a selfie to start your break.');
    try {
      let photoId: string | undefined;
      if (photo) {
        setBusy('Uploading selfie…');
        const slot = await api<IntentResponse>(`/tracking/sessions/${status.session.id}/breaks/photo`, { method: 'POST', body: { contentType: 'image/jpeg', sizeBytes: photo.size } });
        let put;
        try {
          put = await new File(photo.uri).upload(slot.upload.url, { httpMethod: 'PUT', uploadType: UploadType.BINARY_CONTENT, headers: slot.upload.headers });
        } catch {
          throw new ApiError(0, 'NETWORK_ERROR', 'The selfie upload did not complete.');
        }
        if (put.status < 200 || put.status >= 300) throw new Error(`Selfie upload failed (${put.status}). Try again.`);
        photoId = slot.photoId;
      }
      // The server only accepts a break that starts inside the workplace area, judged from a fresh fix.
      setBusy('Confirming you are at the workplace…');
      const fix = await bestFix(status.tracking.maxAccuracyM);
      const reading = toReading(fix, 'FOREGROUND', status.session.id, null);
      if (!reading) throw new Error('The phone returned a location without accuracy information. Retry.');
      setBusy('Starting break…');
      const next = await api<SessionStatus>(`/tracking/sessions/${status.session.id}/breaks`, {
        method: 'POST',
        body: { typeKey: chosen.key, note: note.trim() || undefined, photoId, evidence: toWire(reading) },
        timeoutMs: 45_000,
      });
      queryClient.setQueryData(qk.status, next);
      router.replace('/shift');
    } catch (e) {
      Alert.alert('Break not started', explain(e));
    } finally {
      setBusy(null);
    }
  };

  if (camera) {
    return (
      <View style={{ flex: 1, backgroundColor: '#000' }}>
        <CameraView ref={cam} style={StyleSheet.absoluteFill} facing="front" mode="picture" onCameraReady={() => setReady(true)} animateShutter />
        <View style={st.camBar}>
          <Button title="Cancel" variant="secondary" onPress={() => setCamera(false)} style={{ flex: 1 }} />
          <Pressable onPress={shoot} disabled={!ready} style={[st.shutter, !ready && { opacity: 0.4 }]} accessibilityRole="button" accessibilityLabel="Take selfie" />
          <View style={{ flex: 1 }} />
        </View>
      </View>
    );
  }

  return (
    <Screen>
      <Card tone="info">
        <Body>Start your break before you leave the workplace area. While on break, leaving the area does not raise an absence alert, but your location is still shared with your manager.</Body>
      </Card>

      <Card>
        <H2>What kind of break?</H2>
        <View style={{ gap: space.sm }}>
          {types.map((t) => {
            const on = t.key === typeKey;
            return (
              <Pressable
                key={t.key}
                onPress={() => setTypeKey(t.key)}
                style={[st.option, on && st.optionOn]}
                accessibilityRole="radio"
                accessibilityState={{ checked: on }}
                accessibilityLabel={`${t.label}, ${t.paid ? 'paid' : 'unpaid'}, up to ${t.maxMinutes} minutes`}
              >
                <Text style={[st.optionTitle, on && { color: colors.orangeDark }]}>{t.label}</Text>
                <View style={{ flexDirection: 'row', gap: space.sm, alignItems: 'center' }}>
                  <Muted>up to {t.maxMinutes} min</Muted>
                  <Badge label={t.paid ? 'Paid' : 'Unpaid'} tone={t.paid ? 'success' : 'neutral'} />
                </View>
              </Pressable>
            );
          })}
        </View>
        <Field label="Note (optional)" value={note} onChangeText={setNote} maxLength={500} placeholder="e.g. going to the bank" />
      </Card>

      <Card>
        <H2>{requirePhoto ? 'Selfie' : 'Selfie (optional)'}</H2>
        {photo ? <Image source={{ uri: photo.uri }} style={st.preview} resizeMode="cover" accessibilityLabel="Break selfie" /> : null}
        <Button title={photo ? 'Retake selfie' : 'Take selfie'} variant="secondary" onPress={openCamera} />
      </Card>

      <Button title={busy ?? 'Start break'} onPress={submit} loading={!!busy} disabled={!chosen || (requirePhoto && !photo)} accessibilityHint="Sends your selfie and a fresh GPS fix" />
      {chosen ? <Muted>Your manager is alerted if the break runs past {chosen.maxMinutes} min.</Muted> : null}
    </Screen>
  );
}

const st = StyleSheet.create({
  option: { borderWidth: 1.5, borderColor: colors.border, borderRadius: radius.md, padding: space.md, gap: 2, backgroundColor: colors.white },
  optionOn: { borderColor: colors.orange, backgroundColor: colors.orangeSoft },
  optionTitle: { fontSize: font.lg, fontWeight: '700', color: colors.navy },
  preview: { width: '100%', aspectRatio: 3 / 4, borderRadius: radius.md, backgroundColor: colors.navySoft },
  camBar: { position: 'absolute', left: 0, right: 0, bottom: 40, flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.lg, gap: space.lg },
  shutter: { width: 76, height: 76, borderRadius: 38, borderWidth: 5, borderColor: '#fff', backgroundColor: 'rgba(255,255,255,0.3)' },
});
