import { StyleSheet, Text, View } from 'react-native';
import type { SessionStatus } from '../lib/api/types';
import { fmtDistance, fmtTime } from '../lib/format';
import { colors, font, radius, space, toneColors } from '../lib/theme';
import { Badge, DemoBadge } from './ui';

/** Big status card rendered from the server's guidance text. */
export function StatusCard({ status }: { status: SessionStatus }) {
  const g = status.guidance;
  const t = toneColors[g.tone];
  const s = status.session;
  return (
    <View style={[st.card, { borderColor: t.border, backgroundColor: t.bg }]} accessibilityRole="summary" accessibilityLabel={`${g.title}. ${g.message}`}>
      <View style={st.top}>
        <Badge label={s.stateLabel} tone={g.tone} />
        <DemoBadge show={s.isSimulated} />
      </View>
      <Text style={[st.title, { color: t.fg }]}>{g.title}</Text>
      {g.message ? <Text style={st.msg}>{g.message}</Text> : null}
      <View style={st.facts}>
        <Fact label="Distance" value={fmtDistance(s.lastDistanceM)} />
        <Fact label="Accuracy" value={s.lastAccuracyM == null ? '—' : `±${Math.round(s.lastAccuracyM)} m`} />
        <Fact label="Radius" value={fmtDistance(status.workplace.radiusM)} />
      </View>
      {status.attendance ? <Text style={st.recorded}>✓ Checked in at {fmtTime(status.attendance.recordedAt)}</Text> : null}
    </View>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <View style={st.fact}>
      <Text style={st.factLabel}>{label}</Text>
      <Text style={st.factValue}>{value}</Text>
    </View>
  );
}

const st = StyleSheet.create({
  card: { borderWidth: 1.5, borderRadius: radius.lg, padding: space.lg, gap: space.sm },
  top: { flexDirection: 'row', gap: space.sm, alignItems: 'center' },
  title: { fontSize: font.xl, fontWeight: '800' },
  msg: { fontSize: font.md, color: colors.text, lineHeight: 22 },
  facts: { flexDirection: 'row', gap: space.sm, marginTop: space.xs },
  fact: { flex: 1, backgroundColor: colors.white, borderRadius: radius.sm, padding: space.sm },
  factLabel: { fontSize: 12, color: colors.textMuted },
  factValue: { fontSize: font.lg, fontWeight: '700', color: colors.text },
  recorded: { fontSize: font.sm, color: colors.success, fontWeight: '700' },
});
