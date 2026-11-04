/** Leave: apply in a few taps (type → first day → number of days → reason) and see answers. */
import { useMemo, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { Badge, Button, Card, ErrorState, Field, H2, Loading, Muted, Screen } from '../../../components/ui';
import { api, errorMessage } from '../../../lib/api/client';
import type { LeaveRequest, LeaveStatus, LeaveType } from '../../../lib/api/types';
import { fmtDate } from '../../../lib/format';
import { useAssignment } from '../../../lib/hooks';
import { qk, queryClient } from '../../../lib/queryClient';
import { colors, font, radius, space, type Tone } from '../../../lib/theme';

const TYPES: Array<{ value: LeaveType; label: string }> = [
  { value: 'CASUAL', label: 'Casual' },
  { value: 'SICK', label: 'Sick' },
  { value: 'EARNED', label: 'Earned' },
  { value: 'UNPAID', label: 'Unpaid' },
  { value: 'OTHER', label: 'Other' },
];
const TYPE_LABEL = Object.fromEntries(TYPES.map((t) => [t.value, `${t.label} leave`])) as Record<LeaveType, string>;
const STATUS: Record<LeaveStatus, { label: string; tone: Tone }> = {
  PENDING: { label: 'Waiting', tone: 'warning' },
  APPROVED: { label: 'Approved', tone: 'success' },
  REJECTED: { label: 'Not approved', tone: 'danger' },
  CANCELLED: { label: 'Cancelled', tone: 'neutral' },
};

/** Local calendar date as YYYY-MM-DD (not UTC — "today" must match the phone's day). */
function iso(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function addDays(d: Date, n: number) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

export default function LeaveScreen() {
  const list = useQuery({ queryKey: qk.leave, queryFn: () => api<LeaveRequest[]>('/leave/mine') });
  const assignment = useAssignment();
  const today = useMemo(() => new Date(), []);
  const days = useMemo(() => Array.from({ length: 33 }, (_, i) => addDays(today, i - 2)), [today]); // 2 days back … 30 ahead

  const [type, setType] = useState<LeaveType>('CASUAL');
  const [start, setStart] = useState(iso(today));
  const [count, setCount] = useState(1);
  const [halfDay, setHalfDay] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const startDate = new Date(`${start}T12:00:00`);
  const end = iso(addDays(startDate, count - 1));
  const summary = `${TYPE_LABEL[type]} · ${fmtDate(start)}${count > 1 ? ` – ${fmtDate(end)}` : ''} · ${halfDay ? 'half day' : `${count} day${count === 1 ? '' : 's'}`}`;

  const refresh = () => void list.refetch();
  const submit = async () => {
    if (reason.trim().length < 3) {
      setError('Please write a short reason (at least 3 characters).');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api('/leave/mine', { method: 'POST', body: { leaveType: type, startDate: start, endDate: halfDay ? start : end, halfDay, reason: reason.trim() } });
      setReason('');
      setCount(1);
      setHalfDay(false);
      void queryClient.invalidateQueries({ queryKey: qk.leave });
      Alert.alert('Leave request sent', 'Your administrator has been notified. You will see the answer here.');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const cancel = (l: LeaveRequest) =>
    Alert.alert(l.status === 'PENDING' ? 'Withdraw this request?' : 'Cancel this approved leave?', `${TYPE_LABEL[l.leave_type]}, ${fmtDate(l.start_date)}`, [
      { text: 'Keep', style: 'cancel' },
      {
        text: l.status === 'PENDING' ? 'Withdraw' : 'Cancel leave',
        style: 'destructive',
        onPress: async () => {
          try {
            await api(`/leave/mine/${l.id}/cancel`, { method: 'POST' });
            void queryClient.invalidateQueries({ queryKey: qk.leave });
            void queryClient.invalidateQueries({ queryKey: qk.assignment });
          } catch (e) {
            Alert.alert('Could not cancel', errorMessage(e));
          }
        },
      },
    ]);

  if (list.isPending) return <Loading label="Loading leave…" />;
  const todayIso = iso(today);

  return (
    <Screen onRefresh={refresh} refreshing={list.isFetching}>
      <Card>
        <H2>Apply for leave</H2>

        <Text style={st.label}>Type</Text>
        <View style={st.wrap}>
          {TYPES.map((t) => (
            <Chip key={t.value} label={t.label} selected={type === t.value} onPress={() => setType(t.value)} />
          ))}
        </View>

        <Text style={st.label}>First day</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.sm }}>
          {days.map((d) => {
            const v = iso(d);
            const rel = v === todayIso ? 'Today' : v === iso(addDays(today, 1)) ? 'Tomorrow' : v === iso(addDays(today, -1)) ? 'Yesterday' : d.toLocaleDateString(undefined, { weekday: 'short' });
            return (
              <Pressable
                key={v}
                onPress={() => setStart(v)}
                accessibilityRole="button"
                accessibilityState={{ selected: start === v }}
                accessibilityLabel={`${rel}, ${d.toLocaleDateString(undefined, { day: 'numeric', month: 'long' })}`}
                style={[st.day, start === v && st.daySel]}
              >
                <Text style={[st.dayTop, start === v && st.selText]}>{rel}</Text>
                <Text style={[st.dayNum, start === v && st.selText]}>{d.getDate()}</Text>
                <Text style={[st.dayTop, start === v && st.selText]}>{d.toLocaleDateString(undefined, { month: 'short' })}</Text>
              </Pressable>
            );
          })}
        </ScrollView>

        <Text style={st.label}>How long</Text>
        <View style={[st.wrap, { alignItems: 'center' }]}>
          <Chip label="Half day" selected={halfDay} onPress={() => { setHalfDay(true); setCount(1); }} />
          <Chip label="Full day(s)" selected={!halfDay} onPress={() => setHalfDay(false)} />
          {!halfDay ? (
            <View style={st.stepper}>
              <StepButton label="−" onPress={() => setCount(Math.max(1, count - 1))} accessibilityLabel="One day fewer" />
              <Text style={st.count} accessibilityLabel={`${count} days`}>{count}</Text>
              <StepButton label="+" onPress={() => setCount(Math.min(60, count + 1))} accessibilityLabel="One day more" />
            </View>
          ) : null}
        </View>

        <Field label="Reason" value={reason} onChangeText={setReason} maxLength={1000} placeholder="e.g. fever, family function" error={error} />
        <Muted>{summary}</Muted>
        <Button title="Send request" onPress={submit} loading={busy} />
      </Card>

      {assignment.data?.holidays?.length ? (
        <Card>
          <H2>Upcoming holidays</H2>
          {assignment.data.holidays.map((h) => (
            <View key={h.holiday_date} style={st.holiday}>
              <Text style={st.itemTitle}>{h.name}</Text>
              <Muted>{fmtDate(h.holiday_date)}</Muted>
            </View>
          ))}
        </Card>
      ) : null}

      {list.isError && !list.data ? <ErrorState message={errorMessage(list.error)} onRetry={refresh} /> : null}
      {list.data?.length ? (
        <Card>
          <H2>Your requests</H2>
          {list.data.map((l) => {
            const s = STATUS[l.status];
            const cancellable = l.status === 'PENDING' || (l.status === 'APPROVED' && l.start_date > todayIso);
            return (
              <View key={l.id} style={st.item}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
                  <Text style={st.itemTitle}>{TYPE_LABEL[l.leave_type]}</Text>
                  <Badge label={s.label} tone={s.tone} />
                </View>
                <Text style={st.itemDates}>
                  {fmtDate(l.start_date)}
                  {l.end_date !== l.start_date ? ` – ${fmtDate(l.end_date)}` : ''} · {l.half_day ? 'half day' : `${l.days} day${l.days === 1 ? '' : 's'}`}
                </Text>
                <Muted>
                  {l.requested_by !== l.employee_id ? 'Recorded by your administrator' : `“${l.reason}”`}
                  {l.decision_note && l.requested_by === l.employee_id ? `\nAnswer: ${l.decision_note}` : ''}
                </Muted>
                {cancellable ? <Button title={l.status === 'PENDING' ? 'Withdraw request' : 'Cancel leave'} variant="ghost" onPress={() => cancel(l)} /> : null}
              </View>
            );
          })}
        </Card>
      ) : null}
    </Screen>
  );
}

function Chip({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityState={{ selected }} style={[st.chip, selected && st.chipSel]}>
      <Text style={[st.chipText, selected && st.selText]}>{label}</Text>
    </Pressable>
  );
}

function StepButton({ label, onPress, accessibilityLabel }: { label: string; onPress: () => void; accessibilityLabel: string }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={accessibilityLabel} style={({ pressed }) => [st.step, pressed && { opacity: 0.7 }]}>
      <Text style={st.stepText}>{label}</Text>
    </Pressable>
  );
}

const st = StyleSheet.create({
  label: { fontSize: font.sm, fontWeight: '600', color: colors.text, marginTop: space.sm },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  chip: { minHeight: 44, paddingHorizontal: space.lg, borderRadius: 999, borderWidth: 1.5, borderColor: colors.border, backgroundColor: colors.white, justifyContent: 'center' },
  chipSel: { backgroundColor: colors.navy, borderColor: colors.navy },
  chipText: { fontSize: font.md, fontWeight: '600', color: colors.text },
  selText: { color: colors.white },
  day: { width: 72, paddingVertical: space.sm, borderRadius: radius.md, borderWidth: 1.5, borderColor: colors.border, backgroundColor: colors.white, alignItems: 'center' },
  daySel: { backgroundColor: colors.orange, borderColor: colors.orange },
  dayTop: { fontSize: 12, color: colors.textMuted, fontWeight: '600' },
  dayNum: { fontSize: font.xl, fontWeight: '800', color: colors.navy },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginLeft: 'auto' },
  step: { width: 48, height: 48, borderRadius: 24, borderWidth: 1.5, borderColor: colors.navy, alignItems: 'center', justifyContent: 'center' },
  stepText: { fontSize: 24, fontWeight: '700', color: colors.navy, lineHeight: 26 },
  count: { minWidth: 32, textAlign: 'center', fontSize: font.xl, fontWeight: '800', color: colors.navy },
  item: { paddingVertical: space.sm, borderTopWidth: 1, borderTopColor: colors.border, gap: 2 },
  itemTitle: { fontSize: font.md, fontWeight: '700', color: colors.text },
  itemDates: { fontSize: font.md, color: colors.text },
  holiday: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: space.sm, borderTopWidth: 1, borderTopColor: colors.border },
});
