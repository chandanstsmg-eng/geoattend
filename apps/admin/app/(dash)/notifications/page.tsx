'use client';
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BellRing, CheckCheck } from 'lucide-react';
import { NOTIFICATION_LABELS, NOTIFICATION_TYPES } from '@geoattend/shared';
import { get, post, qs, errorMessage } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { Badge, Button, Card, cx, EmptyState, Input, PageHeader, Pagination, QueryState, Select, SimBadge, Toolbar } from '@/components/ui';
import { SeverityBadge } from '@/components/state-badge';
import { EmployeeSelect, WorkplaceSelect } from '@/components/filters';

function b64ToBytes(b64: string) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

function PushOptIn() {
  const key = useQuery({ queryKey: ['push-key'], queryFn: () => get<{ publicKey: string | null }>('/notifications/web-push/key') });
  const [state, setState] = useState<'unknown' | 'unsupported' | 'on' | 'off' | 'denied'>('unknown');
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return setState('unsupported');
    if (Notification.permission === 'denied') return setState('denied');
    navigator.serviceWorker.getRegistration('/sw.js').then(async (reg) => setState((await reg?.pushManager.getSubscription()) ? 'on' : 'off'));
  }, []);

  async function enable() {
    setErr(null);
    try {
      const reg = await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') return setState('denied');
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(key.data!.publicKey!) });
      await post('/notifications/web-push/subscriptions', sub.toJSON());
      setState('on');
    } catch (e) {
      setErr(errorMessage(e));
    }
  }
  async function disable() {
    const reg = await navigator.serviceWorker.getRegistration('/sw.js');
    const sub = await reg?.pushManager.getSubscription();
    if (sub) {
      await post('/notifications/web-push/unsubscribe', { endpoint: sub.endpoint }).catch(() => undefined);
      await sub.unsubscribe();
    }
    setState('off');
  }

  if (!key.data) return null;
  if (!key.data.publicKey) return <p className="text-xs text-gray-500">Browser push is not configured on the server (VAPID keys). In-app notifications still work.</p>;
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      {state === 'on' && (
        <>
          <Badge tone="green">Browser push on</Badge>
          <Button size="sm" variant="ghost" onClick={disable}>Turn off</Button>
        </>
      )}
      {state === 'off' && (
        <Button size="sm" onClick={enable}>
          <BellRing className="h-4 w-4" aria-hidden /> Enable browser push on this device
        </Button>
      )}
      {state === 'denied' && <span className="text-xs text-gray-500">Notifications are blocked for this site in the browser settings.</span>}
      {state === 'unsupported' && <span className="text-xs text-gray-500">This browser does not support web push.</span>}
      {err && <span className="text-xs text-red-600">{err}</span>}
    </div>
  );
}

