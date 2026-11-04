/**
 * Start overtime once the shift has ended: optional note, selfie, then a fresh GPS fix.
 *
 * Overtime may be worked anywhere, so the fix only records where it started (the server keeps
 * the distance as evidence for the approver). Order: reserve upload → PUT JPEG → fresh fix →
 * POST /overtime. Overtime exists only once the server answered. It is counted toward hours
 * and pay only after an administrator approves it. "End overtime" (with a selfie) ends it.
 */
import { useRef, useState } from 'react';
import { Alert, Image, Pressable, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { File, UploadType } from 'expo-file-system';
import * as Location from 'expo-location';
import { Body, Button, Card, Field, H2, Loading, Muted, Screen } from '../../components/ui';
import { api, ApiError, errorMessage } from '../../lib/api/client';
import type { IntentResponse, SessionStatus } from '../../lib/api/types';
import { fmtTime } from '../../lib/format';
import { useStatus } from '../../lib/hooks';
import { qk, queryClient } from '../../lib/queryClient';
import { applyServerStatus, bestFix, toReading } from '../../lib/tracking/runtime';
import { toWire } from '../../lib/tracking/queue-core';
import { colors, radius, space } from '../../lib/theme';

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
      case 'OVERTIME_TOO_EARLY':
      case 'OVERTIME_NOT_ALLOWED':
      case 'OVERTIME_ALREADY_OPEN':
      case 'EVIDENCE_STALE':
      case 'EVIDENCE_INVALID':
      case 'PHOTO_INVALID':
      case 'PHOTO_MISSING':
        return e.message;
    }
    if (e.isNetwork) return `${e.message} Your overtime has NOT started. Try again.`;
  }
  return errorMessage(e);
}

export default function OvertimeScreen() {
  const statusQ = useStatus();
  const [perm, requestPerm] = useCameraPermissions();
  const cam = useRef<CameraView>(null);
  const [camera, setCamera] = useState(false);
  const [ready, setReady] = useState(false);
  const [photo, setPhoto] = useState<{ uri: string; size: number } | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  if (statusQ.isPending) return <Loading label="Loading…" />;
  const status = statusQ.data ?? null;
  if (!status?.canStartOvertime) {
    return (
      <Screen>
        <Card>
          <H2>{status?.overtime ? 'You are already on overtime' : 'Overtime cannot be started now'}</H2>
          <Body>{status && Date.now() < Date.parse(status.session.scheduledEndAt) ? `Overtime can start once your shift ends at ${fmtTime(status.session.scheduledEndAt)}.` : 'Overtime can start after your shift ends, while the shift is still open and attendance is recorded.'}</Body>
        </Card>
        <Button title="Back to shift" onPress={() => router.replace('/shift')} />
      </Screen>
    );
  }

  const openCamera = async () => {
    if (!perm?.granted && !(await requestPerm()).granted) {
      Alert.alert('Camera needed', 'Allow camera access to take your overtime selfie.');
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
    if (!photo) return Alert.alert('Selfie needed', 'Take a selfie to start overtime.');
    try {
      setBusy('Uploading selfie…');
      const slot = await api<IntentResponse>(`/tracking/sessions/${status.session.id}/overtime/photo`, { method: 'POST', body: { contentType: 'image/jpeg', sizeBytes: photo.size } });
      let put;
      try {
        put = await new File(photo.uri).upload(slot.upload.url, { httpMethod: 'PUT', uploadType: UploadType.BINARY_CONTENT, headers: slot.upload.headers });
      } catch {
        throw new ApiError(0, 'NETWORK_ERROR', 'The selfie upload did not complete.');
      }
      if (put.status < 200 || put.status >= 300) throw new Error(`Selfie upload failed (${put.status}). Try again.`);
      setBusy('Getting your location…');
      const fix = await bestFix(status.tracking.maxAccuracyM);
      const reading = toReading(fix, 'FOREGROUND', status.session.id, null);
      if (!reading) throw new Error('The phone returned a location without accuracy information. Retry.');
      setBusy('Starting overtime…');
      const next = await api<SessionStatus>(`/tracking/sessions/${status.session.id}/overtime`, {
        method: 'POST',
        body: { note: note.trim() || undefined, photoId: slot.photoId, evidence: toWire(reading) },
        timeoutMs: 45_000,
      });
      // Overtime is not bound to the shift window: update the phone's copy before the window time passes.
      await applyServerStatus(next);
      queryClient.setQueryData(qk.status, next);
      router.replace('/shift');
    } catch (e) {
      Alert.alert('Overtime not started', explain(e));
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
        <Body>
          Your shift ended at {fmtTime(status.session.scheduledEndAt)}. If you are still working, start overtime. Your location keeps being shared with your manager until you end it. Overtime is paid only after your manager approves it.
        </Body>
      </Card>

      <Card>
        <H2>What are you working on?</H2>
        <Field label="Note (optional)" value={note} onChangeText={setNote} maxLength={500} placeholder="e.g. finishing the delivery to the warehouse" />
      </Card>

      <Card>
        <H2>Selfie</H2>
        {photo ? <Image source={{ uri: photo.uri }} style={st.preview} resizeMode="cover" accessibilityLabel="Overtime selfie" /> : null}
        <Button title={photo ? 'Retake selfie' : 'Take selfie'} variant="secondary" onPress={openCamera} />
      </Card>

      <Button title={busy ?? 'Start overtime'} onPress={submit} loading={!!busy} disabled={!photo} accessibilityHint="Sends your selfie and your current location" />
      <Muted center>When you finish, tap “End overtime” and take another selfie.</Muted>
    </Screen>
  );
}

const st = StyleSheet.create({
  preview: { width: '100%', aspectRatio: 3 / 4, borderRadius: radius.md, backgroundColor: colors.navySoft },
  camBar: { position: 'absolute', left: 0, right: 0, bottom: 40, flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.lg, gap: space.lg },
  shutter: { width: 76, height: 76, borderRadius: 38, borderWidth: 5, borderColor: '#fff', backgroundColor: 'rgba(255,255,255,0.3)' },
});
