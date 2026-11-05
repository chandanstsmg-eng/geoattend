import { router, useLocalSearchParams } from 'expo-router';
import { Banner, Body, Button, Card, ErrorState, H2, Loading, Muted, Row, Screen } from '../../components/ui';
import { errorMessage } from '../../lib/api/client';
import { fmtDate, fmtDateTime, fmtDays, fmtTime, localISODate } from '../../lib/format';
import { startShift } from '../../lib/start-shift';
import { useAssignment, useStatus } from '../../lib/hooks';

export default function ShiftDetailsScreen() {
  const { shiftId } = useLocalSearchParams<{ shiftId?: string }>();
  const assignment = useAssignment();
  const statusQ = useStatus();
  if (assignment.isPending) return <Loading />;
  if (!assignment.data) return <Screen><ErrorState message={errorMessage(assignment.error)} onRetry={() => assignment.refetch()} /></Screen>;
  const a = assignment.data;
  const shift = a.shifts.find((s) => s.id === shiftId) ?? a.shifts[0];
  if (!shift) {
    return (
      <Screen>
        <Card tone="warning">
          <H2>No shift assigned</H2>
          <Body>Contact your administrator.</Body>
        </Card>
      </Screen>
    );
  }
  const open = statusQ.data && statusQ.data.session.shiftId === shift.id ? statusQ.data : null;
  const cur = shift.current;
  // The roster entry covering today (else the next one): who manages it and what to work on.
  const today = localISODate();
  const range = shift.ranges.find((r) => String(r.from).slice(0, 10) <= today && (!r.to || String(r.to).slice(0, 10) >= today)) ?? shift.ranges.find((r) => String(r.from).slice(0, 10) > today);

  return (
    <Screen onRefresh={() => void assignment.refetch()} refreshing={assignment.isFetching}>
      <Card>
        <H2>{shift.name}</H2>
        <Row label="Time" value={`${shift.startTime}–${shift.endTime}`} strong />
        <Row label="Days" value={fmtDays(shift.daysOfWeek)} />
        <Row label="Time zone" value={shift.timezone} />
        <Row label="Arrival grace" value={`${shift.arrivalGraceMinutes} min`} />
        {shift.absenceThresholdMinutes != null ? <Row label="Absence alert after" value={`${shift.absenceThresholdMinutes} min away`} /> : null}
        {a.workplace ? <Row label="Workspace" value={a.workplace.name} /> : null}
        {a.supervisor ? <Row label="Supervisor" value={a.supervisor.phone ? `${a.supervisor.fullName} · ${a.supervisor.phone}` : a.supervisor.fullName} /> : range?.managerName ? <Row label="Manager" value={range.managerName} /> : null}
        {range?.notes ? <Row label="Assigned work" value={range.notes} /> : null}
        {!shift.isActive ? <Banner tone="warning" title="This shift is not active for your current workplace" /> : null}
      </Card>

      <Card>
        <H2>Today</H2>
        {cur ? (
          <>
            <Row label="Shift date" value={fmtDate(cur.shiftDate)} />
            <Row label="Starts" value={fmtTime(cur.startsAt)} />
            <Row label="Ends" value={fmtTime(cur.endsAt)} />
            <Row label="Tracking allowed" value={`${fmtTime(cur.windowOpensAt)}–${fmtTime(cur.windowClosesAt)}`} />
            <Row label="Status" value={cur.completed ? 'Completed' : open ? open.session.stateLabel : 'Not started'} strong />
            {open?.attendance ? <Row label="Attendance recorded" value={fmtTime(open.attendance.recordedAt)} /> : null}
          </>
        ) : (
          <Muted>The shift window is not open right now.</Muted>
        )}
        {shift.next ? <Muted>Next window: {fmtDateTime(shift.next.windowOpensAt)} to {fmtDateTime(shift.next.windowClosesAt)}</Muted> : null}
      </Card>

      <Muted>Location is only collected between the time you tap “Start shift” and the end of the tracking window above (or when you end the shift, whichever is first).</Muted>

      {open ? (
        <Button title="Open live shift" onPress={() => router.push('/shift')} />
      ) : cur && !cur.completed && shift.isActive ? (
        <Button
          title="Start shift"
          onPress={() =>
            startShift(a, shift.id)
          }
        />
      ) : null}
    </Screen>
  );
}
