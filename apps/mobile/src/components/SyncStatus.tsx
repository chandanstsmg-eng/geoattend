/** What is saved on this phone and where it stands: waiting, sent, or not accepted. */
import { Alert, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import type { OutboxEvent } from '../lib/sync/engine';
import { dismissSaved, retrySaved } from '../lib/sync/outbox';
import { fmtDateTime } from '../lib/format';
import { useOnline, useTrackingSnapshot } from '../lib/hooks';
import { colors, font, space, type Tone } from '../lib/theme';
import { Badge, Banner, Button, Card, H2, Muted } from './ui';

const WHAT = { CHECK_IN: 'Check-in', CHECK_OUT: 'Shift end' };
const LABEL: Record<OutboxEvent['status'], [string, Tone]> = { PENDING: ['Waiting to send', 'warning'], SYNCED: ['Sent', 'success'], FAILED: ['Not accepted', 'danger'] };

/** One line for the home and shift screens. Silent when there is nothing to report. */
export function SyncBanner() {
  const snap = useTrackingSnapshot();
  const online = useOnline();
  const pending = snap.events.filter((e) => e.status === 'PENDING').length;
  const failed = snap.events.filter((e) => e.status === 'FAILED').length;
  return (
    <>
      {snap.syncBlocked ? <Banner tone="danger" title="Saved items cannot be sent yet" message={snap.syncBlocked} /> : null}
      {failed ? <Banner tone="danger" title={`${failed} saved item${failed === 1 ? ' was' : 's were'} not accepted`} actionLabel="See why" onPress={() => router.push('/history')} /> : null}
      {pending ? (
        <Banner
          tone="warning"
          title={snap.syncing ? 'Sending what is saved on this phone…' : `${pending} saved on this phone, not sent yet`}
          message={online ? 'It sends by itself. Keep the app installed.' : 'It sends by itself when the connection returns.'}
          actionLabel="Details"
          onPress={() => router.push('/history')}
        />
      ) : null}
    </>
  );
}

/** Every saved check-in and shift end, for the history screen. */
export function SavedOnPhone() {
  const snap = useTrackingSnapshot();
  const events = [...snap.events].sort((a, b) => Date.parse(b.capturedAt) - Date.parse(a.capturedAt));
  if (events.length === 0 && snap.failedReadings === 0) return null;
  return (
    <Card>
      <H2>Saved on this phone</H2>
      {events.map((e) => {
        const [label, tone] = LABEL[e.status];
        return (
          <View key={e.id} style={st.row}>
            <View style={st.head}>
              <Text style={st.what}>{`${WHAT[e.kind]} · ${e.shiftName}`}</Text>
              <Badge label={label} tone={tone} />
            </View>
            <Muted>{`${fmtDateTime(e.capturedAt)}${e.status === 'SYNCED' ? ', received by the server' : ''}`}</Muted>
            {e.status === 'PENDING' && e.lastError ? <Muted>{`Last try: ${e.lastError}`}</Muted> : null}
            {e.status === 'FAILED' ? (
              <>
                <Text style={st.reason}>{e.lastError ?? 'The server did not accept this.'}</Text>
                <Button title="Try again" variant="secondary" onPress={() => void retrySaved(e.id)} />
                <Button
                  title="Remove from this phone"
                  variant="ghost"
                  onPress={() =>
                    Alert.alert('Remove this item?', 'It was not recorded. Ask your manager to correct your attendance if it was right.', [
                      { text: 'Keep', style: 'cancel' },
                      { text: 'Remove', style: 'destructive', onPress: () => void dismissSaved(e.id) },
                    ])
                  }
                />
              </>
            ) : null}
          </View>
        );
      })}
      {snap.failedReadings > 0 ? <Muted>{`${snap.failedReadings} location reading${snap.failedReadings === 1 ? ' was' : 's were'} not accepted by the server.`}</Muted> : null}
    </Card>
  );
}

const st = StyleSheet.create({
  row: { paddingVertical: space.sm, borderTopWidth: 1, borderTopColor: colors.border, gap: 4 },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.sm },
  what: { flex: 1, fontSize: font.md, fontWeight: '600', color: colors.text },
  reason: { fontSize: font.sm, color: colors.danger },
});
