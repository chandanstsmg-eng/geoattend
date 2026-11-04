/** One task: details, and "Mark as done" with a proof photo, a note and the current location. */
import { useRef, useState } from 'react';
import { Alert, Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { File, UploadType } from 'expo-file-system';
import * as Location from 'expo-location';
import { Badge, Body, Button, Card, ErrorState, Field, H2, Loading, Muted, Screen } from '../../components/ui';
import { api, errorMessage } from '../../lib/api/client';
import type { Task } from '../../lib/api/types';
import { fmtDate, fmtDateTime } from '../../lib/format';
import { qk, queryClient } from '../../lib/queryClient';
import { colors, radius, space } from '../../lib/theme';
import { TASK_STATUS } from '../../lib/tasks';

async function shrink(uri: string, width: number, height: number) {
  let ctx = ImageManipulator.manipulate(uri);
  if (Math.max(width, height) > 1280) ctx = ctx.resize(width >= height ? { width: 1280 } : { height: 1280 });
  const out = await (await ctx.renderAsync()).saveAsync({ compress: 0.6, format: SaveFormat.JPEG });
  return { uri: out.uri, size: new File(out.uri).size ?? 0 };
}

export default function TaskScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const q = useQuery({ queryKey: qk.tasks, queryFn: () => api<Task[]>('/tasks/mine') });
  const [perm, requestPerm] = useCameraPermissions();
  const cam = useRef<CameraView>(null);
  const [camera, setCamera] = useState(false);
  const [photo, setPhoto] = useState<{ uri: string; size: number } | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  if (q.isPending) return <Loading label="Loading task…" />;
  const t = q.data?.find((x) => x.id === id);
  if (!t) return <Screen><ErrorState message={q.error ? errorMessage(q.error) : 'This task is no longer assigned to you.'} onRetry={() => void q.refetch()} /></Screen>;
  const canDo = t.status === 'OPEN' || t.status === 'REOPENED';

  const openCamera = async () => {
    if (!perm?.granted && !(await requestPerm()).granted) {
      Alert.alert('Camera needed', 'Allow camera access to take the proof photo.');
      return;
    }
    setCamera(true);
  };
  const shoot = async () => {
    const pic = await cam.current?.takePictureAsync({ quality: 0.8, exif: false });
    if (!pic) return;
    setPhoto(await shrink(pic.uri, pic.width, pic.height));
    setCamera(false);
  };
  const submit = async () => {
    if (t.requires_photo && !photo) {
      Alert.alert('Photo needed', 'Take a photo of the finished work first.');
      return;
    }
    setBusy(true);
    try {
      let photoId: string | undefined;
      if (photo) {
        const slot = await api<{ photoId: string; upload: { url: string; headers: Record<string, string> } }>(`/tasks/mine/${t.id}/photo`, { method: 'POST', body: { contentType: 'image/jpeg', sizeBytes: photo.size } });
        const put = await new File(photo.uri).upload(slot.upload.url, { httpMethod: 'PUT', uploadType: UploadType.BINARY_CONTENT, headers: slot.upload.headers });
        if (put.status < 200 || put.status >= 300) throw new Error(`Photo upload failed (${put.status}). Try again.`);
        photoId = slot.photoId;
      }
      // Best effort: where the work was finished. Never blocks marking the task done.
      const loc = await Promise.race([Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High }).catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), 8000))]);
      await api(`/tasks/mine/${t.id}/done`, {
        method: 'POST',
        body: { note: note.trim() || undefined, photoId, location: loc?.coords.accuracy ? { latitude: loc.coords.latitude, longitude: loc.coords.longitude, accuracyM: loc.coords.accuracy } : undefined },
      });
      await queryClient.invalidateQueries({ queryKey: qk.tasks });
      Alert.alert('Sent', 'Your manager has been told the task is done.');
      router.back();
    } catch (e) {
      Alert.alert('Not sent', errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (camera) {
    return (
      <View style={{ flex: 1, backgroundColor: '#000' }}>
        <CameraView ref={cam} style={StyleSheet.absoluteFill} facing="back" mode="picture" />
        <View style={st.camBar}>
          <Button title="Cancel" variant="secondary" onPress={() => setCamera(false)} style={{ flex: 1 }} />
          <Pressable onPress={shoot} style={st.shutter} accessibilityRole="button" accessibilityLabel="Take photo" />
          <View style={{ flex: 1 }} />
        </View>
      </View>
    );
  }

  return (
    <Screen>
      <Card>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
          <Badge label={TASK_STATUS[t.status].label} tone={TASK_STATUS[t.status].tone} />
          {t.due_date ? <Muted>Due {fmtDate(t.due_date)}</Muted> : null}
        </View>
        <H2>{t.title}</H2>
        {t.details ? <Body>{t.details}</Body> : null}
        <Muted>From {t.created_by_name ?? 'your manager'}{t.workplace_name ? ` · ${t.workplace_name}` : ''}</Muted>
        {t.status === 'REOPENED' && t.review_note ? <Body color={colors.danger}>Sent back: {t.review_note}</Body> : null}
        {t.status === 'SUBMITTED' ? <Muted>Sent {fmtDateTime(t.submitted_at)} — waiting for your manager to check.</Muted> : null}
        {t.status === 'APPROVED' ? <Muted>Approved{t.review_note ? ` — ${t.review_note}` : ''}.</Muted> : null}
      </Card>

      {canDo ? (
        <Card>
          <H2>Mark as done</H2>
          {photo ? <Image source={{ uri: photo.uri }} style={st.preview} resizeMode="cover" accessibilityLabel="Proof photo" /> : null}
          <Button title={photo ? 'Retake photo' : t.requires_photo ? 'Take proof photo' : 'Add a photo (optional)'} variant="secondary" onPress={openCamera} />
          <Field label="Note (optional)" value={note} onChangeText={setNote} multiline maxLength={1000} placeholder="Anything your manager should know" />
          <Button title="Mark as done" onPress={submit} loading={busy} disabled={t.requires_photo && !photo} />
          <Muted>Your location at this moment is sent with the task.</Muted>
        </Card>
      ) : null}
    </Screen>
  );
}

const st = StyleSheet.create({
  preview: { width: '100%', aspectRatio: 4 / 3, borderRadius: radius.md, backgroundColor: colors.navySoft },
  camBar: { position: 'absolute', left: 0, right: 0, bottom: 40, flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.lg, gap: space.lg },
  shutter: { width: 76, height: 76, borderRadius: 38, borderWidth: 5, borderColor: '#fff', backgroundColor: 'rgba(255,255,255,0.3)' },
});
