'use client';
import { useQuery } from '@tanstack/react-query';
import { get } from '@/lib/api';
import { Select } from './ui';

export function useWorkplaces() {
  return useQuery({ queryKey: ['workplaces'], queryFn: () => get<any[]>('/workplaces') });
}

export function useEmployees() {
  return useQuery({ queryKey: ['employees', 'all'], queryFn: () => get<any[]>('/employees?status=all') });
}

/** Supervisors of the company (owners only — the list is an owner endpoint). */
export function useSupervisors(enabled = true) {
  return useQuery({ queryKey: ['team'], queryFn: () => get<any[]>('/team'), enabled, select: (rows) => rows.filter((r) => r.access === 'SUPERVISOR' && r.is_active) });
}

export function SupervisorSelect({ value, onChange, allLabel = 'All supervisors' }: { value: string; onChange: (v: string) => void; allLabel?: string }) {
  const sups = useSupervisors();
  return (
    <Select aria-label="Supervisor" value={value} onChange={(e) => onChange(e.target.value)} className="w-auto min-w-44">
      <option value="">{allLabel}</option>
      {sups.data?.map((s) => (
        <option key={s.id} value={s.id}>
          {s.full_name}
        </option>
      ))}
    </Select>
  );
}

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export const RANGE_PRESETS = [
  { key: 'today', label: 'Today', range: () => ({ from: iso(new Date()), to: iso(new Date()) }) },
  { key: '7d', label: 'Last 7 days', range: () => ({ from: iso(new Date(Date.now() - 6 * 86400_000)), to: iso(new Date()) }) },
  { key: '14d', label: 'Last 14 days', range: () => ({ from: iso(new Date(Date.now() - 13 * 86400_000)), to: iso(new Date()) }) },
  { key: '30d', label: 'Last 30 days', range: () => ({ from: iso(new Date(Date.now() - 29 * 86400_000)), to: iso(new Date()) }) },
  { key: 'month', label: 'This month', range: () => { const n = new Date(); return { from: iso(new Date(n.getFullYear(), n.getMonth(), 1)), to: iso(n) }; } },
  { key: 'lastMonth', label: 'Last month', range: () => { const n = new Date(); return { from: iso(new Date(n.getFullYear(), n.getMonth() - 1, 1)), to: iso(new Date(n.getFullYear(), n.getMonth(), 0)) }; } },
] as const;

export type DateRangeValue = { preset: string; from: string; to: string };
export const defaultRange = (preset = '14d'): DateRangeValue => ({ preset, ...RANGE_PRESETS.find((p) => p.key === preset)!.range() });

/** Preset ranges plus a custom from–to. */
export function DateRangeSelect({ value, onChange }: { value: DateRangeValue; onChange: (v: DateRangeValue) => void }) {
  return (
    <>
      <Select aria-label="Date range" value={value.preset} onChange={(e) => (e.target.value === 'custom' ? onChange({ ...value, preset: 'custom' }) : onChange(defaultRange(e.target.value)))} className="w-auto min-w-40">
        {RANGE_PRESETS.map((p) => (
          <option key={p.key} value={p.key}>{p.label}</option>
        ))}
        <option value="custom">Custom range…</option>
      </Select>
      {value.preset === 'custom' && (
        <>
          <input type="date" aria-label="From" value={value.from} max={value.to} onChange={(e) => e.target.value && onChange({ ...value, from: e.target.value })} className="h-10 rounded-md border border-gray-300 bg-white px-2 text-sm sm:h-9.5" />
          <input type="date" aria-label="To" value={value.to} min={value.from} onChange={(e) => e.target.value && onChange({ ...value, to: e.target.value })} className="h-10 rounded-md border border-gray-300 bg-white px-2 text-sm sm:h-9.5" />
        </>
      )}
    </>
  );
}

export function WorkplaceSelect({ value, onChange, allLabel = 'All workspaces' }: { value: string; onChange: (v: string) => void; allLabel?: string }) {
  const wps = useWorkplaces();
  return (
    <Select aria-label="Workspace" value={value} onChange={(e) => onChange(e.target.value)} className="w-auto min-w-44">
      <option value="">{allLabel}</option>
      {wps.data?.map((w) => (
        <option key={w.id} value={w.id}>
          {w.name}
          {w.is_active ? '' : ' (disabled)'}
        </option>
      ))}
    </Select>
  );
}

export function EmployeeSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const emps = useEmployees();
  return (
    <Select aria-label="Employee" value={value} onChange={(e) => onChange(e.target.value)} className="w-auto min-w-44">
      <option value="">All employees</option>
      {emps.data?.map((e) => (
        <option key={e.id} value={e.id}>
          {e.full_name} ({e.employee_code})
        </option>
      ))}
    </Select>
  );
}
