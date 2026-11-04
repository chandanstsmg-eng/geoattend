/**
 * Live shift screen. Switches between one component per server state
 * (screens 8/9/10/13/14/15 + permission-required + manual review).
 */
import { useCallback, useEffect, useState } from 'react';
import { AppState, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { EndShiftButton, RequestReviewButton, TakeBreakButton } from '../../components/shift/actions';
import {
  AbsenceView,
  AccuracyWarningView,
  AttendanceReadyView,
  GenericStateView,
  InterruptionView,
  LiveTrackingView,
  OnBreakView,
  OnOvertimeView,
  OutsideGeofenceView,
  OvertimeOffer,
  PermissionRequiredView,
  ReviewPendingView,
} from '../../components/shift/views';
import { TrackingBanners, TrackingStrip } from '../../components/TrackingBanners';
import { Banner, Button, Card, ErrorState, Gap, H2, Loading, Muted, Screen } from '../../components/ui';
import { errorMessage } from '../../lib/api/client';
import type { PermissionReport, SessionStatus } from '../../lib/api/types';
import { fmtDateTime } from '../../lib/format';
import { useStatus, useTrackingSnapshot } from '../../lib/hooks';
import { PRE_ATTENDANCE_STATES } from '../../lib/states';
import { permissionUsable, readPermissionSnapshot } from '../../lib/tracking/runtime';
import { space } from '../../lib/theme';

/** Returns the state component and whether the footer should offer "Request manual review". */
function pickView(status: SessionStatus, local: PermissionReport | null): [React.ReactNode, boolean] {
  const s = status.session;
  const rules = { requireBackground: status.tracking.requireBackgroundLocation, requirePrecise: status.tracking.requirePreciseLocation };
  if (s.state === 'TRACKING_PERMISSION_REQUIRED' || (local && !permissionUsable(local, rules))) return [<PermissionRequiredView status={status} local={local} />, false];
  if (s.state === 'MANUAL_REVIEW_REQUIRED') return [<ReviewPendingView status={status} />, false];
  if (status.attendanceAvailable) return [<AttendanceReadyView status={status} />, false];
  if (s.state === 'TRACKING_INTERRUPTED') return [<InterruptionView status={status} />, true];
  if (s.state === 'TEMPORARILY_AWAY' || s.state === 'PROLONGED_ABSENCE') return [<AbsenceView status={status} />, false];
  if (s.state === 'ON_BREAK') return [<OnBreakView status={status} />, false];
  if (s.state === 'ON_OVERTIME') return [<OnOvertimeView status={status} />, false];
  if (s.state === 'PRESENT') return [<LiveTrackingView status={status} />, false];
  if (s.lastClassification === 'INSUFFICIENT_ACCURACY' && PRE_ATTENDANCE_STATES.includes(s.state)) return [<AccuracyWarningView status={status} />, false];
  if (['SHIFT_START_PENDING', 'TRACKING_ACTIVE', 'OUTSIDE_GEOFENCE', 'ARRIVAL_CANDIDATE'].includes(s.state)) return [<OutsideGeofenceView status={status} />, true];
  return [<GenericStateView status={status} />, true];
}

export default function ShiftScreen() {
  const statusQ = useStatus({ poll: true });
  const snap = useTrackingSnapshot();
  const [local, setLocal] = useState<PermissionReport | null>(null);

  const readLocal = useCallback(() => {
    readPermissionSnapshot().then(setLocal, () => undefined);
  }, []);
  useFocusEffect(
    useCallback(() => {
      readLocal();
      void statusQ.refetch();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []),
  );
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => s === 'active' && readLocal());
    return () => sub.remove();
  }, [readLocal]);

  if (statusQ.isPending) return <Loading label="Loading shift status…" />;
  const status = statusQ.data ?? null;

  if (!status) {
    if (statusQ.isError) {
      return (
        <Screen>
          <ErrorState message={errorMessage(statusQ.error)} onRetry={() => void statusQ.refetch()} />
        </Screen>
      );
    }
    const stopped = snap.meta.stopped;
    return (
      <Screen onRefresh={() => void statusQ.refetch()} refreshing={statusQ.isFetching}>
        <Card>
          <H2>{stopped ? 'Tracking stopped' : 'No shift now'}</H2>
          {stopped ? <Muted>{`${stopped.reason} · ${fmtDateTime(stopped.at)}`}</Muted> : null}
        </Card>
        <Button title="Back to home" onPress={() => router.replace('/')} />
      </Screen>
    );
  }

  const [view, offerReview] = pickView(status, local);
  return (
    <Screen onRefresh={() => void statusQ.refetch()} refreshing={statusQ.isFetching}>
      {statusQ.isError ? <Banner tone="warning" title="Offline — last known status" /> : null}
      <TrackingStrip status={status} />
      <TrackingBanners status={status} />
      <OvertimeOffer status={status} />
      {view}
      <Gap size={space.sm} />
      <View style={{ gap: space.sm }}>
        <TakeBreakButton status={status} />
        {offerReview ? <RequestReviewButton status={status} /> : null}
        <EndShiftButton status={status} />
      </View>
    </Screen>
  );
}