export default function NotificationsPage() {
  const qc = useQueryClient();
  const [f, setF] = useState({ type: '', severity: '', employeeId: '', workplaceId: '', from: '', to: '', unread: '' });
  const [offset, setOffset] = useState(0);
  const limit = 50;
  const list = useQuery({ queryKey: ['notifications', f, offset], queryFn: () => get(`/notifications${qs({ ...f, limit, offset })}`) });
  const markRead = useMutation({ meta: { toastError: true }, mutationFn: (id: string) => post(`/notifications/${id}/read`), onSuccess: () => { qc.invalidateQueries({ queryKey: ['notifications'] }); qc.invalidateQueries({ queryKey: ['unread'] }); } });
  const readAll = useMutation({ meta: { success: 'All marked as read', toastError: true }, mutationFn: () => post('/notifications/read-all'), onSuccess: () => { qc.invalidateQueries({ queryKey: ['notifications'] }); qc.invalidateQueries({ queryKey: ['unread'] }); } });
  const set = (k: keyof typeof f) => (v: string) => { setOffset(0); setF({ ...f, [k]: v }); };

  return (
    <>
      <PageHeader
        title="Notifications"
        description="Every alert is stored here first; browser push and e-mail are optional extra channels with automatic retry. Repeated alerts are de-duplicated."
        actions={
          <Button onClick={() => readAll.mutate()} loading={readAll.isPending}>
            <CheckCheck className="h-4 w-4" aria-hidden /> Mark all read
          </Button>
        }
      />
      <div className="mb-4 rounded-lg border border-gray-200 bg-white px-4 py-3"><PushOptIn /></div>
      <Card padded={false}>
        <Toolbar>
          <Select aria-label="Event type" value={f.type} onChange={(e) => set('type')(e.target.value)} className="w-auto">
            <option value="">All event types</option>
            {NOTIFICATION_TYPES.filter((t) => t !== 'ATTENDANCE_READY').map((t) => <option key={t} value={t}>{NOTIFICATION_LABELS[t]}</option>)}
          </Select>
          <Select aria-label="Severity" value={f.severity} onChange={(e) => set('severity')(e.target.value)} className="w-auto">
            <option value="">Any severity</option>
            <option value="CRITICAL">Critical</option>
            <option value="WARNING">Warning</option>
            <option value="INFO">Info</option>
          </Select>
          <EmployeeSelect value={f.employeeId} onChange={set('employeeId')} />
          <WorkplaceSelect value={f.workplaceId} onChange={set('workplaceId')} />
          <Input type="date" aria-label="From" value={f.from} onChange={(e) => set('from')(e.target.value)} className="w-auto" />
          <Input type="date" aria-label="To" value={f.to} onChange={(e) => set('to')(e.target.value)} className="w-auto" />
          <label className="flex items-center gap-1.5 text-sm">
            <input type="checkbox" checked={f.unread === 'true'} onChange={(e) => set('unread')(e.target.checked ? 'true' : '')} /> Unread only
          </label>
        </Toolbar>
        <QueryState query={list} isEmpty={(d: any) => d.items.length === 0} empty={<EmptyState title="No notifications match" />}>
          {(d: any) => (
            <>
              <ul className="divide-y divide-gray-100">
                {d.items.map((n: any) => (
                  <li key={n.id} className={cx('flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-start', !n.read_at && 'bg-primary-50/40')}>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        {!n.read_at && <span className="h-2 w-2 rounded-full bg-primary-500" role="img" aria-label="Unread" />}
                        {n.severity !== 'INFO' && <SeverityBadge severity={n.severity} />}
                        <span className={cx('text-gray-900', !n.read_at && 'font-medium')}>{n.title}</span>
                        {n.is_simulated && <SimBadge />}
                      </div>
                      <p className="mt-1 text-sm text-gray-600">{n.body}</p>
                      <p className="mt-1 text-xs text-gray-500">
                        {fmtDateTime(n.created_at)} · {n.employee_name ?? 'System'} {n.workplace_name ? `· ${n.workplace_name}` : ''}
                        {(n.deliveries ?? []).map((dl: any, i: number) => (
                          <span key={i} className="ml-2">
                            <Badge tone={dl.status === 'SENT' ? 'green' : dl.status === 'GAVE_UP' ? 'red' : 'amber'} title={dl.lastError ?? undefined}>
                              {dl.channel.toLowerCase().replace('_', ' ')}: {dl.status.toLowerCase()}{dl.attempts > 1 ? ` (${dl.attempts})` : ''}
                            </Badge>
                          </span>
                        ))}
                      </p>
                    </div>
                    {!n.read_at && <Button size="sm" variant="ghost" className="self-start" onClick={() => markRead.mutate(n.id)}>Mark read</Button>}
                  </li>
                ))}
              </ul>
              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-gray-200">
                <span className="pl-4 text-body-sm text-gray-500">{d.unread} unread</span>
                <Pagination offset={offset} limit={limit} total={d.total} onChange={setOffset} noun="notification" />
              </div>
            </>
          )}
        </QueryState>
      </Card>
    </>
  );
}
