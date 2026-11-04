/** Screen 17: attendance history (/me/attendance) with a dispute action per record. */
import { useState } from 'react';
import { Alert, StyleSheet, Text, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { Badge, Button, Card, DemoBadge, ErrorState, H2, Loading, Muted, ReasonModal, Screen } from '../../../components/ui';
import { api, errorMessage } from '../../../lib/api/client';
import type { AttendanceHistory, AttendanceHistoryItem, ReviewItem } from '../../../lib/api/types';
import { fmtDate, fmtDateTime, fmtDistance, fmtTime } from '../../../lib/format';
import { qk, queryClient } from '../../../lib/queryClient';
import { stateLabel } from '../../../lib/states';
import { colors, font, space, type Tone } from '../../../lib/theme';

const hm = (m: number) => (m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`);

const STATUS_TONE: Record<string, Tone> = { VERIFIED: 'success', MANUAL_APPROVED: 'success', CORRECTED: 'info', DISPUTED: 'warning', VOIDED: 'danger' };

/** Overtime after the shift and where its approval stands (only approved overtime is paid). */
function OvertimeBadge({ a }: { a: AttendanceHistoryItem }) {
  const worked = a.overtime_claimed_minutes ?? 0;
  switch (a.overtime_status) {
    case 'RUNNING':
      return <Badge label={`On overtime · ${hm(worked)}`} tone="info" />;
    case 'PENDING':
      return <Badge label={`+${hm(worked)} overtime · waiting approval`} tone="warning" />;
    case 'REJECTED':
      return <Badge label={`${hm(worked)} overtime not approved`} tone="danger" />;
    case 'APPROVED':
      return <Badge label={`+${hm(a.overtime_minutes)} overtime approved`} tone="success" />;
    default:
      return null;
  }
}

export default function HistoryScreen() {
  const history = useQuery({ queryKey: qk.history, queryFn: () => api<AttendanceHistory>('/me/attendance?limit=60') });
  const reviews = useQuery({ queryKey: qk.reviews, queryFn: () => api<ReviewItem[]>('/me/reviews') });
  const [disputing, setDisputing] = useState<AttendanceHistoryItem | null>(null);
  const refresh = () => {
    void history.refetch();
    void reviews.refetch();
  };

  if (history.isPending) return <Loading label="Loading history…" />;
  if (!history.data) return <Screen><ErrorState message={errorMessage(history.error)} onRetry={refresh} /></Screen>;
  const { attendance, sessions } = history.data;
  const openDisputes = new Set((reviews.data ?? []).filter((r) => r.kind === 'DISPUTE' && r.status === 'OPEN').map((r) => r.attendance_id));
  const attendedSessionDates = new Set(attendance.map((a) => `${a.shift_date}|${a.shift_name}`));
  const missed = sessions.filter((s) => s.ended_at && !attendedSessionDates.has(`${s.shift_date}|${s.shift_name}`));

  return (
    <Screen onRefresh={refresh} refreshing={history.isFetching}>
      {attendance.length === 0 ? (
        <Card>
          <H2>No attendance yet</H2>
          <Muted>Records appear here after the server confirms your attendance.</Muted>
        </Card>
      ) : null}
      {attendance.map((a) => (
        <Card key={a.id}>
          <View style={st.head}>
            <View style={{ flex: 1 }}>
              <Text style={st.date}>{fmtDate(a.shift_date)}</Text>
              <Muted>
                {a.shift_name} · {a.workplace_name}
              </Muted>
            </View>
            <DemoBadge show={a.is_simulated} />
            <Badge label={a.verification_status} tone={STATUS_TONE[a.verification_status] ?? 'neutral'} />
          </View>
          <Text style={st.time}>Recorded at {fmtTime(a.recorded_at)}</Text>
          <Muted>
            {a.is_late ? `Late by ${a.late_by_minutes} min` : 'On time'}
            {a.evidence_distance_m != null ? ` · ${fmtDistance(a.evidence_distance_m)} from centre` : ''}
            {a.evidence_accuracy_m != null ? ` (±${Math.round(a.evidence_accuracy_m)} m)` : ''}
            {a.away_minutes > 0 ? ` · away ${a.away_minutes} min` : ''}
          </Muted>
          {a.worked_minutes != null ? (
            <View style={st.worked}>
              <Text style={st.workedText}>
                Worked {hm(a.worked_minutes)}
                {a.in_progress ? ' so far' : ''}
              </Text>
              <OvertimeBadge a={a} />
              {a.left_early ? <Badge label="Left early" tone="warning" /> : null}
            </View>
          ) : null}
          {a.verification_status === 'DISPUTED' || openDisputes.has(a.id) ? (
            <Muted>Dispute submitted — your administrator will review it.</Muted>
          ) : a.verification_status !== 'VOIDED' ? (
            <Button title="Dispute this record" variant="ghost" onPress={() => setDisputing(a)} accessibilityHint="Ask your administrator to review this record" />
          ) : null}
        </Card>
      ))}

      {missed.length ? (
        <Card>
          <H2>Shifts without attendance</H2>
          {missed.map((s) => (
            <View key={s.id} style={st.missed}>
              <Text style={st.missedText}>
                {fmtDate(s.shift_date)} · {s.shift_name}
              </Text>
              <Muted>
                {stateLabel(s.state)} · ended {fmtDateTime(s.ended_at)}
                {s.termination_reason ? ` · ${s.termination_reason}` : ''}
              </Muted>
            </View>
          ))}
        </Card>
      ) : null}

      {reviews.data && reviews.data.length ? (
        <Card>
          <H2>Your requests</H2>
          {reviews.data.map((r) => (
            <View key={r.id} style={st.missed}>
              <View style={{ flexDirection: 'row', gap: space.sm, alignItems: 'center' }}>
                <Badge label={r.kind.replace('_', ' ')} />
                <Badge label={r.status} tone={r.status === 'OPEN' ? 'warning' : r.status === 'APPROVED' ? 'success' : r.status === 'REJECTED' ? 'danger' : 'neutral'} />
              </View>
              <Text style={st.missedText}>{r.reason}</Text>
              <Muted>
                {fmtDateTime(r.created_at)}
                {r.resolution_note ? ` · ${r.resolution_note}` : ''}
              </Muted>
            </View>
          ))}
        </Card>
      ) : null}

      <ReasonModal
        visible={disputing !== null}
        title="Dispute attendance record"
        description={disputing ? `${fmtDate(disputing.shift_date)} · ${disputing.shift_name}, recorded at ${fmtTime(disputing.recorded_at)}. Explain what is wrong.` : ''}
        submitLabel="Send dispute"
        onCancel={() => setDisputing(null)}
        onSubmit={async (reason) => {
          if (!disputing) return;
          await api('/me/issues', { method: 'POST', body: { kind: 'DISPUTE', attendanceId: disputing.id, reason } });
          setDisputing(null);
          void queryClient.invalidateQueries({ queryKey: qk.history });
          void queryClient.invalidateQueries({ queryKey: qk.reviews });
          Alert.alert('Dispute sent', 'Your administrator has been notified.');
        }}
      />
    </Screen>
  );
}

const st = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  date: { fontSize: font.lg, fontWeight: '700', color: colors.navy },
  time: { fontSize: font.md, fontWeight: '600', color: colors.text },
  worked: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space.sm },
  workedText: { fontSize: font.md, fontWeight: '600', color: colors.navy },
  missed: { paddingVertical: space.sm, borderTopWidth: 1, borderTopColor: colors.border, gap: 2 },
  missedText: { fontSize: font.md, color: colors.text },
});
