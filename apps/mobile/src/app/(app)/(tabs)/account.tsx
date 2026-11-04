/** Screen 19: account settings — profile, change password, report a technical issue, sign out. */
import { useEffect, useState } from 'react';
import { Alert } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { Banner, Body, Button, Card, DemoBadge, Field, H2, Muted, ReasonModal, Row, Screen } from '../../../components/ui';
import { api, errorMessage } from '../../../lib/api/client';
import { useAuth } from '../../../lib/auth';
import { API_URL, APP_VARIANT, APP_VERSION } from '../../../lib/config';
import { deviceInfo } from '../../../lib/device';
import { useAssignment, useStatus, useTrackingSnapshot } from '../../../lib/hooks';

export default function AccountScreen() {
  const { user, signOut, signIn } = useAuth();
  const params = useLocalSearchParams<{ report?: string }>();
  const assignment = useAssignment();
  const statusQ = useStatus();
  const snap = useTrackingSnapshot();
  const [reportOpen, setReportOpen] = useState(false);
  const [deviceId, setDeviceId] = useState('');

  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [pwBusy, setPwBusy] = useState(false);
  const [pwError, setPwError] = useState<string | null>(null);
  const [pwDone, setPwDone] = useState(false);

  useEffect(() => {
    if (params.report) setReportOpen(true);
  }, [params.report]);
  useEffect(() => {
    deviceInfo().then((d) => setDeviceId(d.deviceId), () => undefined);
  }, []);

  const emp = assignment.data?.employee;
  const openSession = statusQ.data ?? null;

  const changePassword = async () => {
    setPwError(null);
    setPwDone(false);
    if (!current || !next) return setPwError('Fill in both passwords.');
    if (next !== confirm) return setPwError('The new passwords do not match.');
    setPwBusy(true);
    try {
      await api('/auth/change-password', { method: 'POST', body: { currentPassword: current, newPassword: next } });
      // The server revokes every refresh token (including this phone's): sign in again with the new password.
      const email = user?.email ?? emp?.email;
      if (email) await signIn(email, next).catch(() => undefined);
      setCurrent('');
      setNext('');
      setConfirm('');
      setPwDone(true);
    } catch (e) {
      setPwError(errorMessage(e));
    } finally {
      setPwBusy(false);
    }
  };

  const saved = snap.queueLength + snap.events.filter((e) => e.status === 'PENDING').length;

  const confirmSignOut = () =>
    Alert.alert(
      'Sign out?',
      `${
        openSession
          ? 'Signing out stops location tracking on this phone immediately. Your shift stays open on the server — end the shift first if you have finished work.'
          : 'You will need your password to sign in again.'
      }${saved ? ` ${saved} saved item${saved === 1 ? ' is' : 's are'} not sent yet: they stay on this phone and go when you sign in again.` : ''}`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Sign out', style: 'destructive', onPress: () => void signOut() },
      ],
    );

  return (
    <Screen>
      <Card>
        <H2>{user?.fullName ?? emp?.fullName ?? 'Profile'}</H2>
        <DemoBadge show={user?.isDemo || emp?.isDemo} />
        <Row label="Email" value={user?.email ?? emp?.email ?? '—'} />
        {emp?.employeeCode ? <Row label="Employee code" value={emp.employeeCode} /> : null}
        {emp?.designation ? <Row label="Designation" value={emp.designation} /> : null}
        {emp?.department ? <Row label="Department" value={emp.department} /> : null}
        {assignment.data?.workplace ? <Row label="Workplace" value={assignment.data.workplace.name} /> : null}
      </Card>

      <Card>
        <H2>Change password</H2>
        {user?.mustChangePassword ? <Banner tone="warning" title="Your administrator asked you to change your password" /> : null}
        <Field label="Current password" value={current} onChangeText={setCurrent} secureTextEntry autoComplete="current-password" />
        <Field label="New password" value={next} onChangeText={setNext} secureTextEntry autoComplete="new-password" />
        <Field label="Repeat new password" value={confirm} onChangeText={setConfirm} secureTextEntry autoComplete="new-password" error={pwError} />
        {pwDone ? <Banner tone="success" title="Password changed" message="Other devices have been signed out. This phone stays signed in." /> : null}
        <Button title="Change password" variant="secondary" onPress={changePassword} loading={pwBusy} />
      </Card>

      <Card>
        <H2>Report a technical issue</H2>
        <Body>Problems with GPS, tracking, the camera or the app? Your administrator receives the report{openSession ? ' together with your current shift' : ''}.</Body>
        <Button title="Report a technical issue" variant="secondary" onPress={() => setReportOpen(true)} />
      </Card>

      <Card>
        <H2>This device</H2>
        <Row label="App version" value={`${APP_VERSION} (${APP_VARIANT})`} />
        <Row label="Server" value={API_URL || 'not configured'} />
        <Row label="Device ID" value={deviceId ? `${deviceId.slice(0, 8)}…` : '—'} />
        <Row label="Tracking on this phone" value={snap.meta.sessionId ? (snap.meta.mode === 'foreground' ? 'Only while app open' : 'Active') : 'Off'} />
        <Row label="Saved locations, not sent" value={String(snap.queueLength)} />
        <Row label="Saved check-ins and shift ends" value={String(snap.events.filter((e) => e.status === 'PENDING').length)} />
      </Card>

      <Button title="Sign out" variant="danger" onPress={confirmSignOut} />
      <Muted center>Signing out always stops location collection on this phone.</Muted>

      <ReasonModal
        visible={reportOpen}
        title="Report a technical issue"
        description="Describe what happened and when. Do not include passwords."
        submitLabel="Send report"
        onCancel={() => setReportOpen(false)}
        onSubmit={async (reason) => {
          await api('/me/issues', { method: 'POST', body: { kind: 'TECHNICAL_ISSUE', sessionId: openSession?.session.id ?? null, reason } });
          setReportOpen(false);
          Alert.alert('Report sent', 'Your administrator has been notified.');
        }}
      />
    </Screen>
  );
}
