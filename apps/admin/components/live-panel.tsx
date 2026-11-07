'use client';
/**
 * The panel beside the Live map: the people on shift (and, optionally, rostered people not yet
 * checked in) and, once someone is selected, their live details.
 */
import { useEffect, useState } from 'react';
import { ArrowLeft, ExternalLink } from 'lucide-react';
import { MARKER_STYLE, BODY_STYLE, LOCATION_GROUPS, initialsOf, kindFor } from './maps/markers';
import { ago, fmtTime, metres, minutes } from '@/lib/format';
import { Badge, Button, KeyValue, SearchInput, SimBadge, cx } from './ui';
import { BatteryBadge, StateBadge } from './state-badge';
import { SessionTimeline } from './session-timeline';

export function useNow(ms = 5000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

const geofenceText = (s: any) => {
  if (!s.last_classification || s.ended_at) return '—';
  if (s.is_stale) return `Unknown — last reading ${s.last_classification.toLowerCase()}`;
  return s.last_classification === 'INSIDE' ? 'Inside the workplace area' : s.last_classification === 'OUTSIDE' ? 'Outside the workplace area' : 'Uncertain (GPS accuracy too low to decide)';
};

/**
 * Which of the distinct location situations applies — never collapsed into one "offline": missing
 * permission, interrupted updates, no reading yet, stale, outside, inside, or too inaccurate to decide.
 */
export function locationStatus(s: any): { label: string; tone: 'green' | 'amber' | 'red' | 'gray' } {
  if (s.ended_at) return { label: 'Shift ended — last known position', tone: 'gray' };
  if (s.state === 'TRACKING_PERMISSION_REQUIRED' || (s.foreground_permission && s.foreground_permission !== 'granted')) return { label: 'Location permission missing on the phone', tone: 'red' };
  if (s.location_services_enabled === false) return { label: 'Location services switched off on the phone', tone: 'red' };
  if (s.state === 'TRACKING_INTERRUPTED') return { label: 'GPS updates stopped (tracking interrupted)', tone: 'red' };
  if (!s.last_location_at) return { label: 'No GPS reading received yet', tone: 'gray' };
  if (s.is_stale) return { label: 'Stale — no fresh update; showing last known position', tone: 'amber' };
  if (s.last_classification === 'OUTSIDE') return { label: 'Fresh update, outside the geofence', tone: 'amber' };
  if (s.last_classification === 'INSIDE') return { label: 'Fresh update, verified inside the geofence', tone: 'green' };
  return { label: 'Fresh update, but GPS accuracy too low to decide', tone: 'amber' };
}

/** "Live 2 min ago" / "Last known 40 min ago" / "No location yet", with the matching tone. */
export function Freshness({ s, now }: { s: any; now: number }) {
  if (!s.last_location_at) return <span className="text-gray-500">No location yet</span>;
  const live = !s.is_stale && !s.ended_at;
  return <span className={live ? 'text-teal-700' : 'text-gray-500'}>{live ? 'Live' : 'Last known'} · {ago(s.last_location_at, now)}</span>;
}

function Avatar({ s }: { s: any }) {
  const st = MARKER_STYLE[kindFor(s)];
  const body = BODY_STYLE[st.body];
  return (
    <span className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-caption font-bold" style={{ background: body.fill, color: body.text, border: st.body === 'hollow' ? '2px dashed #94a3b8' : undefined }} title={st.label} aria-hidden>
      {initialsOf(s.full_name)}
      <span className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-white" style={{ background: st.color }} />
    </span>
  );
}

export function SessionDetails({ s, now, onBack, onOpenEmployee }: { s: any; now: number; onBack: () => void; onOpenEmployee: (employeeId: string) => void }) {
  return (
    <>
      <div className="flex items-center gap-2 border-b border-gray-200 px-2 py-2">
        <Button size="sm" variant="ghost" onClick={onBack}>
          <ArrowLeft className="h-4 w-4" aria-hidden /> All people
        </Button>
        <Button size="sm" className="ml-auto" title="Employee record, with location history and day replay where you are allowed to see them" onClick={() => onOpenEmployee(s.employee_id)}>
          Record and location history <ExternalLink className="h-3.5 w-3.5" aria-hidden />
        </Button>
      </div>
      <div className="space-y-4 p-4">
        <div className="flex items-start gap-3">
          <Avatar s={s} />
          <div className="min-w-0">
            <h3 className="flex flex-wrap items-center gap-2 text-title font-semibold text-navy-900">
              {s.full_name} {s.is_simulated && <SimBadge />}
            </h3>
            <p className="text-xs text-gray-500">
              {s.employee_code} · {s.shift_name} · {s.workplace_name}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <StateBadge state={s.state} />
          {s.last_location_at && !s.is_stale && !s.ended_at ? (
            <Badge tone="green" title="Updates are arriving on time">Location live · {ago(s.last_location_at, now)}</Badge>
          ) : (
            <Badge tone="gray" title="No fresh update — this is where the phone last reported">{s.last_location_at ? `Last known · ${ago(s.last_location_at, now)}` : 'No location yet'}</Badge>
          )}
          {s.last_is_mocked && <Badge tone="red" title="The device reported a mock-location source. A risk indicator, not proof.">mock location reported</Badge>}
          <BatteryBadge level={s.last_battery_level} charging={s.last_battery_charging} lowPower={s.last_low_power_mode} />
          {s.last_network === 'none' && <Badge tone="amber">no internet at last upload</Badge>}
        </div>
        {(() => {
          const ls = locationStatus(s);
          return <Badge dot tone={ls.tone} className="whitespace-normal">{ls.label}</Badge>;
        })()}
        <KeyValue
          cols={1}
          items={[
            ['Shift', s.shift_name ?? '—'],
            ['Supervisor', s.supervisor_name ?? 'Not assigned'],
            ['Attendance', s.attendance_at ? `Checked in ${fmtTime(s.attendance_at)}${s.is_late ? ' (late)' : ''}` : 'Not recorded yet'],
            ['Geofence result', geofenceText(s)],
            ['Distance · GPS accuracy', s.last_distance_m != null ? `${metres(s.last_distance_m)} from the centre · ±${Math.round(s.last_accuracy_m ?? 0)} m reported by the phone` : '—'],
            ['Permitted area', s.radius_m ? `${s.workplace_name} · ${Math.round(s.radius_m)} m radius${s.last_distance_m != null ? ` · ${s.last_distance_m <= s.radius_m ? 'centre point within' : `${metres(s.last_distance_m - s.radius_m)} beyond`} the edge` : ''}` : '—'],
            ['Last location update', s.last_location_at ? `${fmtTime(s.last_location_at)} (received by the server)` : '—'],
            ...(s.break_since ? [['Break', `${s.break_label} · ${minutes(s.break_minutes)} of ${s.break_max_minutes} min${s.break_paid ? ' (paid)' : ' (unpaid)'}${s.break_overdue_at ? ' · over the limit' : ''}${s.break_left_at ? ` · left the area at ${fmtTime(s.break_left_at)}` : ' · inside the area'}`] as [string, string]] : []),
            ...(s.away_since ? [['Absence', `${minutes(s.away_minutes)} (alert at ${s.away_threshold} min)${s.tracking_gap ? ' · includes a tracking gap' : ''}`] as [string, string]] : []),
          ]}
        />
        <details className="rounded-md border border-gray-200">
          <summary className="cursor-pointer px-3 py-2 text-body-sm font-medium text-gray-700">Phone, permissions and coordinates</summary>
          <div className="border-t border-gray-200 p-3">
            <KeyValue
              cols={1}
              items={[
                ['Coordinates', s.last_latitude != null ? `${s.last_latitude.toFixed(6)}, ${s.last_longitude.toFixed(6)}` : 'No location yet'],
                ['Phone', s.last_device_status_at ? `battery ${s.last_battery_level != null ? Math.round(s.last_battery_level * 100) + '%' : '?'}${s.last_battery_charging ? ' (charging)' : ''} · network ${s.last_network ?? '?'} · reported ${ago(s.last_device_status_at, now)}` : 'Not reported (older app version)'],
                ['Permission', `foreground ${s.foreground_permission ?? '?'} · background ${s.background_permission ?? '?'}${s.location_services_enabled === false ? ' · location services OFF' : ''}`],
              ]}
            />
          </div>
        </details>
        <details className="rounded-md border border-gray-200">
          <summary className="cursor-pointer px-3 py-2 text-body-sm font-medium text-gray-700">Session timeline</summary>
          <div className="border-t border-gray-200 p-3">
            <SessionTimeline sessionId={s.id} />
          </div>
        </details>
      </div>
    </>
  );
}

function PeopleSection({ label, rows, selected, onSelect, now }: { label: string; rows: any[]; selected: string | null; onSelect: (id: string) => void; now: number }) {
  return (
    <>
      {label && <li className="sticky top-0 z-[1] bg-gray-50 px-3.5 py-1.5 text-caption font-semibold uppercase tracking-wider text-gray-500">{label} · {rows.length}</li>}
      {rows.map((s) => (
        <li key={s.id}>
          <button type="button" onClick={() => onSelect(s.id)} aria-pressed={selected === s.id} className={cx('flex w-full items-center gap-3 px-3.5 py-2.5 text-left text-sm transition-colors', selected === s.id ? 'bg-navy-800' : 'hover:bg-gray-50')}>
            <Avatar s={s} />
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5">
                <span className="truncate font-semibold text-gray-900">{s.full_name}</span>
                {s.is_simulated && <SimBadge />}
              </span>
              <span className="block truncate text-xs text-gray-500">
                {s.workplace_name}
                {s.shift_name ? ` · ${s.shift_name}` : ''}
              </span>
              <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <StateBadge state={s.state} />
                <span className="text-caption"><Freshness s={s} now={now} /></span>
              </span>
            </span>
          </button>
        </li>
      ))}
    </>
  );
}

/**
 * The list of people. `notIn` rows (rostered, no session) open the employee record; session rows
 * select the person on the map. `grouped` sections the list by location state.
 */
export function PeopleList({ sessions, notIn = [], selected, onSelect, onOpenEmployee, now, className, emptyText = 'Nobody in this view.', grouped }: { sessions: any[]; notIn?: any[]; selected: string | null; onSelect: (id: string) => void; onOpenEmployee: (employeeId: string) => void; now: number; className?: string; emptyText?: string; grouped?: boolean }) {
  const [find, setFind] = useState('');
  const match = (t: string) => !find || t.toLowerCase().includes(find.toLowerCase());
  const listed = sessions.filter((s) => match(`${s.full_name} ${s.employee_code} ${s.workplace_name ?? ''} ${s.supervisor_name ?? ''} ${s.shift_name ?? ''}`));
  const waiting = notIn.filter((r) => match(`${r.full_name} ${r.employee_code} ${r.workplace_name ?? ''}`));
  const sections = grouped
    ? LOCATION_GROUPS.map((g) => ({ ...g, rows: listed.filter((s) => g.kinds.includes(kindFor(s))) })).filter((g) => g.rows.length)
    : [{ key: 'all', label: '', filter: '', kinds: [], rows: listed }];
  return (
    <>
      {sessions.length + notIn.length > 5 && (
        <div className="border-b border-gray-200 px-3 py-2.5">
          <SearchInput aria-label="Find a person on shift" placeholder="Find a person, workplace or shift" value={find} onChange={(e) => setFind(e.target.value)} />
        </div>
      )}
      <ul className={cx('divide-y divide-gray-100 overflow-y-auto', className)}>
        {sections.map((g) => (
          <PeopleSection key={g.key} label={g.label} rows={g.rows} selected={selected} onSelect={onSelect} now={now} />
        ))}
        {waiting.length > 0 && (
          <>
            <li className="bg-gray-50 px-3.5 py-1.5 text-caption font-semibold uppercase tracking-wider text-gray-500">Not checked in · {waiting.length}</li>
            {waiting.map((r) => (
              <li key={`${r.employee_id}-${r.shift_id}`}>
                <button type="button" onClick={() => onOpenEmployee(r.employee_id)} className="flex w-full items-center gap-3 px-3.5 py-2.5 text-left text-sm hover:bg-gray-50">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border-2 border-dashed border-gray-300 text-caption font-bold text-gray-500" aria-hidden>{initialsOf(r.full_name)}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold text-gray-900">{r.full_name}</span>
                    <span className="block truncate text-xs text-gray-500">{r.workplace_name} · {String(r.start_time).slice(0, 5)}–{String(r.end_time).slice(0, 5)}</span>
                  </span>
                  {r.no_show ? <Badge dot tone="red">No-show</Badge> : <Badge dot tone="gray">Not started</Badge>}
                </button>
              </li>
            ))}
          </>
        )}
        {listed.length === 0 && waiting.length === 0 && <li className="px-4 py-10 text-center text-sm text-gray-500">{find ? `No one matches “${find}”.` : emptyText}</li>}
      </ul>
    </>
  );
}
