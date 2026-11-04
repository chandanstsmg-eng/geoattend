'use client';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MapPin, Phone, Siren } from 'lucide-react';
import { get, post } from '@/lib/api';
import { ago } from '@/lib/format';
import { Button, Field, InlineError, Modal, Textarea } from './ui';

/** A red bar on every page while any SOS is open — it cannot be missed. */
export function SosBanner() {
  const qc = useQueryClient();
  const open = useQuery({ queryKey: ['sos', 'open'], queryFn: () => get<any[]>('/sos?open=true'), refetchInterval: 15_000 });
  const refresh = () => qc.invalidateQueries({ queryKey: ['sos'] });
  const [closing, setClosing] = useState<any | null>(null);
  const [note, setNote] = useState('');
  const ack = useMutation({ meta: { success: 'SOS acknowledged', toastError: true }, mutationFn: (id: string) => post(`/sos/${id}/acknowledge`), onSuccess: refresh });
  const resolve = useMutation({ meta: { success: 'SOS resolved', toastError: true },
    mutationFn: ({ id, note }: { id: string; note: string }) => post(`/sos/${id}/resolve`, { note }),
    onSuccess: () => {
      setClosing(null);
      setNote('');
      refresh();
    },
  });
  const items = open.data ?? [];
  if (!items.length) return null;
  const action = 'bg-white text-red-700 border-white hover:bg-red-50 hover:border-red-50';
  return (
    <div className="space-y-2 bg-red-700 px-4 py-3 text-white sm:px-6 lg:px-8 print:hidden" role="alert">
      {items.map((s) => (
        <div key={s.id} className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <span className="inline-flex items-center gap-2 font-semibold">
            <Siren className="h-5 w-5 animate-pulse" aria-hidden /> SOS — {s.full_name}
          </span>
          <span className="text-sm text-red-50">
            {ago(s.created_at)}
            {s.message ? ` · “${s.message}”` : ''}
            {s.workplace_name ? ` · ${s.workplace_name}` : ''}
            {s.status === 'ACKNOWLEDGED' ? ` · being handled by ${s.acknowledged_by_name}` : ''}
          </span>
          <span className="ml-auto flex flex-wrap gap-2">
            {s.latitude != null && (
              <a className="inline-flex h-8 items-center gap-1 rounded-md bg-white/15 px-3 text-sm hover:bg-white/25" href={`https://www.google.com/maps?q=${s.latitude},${s.longitude}`} target="_blank" rel="noreferrer">
                <MapPin className="h-4 w-4" aria-hidden /> Location
              </a>
            )}
            {s.employee_phone && (
              <a className="inline-flex h-8 items-center gap-1 rounded-md bg-white/15 px-3 text-sm hover:bg-white/25" href={`tel:${s.employee_phone}`}>
                <Phone className="h-4 w-4" aria-hidden /> Call
              </a>
            )}
            {s.status === 'OPEN' ? (
              <Button size="sm" className={action} loading={ack.isPending && ack.variables === s.id} onClick={() => ack.mutate(s.id)}>I’m handling it</Button>
            ) : (
              <Button size="sm" className={action} onClick={() => setClosing(s)}>Close…</Button>
            )}
          </span>
        </div>
      ))}
      <Modal open={!!closing} onOpenChange={(o) => !o && setClosing(null)} title={closing ? `Close SOS from ${closing.full_name}` : ''} description="Record what happened. The note is kept with the SOS.">
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); resolve.mutate({ id: closing.id, note: note.trim() }); }}>
          <Field label="What happened?" required>
            <Textarea required minLength={3} value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          <InlineError error={resolve.error} />
          <div className="flex justify-end gap-2">
            <Button type="button" onClick={() => setClosing(null)}>Cancel</Button>
            <Button type="submit" variant="primary" loading={resolve.isPending}>Close SOS</Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
