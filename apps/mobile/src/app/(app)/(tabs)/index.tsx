import { useCallback, useState } from 'react';
import { router, useFocusEffect } from 'expo-router';
import { runPhoneChecks } from '../../../lib/phone-health';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../../lib/api/client';
import type { AttendanceHistory, Earnings, Task } from '../../../lib/api/types';
import { attendanceStatus, hoursMinutes, recordForToday } from '../../../lib/attendance-status';
import { inr } from '../../../lib/money';
import { qk } from '../../../lib/queryClient';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { StatusCard } from '../../../components/StatusCard';
import { SyncBanner } from '../../../components/SyncStatus';
import { TrackingBanners, TrackingStrip } from '../../../components/TrackingBanners';
import { Badge, Banner, Body, Button, Card, DemoBadge, ErrorState, H2, Loading, Muted, Row, Screen } from '../../../components/ui';
import { errorMessage } from '../../../lib/api/client';
import type { ShiftView } from '../../../lib/api/types';
import { useAuth } from '../../../lib/auth';
import { fmtDate, fmtDays, fmtTime, localISODate } from '../../../lib/format';
import { useAssignment, useStatus, useTrackingSnapshot } from '../../../lib/hooks';
import { colors, font, space } from '../../../lib/theme';
import { startShift } from '../../../lib/start-shift';


