import { router } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';
import type { SessionStatus } from '../lib/api/types';
import { fmtAgo } from '../lib/format';
import { useNow, useOnline, useTrackingSnapshot } from '../lib/hooks';
import { isForegroundWatcherActive } from '../lib/tracking/runtime';
import { colors, font, space } from '../lib/theme';
import { Banner } from './ui';

/** Connection, queue, "not running" and staleness indicators for an open session. */
export function TrackingBanners({ status }: { status: SessionStatus | null | undefined }) {
  const snap = useTrackingSnapshot();
  const online = useOnline();
  useNow(15_000);
  if (!status || !status.tracking.shouldTrack) return null;

  const deviceOnThisSession = snap.meta.sessionId === status.session.id;
  const running = deviceOnThisSession && (snap.updatesRunning === true || isForegroundWatcherActive());
  const notRunning = snap.updatesRunning !== null && !running;

  return (
    <View style={{ gap: space.sm }}>
      {notRunning ? (
        <Banner
          tone="danger"
          title="Tracking is off on this phone"
          actionLabel="Resume"
          onPress={() => router.push({ pathname: '/permissions', params: { shiftId: status.session.shiftId, resume: '1' } })}
        />
      ) : null}
      {!online ? (
        <Banner tone="warning" title={`Offline — ${snap.queueLength} saved, will send later`} />
      ) : snap.queueLength > 0 ? (
        <Banner tone="info" title={`Sending ${snap.queueLength} saved location${snap.queueLength === 1 ? '' : 's'}…`} />
      ) : null}
      {snap.dropped > 0 ? <Banner tone="warning" title={`${snap.dropped} old location${snap.dropped === 1 ? '' : 's'} removed: the phone's limit was reached`} message="Your attendance is not affected. Reconnect to send the rest." /> : null}
      {status.session.isStale ? (
        <Banner tone="warning" title="Location not updating" message={`Last update ${fmtAgo(status.session.lastLocationAt)}`} />
      ) : null}
      {running && snap.meta.mode === 'foreground' ? (
        <Banner tone="warning" title="Keep the app open" message="Background location is off." />
      ) : null}
    </View>
  );
}

/** Small strip: tracking dot + last sent time. */
export function TrackingStrip({ status }: { status: SessionStatus }) {
  const snap = useTrackingSnapshot();
  const now = useNow(10_000);
  const running = snap.meta.sessionId === status.session.id && (snap.updatesRunning === true || isForegroundWatcherActive());
  return (
    <View style={s.strip} accessibilityLabel={`Tracking ${running ? 'on' : 'off'}. Last sent ${fmtAgo(snap.meta.lastSentAt, now)}`}>
      <View style={[s.dot, { backgroundColor: running ? colors.success : colors.danger }]} />
      <Text style={s.text}>{running ? 'Tracking on' : 'Tracking off'}</Text>
      <Text style={s.sep}>·</Text>
      <Text style={s.text}>Sent {snap.meta.lastSentAt ? fmtAgo(snap.meta.lastSentAt, now) : '—'}</Text>
      {status.session.isStale ? <Text style={[s.text, { color: colors.warning, fontWeight: '700' }]}> · Delayed</Text> : null}
    </View>
  );
}

const s = StyleSheet.create({
  strip: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6, backgroundColor: colors.white, borderRadius: 999, borderWidth: 1, borderColor: colors.border, paddingHorizontal: space.md, paddingVertical: 8 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  text: { fontSize: font.sm, color: colors.text },
  sep: { color: colors.textFaint },
});
