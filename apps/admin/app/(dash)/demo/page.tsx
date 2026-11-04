'use client';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FlaskConical, RotateCcw } from 'lucide-react';
import { get, post, errorMessage } from '@/lib/api';
import { ago, fmtTime, metres, minutes } from '@/lib/format';
import { Badge, Button, Card, EmptyState, Modal, PageHeader, QueryState, Spinner } from '@/components/ui';
import { SeverityBadge, StateBadge } from '@/components/state-badge';
import { SchematicMap } from '@/components/maps/schematic';
import { kindFor } from '@/components/maps/markers';

type Action = { label: string; path: string; body?: object; variant?: 'primary' | 'accent' | 'secondary' | 'danger'; title?: string };

function EmployeeCard({ e }: { e: any }) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const act = useMutation({
    mutationFn: (a: Action) => post(`/demo/employees/${e.id}${a.path}`, a.body ?? {}),
    onMutate: () => setError(null),
    onError: (err) => setError(errorMessage(err)),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['demo'] });
      qc.invalidateQueries({ queryKey: ['live'] });
    },
  });
  const st = e.status;
  const s = st?.session;
  const open = s && !s.endedAt;
  const groups: Array<{ title: string; actions: Action[] }> = [
    {
      title: 'Shift',
      actions: [
        { label: 'Start shift', path: '/start-shift', variant: 'primary' },
        { label: 'End shift', path: '/end-shift' },
      ],
    },
    {
      title: 'Location',
      actions: [
        { label: 'Move far away', path: '/move', body: { position: 'far' } },
        { label: 'Move outside geofence', path: '/move', body: { position: 'outside' }, title: 'Also simulates a workplace departure after attendance' },
        { label: 'Move inside geofence', path: '/move', body: { position: 'inside' }, title: 'Also simulates a return when away' },
        { label: 'Single inside reading', path: '/move', body: { position: 'inside', hold: false }, title: 'One reading only — shows the stabilisation (ARRIVAL_CANDIDATE) step' },
        { label: 'Near boundary', path: '/move', body: { position: 'boundary', hold: false } },
        { label: 'Weak GPS reading', path: '/move', body: { position: 'weak_gps', hold: false } },
      ],
    },
    {
      title: 'Events',
      actions: [
        { label: 'Simulate successful attendance', path: '/attendance', variant: 'accent' },
        { label: 'Advance absence timer +5 min', path: '/advance', body: { minutes: 5 } },
        { label: '+15 min', path: '/advance', body: { minutes: 15 } },
        { label: 'Simulate tracking interruption', path: '/interrupt' },
        { label: 'Revoke location permission', path: '/revoke-permission' },
        { label: 'Restore permission', path: '/restore-permission' },
      ],
    },
  ];

  return (
    <Card
      title={
        <span className="flex flex-wrap items-center gap-2">
          {e.full_name} <span className="text-xs font-normal text-gray-500">{e.employee_code}</span>
        </span>
      }
      actions={s ? <StateBadge state={s.state} /> : <Badge>Not started</Badge>}
    >
      {st && (
        <div className="mb-3 rounded-md bg-gray-50 p-3 text-sm">
          <p className="font-medium text-gray-900">{st.guidance.title}</p>
          <p className="text-gray-700">{st.guidance.message}</p>
          <p className="mt-1 text-xs text-gray-500">
            {metres(s.lastDistanceM)} {s.lastAccuracyM ? `±${Math.round(s.lastAccuracyM)} m` : ''} · {s.lastClassification?.toLowerCase().replace('_', ' ') ?? 'no reading yet'}
            {s.simClockOffsetSec ? ` · simulated clock +${minutes(Math.round(s.simClockOffsetSec / 60))}` : ''}
            {st.attendance && ` · attendance ${fmtTime(st.attendance.recordedAt)}`}
            {st.absence && ` · away since ${fmtTime(st.absence.startedAt)}`}
          </p>
        </div>
      )}
      <div className="space-y-2">
        {groups.map((g) => (
          <div key={g.title}>
            <p className="mb-1 text-xs font-medium text-gray-500">{g.title}</p>
            <div className="flex flex-wrap gap-1.5">
              {g.actions.map((a) => (
                <Button
                  key={a.label}
                  size="sm"
                  variant={a.variant ?? 'secondary'}
                  title={a.title}
                  disabled={act.isPending || (a.path === '/start-shift' ? !!open : !open)}
                  loading={act.isPending && act.variables?.label === a.label}
                  onClick={() => act.mutate(a)}
                >
                  {a.label}
                </Button>
              ))}
            </div>
          </div>
        ))}
      </div>
      {error && <p role="alert" className="mt-2 rounded bg-red-50 px-2 py-1 text-xs text-red-700">{error}</p>}
    </Card>
  );
}

