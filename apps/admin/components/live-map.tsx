'use client';
/**
 * The workforce map shared by the dashboard and the Live map page: workplace geofences, one marker
 * per located session (body = navy / orange-for-attention / hollow-when-not-fresh, plus a status
 * dot), clustering when markers would overlap at the current zoom, a Google location search and
 * controls to fit everyone or jump to a workplace. The selected person is ringed in orange and the
 * map pans to them. Without a Google Maps key it falls back to the schematic diagram.
 */
import { useEffect, useMemo, useState } from 'react';
import { Maximize2, Search, X } from 'lucide-react';
import { ControlPosition, MapControl, useMap } from '@vis.gl/react-google-maps';
import { AdvancedMarker, GeofenceCircle, Map, MAP_ID, MapSetupNotice, MapsProvider, mapsConfigured, Pin, PlaceSearch, useMapsRefused } from './maps/google';
import { SchematicMap, SiteOverview } from './maps/schematic';
import { BODY_STYLE, MARKER_STYLE, initialsOf, kindFor } from './maps/markers';
import { Button, Select, cx } from './ui';

export interface MapWorkplace {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  radius_m?: number;
  radiusM?: number;
}

const radiusOf = (w: MapWorkplace) => Number(w.radius_m ?? w.radiusM ?? 100);

/** Web-Mercator world pixels at a zoom level (enough to measure on-screen distances). */
function project(lat: number, lng: number, zoom: number) {
  const s = Math.min(Math.max(Math.sin((lat * Math.PI) / 180), -0.9999), 0.9999);
  const scale = 256 * 2 ** zoom;
  return { x: ((lng + 180) / 360) * scale, y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * scale };
}

type Cluster = { lat: number; lng: number; members: any[] };

/** Greedy grouping of markers closer than `px` pixels at `zoom`. */
function cluster(points: any[], zoom: number, px = 40): Cluster[] {
  const out: Array<Cluster & { x: number; y: number }> = [];
  for (const p of points) {
    const q = project(p.last_latitude, p.last_longitude, zoom);
    const hit = out.find((c) => Math.hypot(c.x - q.x, c.y - q.y) < px);
    if (hit) hit.members.push(p);
    else out.push({ ...q, lat: p.last_latitude, lng: p.last_longitude, members: [p] });
  }
  return out;
}

const ctrlBtn = 'inline-flex h-9 items-center gap-1.5 rounded-md border border-gray-200 bg-white px-2.5 text-body-sm font-medium text-gray-800 shadow-sm hover:border-gray-300 hover:bg-gray-50';

function fitTo(map: google.maps.Map, pts: google.maps.LatLngLiteral[]) {
  if (!pts.length) return;
  if (pts.length === 1) {
    map.setCenter(pts[0]!);
    map.setZoom(17);
    return;
  }
  const b = new google.maps.LatLngBounds();
  pts.forEach((p) => b.extend(p));
  map.fitBounds(b, 56);
}

