'use client';
/**
 * Day replay: a shift on a map-like diagram with a time slider — the route so far, the
 * position and its GPS accuracy at that moment, the state, and the arrival / exit /
 * return events. Settles "I was there" disputes in seconds. Loading it is audited
 * (it reads raw location history).
 */
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Pause, Play } from 'lucide-react';
import { STATE_LABELS, toLocalMeters, type SessionState } from '@geoattend/shared';
import { get } from '@/lib/api';
import { fmtTime, metres } from '@/lib/format';
import { Badge, Button, QueryState } from './ui';

const EVENT_LABEL: Record<string, string> = {
  ENTRY_VERIFIED: 'Arrived',
  EXIT_VERIFIED: 'Left the area',
  RETURN_VERIFIED: 'Came back',
  LEFT_BEFORE_ATTENDANCE: 'Left before attendance',
};

export function DayReplay({ sessionId }: { sessionId: string }) {
  const data = useQuery({
    queryKey: ['replay', sessionId],
    queryFn: async () => {
      const [status, locations, timeline] = await Promise.all([get(`/tracking/sessions/${sessionId}`), get<any[]>(`/tracking/sessions/${sessionId}/locations`), get(`/tracking/sessions/${sessionId}/timeline`)]);
      return { status, locations, timeline };
    },
  });
  return <QueryState query={data}>{(d: any) => <Replay {...d} />}</QueryState>;
}

