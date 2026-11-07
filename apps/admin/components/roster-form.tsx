'use client';
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { get, post, qs } from '@/lib/api';
import { todayISO } from '@/lib/format';
import { Button, Field, InlineError, Input, Select, Textarea } from './ui';
import { useWorkplaces } from './filters';
import { useMe } from '@/lib/me';

const CUSTOM = '__custom__';

function plusDays(iso: string, n: number) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Adds one roster entry for an employee: where (workplace), when (shift or custom times, and
 * dates) and under whom (manager). Custom times create a shift at that workplace first.
 * The server refuses entries that clash with the employee's other entries.
 */
export function RosterEntryForm({
  employeeId,
  defaultWorkplaceId,
  defaultFrom,
  onDone,
  onCancel,
}: {
  employeeId: string;
  defaultWorkplaceId?: string | null;
  defaultFrom?: string;
  onDone: () => void;
  onCancel?: () => void;
}) {
  const qc = useQueryClient();
  const wps = useWorkplaces();
  // A custom time creates a new shift, which only the owner may do.
  const { isOwner } = useMe();
  const [workplaceId, setWorkplaceId] = useState(defaultWorkplaceId ?? '');
  const [shiftId, setShiftId] = useState('');
  const [custom, setCustom] = useState({ start: '09:00', end: '18:00' });
  const [managerId, setManagerId] = useState('');
  const [from, setFrom] = useState(defaultFrom ?? todayISO());
  const [length, setLength] = useState<'day' | 'week' | 'until' | 'open'>('day');
  const [to, setTo] = useState(defaultFrom ?? todayISO());
  const [notes, setNotes] = useState('');

  const active = (wps.data ?? []).filter((w: any) => w.is_active);
  useEffect(() => {
    if (!workplaceId && active.length === 1) setWorkplaceId(active[0].id);
  }, [active, workplaceId]);

  const shifts = useQuery({ queryKey: ['shifts', workplaceId], queryFn: () => get<any[]>(`/shifts${qs({ workplaceId })}`), enabled: !!workplaceId });
  const managers = useQuery({ queryKey: ['roster', 'managers', workplaceId], queryFn: () => get<any[]>(`/roster/managers${qs({ workplaceId })}`), enabled: !!workplaceId });
  const wp = active.find((w: any) => w.id === workplaceId);

  const effectiveTo = length === 'day' ? from : length === 'week' ? plusDays(from, 6) : length === 'until' ? to : null;

  const save = useMutation({ meta: { success: 'Roster saved' },
    mutationFn: async () => {
      let id = shiftId;
      // Reuse a shift with the same times at this workplace rather than piling up identical ones.
      const same = shifts.data?.find((s) => s.is_active && s.start_time.slice(0, 5) === custom.start && s.end_time.slice(0, 5) === custom.end && s.days_of_week.length === 7);
      if (shiftId === CUSTOM && same) id = same.id;
      else if (shiftId === CUSTOM) {
        const s = await post('/shifts', {
          workplaceId,
          name: `${custom.start}–${custom.end}`,
          startTime: custom.start,
          endTime: custom.end,
          timezone: wp?.timezone ?? 'Asia/Kolkata',
          daysOfWeek: [1, 2, 3, 4, 5, 6, 7], // the roster dates decide which days are worked
        });
        id = s.id;
      }
      return post(`/employees/${employeeId}/shifts`, { shiftId: id, effectiveFrom: from, effectiveTo, managerId: managerId || null, notes: notes.trim() || null });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['roster'] });
      qc.invalidateQueries({ queryKey: ['shifts'] });
      onDone();
    },
  });

  const ready = workplaceId && shiftId && from && (length !== 'until' || (to && to >= from)) && (shiftId !== CUSTOM || custom.start !== custom.end);

  return (
    <form
      className="space-y-3"
      onSubmit={(ev) => {
        ev.preventDefault();
        save.mutate();
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Workplace">
          <Select required value={workplaceId} onChange={(ev) => { setWorkplaceId(ev.target.value); setShiftId(''); setManagerId(''); }}>
            <option value="">Choose…</option>
            {active.map((w: any) => (
              <option key={w.id} value={w.id}>{w.name}</option>
            ))}
          </Select>
        </Field>
        <Field label="Manager" hint="Gets this employee’s alerts for these days.">
          <Select value={managerId} onChange={(ev) => setManagerId(ev.target.value)} disabled={!workplaceId}>
            <option value="">No specific manager</option>
            {managers.data?.map((m: any) => (
              <option key={m.id} value={m.id}>{m.full_name}{m.access === 'OWNER' ? ' (owner)' : ''}</option>
            ))}
          </Select>
        </Field>
        <Field label="Shift">
          <Select required value={shiftId} onChange={(ev) => setShiftId(ev.target.value)} disabled={!workplaceId}>
            <option value="">Choose…</option>
            {shifts.data?.filter((s) => s.is_active).map((s) => (
              <option key={s.id} value={s.id}>{s.name} ({s.start_time.slice(0, 5)}–{s.end_time.slice(0, 5)})</option>
            ))}
            {isOwner && <option value={CUSTOM}>Custom time…</option>}
          </Select>
        </Field>
        {shiftId === CUSTOM ? (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Starts"><Input type="time" required value={custom.start} onChange={(ev) => setCustom({ ...custom, start: ev.target.value })} /></Field>
            <Field label="Ends" hint={custom.end <= custom.start ? 'Ends the next day' : undefined}><Input type="time" required value={custom.end} onChange={(ev) => setCustom({ ...custom, end: ev.target.value })} /></Field>
          </div>
        ) : (
          <div className="hidden sm:block" />
        )}
        <Field label="From">
          <Input type="date" required value={from} onChange={(ev) => setFrom(ev.target.value)} />
        </Field>
        <Field label="For">
          <Select value={length} onChange={(ev) => setLength(ev.target.value as typeof length)}>
            <option value="day">This day only</option>
            <option value="week">One week (7 days)</option>
            <option value="until">Until a date…</option>
            <option value="open">Until changed</option>
          </Select>
        </Field>
        {length === 'until' && (
          <Field label="To (including)">
            <Input type="date" required min={from} value={to} onChange={(ev) => setTo(ev.target.value)} />
          </Field>
        )}
      </div>
      <Field label="Work assignment" hint="Optional. Shown to the worker in their app.">
        <Textarea rows={2} maxLength={500} value={notes} onChange={(ev) => setNotes(ev.target.value)} placeholder="e.g. Unload deliveries at bay 3" />
      </Field>
      <InlineError error={save.error} />
      <div className="flex justify-end gap-2">
        {onCancel && <Button type="button" onClick={onCancel}>Cancel</Button>}
        <Button type="submit" variant="primary" disabled={!ready} loading={save.isPending}>Add to roster</Button>
      </div>
    </form>
  );
}

const RESULT_TEXT: Record<string, string> = { OUTSIDE_HOME_WORKPLACE: 'rostered away from their home workplace' };

/**
 * Rosters several workers on one shift for a date range. Each worker succeeds or fails on its
 * own (clashing entries, workers or workplaces outside the user's scope); the result lists both.
 */
export function BulkAssignForm({ defaultWorkplaceId, defaultFrom, onDone, onCancel }: { defaultWorkplaceId?: string; defaultFrom?: string; onDone: () => void; onCancel: () => void }) {
  const qc = useQueryClient();
  const wps = useWorkplaces();
  const active = (wps.data ?? []).filter((w: any) => w.is_active);
  const [workplaceId, setWorkplaceId] = useState(defaultWorkplaceId ?? '');
  const [shiftId, setShiftId] = useState('');
  const [managerId, setManagerId] = useState('');
  const [from, setFrom] = useState(defaultFrom ?? todayISO());
  const [to, setTo] = useState(plusDays(defaultFrom ?? todayISO(), 6));
  const [notes, setNotes] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [find, setFind] = useState('');
  useEffect(() => {
    if (!workplaceId && active.length === 1) setWorkplaceId(active[0].id);
  }, [active, workplaceId]);
  const shifts = useQuery({ queryKey: ['shifts', workplaceId], queryFn: () => get<any[]>(`/shifts${qs({ workplaceId })}`), enabled: !!workplaceId });
  const managers = useQuery({ queryKey: ['roster', 'managers', workplaceId], queryFn: () => get<any[]>(`/roster/managers${qs({ workplaceId })}`), enabled: !!workplaceId });
  const employees = useQuery({ queryKey: ['employees', 'active'], queryFn: () => get<any[]>('/employees?status=active') });
  // This workplace's own workers first, then everyone else the user can see.
  const people = (employees.data ?? [])
    .filter((e) => !find || `${e.full_name} ${e.employee_code}`.toLowerCase().includes(find.toLowerCase()))
    .sort((a, b) => Number(b.workplace_id === workplaceId) - Number(a.workplace_id === workplaceId) || a.full_name.localeCompare(b.full_name));
  const save = useMutation({ meta: { success: 'Workers rostered' },
    mutationFn: () => post('/roster/bulk', { employeeIds: [...picked], shiftId, effectiveFrom: from, effectiveTo: to, managerId: managerId || null, notes: notes.trim() || null }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['roster'] });
      qc.invalidateQueries({ queryKey: ['employees'] });
    },
  });
  const nameOf = (id: string) => employees.data?.find((e) => e.id === id)?.full_name ?? id;
  const toggle = (id: string) => setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  if (save.data) {
    const r = save.data as any;
    return (
      <div className="space-y-3">
        <p className="text-sm text-gray-800"><strong>{r.created}</strong> rostered{r.failed ? <>, <strong className="text-red-700">{r.failed}</strong> not rostered</> : ''}.</p>
        <ul className="max-h-72 divide-y divide-gray-100 overflow-y-auto rounded-md border border-gray-200 text-sm">
          {r.results.map((x: any) => (
            <li key={x.employeeId} className="flex items-start gap-2 px-3 py-2">
              <span className={x.ok ? 'text-teal-700' : 'text-red-700'} aria-hidden>{x.ok ? '✓' : '✕'}</span>
              <span className="min-w-0 flex-1">
                <span className="font-medium text-gray-900">{nameOf(x.employeeId)}</span>
                {x.error && <span className="block text-xs text-red-700">{x.error}</span>}
                {x.warning && <span className="block text-xs text-amber-800">Note: {RESULT_TEXT[x.warning] ?? x.warning}</span>}
              </span>
            </li>
          ))}
        </ul>
        <div className="flex justify-end gap-2">
          {r.failed > 0 && <Button onClick={() => save.reset()}>Back</Button>}
          <Button variant="primary" onClick={onDone}>Done</Button>
        </div>
      </div>
    );
  }

  return (
    <form className="space-y-4" onSubmit={(ev) => { ev.preventDefault(); save.mutate(); }}>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="1. Workplace">
          <Select required value={workplaceId} onChange={(ev) => { setWorkplaceId(ev.target.value); setShiftId(''); setManagerId(''); }}>
            <option value="">Choose…</option>
            {active.map((w: any) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </Select>
        </Field>
        <Field label="2. Shift">
          <Select required value={shiftId} onChange={(ev) => setShiftId(ev.target.value)} disabled={!workplaceId}>
            <option value="">Choose…</option>
            {shifts.data?.filter((s) => s.is_active).map((s) => <option key={s.id} value={s.id}>{s.name} ({s.start_time.slice(0, 5)}–{s.end_time.slice(0, 5)})</option>)}
          </Select>
        </Field>
        <Field label="3. Supervisor">
          <Select value={managerId} onChange={(ev) => setManagerId(ev.target.value)} disabled={!workplaceId}>
            <option value="">No specific manager</option>
            {managers.data?.map((m: any) => <option key={m.id} value={m.id}>{m.full_name}{m.access === 'OWNER' ? ' (owner)' : ''}</option>)}
          </Select>
        </Field>
        <Field label="4. From"><Input type="date" required value={from} onChange={(ev) => { setFrom(ev.target.value); if (to < ev.target.value) setTo(ev.target.value); }} /></Field>
        <Field label="To (including)"><Input type="date" required min={from} value={to} onChange={(ev) => setTo(ev.target.value)} /></Field>
        <Field label="Work assignment" hint="Shown to the workers"><Input maxLength={500} value={notes} onChange={(ev) => setNotes(ev.target.value)} placeholder="Optional" /></Field>
      </div>
      <fieldset>
        <legend className="mb-1.5 flex w-full items-center justify-between text-body-sm font-medium text-gray-700">
          <span>5. Workers <span className="font-normal text-gray-500">({picked.size} selected)</span></span>
          {picked.size > 0 && <button type="button" className="text-xs font-medium text-primary-700 hover:underline" onClick={() => setPicked(new Set())}>Clear</button>}
        </legend>
        <Input type="search" aria-label="Find a worker" placeholder="Find a worker" value={find} onChange={(ev) => setFind(ev.target.value)} className="mb-2" />
        <ul className="max-h-60 divide-y divide-gray-100 overflow-y-auto rounded-md border border-gray-200">
          {people.map((e) => (
            <li key={e.id}>
              <label className="flex cursor-pointer items-center gap-2.5 px-3 py-2 text-sm hover:bg-gray-50">
                <input type="checkbox" checked={picked.has(e.id)} onChange={() => toggle(e.id)} />
                <span className="flex-1 truncate">{e.full_name} <span className="text-xs text-gray-500">{e.employee_code}</span></span>
                <span className={e.workplace_id === workplaceId ? 'text-xs text-gray-500' : 'text-xs text-amber-700'}>{e.workplace_name ?? 'no home workplace'}</span>
              </label>
            </li>
          ))}
          {people.length === 0 && <li className="px-3 py-4 text-center text-sm text-gray-500">No workers found.</li>}
        </ul>
      </fieldset>
      <InlineError error={save.error} />
      <div className="flex justify-end gap-2">
        <Button type="button" onClick={onCancel}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={!workplaceId || !shiftId || !picked.size || to < from} loading={save.isPending}>Assign {picked.size || ''} worker{picked.size === 1 ? '' : 's'}</Button>
      </div>
    </form>
  );
}
