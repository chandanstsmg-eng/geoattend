/** Screen 12: attendance success — only reached after POST /attendance returned 200/201. */
import { Redirect, router, useLocalSearchParams } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';
import { Banner, Body, Button, Card, Muted, Row, Screen } from '../../components/ui';
import { fmtDate, fmtTimeSec } from '../../lib/format';
import { colors, font, space } from '../../lib/theme';

export default function SuccessScreen() {
  const p = useLocalSearchParams<{ ref?: string; recordedAt?: string; isLate?: string; lateBy?: string; verification?: string; replay?: string }>();
  // A short receipt number the employee can quote if anyone says the attendance is missing.
  const receipt = p.ref ? p.ref.replace(/-/g, '').slice(0, 8).toUpperCase().replace(/(.{4})(.{4})/, '$1-$2') : null;
  if (!p.recordedAt) {
    // Defensive: never claim success without the server's timestamp.
    return <Redirect href="/shift" />;
  }
  return (
    <Screen>
      <View style={st.hero} accessibilityRole="summary" accessibilityLabel={`Attendance recorded at ${fmtTimeSec(p.recordedAt)}`}>
        <View style={st.check}>
          <Text style={st.checkText}>✓</Text>
        </View>
        <Text style={st.title}>Attendance recorded</Text>
        <Text style={st.time}>Recorded at: {fmtTimeSec(p.recordedAt)}</Text>
        <Muted center>{fmtDate(p.recordedAt)} · server time</Muted>
        {receipt ? <Text style={st.receipt} selectable>Receipt {receipt}</Text> : null}
      </View>
      {p.replay ? <Banner tone="info" title="This attendance was already recorded" message="The server returned the original record; nothing was duplicated." /> : null}
      <Card>
        <Row label="Verification" value={p.verification ?? 'VERIFIED'} />
        {p.isLate ? <Row label="Late by" value={`${p.lateBy} min`} /> : <Row label="Arrival" value="On time" />}
      </Card>
      <Body>Location tracking continues until you end the shift or the shift window closes.</Body>
      <Button title="Go to live shift" onPress={() => router.replace('/shift')} />
    </Screen>
  );
}

const st = StyleSheet.create({
  hero: { alignItems: 'center', gap: space.sm, paddingVertical: space.xl, backgroundColor: colors.successSoft, borderRadius: 16, borderWidth: 1.5, borderColor: '#B8E2C5' },
  check: { width: 72, height: 72, borderRadius: 36, backgroundColor: colors.success, alignItems: 'center', justifyContent: 'center' },
  checkText: { color: colors.white, fontSize: 40, fontWeight: '800' },
  title: { fontSize: font.xxl, fontWeight: '800', color: colors.success },
  time: { fontSize: font.xl, fontWeight: '700', color: colors.text },
  receipt: { marginTop: space.xs, fontSize: font.md, fontWeight: '700', letterSpacing: 1, color: colors.navy, backgroundColor: colors.white, paddingHorizontal: space.md, paddingVertical: 4, borderRadius: 8, overflow: 'hidden' },
});