export default function DemoPage() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['demo'], queryFn: () => get('/demo/status'), retry: false });
  const [confirm, setConfirm] = useState(false);
  const reset = useMutation({ meta: { success: 'Demo data reset', toastError: true },
    mutationFn: () => post('/demo/reset'),
    onSuccess: () => {
      setConfirm(false);
      qc.invalidateQueries();
    },
  });

  return (
    <>
      <PageHeader
        title="Demo Simulator"
        description="Development-only. Moves the fictional demo employees through the same server rules as real devices. Every simulated location, event and record is labelled SIMULATED and kept apart from real employees."
        actions={
          <Button variant="danger" onClick={() => setConfirm(true)}>
            <RotateCcw className="h-4 w-4" aria-hidden /> Reset demo data
          </Button>
        }
      />
      <p className="mb-4 flex gap-2 rounded-md border border-violet-200 bg-violet-50 p-3 text-sm text-violet-900">
        <FlaskConical className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        <span>
          Simulated sessions run on their own clock: to satisfy stabilisation windows or an absence threshold the simulator advances that session&apos;s clock instead of making you wait. The attendance photo is a synthetic striped image, not a camera capture. Production attendance always uses the device camera.
        </span>
      </p>
      <QueryState query={q}>
        {(d: any) => {
          if (!d.employees.length) return <EmptyState title="No demo employees">Run `npm run db:seed` with DEMO_MODE=true.</EmptyState>;
          const wp = d.employees[0].workplace;
          const onShift = d.employees.filter((e: any) => e.status?.session && !e.status.session.endedAt).length;
          return (
            <div className="grid gap-6 xl:grid-cols-3">
              <div className="space-y-4 xl:col-span-2">
                {d.employees.map((e: any) => (
                  <EmployeeCard key={e.id} e={e} />
                ))}
              </div>
              <div className="space-y-4">
                {wp && (
                  <Card title={`${wp.name}`}>
                    <DemoPositions wp={wp} employees={d.employees} />
                    <p className="mt-2 text-xs text-gray-500">{onShift} demo employee(s) on shift. Radius {wp.radiusM} m. Fictional workplace at sample coordinates.</p>
                  </Card>
                )}
                <Card title="Simulated event timeline" padded={false}>
                  {d.timeline.length === 0 ? (
                    <EmptyState title="No simulated events yet" />
                  ) : (
                    <ol className="max-h-[560px] divide-y divide-gray-100 overflow-y-auto">
                      {d.timeline.map((n: any) => (
                        <li key={n.id} className="px-4 py-2 text-sm">
                          <div className="flex items-center gap-2">
                            <SeverityBadge severity={n.severity} />
                            <span className="font-medium">{n.title}</span>
                            <span className="ml-auto text-xs text-gray-500">{ago(n.created_at)}</span>
                          </div>
                          <p className="text-xs text-gray-600">{n.body}</p>
                        </li>
                      ))}
                    </ol>
                  )}
                </Card>
              </div>
            </div>
          );
        }}
      </QueryState>
      <Modal open={confirm} onOpenChange={setConfirm} title="Reset demo data?" description="Deletes every session, location, attendance record, photo and notification belonging to demo employees, so the demo can be replayed today. Real employees are not affected.">
        {reset.isPending ? (
          <Spinner label="Resetting…" />
        ) : (
          <div className="flex justify-end gap-2">
            <Button onClick={() => setConfirm(false)}>Cancel</Button>
            <Button variant="danger" onClick={() => reset.mutate()}>Reset</Button>
          </div>
        )}
      </Modal>
    </>
  );
}

/** Uses the live endpoint for real coordinates of the demo sessions. */
function DemoPositions({ wp, employees }: { wp: any; employees: any[] }) {
  const live = useQuery({ queryKey: ['live', 'demo-map'], queryFn: () => get('/tracking/live') });
  const ids = new Set(employees.map((e) => e.id));
  const pts = (live.data?.sessions ?? [])
    .filter((s: any) => ids.has(s.employee_id) && s.last_latitude != null && !s.ended_at)
    .map((s: any) => ({ id: s.id, lat: s.last_latitude, lng: s.last_longitude, label: s.full_name.split(' ')[0], kind: kindFor(s), accuracyM: s.last_accuracy_m }));
  return <SchematicMap center={{ lat: wp.latitude, lng: wp.longitude }} radiusM={wp.radiusM} points={pts} height={340} />;
}
