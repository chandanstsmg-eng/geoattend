/**
 * One clear UI component per server state group (screens 8, 9, 10, 13, 14, 15 +
 * permission-required and manual-review). Text comes from the server's guidance;
 * the app never decides eligibility itself.
 */
import { useState } from 'react';
import { Linking, Platform, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import * as Location from 'expo-location';
import type { PermissionReport, SessionStatus } from '../../lib/api/types';
import { fmtAgo, fmtDistance, fmtTime } from '../../lib/format';
import { useNow, useTrackingSnapshot } from '../../lib/hooks';
import { colors, font, radius, space, toneColors, type Tone } from '../../lib/theme';
import { Badge, Body, Button, Card, DemoBadge, Muted, Row } from '../ui';
import { CancelReviewButton, EndBreakButton, FreshFixButton, RequestReviewButton, openCaptureFlow } from './actions';

function Hero({ status, tone, title, children }: { status: SessionStatus; tone?: Tone; title?: string; children?: React.ReactNode }) {
  const g = status.guidance;
  const t = toneColors[tone ?? g.tone];
  return (
    <View style={[st.hero, { backgroundColor: t.bg, borderColor: t.border }]} accessibilityRole="summary">
      <View style={{ flexDirection: 'row', gap: space.sm, alignItems: 'center' }}>
        <Badge label={status.session.stateLabel} tone={tone ?? g.tone} />
        <DemoBadge show={status.session.isSimulated} />
      </View>
      <Text style={[st.heroTitle, { color: t.fg }]}>{title ?? g.title}</Text>
      {g.message ? <Text style={st.heroMsg}>{g.message}</Text> : null}
      {children}
    </View>
  );
}

function BigNumber({ value, caption }: { value: string; caption: string }) {
  return (
    <View style={st.big} accessibilityLabel={`${caption}: ${value}`}>
      <Text style={st.bigValue}>{value}</Text>
      <Text style={st.bigCaption}>{caption}</Text>
    </View>
  );
}

/** Screen 8: outside the geofence / getting a fix / verifying arrival. */
export function OutsideGeofenceView({ status }: { status: SessionStatus }) {
  const s = status.session;
  const verifying = s.state === 'ARRIVAL_CANDIDATE';
  const waiting = s.lastDistanceM == null;
  return (
    <>
      <Hero status={status}>
        {!waiting ? <BigNumber value={fmtDistance(s.lastDistanceM)} caption={`to ${status.workplace.name} · within ${fmtDistance(status.workplace.radiusM)} needed`} /> : null}
      </Hero>
      {!verifying && !waiting ? <Muted center>GPS ±{s.lastAccuracyM == null ? '—' : Math.round(s.lastAccuracyM)} m · {fmtAgo(s.lastLocationAt)}</Muted> : null}
      <Button title="View map" variant="secondary" onPress={() => router.push('/map')} />
    </>
  );
}

/** Screen 9: GPS accuracy insufficient. */
export function AccuracyWarningView({ status }: { status: SessionStatus }) {
  const s = status.session;
  return (
    <>
      <Hero status={status} tone="warning">
        <BigNumber value={s.lastAccuracyM == null ? '—' : `±${Math.round(s.lastAccuracyM)} m`} caption={`GPS accuracy · ±${status.tracking.maxAccuracyM} m needed`} />
      </Hero>
      <Card>
        <Body>• Go near a window or outside{'\n'}• Turn on “Precise location”</Body>
      </Card>
      <FreshFixButton status={status} />
      {status.suggestReview ? (
        <Card tone="warning">
          <Body>At work but GPS stays weak? Ask your manager to check.</Body>
          <RequestReviewButton status={status} variant="primary" />
        </Card>
      ) : null}
    </>
  );
}

/** Screen 10: attendance ready. Camera opens ONLY from this button. */
export function AttendanceReadyView({ status }: { status: SessionStatus }) {
  const [busy, setBusy] = useState(false);
  const pending = status.session.state === 'ATTENDANCE_SUBMISSION_PENDING';
  return (
    <>
      <Hero status={status} tone="success" title="You're at work" />
      {pending ? <Muted>Not recorded yet — take the photo again.</Muted> : null}
      <Button
        title="Take attendance photo"
        loading={busy}
        onPress={async () => {
          setBusy(true);
          try {
            await openCaptureFlow(status);
          } finally {
            setBusy(false);
          }
        }}
        accessibilityHint="Asks for camera permission and opens the camera"
      />
    </>
  );
}

/** Screen 13: live tracking after attendance (PRESENT). */
export function LiveTrackingView({ status }: { status: SessionStatus }) {
  const snap = useTrackingSnapshot();
  const now = useNow(10_000);
  return (
    <>
      <Hero status={status} />
      <Card>
        {status.attendance ? <Row label="Checked in" value={fmtTime(status.attendance.recordedAt)} strong /> : null}
        {status.attendance?.isLate ? <Row label="Late by" value={`${status.attendance.lateByMinutes} min`} /> : null}
        <Row label="Last update" value={status.session.lastLocationAt ? fmtAgo(status.session.lastLocationAt, now) : '—'} />
        {snap.queueLength ? <Row label="Waiting to send" value={String(snap.queueLength)} /> : null}
        <Row label="Shift ends" value={fmtTime(status.session.scheduledEndAt)} />
      </Card>
    </>
  );
}

/** Screen 14: temporary / prolonged absence. */
export function AbsenceView({ status }: { status: SessionStatus }) {
  const now = useNow(15_000);
  const a = status.absence;
  const awayMin = a ? Math.max(0, Math.round((now - Date.parse(a.startedAt)) / 60_000)) : null;
  return (
    <>
      <Hero status={status}>
        {awayMin != null ? <BigNumber value={`${awayMin} min`} caption={a?.thresholdMinutes ? `away · limit ${a.thresholdMinutes} min` : 'away'} /> : null}
      </Hero>
      <Card>
        {a ? <Row label="Away since" value={fmtTime(a.startedAt)} /> : null}
        {a?.prolongedAt ? <Row label="Manager told" value={fmtTime(a.prolongedAt)} /> : null}
        <Row label="Distance" value={fmtDistance(status.session.lastDistanceM)} />
      </Card>
      <Muted center>Come back to be marked Present again.</Muted>
      <Button title="View map" variant="secondary" onPress={() => router.push('/map')} />
    </>
  );
}

/** On a declared break: elapsed time against the limit, and End break. */
export function OnBreakView({ status }: { status: SessionStatus }) {
  const now = useNow(15_000);
  const b = status.break;
  if (!b) return <Hero status={status} />;
  const took = Math.max(0, Math.round((now - Date.parse(b.startedAt)) / 60_000));
  const over = now > Date.parse(b.endsAt);
  return (
    <>
      <Hero status={status} tone={over ? 'warning' : 'info'} title={over ? 'Break time is over' : `${b.label} break`}>
        <BigNumber value={`${took} min`} caption={over ? `limit ${b.maxMinutes} min · manager told` : `of ${b.maxMinutes} min · ends ${fmtTime(b.endsAt)}`} />
      </Hero>
      <Card>
        <Row label="Started" value={fmtTime(b.startedAt)} />
        <Row label="Type" value={`${b.label} (${b.paid ? 'paid' : 'unpaid'})`} />
        {b.note ? <Row label="Note" value={b.note} /> : null}
        {b.leftAt ? <Row label="Left at" value={fmtTime(b.leftAt)} /> : null}
      </Card>
      <EndBreakButton status={status} />
      <Muted center>Ends automatically when you're back.</Muted>
    </>
  );
}

/** On overtime: time since it started, where, and the reminder that it needs approval. */
export function OnOvertimeView({ status }: { status: SessionStatus }) {
  const now = useNow(15_000);
  const o = status.overtime;
  if (!o) return <Hero status={status} />;
  const took = Math.max(0, Math.round((now - Date.parse(o.startedAt)) / 60_000));
  const value = took >= 60 ? `${Math.floor(took / 60)} h ${took % 60} min` : `${took} min`;
  return (
    <>
      <Hero status={status} tone={status.session.isStale ? 'warning' : 'info'}>
        <BigNumber value={value} caption={`overtime since ${fmtTime(o.startedAt)} · shift ended ${fmtTime(status.session.scheduledEndAt)}`} />
      </Hero>
      <Card>
        {o.note ? <Row label="Working on" value={o.note} /> : null}
        <Row label="Last update" value={status.session.lastLocationAt ? fmtAgo(status.session.lastLocationAt, now) : '—'} />
        <Row label="From workplace" value={fmtDistance(status.session.lastDistanceM)} />
      </Card>
      <Muted center>Keep GeoAttend running. If your phone stops sending location for an hour, overtime ends at the last location received.</Muted>
    </>
  );
}

/** After the scheduled end: offer overtime (the server decides when it is allowed). */
export function OvertimeOffer({ status }: { status: SessionStatus }) {
  if (!status.canStartOvertime) return null;
  return (
    <Card tone="info">
      <Text style={st.offerTitle}>Your shift has ended</Text>
      <Body>{`${status.session.shiftName} ended at ${fmtTime(status.session.scheduledEndAt)}. Still working? Start overtime with a selfie. It is paid once your manager approves it. Otherwise, end your shift.`}</Body>
      <Button title="Start overtime" onPress={() => router.push('/overtime')} accessibilityHint="Take a selfie to start overtime" />
    </Card>
  );
}

/** Screen 15: connection / tracking interruption. */
export function InterruptionView({ status }: { status: SessionStatus }) {
  return (
    <>
      <Hero status={status} tone="warning" />
      <Card>
        <Body>• Internet on{'\n'}• GPS on{'\n'}• Battery saver off for GeoAttend</Body>
        <Muted>Last update {fmtAgo(status.session.lastLocationAt)}</Muted>
      </Card>
      <FreshFixButton status={status} title="Send my location now" />
      <Button title="Report a problem" variant="secondary" onPress={() => router.push({ pathname: '/account', params: { report: '1' } })} />
    </>
  );
}

/** Location permission revoked / location services off. */
export function PermissionRequiredView({ status, local }: { status: SessionStatus; local: PermissionReport | null }) {
  const servicesOff = local ? !local.locationServicesEnabled : false;
  const imprecise = !servicesOff && local?.precise === false;
  return (
    <>
      <Hero status={status} tone="danger" title={servicesOff ? 'Location services are off' : imprecise ? 'Precise location is off' : undefined} />
      <Body>{servicesOff ? 'Turn on GPS from quick settings.' : imprecise ? 'Settings → Apps → GeoAttend → Location → turn on “Use precise location”.' : 'Settings → Apps → GeoAttend → Location → “Allow all the time”.'}</Body>
      {servicesOff && Platform.OS === 'android' ? <Button title="Turn on location" onPress={() => void Location.enableNetworkProviderAsync().catch(() => Linking.openSettings())} /> : null}
      <Button title="Open settings" onPress={() => void Linking.openSettings()} />
      <Button title="Resume tracking" variant="secondary" onPress={() => router.push({ pathname: '/permissions', params: { shiftId: status.session.shiftId, resume: '1' } })} />
      <RequestReviewButton status={status} />
    </>
  );
}

export function ReviewPendingView({ status }: { status: SessionStatus }) {
  return (
    <>
      <Hero status={status} />
      {status.review ? (
        <Card>
          <Row label="Requested" value={fmtTime(status.review.createdAt)} />
          <Body>“{status.review.reason}”</Body>
        </Card>
      ) : null}
      <CancelReviewButton status={status} />
    </>
  );
}

/** Fallback for any state without a dedicated component. */
export function GenericStateView({ status }: { status: SessionStatus }) {
  return <Hero status={status} />;
}

const st = StyleSheet.create({
  hero: { borderWidth: 1.5, borderRadius: radius.lg, padding: space.lg, gap: space.sm },
  heroTitle: { fontSize: font.xxl, fontWeight: '800' },
  heroMsg: { fontSize: font.md, color: colors.text, lineHeight: 22 },
  big: { backgroundColor: colors.white, borderRadius: radius.md, padding: space.md, alignItems: 'center', marginTop: space.xs },
  bigValue: { fontSize: 40, fontWeight: '800', color: colors.navy },
  bigCaption: { fontSize: font.sm, color: colors.textMuted, textAlign: 'center' },
  offerTitle: { fontSize: font.lg, fontWeight: '800', color: colors.navy },
});