export default function HomeScreen() {
  const { user } = useAuth();
  const assignment = useAssignment();
  const statusQ = useStatus({ poll: true });
  const snap = useTrackingSnapshot();
  const earnings = useQuery({ queryKey: qk.earnings, queryFn: () => api<Earnings>('/me/earnings'), staleTime: 5 * 60_000 });
  const tasks = useQuery({ queryKey: qk.tasks, queryFn: () => api<Task[]>('/tasks/mine') });
  const tasksToDo = (tasks.data ?? []).filter((t) => t.status === 'OPEN' || t.status === 'REOPENED').length;
  const messages = useQuery({ queryKey: ['me', 'messages'], queryFn: () => api<Array<{ read_at: string | null }>>('/broadcasts/mine') });
  const unreadMessages = (messages.data ?? []).filter((m) => !m.read_at).length;
  const history = useQuery({ queryKey: qk.history, queryFn: () => api<AttendanceHistory>('/me/attendance?limit=60') });
  const [phoneIssues, setPhoneIssues] = useState<{ fail: number; warn: number } | null>(null);
  useFocusEffect(
    useCallback(() => {
      void runPhoneChecks().then((c) => {
        const fail = c.filter((x) => x.level === 'fail').length;
        // Expo Go's "screen off" limitation is expected while testing; do not nag about it on Home.
        const warn = c.filter((x) => x.level === 'warn' && x.key !== 'background').length;
        setPhoneIssues(fail || warn ? { fail, warn } : null);
      });
    }, []),
  );
  // Only a pull shows the spinner: tying it to the 15-second poll made the screen flicker.
  const [refreshing, setRefreshing] = useState(false);
  const refresh = () => {
    setRefreshing(true);
    void Promise.allSettled([assignment.refetch(), statusQ.refetch(), tasks.refetch(), messages.refetch(), earnings.refetch(), history.refetch()]).finally(() => setRefreshing(false));
  };

  if (assignment.isPending) return <Loading label="Loading your assignment…" />;
  if (assignment.isError && !assignment.data) {
    return (
      <Screen onRefresh={refresh} refreshing={refreshing}>
        <ErrorState message={errorMessage(assignment.error)} onRetry={refresh} />
        {/* Help must not depend on a connection. The shift screen stays out of reach here: without the assignment it cannot apply the selfie rules. */}
        <Button title="SOS — get help" variant="danger" onPress={() => router.push('/sos')} accessibilityHint="Opens emergency help" />
      </Screen>
    );
  }
  const a = assignment.data!;
  // Prefer the live status query; fall back to the assignment's snapshot while it loads.
  const status = statusQ.data !== undefined ? statusQ.data : a.openSession && a.openSession.tracking.shouldTrack ? a.openSession : null;
  const activeShifts = a.shifts.filter((s) => s.isActive);
  const now = new Date();
  const localToday = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const holidayToday = (a.holidays ?? []).find((h) => h.holiday_date === localToday);
  const startable = activeShifts.find((s) => s.current && !s.current.completed);
  const completedToday = activeShifts.find((s) => s.current?.completed);
  const upcoming = activeShifts
    .filter((s) => s.next)
    .sort((x, y) => Date.parse(x.next!.windowOpensAt) - Date.parse(y.next!.windowOpensAt))[0];

  return (
    <Screen onRefresh={refresh} refreshing={refreshing}>
      <View style={st.hello}>
        <View style={{ flex: 1 }}>
          <Text style={st.helloName}>Hello, {a.employee.fullName.split(' ')[0]}</Text>
          <Muted>{[a.employee.employeeCode, a.employee.designation].filter(Boolean).join(' · ') || a.employee.email}</Muted>
        </View>
        <DemoBadge show={a.employee.isDemo || user?.isDemo} />
        <Pressable onPress={() => router.push('/sos')} accessibilityRole="button" accessibilityLabel="SOS — get help" style={({ pressed }) => [st.sos, pressed && { opacity: 0.8 }]}>
          <Text style={st.sosText}>SOS</Text>
        </Pressable>
      </View>
      {unreadMessages ? (
        <Banner tone="info" title={`${unreadMessages} new announcement${unreadMessages > 1 ? 's' : ''}`} actionLabel="Read" onPress={() => router.push('/messages')} />
      ) : null}

      {user?.mustChangePassword ? (
        <Banner tone="warning" title="Change your temporary password" actionLabel="Change" onPress={() => router.push('/account')} />
      ) : null}
      {statusQ.isError && statusQ.data !== undefined ? <Banner tone="warning" title="Offline — last known status" message="Starting a new shift needs a connection." /> : null}
      <SyncBanner />
      {phoneIssues ? (
        <Banner
          tone={phoneIssues.fail ? 'danger' : 'warning'}
          title={phoneIssues.fail ? 'Phone not ready for attendance' : `${phoneIssues.warn} phone setting${phoneIssues.warn > 1 ? 's' : ''} to fix`}
          actionLabel="Fix now"
          onPress={() => router.push('/phone-check')}
        />
      ) : null}
      {holidayToday && !status ? (
        <Banner tone="success" title={`Holiday today: ${holidayToday.name}`} />
      ) : null}
      {a.leaveToday && !status ? (
        <Banner
          tone="success"
          title={a.leaveToday.half_day ? 'Half-day leave today' : 'You are on leave today'}
          message={a.leaveToday.half_day ? undefined : `Until ${fmtDate(a.leaveToday.end_date)}`}
          actionLabel="View"
          onPress={() => router.push('/leave')}
        />
      ) : null}

      {status ? (
        <>
          <TrackingBanners status={status} />
          <StatusCard status={status} />
          <TrackingStrip status={status} />
          <Button title="Continue shift" onPress={() => router.push('/shift')} accessibilityHint="Opens your live shift screen" />
        </>
      ) : (
        <>
          {snap.meta.stopped && Date.now() - Date.parse(snap.meta.stopped.at) < 12 * 3600_000 ? (
            <Banner tone="info" title="Tracking stopped" message={`${snap.meta.stopped.reason} · ${fmtTime(snap.meta.stopped.at)}`} />
          ) : null}
          {!a.noticeAcknowledged ? (
            <Banner tone="info" title="Accept the privacy notice" actionLabel="Open" onPress={() => router.push('/privacy')} />
          ) : null}
          {a.faceEnrollment?.required && !a.faceEnrollment.enrolled ? (
            <Banner tone="info" title="Set up face photos" actionLabel="Start" onPress={() => router.push('/face-enroll')} />
          ) : null}
          <Card tone="neutral">
            <Badge label="Off shift" />
            <H2>{startable ? 'Ready to start' : completedToday ? 'Shift completed' : 'No shift now'}</H2>
            {startable ? <Body>{`${startable.name} · ${fmtTime(startable.current!.startsAt)}–${fmtTime(startable.current!.endsAt)}`}</Body> : null}
            {!startable && upcoming?.next ? (
              <Muted>
                Next: {upcoming.name} · {fmtDate(upcoming.next.shiftDate)}, {fmtTime(upcoming.next.startsAt)}
              </Muted>
            ) : null}
          </Card>
          {startable ? <Button title="Start shift" onPress={() => startShift(a, startable.id)} accessibilityHint="Explains location tracking, then starts your shift" /> : null}
          {!phoneIssues ? <Button title="Phone check" variant="ghost" onPress={() => router.push('/phone-check')} accessibilityHint="Checks location, GPS, battery and notification settings" /> : null}
        </>
      )}

      <TodayCard records={history.data?.attendance ?? []} />

      {a.workplace ? (
        <Card>
          <View style={st.rowBetween}>
            <H2>{a.workplace.name}</H2>
            <DemoBadge show={a.workplace.isDemo} />
          </View>
          {a.workplace.address ? <Body>{a.workplace.address}</Body> : null}
          {!a.workplace.isActive ? <Banner tone="warning" title="Workplace disabled" /> : null}
          <Button title="View map" variant="secondary" onPress={() => router.push('/map')} />
        </Card>
      ) : (
        <Card tone="warning">
          <H2>Not assigned to a workplace</H2>
          <Body>Contact your administrator to be assigned to a workplace and shift.</Body>
        </Card>
      )}

      <Card>
        <LinkRow title="Announcements" note={unreadMessages ? `${unreadMessages} new` : undefined} onPress={() => router.push('/messages')} />
        <LinkRow title="Tasks" note={tasksToDo ? `${tasksToDo} to do` : undefined} onPress={() => router.push('/tasks')} />
      </Card>

      {earnings.data && (earnings.data.estimate || earnings.data.payslips.length) ? (
        <Pressable onPress={() => router.push('/earnings')} accessibilityRole="button" accessibilityLabel="My earnings" style={({ pressed }) => pressed && { opacity: 0.85 }}>
          <Card>
            <View style={st.rowBetween}>
              <View>
                <Muted>{earnings.data.estimate ? 'Earned so far this month' : 'Latest payslip'}</Muted>
                <Text style={st.money}>{inr(earnings.data.estimate ? earnings.data.estimate.result.net : earnings.data.payslips[0]!.net_amount)}</Text>
              </View>
              <Text style={st.chev}>›</Text>
            </View>
          </Card>
        </Pressable>
      ) : null}

      {a.workplace && activeShifts[0] ? <MyRules shift={startable ?? upcoming ?? activeShifts[0]} radiusM={a.workplace.radiusM} /> : null}

      {activeShifts.length ? (
        <Card>
          <H2>Your shifts</H2>
          {activeShifts.map((s) => (
            <ShiftRow key={s.id} shift={s} />
          ))}
        </Card>
      ) : null}
    </Screen>
  );
}