function Controls({ workplaces, located, search }: { workplaces: MapWorkplace[]; located: any[]; search: boolean }) {
  const map = useMap();
  const [found, setFound] = useState<google.maps.LatLngLiteral | null>(null);
  const [searching, setSearching] = useState(false);
  const all = () => [...located.map((s) => ({ lat: s.last_latitude, lng: s.last_longitude })), ...workplaces.map((w) => ({ lat: w.latitude, lng: w.longitude }))];
  // First view: the people on shift (fresh positions) and their workplaces, so two distant sites
  // do not zoom the map out to a whole state; "Fit all" shows everything.
  // A different set of workplaces (a filter) is a new view, so it fits again.
  const view = workplaces.map((w) => w.id).join();
  const [fitted, setFitted] = useState<string | null>(null);
  useEffect(() => {
    if (!map || fitted === view || !(located.length || workplaces.length)) return;
    // Prefer fresh positions, then any last-known positions, then the workplaces themselves.
    const live = located.filter((s) => !s.is_stale && !s.ended_at);
    const people = live.length ? live : located;
    // With nobody located, show the workplaces that have staff rather than every site in the company.
    const staffed = workplaces.filter((w: any) => (w.homeWorkers ?? w.home_workers ?? 1) > 0);
    const sites = people.length ? workplaces.filter((w) => people.some((s) => s.workplace_id === w.id)) : staffed.length ? staffed : workplaces;
    fitTo(map, [...people.map((s) => ({ lat: s.last_latitude, lng: s.last_longitude })), ...sites.map((w) => ({ lat: w.latitude, lng: w.longitude }))]);
    setFitted(view);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, located.length, view]);
  return (
    <>
      <MapControl position={ControlPosition.TOP_LEFT}>
        <div className="m-2.5 flex max-w-[calc(100vw-5rem)] flex-wrap items-start gap-1.5">
          <button type="button" onClick={() => map && fitTo(map, all())} className={ctrlBtn} title="Fit all people and workplaces">
            <Maximize2 className="h-3.5 w-3.5" aria-hidden /> Fit all
          </button>
          {workplaces.length > 1 && (
            <Select
              aria-label="Go to workplace"
              value=""
              onChange={(e) => {
                const w = workplaces.find((x) => x.id === e.target.value);
                if (w && map) {
                  map.setCenter({ lat: w.latitude, lng: w.longitude });
                  map.setZoom(18);
                }
              }}
              className="h-9 w-48 border-gray-200 bg-white text-body-sm shadow-sm"
            >
              <option value="">Go to workplace…</option>
              {workplaces.map((w) => (
                <option key={w.id} value={w.id}>{w.name}</option>
              ))}
            </Select>
          )}
          {search &&
            (searching ? (
              <div className="flex w-72 items-start gap-1 rounded-md border border-gray-200 bg-white p-1 shadow-sm">
                <div className="min-w-0 flex-1 [&_gmp-place-autocomplete]:w-full">
                  <PlaceSearch
                    onPlace={(p) => {
                      if (!map) return;
                      setFound({ lat: p.lat, lng: p.lng });
                      map.panTo({ lat: p.lat, lng: p.lng });
                      map.setZoom(17);
                    }}
                  />
                </div>
                <button type="button" onClick={() => { setSearching(false); setFound(null); }} className="rounded p-1.5 text-gray-500 hover:bg-gray-100" aria-label="Close location search">
                  <X className="h-4 w-4" aria-hidden />
                </button>
              </div>
            ) : (
              <button type="button" onClick={() => setSearching(true)} className={ctrlBtn} title="Search for a place or address">
                <Search className="h-3.5 w-3.5" aria-hidden /> Search location
              </button>
            ))}
        </div>
      </MapControl>
      {found && (
        <AdvancedMarker position={found} title="Search result">
          <Pin background="#64748b" borderColor="#36475a" glyphColor="#ffffff" />
        </AdvancedMarker>
      )}
    </>
  );
}

function PersonMarker({ s, selected }: { s: any; selected: boolean }) {
  const st = MARKER_STYLE[kindFor(s)];
  const body = BODY_STYLE[st.body];
  return (
    <div className="flex flex-col items-center" style={{ transform: selected ? 'scale(1.12)' : undefined, transformOrigin: 'bottom center' }}>
      <span className={cx('mb-1 max-w-28 truncate rounded px-1.5 py-0.5 text-caption font-semibold shadow-sm', selected ? 'bg-navy-800 text-white' : 'bg-white text-gray-900 ring-1 ring-gray-200')}>{s.full_name.split(' ')[0]}</span>
      <span
        className="relative flex h-8 w-8 items-center justify-center rounded-full text-caption font-bold shadow-md"
        style={{
          background: body.fill,
          color: body.text,
          border: st.body === 'hollow' ? `2px dashed ${body.border}` : `2px solid ${body.border}`,
          boxShadow: selected ? '0 0 0 3px #0b4f72, 0 2px 6px rgb(0 0 0 / 0.25)' : undefined,
          opacity: st.body === 'hollow' ? 0.9 : 1,
        }}
      >
        {initialsOf(s.full_name)}
        <span className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full ring-2 ring-white" style={{ background: st.color }} aria-hidden />
      </span>
    </div>
  );
}

