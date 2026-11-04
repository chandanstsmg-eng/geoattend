/** Screen 18: privacy & tracking information, with acknowledgement. */
import { useState } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { Banner, Body, Button, Card, ErrorState, H2, Loading, Muted, Row, Screen } from '../../../components/ui';
import { api, ApiError, errorMessage } from '../../../lib/api/client';
import type { PrivacyNotice } from '../../../lib/api/types';
import { qk, queryClient } from '../../../lib/queryClient';

export default function PrivacyScreen() {
  const { next, shiftId } = useLocalSearchParams<{ next?: string; shiftId?: string }>();
  const notice = useQuery({ queryKey: qk.privacy, queryFn: () => api<PrivacyNotice>('/me/privacy-notice') });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (notice.isPending) return <Loading />;
  if (!notice.data) return <Screen><ErrorState message={errorMessage(notice.error)} onRetry={() => notice.refetch()} /></Screen>;
  const n = notice.data;
  const continueToStart = next === 'start' && !!shiftId;

  const acknowledge = async () => {
    setBusy(true);
    setError(null);
    try {
      await api('/me/privacy-notice/ack', { method: 'POST', body: { version: n.version } });
      await queryClient.invalidateQueries({ queryKey: qk.privacy });
      await queryClient.invalidateQueries({ queryKey: qk.assignment });
      if (continueToStart) router.replace({ pathname: '/permissions', params: { shiftId } });
    } catch (e) {
      if (e instanceof ApiError && e.code === 'NOTICE_OUTDATED') void notice.refetch();
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen onRefresh={() => void notice.refetch()} refreshing={notice.isFetching}>
      {continueToStart && !n.acknowledged ? <Banner tone="info" title="Please read and acknowledge this notice before your first shift" /> : null}
      <Card>
        <H2>Location tracking & attendance photo notice</H2>
        <Muted>Version {n.version}</Muted>
        <Body>{n.text}</Body>
      </Card>
      <Card>
        <H2>Key facts</H2>
        <Row label="Data controller" value={n.controller} />
        <Row label="Contact" value={n.contact} />
        <Row label="Location history kept for" value={`${n.retention.locationDays} days`} strong />
        <Row label="Attendance photos kept for" value={`${n.retention.photoDays} days`} strong />
        <Row label="Update interval while tracking" value={`about every ${n.tracking.updateIntervalSec} s`} />
        <Row label="Earliest start before shift" value={`${n.tracking.earlyStartMinutes} min`} />
        <Row label="Tracking stops after shift end" value={`within ${n.tracking.endGraceMinutes} min`} />
      </Card>
      <Card>
        <H2>What this app does</H2>
        <Body>
          • Collects location only while a shift you started is open{'\n'}• Stops when you end the shift, the shift window closes, an administrator ends it, or you sign out{'\n'}• Opens the camera only when you tap “Capture Attendance Photo”{'\n'}• Never uses your photo gallery
        </Body>
      </Card>
      {error ? <Banner tone="danger" title={error} /> : null}
      {n.acknowledged ? (
        <>
          <Banner tone="success" title={`You acknowledged version ${n.version}`} />
          {continueToStart ? <Button title="Continue to start shift" onPress={() => router.replace({ pathname: '/permissions', params: { shiftId } })} /> : null}
        </>
      ) : (
        <Button title={`Acknowledge notice (version ${n.version})`} onPress={acknowledge} loading={busy} accessibilityHint={`Confirms you have read version ${n.version}, with ${n.retention.locationDays}-day location and ${n.retention.photoDays}-day photo retention`} />
      )}
    </Screen>
  );
}
