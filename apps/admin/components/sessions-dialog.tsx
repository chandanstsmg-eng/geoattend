'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Monitor, Smartphone } from 'lucide-react';
import { get, post } from '@/lib/api';
import { ago, fmtDateTime } from '@/lib/format';
import { Badge, Button, EmptyState, InlineError, Modal, QueryState } from './ui';

interface Session {
  id: string;
  client: 'web' | 'mobile';
  deviceId: string | null;
  signedInAt: string;
  lastActiveAt: string;
  expiresAt: string;
  current: boolean;
}

/** Your sign-ins (browsers and phones), with sign-out for one or for all the others. */
export function SessionsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const sessions = useQuery({ queryKey: ['auth', 'sessions'], queryFn: () => get<Session[]>('/auth/sessions'), enabled: open });
  const refresh = () => qc.invalidateQueries({ queryKey: ['auth', 'sessions'] });
  const revoke = useMutation({ meta: { success: 'Signed out' }, mutationFn: (id: string) => post(`/auth/sessions/${id}/revoke`), onSuccess: refresh });
  const others = useMutation({ meta: { success: 'Signed out everywhere else' }, mutationFn: () => post('/auth/sessions/revoke-others'), onSuccess: refresh });
  return (
    <Modal open={open} onOpenChange={onOpenChange} title="Signed-in devices" description="Browsers and phones signed in to your account. Signing one out takes effect within a few minutes.">
      <QueryState query={sessions} isEmpty={(d) => d.length === 0} empty={<EmptyState title="No active sign-ins" />}>
        {(rows) => (
          <div className="space-y-4">
            <ul className="divide-y divide-gray-100 rounded-md border border-gray-200">
              {rows.map((s) => (
                <li key={s.id} className="flex items-center gap-3 px-3 py-2.5">
                  {s.client === 'mobile' ? <Smartphone className="h-4 w-4 shrink-0 text-gray-500" aria-hidden /> : <Monitor className="h-4 w-4 shrink-0 text-gray-500" aria-hidden />}
                  <div className="min-w-0 flex-1 text-sm">
                    <p className="font-medium text-gray-900">
                      {s.client === 'mobile' ? 'Phone app' : 'Web browser'} {s.current && <Badge tone="green">This device</Badge>}
                    </p>
                    <p className="text-xs text-gray-500">Signed in {fmtDateTime(s.signedInAt)} · last active {ago(s.lastActiveAt)}</p>
                  </div>
                  {!s.current && (
                    <Button size="sm" loading={revoke.isPending && revoke.variables === s.id} onClick={() => revoke.mutate(s.id)}>
                      Sign out
                    </Button>
                  )}
                </li>
              ))}
            </ul>
            <InlineError error={revoke.error ?? others.error} />
            <div className="flex justify-end">
              <Button variant="danger" loading={others.isPending} disabled={!rows.some((s) => !s.current)} onClick={() => others.mutate()}>
                Sign out everywhere else
              </Button>
            </div>
          </div>
        )}
      </QueryState>
    </Modal>
  );
}
