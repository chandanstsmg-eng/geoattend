'use client';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { get, patch, post, qs } from '@/lib/api';
import { DAY_NAMES } from '@/lib/format';
import { Badge, Button, Card, cx, DemoTag, EmptyState, Field, InlineError, Input, Modal, PageHeader, QueryState, Select, Table, Td, Th } from '@/components/ui';
import { WorkplaceSelect, useWorkplaces } from '@/components/filters';

export default function ShiftsPage() {
  const [workplaceId, setWorkplaceId] = useState('');
  const [editing, setEditing] = useState<any | null>(null);
  const list = useQuery({ queryKey: ['shifts', workplaceId], queryFn: () => get<any[]>(`/shifts${qs({ workplaceId })}`) });

  return (
    <>
      <PageHeader
        title="Shifts"
        description="Tracking is authorised only inside a shift window (from shortly before the start until shortly after the end — see Settings). Overnight shifts end the next day."
        actions={
          <>
            <WorkplaceSelect value={workplaceId} onChange={setWorkplaceId} />
            <Button variant="primary" onClick={() => setEditing({})}>
              <Plus className="h-4 w-4" aria-hidden /> New shift
            </Button>
          </>
        }
      />
      <Card padded={false}>
        <QueryState query={list} isEmpty={(d) => d.length === 0} empty={<EmptyState title="No shifts yet" />}>
          {(rows) => (
            <Table>
              <thead>
                <tr>
                  <Th>Shift</Th>
                  <Th>Workplace</Th>
                  <Th>Hours</Th>
                  <Th>Days</Th>
                  <Th>Grace</Th>
                  <Th>Absence alert</Th>
                  <Th>Employees</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => (
                  <tr key={s.id}>
                    <Td>
                      <span className="inline-flex items-center gap-1.5"><span className="font-medium text-gray-900">{s.name}</span>{s.is_demo && <DemoTag />}{!s.is_active && <Badge>Disabled</Badge>}</span>
                    </Td>
                    <Td className="text-gray-600">{s.workplace_name}</Td>
                    <Td className="tabular">
                      {s.start_time.slice(0, 5)}–{s.end_time.slice(0, 5)} <span className="text-xs text-gray-500">{s.timezone}</span>
                      {s.end_time <= s.start_time && <span className="ml-1 text-xs text-gray-500">(overnight)</span>}
                    </Td>
                    <Td className="text-xs">{s.days_of_week.map((d: number) => DAY_NAMES[d - 1]).join(' ')}</Td>
                    <Td className="tabular">{s.arrival_grace_minutes} min</Td>
                    <Td className="tabular">{s.absence_threshold_minutes ? `${s.absence_threshold_minutes} min` : <span className="text-gray-500">workplace default</span>}</Td>
                    <Td className="tabular">{s.employee_count}</Td>
                    <Td>
                      <Button size="sm" variant="ghost" onClick={() => setEditing(s)} aria-label={`Edit ${s.name}`}>
                        Edit
                      </Button>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </QueryState>
      </Card>
      {editing && <ShiftDialog shift={editing} onClose={() => setEditing(null)} />}
    </>
  );
}

/** Matches the server rule: longer shifts need explicit confirmation. */
const LONG_SHIFT_HOURS = 16;
const shiftHours = (start: string, end: string) => {
  const m = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  const d = m(end) - m(start);
  return (d > 0 ? d : d + 1440) / 60;
};
/** Some browsers still report legacy zone names; the server stores the current one. */
const canonicalZone = (tz: string) => (tz === 'Asia/Calcutta' ? 'Asia/Kolkata' : tz);

function ShiftDialog({ shift, onClose }: { shift: any; onClose: () => void }) {
  const qc = useQueryClient();
  const wps = useWorkplaces();
  const isNew = !shift.id;
  const [f, setF] = useState({
    workplaceId: shift.workplace_id ?? '',
    name: shift.name ?? '',
    startTime: shift.start_time?.slice(0, 5) ?? '09:00',
    endTime: shift.end_time?.slice(0, 5) ?? '17:00',
    timezone: shift.timezone ?? canonicalZone(Intl.DateTimeFormat().resolvedOptions().timeZone),
    daysOfWeek: (shift.days_of_week as number[]) ?? [1, 2, 3, 4, 5],
    arrivalGraceMinutes: shift.arrival_grace_minutes ?? 10,
    absenceThresholdMinutes: shift.absence_threshold_minutes ?? ('' as number | ''),
    isActive: shift.is_active ?? true,
  });
  const hours = shiftHours(f.startTime, f.endTime);
  const long = hours > LONG_SHIFT_HOURS;
  const [confirmLong, setConfirmLong] = useState(false);
  const save = useMutation({ meta: { success: 'Shift saved' },
    mutationFn: () => {
      const body = { ...f, absenceThresholdMinutes: f.absenceThresholdMinutes === '' ? null : Number(f.absenceThresholdMinutes), ...(long ? { confirmLongShift: confirmLong } : {}) };
      if (isNew) {
        const { isActive: _a, ...create } = body;
        return post('/shifts', create);
      }
      const { workplaceId: _w, ...upd } = body;
      return patch(`/shifts/${shift.id}`, upd);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['shifts'] });
      onClose();
    },
  });
  const toggleDay = (d: number) => setF({ ...f, daysOfWeek: f.daysOfWeek.includes(d) ? f.daysOfWeek.filter((x) => x !== d) : [...f.daysOfWeek, d].sort() });
  const onWorkplace = (id: string) => {
    const w = wps.data?.find((x: any) => x.id === id);
    setF({ ...f, workplaceId: id, timezone: w?.timezone ?? f.timezone, arrivalGraceMinutes: w?.default_grace_minutes ?? f.arrivalGraceMinutes });
  };

  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={isNew ? 'New shift' : `Edit ${shift.name}`}>
      <form className="grid gap-3 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <div className="sm:col-span-2">
          <Field label="Workplace">
            <Select required value={f.workplaceId} onChange={(e) => onWorkplace(e.target.value)} disabled={!isNew}>
              <option value="">Select…</option>
              {wps.data?.map((w: any) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </Select>
          </Field>
        </div>
        <div className="sm:col-span-2"><Field label="Name"><Input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field></div>
        <Field label="Start"><Input type="time" required value={f.startTime} onChange={(e) => setF({ ...f, startTime: e.target.value })} /></Field>
        <Field label="End" hint={f.endTime <= f.startTime ? 'Ends the next day (overnight).' : undefined}><Input type="time" required value={f.endTime} onChange={(e) => setF({ ...f, endTime: e.target.value })} /></Field>
        {long && (
          <div className="sm:col-span-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            <p>This shift is <strong>{Math.round(hours * 10) / 10} hours</strong> long. Lateness is measured from its start and overtime from its end, so an all-day window makes every arrival look hours late.</p>
            <label className="mt-2 flex items-center gap-2 font-medium">
              <input type="checkbox" checked={confirmLong} onChange={(e) => setConfirmLong(e.target.checked)} /> I confirm a shift over {LONG_SHIFT_HOURS} hours is intended
            </label>
          </div>
        )}
        <div className="sm:col-span-2"><Field label="Time zone"><Input required value={f.timezone} onChange={(e) => setF({ ...f, timezone: e.target.value })} /></Field></div>
        <fieldset className="sm:col-span-2">
          <legend className="mb-1 text-xs font-medium text-gray-700">Days</legend>
          <div className="flex flex-wrap gap-1.5">
            {DAY_NAMES.map((d, i) => (
              <button type="button" key={d} aria-pressed={f.daysOfWeek.includes(i + 1)} onClick={() => toggleDay(i + 1)} className={cx('h-8 w-12 rounded-md border text-sm', f.daysOfWeek.includes(i + 1) ? 'border-navy-800 bg-navy-800 text-white' : 'border-gray-300 bg-white text-gray-700')}>
                {d}
              </button>
            ))}
          </div>
        </fieldset>
        <Field label="Arrival grace (min)"><Input type="number" min={0} max={240} value={f.arrivalGraceMinutes} onChange={(e) => setF({ ...f, arrivalGraceMinutes: Number(e.target.value) })} /></Field>
        <Field label="Absence alert (min)" hint="Empty = workplace default"><Input type="number" min={1} max={480} value={f.absenceThresholdMinutes} onChange={(e) => setF({ ...f, absenceThresholdMinutes: e.target.value === '' ? '' : Number(e.target.value) })} /></Field>
        {!isNew && (
          <label className="sm:col-span-2 flex items-center gap-2 text-sm">
            <input type="checkbox" checked={f.isActive} onChange={(e) => setF({ ...f, isActive: e.target.checked })} /> Shift is active
          </label>
        )}
        <div className="sm:col-span-2"><InlineError error={save.error} /></div>
        <div className="sm:col-span-2 flex justify-end gap-2">
          <Button type="button" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!f.daysOfWeek.length || (long && !confirmLong)}>Save shift</Button>
        </div>
      </form>
    </Modal>
  );
}
