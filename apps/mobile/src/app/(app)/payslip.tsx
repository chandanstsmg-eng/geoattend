/** One approved payslip, with a share button (WhatsApp, e-mail…). */
import { useLocalSearchParams } from 'expo-router';
import { Share, StyleSheet, Text, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { Badge, Button, Card, ErrorState, H2, Loading, Muted, Row, Screen } from '../../components/ui';
import { api, errorMessage } from '../../lib/api/client';
import type { Payslip } from '../../lib/api/types';
import { ADJUSTMENT_LABEL, inr, monthName } from '../../lib/money';
import { colors, space } from '../../lib/theme';

export default function PayslipScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const q = useQuery({ queryKey: ['me', 'payslip', id], queryFn: () => api<Payslip>(`/me/payslips/${id}`), enabled: !!id });
  if (q.isPending) return <Loading label="Loading payslip…" />;
  if (!q.data) return <Screen><ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} /></Screen>;
  const p = q.data;
  const { attendance: a, result: r, adjustments } = p.data;

  const share = () => {
    const lines = [
      `${p.company_name} — payslip for ${monthName(p.month)}`,
      `${p.data.employee.fullName} (${p.data.employee.employeeCode})`,
      `Present ${a.present} · paid leave ${a.paidLeave} · unpaid leave ${a.unpaidLeave} · holidays ${a.holidays} · absent ${a.absent}`,
      `Basic ${inr(r.basic)}`,
      r.lossOfPay ? `Loss of pay −${inr(r.lossOfPay)}` : '',
      r.overtimePay ? `Overtime +${inr(r.overtimePay)}` : '',
      ...adjustments.map((x) => `${ADJUSTMENT_LABEL[x.kind]} ${x.kind === 'ADVANCE' || x.kind === 'DEDUCTION' ? '−' : '+'}${inr(x.amount)}`),
      `Net pay ${inr(r.net)}`,
    ].filter(Boolean);
    void Share.share({ message: lines.join('\n') });
  };

  return (
    <Screen>
      <Card>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
          <H2>{monthName(p.month)}</H2>
          <Badge label={p.status === 'PAID' ? 'Paid' : 'Approved'} tone={p.status === 'PAID' ? 'success' : 'info'} />
        </View>
        <Muted>{p.company_name}</Muted>
        <Text style={st.net}>{inr(r.net)}</Text>
        <Muted>Net pay</Muted>
      </Card>
      <Card>
        <H2>Attendance</H2>
        <Row label="Days in month" value={a.daysInMonth} />
        <Row label="Present" value={a.present} />
        <Row label="Paid leave" value={a.paidLeave} />
        <Row label="Unpaid leave" value={a.unpaidLeave} />
        <Row label="Holidays" value={a.holidays} />
        <Row label="Absent" value={a.absent} />
        <Row label="Overtime" value={`${r.overtimeHours} h`} />
      </Card>
      <Card>
        <H2>Pay</H2>
        <Row label="Basic" value={inr(r.basic)} />
        {r.lossOfPay ? <Row label={`Loss of pay (${r.lossOfPayDays} day${r.lossOfPayDays === 1 ? '' : 's'})`} value={`−${inr(r.lossOfPay)}`} /> : null}
        {r.overtimePay ? <Row label="Overtime" value={`+${inr(r.overtimePay)}`} /> : null}
        {adjustments.map((x) => (
          <Row key={x.id} label={`${ADJUSTMENT_LABEL[x.kind]}${x.note ? ` (${x.note})` : ''}`} value={`${x.kind === 'ADVANCE' || x.kind === 'DEDUCTION' ? '−' : '+'}${inr(x.amount)}`} />
        ))}
        <Row label="Net pay" value={inr(r.net)} strong />
        {r.carryForward > 0 ? <Muted>{inr(r.carryForward)} of your advance will be recovered next month.</Muted> : null}
      </Card>
      <Button title="Share payslip" variant="secondary" onPress={share} />
    </Screen>
  );
}

const st = StyleSheet.create({ net: { fontSize: 34, fontWeight: '800', color: colors.navy, marginTop: space.sm } });
