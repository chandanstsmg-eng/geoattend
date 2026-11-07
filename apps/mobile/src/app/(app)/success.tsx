/** Screen 12: attendance success — only reached after POST /attendance returned 200/201. */
import { Redirect, router, useLocalSearchParams } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';
import { Banner, Body, Button, Card, Muted, Row, Screen } from '../../components/ui';
import { attendanceStatus } from '../../lib/attendance-status';
import { fmtDate, fmtTimeSec } from '../../lib/format';
import { colors, font, space } from '../../lib/theme';

export default function SuccessScreen() {
  const p = useLocalSearchParams<{ ref?: string; recordedAt?: string; isLate?: string; lateBy?: string; verification?: string; replay?: string; pending?: string; capturedAt?: string }>();
  // A short receipt number the employee can quote if anyone says the attendance is missing.
  const receipt = p.ref ? p.ref.replace(/-/g, '').slice(0, 8).toUpperCase().replace(/(.{4})(.{4})/, '$1-$2') : null;
  if (p.pending && p.capturedAt) {
    // Saved, not recorded: the server has not seen it, so nothing here may read as confirmed.
    return (
      <Screen>
        <View accessible style={st.saved} accessibilityRole="summary" accessibilityLabel={`Check-in saved on this phone at ${fmtTimeSec(p.capturedAt)}. Not recorded yet.`}>
          <Text style={st.savedTitle}>Saved on this phone</Text>
          <Text style={st.time}>Taken at: {fmtTimeSec(p.capturedAt)}</Text>
          <Muted center>Not recorded yet</Muted>
        </View>
        <Banner tone="warning" title="No connection" message="Your photo and location are saved. They are sent by themselves when the connection returns. The server checks them, then your manager reviews the record." />
        <Body>Do not uninstall the app or clear its data until it has been sent. You can see where it stands in History.</Body>
        <Button title="Go to live shift" onPress={() => router.replace('/shift')} />
        <Button title="See history" variant="secondary" onPress={() => router.replace('/history')} />
      </Screen>
    );
  }
  if (!p.recordedAt) {
    // Defensive: never claim success without the server's timestamp.
    return <Redirect href="/shift" />;
  }
  // The server has this record, but it may still be waiting for a person: only a counted record looks confirmed.
  const v = attendanceStatus(p.verification);
  return (
    <Screen>
      <View accessible style={v.counted ? st.hero : st.saved} accessibilityRole="summary" accessibilityLabel={`${v.counted ? 'Attendance recorded' : 'Received, not counted yet'} at ${fmtTimeSec(p.recordedAt)}. ${v.label}`}>
        {v.counted ? (
          <View style={st.check}>
            <Text style={st.checkText}>✓</Text>
          </View>
        ) : null}
        <Text style={v.counted ? st.title : st.savedTitle}>{v.counted ? 'Attendance recorded' : 'Received, not counted yet'}</Text>
        <Text style={st.time}>Recorded at: {fmtTimeSec(p.recordedAt)}</Text>
        <Muted center>{fmtDate(p.recordedAt)} · server time</Muted>
        {receipt ? <Text style={st.receipt} selectable>Receipt {receipt}</Text> : null}
      </View>
      {p.replay ? <Banner tone="info" title="This attendance was already recorded" message="The server returned the original record; nothing was duplicated." /> : null}
      <Card>
        <Row label="Status" value={v.label} />
        {p.isLate ? <Row label="Late by" value={`${p.lateBy} min`} /> : <Row label="Arrival" value="On time" />}
      </Card>
      {v.counted ? null : <Banner tone="warning" title="Your manager checks this record" message="It counts once they approve it. You can follow it in History." />}
      <Body>Location tracking continues until you end the shift or the shift window closes.</Body>
      <Button title="Go to live shift" onPress={() => router.replace('/shift')} />
    </Screen>
  );
}

const st = StyleSheet.create({
  saved: { alignItems: 'center', gap: space.sm, paddingVertical: space.xl, backgroundColor: colors.white, borderRadius: 16, borderWidth: 1.5, borderColor: colors.warning },
  savedTitle: { fontSize: font.xxl, fontWeight: '800', color: colors.warning },
  hero: { alignItems: 'center', gap: space.sm, paddingVertical: space.xl, backgroundColor: colors.successSoft, borderRadius: 16, borderWidth: 1.5, borderColor: '#B8E2C5' },
  check: { width: 72, height: 72, borderRadius: 36, backgroundColor: colors.success, alignItems: 'center', justifyContent: 'center' },
  checkText: { color: colors.white, fontSize: 40, fontWeight: '800' },
  title: { fontSize: font.xxl, fontWeight: '800', color: colors.success },
  time: { fontSize: font.xl, fontWeight: '700', color: colors.text },
  receipt: { marginTop: space.xs, fontSize: font.md, fontWeight: '700', letterSpacing: 1, color: colors.navy, backgroundColor: colors.white, paddingHorizontal: space.md, paddingVertical: 4, borderRadius: 8, overflow: 'hidden' },
});