/** Today at a glance. Hidden until there is a record; a pending one says plainly that it does not count yet. */
function TodayCard({ records }: { records: AttendanceHistory['attendance'] }) {
  const r = recordForToday(records, localISODate());
  if (!r) return null;
  const v = attendanceStatus(r.verification_status);
  return (
    <Card tone={v.counted ? undefined : 'warning'}>
      <View style={st.rowBetween}>
        <H2>Today</H2>
        <Badge label={v.label} tone={v.tone} />
      </View>
      <Row label="Checked in" value={fmtTime(r.recorded_at)} strong />
      {r.worked_minutes != null ? <Row label={r.in_progress ? 'Worked so far' : 'Worked'} value={hoursMinutes(r.worked_minutes)} strong /> : null}
      {r.pending_minutes != null ? <Muted>{hoursMinutes(r.pending_minutes)} waiting for your manager. Not counted yet.</Muted> : null}
    </Card>
  );
}

function LinkRow({ title, note, onPress }: { title: string; note?: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={note ? `${title}, ${note}` : title} style={({ pressed }) => [st.linkRow, pressed && { backgroundColor: colors.navySoft }]}>
      <Text style={st.shiftName}>{title}</Text>
      <View style={st.linkEnd}>
        {note ? <Badge label={note} tone="warning" /> : null}
        <Text style={st.chev}>›</Text>
      </View>
    </Pressable>
  );
}