function Replay({ status, locations, timeline }: { status: any; locations: any[]; timeline: any }) {
  const wp = status.workplace;
  const pts = useMemo(
    () => locations.map((l) => ({ ...l, t: Date.parse(l.client_time), ...toLocalMeters({ lat: wp.latitude, lng: wp.longitude }, { lat: l.latitude, lng: l.longitude }) })).sort((a, b) => a.t - b.t),
    [locations, wp],
  );
  const events = useMemo(
    () => [
      ...timeline.geofenceEvents.filter((e: any) => EVENT_LABEL[e.event_type]).map((e: any) => ({ t: Date.parse(e.event_time), label: EVENT_LABEL[e.event_type], kind: e.event_type })),
      ...(status.attendance ? [{ t: Date.parse(status.attendance.recordedAt), label: `Attendance marked${status.attendance.isLate ? ` (late ${status.attendance.lateByMinutes} min)` : ''}`, kind: 'ATTENDANCE' }] : []),
    ].sort((a, b) => a.t - b.t),
    [timeline, status],
  );
  const [i, setI] = useState(pts.length - 1);
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => setI((x) => (x >= pts.length - 1 ? (setPlaying(false), x) : x + 1)), 120);
    return () => clearInterval(timer);
  }, [playing, pts.length]);

  if (!pts.length) return <p className="text-sm text-gray-500">No locations were recorded for this shift.</p>;
  const cur = pts[Math.max(0, i)]!;
  const state = [...timeline.transitions].reverse().find((tr: any) => Date.parse(tr.at) <= cur.t)?.to_state as SessionState | undefined;

  // Drawing: metres around the workplace centre, north up.
  const extent = Math.max(wp.radiusM * 2.2, ...pts.map((p) => Math.hypot(p.x, p.y) * 1.15), 60);
  const size = 400;
  const k = size / 2 / extent;
  const X = (x: number) => size / 2 + x * k;
  const Y = (y: number) => size / 2 - y * k;
  const path = pts.slice(0, i + 1).map((p) => `${X(p.x)},${Y(p.y)}`).join(' ');
  const inside = cur.classification === 'INSIDE';
  const t0 = pts[0]!.t;
  const span = Math.max(1, pts[pts.length - 1]!.t - t0);
  const jumpTo = (t: number) => setI(Math.max(0, pts.findIndex((p) => p.t >= t)));

  return (
    <div className="space-y-3">
      <div className="relative overflow-hidden rounded-md border border-gray-200 bg-[repeating-linear-gradient(0deg,#f8fafc,#f8fafc_19px,#eef2f7_20px),repeating-linear-gradient(90deg,transparent,transparent_19px,#eef2f7_20px)]">
        <svg viewBox={`0 0 ${size} ${size}`} className="mx-auto block h-auto w-full max-w-md" role="img" aria-label="Replay of the shift around the workplace">
          <circle cx={size / 2} cy={size / 2} r={wp.radiusM * k} fill="#1668a0" fillOpacity={0.1} stroke="#1668a0" strokeWidth={2} />
          <text x={size / 2 + 6} y={size / 2 - 6} fontSize={10} fill="#083e5a">{wp.name}</text>
          <polyline points={path} fill="none" stroke="#344a8c" strokeWidth={2} strokeOpacity={0.6} strokeLinejoin="round" />
          {pts.slice(0, i + 1).map((p) => <circle key={p.id} cx={X(p.x)} cy={Y(p.y)} r={1.8} fill="#344a8c" />)}
          <circle cx={X(cur.x)} cy={Y(cur.y)} r={Math.max(3, cur.accuracy_m * k)} fill={inside ? '#0d9488' : '#d97706'} fillOpacity={0.15} stroke={inside ? '#0d9488' : '#d97706'} />
          <circle cx={X(cur.x)} cy={Y(cur.y)} r={7} fill={inside ? '#0d9488' : '#d97706'} stroke="#fff" strokeWidth={2} />
          <text x={size - 12} y={20} fontSize={11} textAnchor="end" fill="#374151">N ↑</text>
        </svg>
        <div className="absolute left-2 top-2 rounded bg-white/90 px-2 py-1 text-xs ring-1 ring-gray-200">
          <p className="font-semibold tabular text-gray-900">{fmtTime(new Date(cur.t))}</p>
          <p className="text-gray-600">{metres(cur.distance_m)} from centre · ±{Math.round(cur.accuracy_m)} m</p>
          {state && <Badge tone={inside ? 'green' : 'amber'}>{STATE_LABELS[state] ?? state}</Badge>}
          {cur.is_mocked && <Badge tone="red">mock location</Badge>}
        </div>
      </div>

      <div className="flex items-center gap-3">
        <Button size="sm" variant="primary" aria-label={playing ? 'Pause' : 'Play'} onClick={() => { if (i >= pts.length - 1) setI(0); setPlaying(!playing); }}>
          {playing ? <Pause className="h-4 w-4" aria-hidden /> : <Play className="h-4 w-4" aria-hidden />}
        </Button>
        <div className="relative flex-1">
          <input type="range" min={0} max={pts.length - 1} value={i} onChange={(e) => { setPlaying(false); setI(Number(e.target.value)); }} className="w-full accent-navy-800" aria-label="Time in the shift" />
          {events.map((e) => (
            <span key={`${e.kind}-${e.t}`} className="pointer-events-none absolute top-5 h-2 w-0.5 bg-navy-700" style={{ left: `${((e.t - t0) / span) * 100}%` }} aria-hidden />
          ))}
        </div>
        <span className="w-20 text-right text-xs tabular text-gray-500">{fmtTime(new Date(pts[pts.length - 1]!.t))}</span>
      </div>

      <ol className="flex flex-wrap gap-2 text-xs">
        {events.map((e) => (
          <li key={`${e.kind}-${e.t}`}>
            <button className="rounded-full bg-gray-100 px-2.5 py-1 hover:bg-gray-200" onClick={() => { setPlaying(false); jumpTo(e.t); }}>
              <span className="tabular">{fmtTime(new Date(e.t))}</span> · {e.label}
            </button>
          </li>
        ))}
      </ol>
      <p className="text-caption text-gray-500">Schematic view (not a street map): positions are drawn to scale around the workplace centre. {pts.length} readings. Viewing locations is recorded in the audit log.</p>
    </div>
  );
}
