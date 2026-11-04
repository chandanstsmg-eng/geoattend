/** Screen 16: shift completion — confirms that location tracking has stopped. */
import { useEffect, useState } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';
import { Banner, Body, Button, Card, Row, Screen } from '../../components/ui';
import { fmtTime } from '../../lib/format';
import { isUpdatesRunning } from '../../lib/tracking/runtime';
import { colors, font, space } from '../../lib/theme';

export default function CompletedScreen() {
  const p = useLocalSearchParams<{ endedAt?: string; recordedAt?: string; shiftName?: string; offline?: string }>();
  const [running, setRunning] = useState<boolean | null>(null);
  useEffect(() => {
    isUpdatesRunning().then(setRunning, () => setRunning(false));
  }, []);
  return (
    <Screen>
      <View style={st.hero}>
        <Text style={st.title}>Location tracking has stopped</Text>
        <Body center>{p.shiftName ? `${p.shiftName} is complete.` : 'Your shift is complete.'} No location is collected until you start another shift.</Body>
      </View>
      {running ? <Banner tone="danger" title="Location updates are still registered on this phone" message="Restart the app; GeoAttend stops them automatically when no shift is open." /> : null}
      {p.offline === 'saved' ? (
        <Banner tone="warning" title="Saved on this phone, not sent yet" message="The time you ended is sent by itself when the connection returns. Until then the shift stays open on the server." />
      ) : p.offline ? (
        <Banner tone="warning" title="Ended on this phone only" message="The server could not be reached. It will mark tracking as interrupted and close the shift automatically at the end of the shift window." />
      ) : null}
      <Card>
        <Row label="Tracking stopped" value={fmtTime(p.endedAt)} strong />
        <Row label="Attendance" value={p.recordedAt ? `Recorded at ${fmtTime(p.recordedAt)}` : p.offline ? 'See history' : 'Not recorded for this shift'} />
        <Row label="Location on this phone" value={running === null ? 'Checking…' : running ? 'Still registered' : 'Stopped'} />
      </Card>
      <Button title="Back to home" onPress={() => router.replace('/')} />
      <Button title="View attendance history" variant="secondary" onPress={() => router.replace('/history')} />
    </Screen>
  );
}

const st = StyleSheet.create({
  hero: { gap: space.sm, padding: space.xl, backgroundColor: colors.navySoft, borderRadius: 16, alignItems: 'center' },
  title: { fontSize: font.xxl, fontWeight: '800', color: colors.navy, textAlign: 'center' },
});