/** The rules that decide "late", "away" and "present" — in plain words, so nobody is surprised. */
function MyRules({ shift, radiusM }: { shift: ShiftView; radiusM: number }) {
  const [h, m] = shift.startTime.split(':').map(Number);
  const by = new Date(2000, 0, 1, h, m + (shift.arrivalGraceMinutes ?? 0));
  const arriveBy = `${String(by.getHours()).padStart(2, '0')}:${String(by.getMinutes()).padStart(2, '0')}`;
  return (
    <Card>
      <H2>My rules</H2>
      <Row label="Arrive by" value={arriveBy} strong />
      <Row label="Attendance area" value={`${Math.round(radiusM)} m`} strong />
      {shift.absenceThresholdMinutes ? <Row label="Step out up to" value={`${shift.absenceThresholdMinutes} min`} strong /> : null}
    </Card>
  );
}

/** "30 Oct", "30 Oct – 5 Nov" or "from 30 Oct" for the rostered dates that matter now; null when open-ended from the past. */
function rosterDates(shift: ShiftView): string | null {
  const today = localISODate();
  const r = (shift.ranges ?? []).filter((x) => !x.to || x.to >= today).sort((x, y) => x.from.localeCompare(y.from))[0];
  if (!r) return null;
  if (r.to === r.from) return fmtDate(r.from);
  if (r.to) return `${fmtDate(r.from)} – ${fmtDate(r.to)}`;
  return r.from > today ? `from ${fmtDate(r.from)}` : null;
}

function ShiftRow({ shift }: { shift: ShiftView }) {
  const label = shift.current ? (shift.current.completed ? 'Completed' : 'Window open') : shift.next ? `Next ${fmtDate(shift.next.shiftDate)}` : '';
  return (
    <Pressable
      onPress={() => router.push({ pathname: '/shift-details', params: { shiftId: shift.id } })}
      accessibilityRole="button"
      accessibilityLabel={`${shift.name}, ${shift.startTime} to ${shift.endTime}. ${label}. Show details`}
      style={({ pressed }) => [st.shiftRow, pressed && { backgroundColor: colors.navySoft }]}
    >
      <View style={{ flex: 1 }}>
        <Text style={st.shiftName}>{shift.name}</Text>
        <Muted>
          {shift.workplace?.name ? `${shift.workplace.name} · ` : ''}
          {shift.startTime}–{shift.endTime} · {rosterDates(shift) ?? fmtDays(shift.daysOfWeek)}
        </Muted>
      </View>
      <Badge label={label} tone={shift.current && !shift.current.completed ? 'success' : 'neutral'} />
      <Text style={st.chev}>›</Text>
    </Pressable>
  );
}

const st = StyleSheet.create({
  hello: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  helloName: { fontSize: font.xxl, fontWeight: '800', color: colors.navy },
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  shiftRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, minHeight: 56, paddingVertical: space.sm, borderTopWidth: 1, borderTopColor: colors.border },
  shiftName: { fontSize: font.md, fontWeight: '700', color: colors.text },
  chev: { fontSize: 24, color: colors.textFaint },
  money: { fontSize: 28, fontWeight: '800', color: colors.navy },
  linkRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 52 },
  linkEnd: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  sos: { minWidth: 64, height: 48, borderRadius: 24, backgroundColor: colors.danger, alignItems: 'center', justifyContent: 'center', paddingHorizontal: space.md },
  sosText: { color: colors.white, fontWeight: '900', fontSize: font.md, letterSpacing: 1 },
});