function Markers({ located, selected, onSelect }: { located: any[]; selected: string | null; onSelect: (id: string) => void }) {
  const map = useMap();
  const [zoom, setZoom] = useState(17);
  useEffect(() => {
    if (!map) return;
    setZoom(map.getZoom() ?? 17);
    const l = map.addListener('zoom_changed', () => setZoom(map.getZoom() ?? 17));
    return () => l.remove();
  }, [map]);
  // Bring the selected person into view (from the list, a link or a marker click).
  useEffect(() => {
    if (!map || !selected) return;
    const s = located.find((x) => x.id === selected);
    if (!s) return;
    map.panTo({ lat: s.last_latitude, lng: s.last_longitude });
    if ((map.getZoom() ?? 0) < 16) map.setZoom(17);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, selected]);
  const groups = useMemo(() => cluster(located, zoom), [located, zoom]);
  return (
    <>
      {groups.map((g) => {
        const sel = g.members.find((m) => m.id === selected);
        if (g.members.length === 1) {
          const s = g.members[0];
          const st = MARKER_STYLE[kindFor(s)];
          return (
            <AdvancedMarker key={s.id} position={{ lat: s.last_latitude, lng: s.last_longitude }} onClick={() => onSelect(s.id)} title={`${s.full_name} — ${st.label}`} zIndex={selected === s.id ? 100 : st.body === 'attention' ? 20 : 10}>
              <PersonMarker s={s} selected={selected === s.id} />
            </AdvancedMarker>
          );
        }
        const attention = g.members.filter((m) => MARKER_STYLE[kindFor(m)].body === 'attention').length;
        return (
          <AdvancedMarker
            key={g.members.map((m) => m.id).join()}
            position={{ lat: g.lat, lng: g.lng }}
            title={`${g.members.length} people: ${g.members.map((m) => m.full_name).join(', ')}${attention ? ` — ${attention} need attention` : ''}`}
            zIndex={sel ? 100 : 30}
            onClick={() => {
              if (!map) return;
              map.setCenter({ lat: g.lat, lng: g.lng });
              map.setZoom(Math.min(21, zoom + 2));
            }}
          >
            <span className="relative flex h-10 w-10 items-center justify-center rounded-full bg-navy-800 text-body-sm font-bold text-white shadow-md ring-4 ring-navy-800/20" style={{ boxShadow: sel ? '0 0 0 3px #0b4f72' : undefined }}>
              {g.members.length}
              {attention > 0 && <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-600 px-1 text-[10px] font-bold text-white ring-2 ring-white">{attention}</span>}
            </span>
          </AdvancedMarker>
        );
      })}
    </>
  );
}

/** The states people scan for. Each says only what is known; the exact state is in the marker's tooltip and the side panel. */
const LEGEND: Array<{ label: string; body: keyof typeof BODY_STYLE; dot?: string; hint: string }> = [
  { label: 'Inside the zone', body: 'normal', dot: MARKER_STYLE.present.color, hint: 'A fresh position, verified inside the geofence' },
  { label: 'On break', body: 'normal', dot: MARKER_STYLE.break.color, hint: 'On a declared break' },
  { label: 'Not yet on site', body: 'normal', dot: MARKER_STYLE.arriving.color, hint: 'On shift, not verified inside the geofence yet' },
  { label: 'On overtime', body: 'normal', dot: MARKER_STYLE.overtime.color, hint: 'Overtime may be worked off-site, so this says nothing about the zone' },
  { label: 'Needs attention', body: 'attention', dot: MARKER_STYLE.away.color, hint: 'Away from the geofence, prolonged absence or manual review' },
  { label: 'Last known', body: 'hollow', hint: 'No fresh position: stale, location unavailable or shift ended. The marker is where the phone last reported, not where the person is now.' },
];

export function MapLegend({ className }: { className?: string }) {
  return (
    <details open className={cx('group text-xs text-gray-600', className)}>
      <summary className="inline-flex cursor-pointer select-none items-center gap-1 rounded-full border border-gray-200 bg-white px-2.5 py-1 font-medium text-gray-700 hover:bg-gray-50">
        Legend <span aria-hidden className="text-gray-500 group-open:rotate-180">▾</span>
      </summary>
      <ul className="mt-2 flex flex-wrap items-center gap-2" aria-label="Map legend">
        {LEGEND.map((l) => (
          <li key={l.label} title={l.hint} className="inline-flex items-center gap-1.5 rounded-full border border-gray-200 bg-white px-2.5 py-1">
            <span className="relative inline-block h-3.5 w-3.5 rounded-full" style={{ background: BODY_STYLE[l.body].fill, border: l.body === 'hollow' ? '2px dashed #94a3b8' : undefined }} aria-hidden>
              {l.dot && <span className="absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full ring-1 ring-white" style={{ background: l.dot }} />}
            </span>
            {l.label}
          </li>
        ))}
        <li className="text-gray-500">Numbered circle = group, select to zoom · People with no location yet are in the list, not on the map</li>
      </ul>
    </details>
  );
}

export function WorkforceMap({ sessions, workplaces, selected, onSelect, className, search = true }: { sessions: any[]; workplaces: MapWorkplace[]; selected: string | null; onSelect: (id: string) => void; className?: string; search?: boolean }) {
  const located = useMemo(() => sessions.filter((s) => s.last_latitude != null), [sessions]);
  const first = workplaces[0];
  const center = first ? { lat: first.latitude, lng: first.longitude } : located[0] ? { lat: located[0].last_latitude, lng: located[0].last_longitude } : null;
  const [schematicWp, setSchematicWp] = useState<string>('');
  const refused = useMapsRefused();
  // Touch screens keep one-finger scrolling for the page; two fingers move the map.
  const [gestures, setGestures] = useState<'greedy' | 'cooperative'>('greedy');
  useEffect(() => setGestures(window.matchMedia('(pointer: coarse)').matches ? 'cooperative' : 'greedy'), []);
  // A person selected at another workplace brings that workplace up.
  const selectedWp = sessions.find((s) => s.id === selected)?.workplace_id as string | undefined;
  useEffect(() => {
    if (selectedWp) setSchematicWp(selectedWp);
  }, [selectedWp]);
  if (!center) return <div className={cx('flex items-center justify-center bg-gray-50 text-sm text-gray-500', className)}>No active workplace to show</div>;

  if (!mapsConfigured || refused) {
    const w = workplaces.find((x) => x.id === schematicWp) ?? (workplaces.length === 1 ? first : undefined);
    const c = w ? { lat: w.latitude, lng: w.longitude } : center;
    const open = sessions.filter((s) => s.is_open !== false);
    return (
      <div className="space-y-3 p-4">
        <MapSetupNotice compact refused={refused} />
        {workplaces.length > 1 && (
          <div className="flex flex-wrap items-center gap-2">
            <Select aria-label="Workplace shown" value={w?.id ?? ''} onChange={(e) => setSchematicWp(e.target.value)} className="w-56">
              <option value="">All workplaces</option>
              {workplaces.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </Select>
            {w && <Button size="sm" variant="ghost" onClick={() => setSchematicWp('')}>Back to all</Button>}
          </div>
        )}
        {!w ? (
          <SiteOverview
            sites={workplaces.map((x) => {
              const here = open.filter((s) => s.workplace_id === x.id);
              return { id: x.id, name: x.name, lat: x.latitude, lng: x.longitude, onShift: here.length, needsLook: here.filter((s) => MARKER_STYLE[kindFor(s)].body !== 'normal').length };
            })}
            onOpen={setSchematicWp}
          />
        ) : (
        <SchematicMap
          center={c}
          radiusM={w ? radiusOf(w) : 100}
          points={located.filter((s) => !w || s.workplace_id === w.id).map((s) => ({ id: s.id, lat: s.last_latitude, lng: s.last_longitude, label: s.full_name.split(' ')[0], kind: kindFor(s), accuracyM: s.last_accuracy_m }))}
          selectedId={selected}
          onSelect={onSelect}
          height={380}
        />
        )}
      </div>
    );
  }

  return (
    <div className={cx('relative', className)}>
      <MapsProvider>
      <Map
        className="h-full w-full"
        defaultCenter={center}
        defaultZoom={16}
        mapId={MAP_ID}
        gestureHandling={gestures}
        clickableIcons={false}
        streetViewControl={false}
        mapTypeControlOptions={{ position: ControlPosition.LEFT_BOTTOM }}
        fullscreenControlOptions={{ position: ControlPosition.RIGHT_TOP }}
      >
        {workplaces.map((w) => (
          <GeofenceCircle key={w.id} center={{ lat: w.latitude, lng: w.longitude }} radius={radiusOf(w)} />
        ))}
        {workplaces.map((w) => (
          <AdvancedMarker key={`label-${w.id}`} position={{ lat: w.latitude, lng: w.longitude }} title={`${w.name}: ${radiusOf(w)} m permitted radius`} zIndex={1}>
            <span className="rounded bg-navy-800/90 px-1.5 py-0.5 text-caption font-semibold text-white shadow-sm">{w.name} · {radiusOf(w)} m</span>
          </AdvancedMarker>
        ))}
        <Markers located={located} selected={selected} onSelect={onSelect} />
        <Controls workplaces={workplaces} located={located} search={search} />
      </Map>
      </MapsProvider>
    </div>
  );
}
