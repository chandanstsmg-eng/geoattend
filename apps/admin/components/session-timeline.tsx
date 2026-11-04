'use client';
import { useQuery } from '@tanstack/react-query';
import { get, post } from '@/lib/api';
import { fmtTime } from '@/lib/format';
import { QueryState, EmptyState, Badge, Button } from './ui';
import { StateBadge } from './state-badge';

/** Merged, time-ordered view of state transitions, geofence events and permission reports for one session. */
export function SessionTimeline({ sessionId }: { sessionId: string }) {
  const q = useQuery({ queryKey: ['session', 'timeline', sessionId], queryFn: () => get(`/tracking/sessions/${sessionId}/timeline`) });
  return (
    <QueryState query={q}>
      {(d: any) => {
        const items = [
          ...d.transitions.map((t: any) => ({ at: t.at, key: `t${t.id}`, node: <span className="flex flex-wrap items-center gap-1.5"><StateBadge state={t.to_state} /><span className="text-gray-600">{t.reason}</span><Badge tone="gray">{t.actor.toLowerCase()}</Badge></span> })),
          ...d.geofenceEvents.map((g: any) => ({ at: g.event_time, key: `g${g.id}`, node: <span className="text-gray-700">Geofence: <b>{g.event_type.replaceAll('_', ' ').toLowerCase()}</b> · {Math.round(g.distance_m)} m ±{Math.round(g.accuracy_m)} m</span> })),
          ...d.permissions.map((p: any) => ({ at: p.received_at, key: `p${p.id}`, node: <span className="text-gray-700">Permissions: foreground {p.foreground}, background {p.background}{p.location_services_enabled ? '' : ', location services OFF'}</span> })),
          ...(d.breaks ?? []).map((b: any) => ({ at: b.started_at, key: `b${b.id}`, node: <BreakLine sessionId={sessionId} b={b} /> })),
          ...d.absences.map((a: any) => ({ at: a.started_at, key: `a${a.id}`, node: <span className="text-amber-800">Absence {a.status.toLowerCase()} — threshold {a.threshold_minutes} min{a.prolonged_at ? ', became prolonged' : ''}{a.tracking_gap ? ', with a tracking gap' : ''}</span> })),
        ].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
        if (!items.length) return <EmptyState title="No events" />;
        return (
          <ol className="space-y-1.5 text-sm">
            {items.map((i) => (
              <li key={i.key} className="flex gap-3">
                <span className="tabular w-20 shrink-0 text-xs text-gray-500">{fmtTime(i.at)}</span>
                {i.node}
              </li>
            ))}
          </ol>
        );
      }}
    </QueryState>
  );
}

function BreakLine({ sessionId, b }: { sessionId: string; b: any }) {
  const took = Math.round((new Date(b.ended_at ?? Date.now()).getTime() - new Date(b.started_at).getTime()) / 60000);
  const openPhoto = async () => {
    // Open the tab inside the click so pop-up blockers allow it, then point it at the short-lived link.
    const tab = window.open('', '_blank');
    const { url } = await post(`/tracking/sessions/${sessionId}/breaks/${b.id}/photo-url`);
    if (tab) {
      tab.opener = null;
      tab.location.href = url;
    }
  };
  return (
    <span className="flex flex-wrap items-center gap-1.5 text-teal-800">
      Break: <b>{b.type_label}</b> · {took} min of {b.max_minutes}
      <Badge tone={b.paid ? 'green' : 'gray'}>{b.paid ? 'paid' : 'unpaid'}</Badge>
      {b.overdue_at && <Badge tone="amber">over limit</Badge>}
      {b.left_at ? <span className="text-gray-600">left the area {fmtTime(b.left_at)}</span> : <span className="text-gray-600">stayed inside</span>}
      {b.ended_at ? <span className="text-gray-600">· ended {fmtTime(b.ended_at)} ({b.end_reason === 'RETURNED' ? 'returned' : b.end_reason === 'SHIFT_ENDED' ? 'shift ended' : 'by employee'})</span> : <Badge tone="teal">in progress</Badge>}
      {b.note && <span className="text-gray-600">“{b.note}”</span>}
      {b.photo_id && <Button size="sm" onClick={() => void openPhoto()}>View selfie</Button>}
    </span>
  );
}
