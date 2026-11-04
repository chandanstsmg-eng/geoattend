/** My earnings: this month so far (an estimate) and approved payslips. */
import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { Badge, Card, ErrorState, H2, Loading, Muted, Row, Screen } from '../../components/ui';
import { api, errorMessage } from '../../lib/api/client';
import type { Earnings } from '../../lib/api/types';
import { ADJUSTMENT_LABEL, inr, monthName } from '../../lib/money';
import { qk } from '../../lib/queryClient';
import { colors, font, space } from '../../lib/theme';

export default function EarningsScreen() {
  const q = useQuery({ queryKey: qk.earnings, queryFn: () => api<Earnings>('/me/earnings') });
  if (q.isPending) return <Loading label="Loading earnings…" />;
  if (!q.data) return <Screen><ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} /></Screen>;
  const { estimate: e, payslips, month } = q.data;

  return (
    <Screen onRefresh={() => void q.refetch()} refreshing={q.isFetching}>
      {e ? (
        <Card>
          <Muted>{monthName(month)} · so far</Muted>
          <Text style={st.big}>{inr(e.result.net)}</Text>
          <Muted>An estimate from your attendance until today. The final amount is on your payslip after your employer approves the month.</Muted>
          <View style={st.grid}>
            {[
              ['Present', e.attendance.present],
              ['Paid leave', e.attendance.paidLeave],
              ['Absent', e.attendance.absent],
              ['Overtime h', +(e.attendance.overtimeMinutes / 60).toFixed(1)],
            ].map(([l, v]) => (
              <View key={l as string} style={st.cell}>
                <Text style={st.cellValue}>{v as number}</Text>
                <Text style={st.cellLabel}>{l}</Text>
              </View>
            ))}
          </View>
          {e.result.lossOfPay > 0 ? <Row label={`Cut for ${e.result.lossOfPayDays} absent / unpaid day(s)`} value={`−${inr(e.result.lossOfPay)}`} /> : null}
          {e.result.overtimePay > 0 ? <Row label="Overtime" value={`+${inr(e.result.overtimePay)}`} /> : null}
          {e.adjustments.map((a) => (
            <Row key={a.id} label={`${ADJUSTMENT_LABEL[a.kind]}${a.note ? ` (${a.note})` : ''}`} value={`${a.kind === 'ADVANCE' || a.kind === 'DEDUCTION' ? '−' : '+'}${inr(a.amount)}`} />
          ))}
        </Card>
      ) : (
        <Card>
          <H2>No estimate for this month</H2>
          <Muted>Your employer has not set your pay in GeoAttend yet, or this month is already approved — see your payslips below.</Muted>
        </Card>
      )}

      <Card>
        <H2>Payslips</H2>
        {payslips.length === 0 ? <Muted>Payslips appear here after your employer approves a month.</Muted> : null}
        {payslips.map((p) => (
          <Pressable
            key={p.id}
            onPress={() => router.push({ pathname: '/payslip', params: { id: p.id } })}
            accessibilityRole="button"
            accessibilityLabel={`Payslip for ${monthName(p.month)}, ${inr(p.net_amount)}`}
            style={({ pressed }) => [st.slip, pressed && { backgroundColor: colors.navySoft }]}
          >
            <View style={{ flex: 1 }}>
              <Text style={st.slipMonth}>{monthName(p.month)}</Text>
              <Text style={st.slipNet}>{inr(p.net_amount)}</Text>
            </View>
            <Badge label={p.status === 'PAID' ? 'Paid' : 'Approved'} tone={p.status === 'PAID' ? 'success' : 'info'} />
            <Text style={st.chev}>›</Text>
          </Pressable>
        ))}
      </Card>
    </Screen>
  );
}

const st = StyleSheet.create({
  big: { fontSize: 34, fontWeight: '800', color: colors.navy },
  grid: { flexDirection: 'row', gap: space.sm, marginVertical: space.sm },
  cell: { flex: 1, backgroundColor: colors.navySoft, borderRadius: 10, paddingVertical: space.sm, alignItems: 'center' },
  cellValue: { fontSize: font.xl, fontWeight: '800', color: colors.navy },
  cellLabel: { fontSize: 11, color: colors.textMuted },
  slip: { flexDirection: 'row', alignItems: 'center', gap: space.sm, minHeight: 56, paddingVertical: space.sm, borderTopWidth: 1, borderTopColor: colors.border },
  slipMonth: { fontSize: font.md, fontWeight: '700', color: colors.text },
  slipNet: { fontSize: font.sm, color: colors.textMuted },
  chev: { fontSize: 24, color: colors.textFaint },
});
