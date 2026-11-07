'use client';
/**
 * Schematic (non-map) view used when Google Maps is not configured. Positions
 * are drawn relative to the workplace centre using the same geodesy as the
 * server, and the diagram is explicitly labelled as not being a map.
 */
import { toLocalMeters } from '@geoattend/shared';
import type { KeyboardEvent } from 'react';
import { MARKER_STYLE } from './markers';
import type { MarkerKind } from '@geoattend/shared';

const pressed = (act?: () => void) => (e: KeyboardEvent) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  e.preventDefault();
  act?.();
};

export interface SchematicPoint {
  id: string;
  lat: number;
  lng: number;
  label: string;
  kind: MarkerKind;
  accuracyM?: number | null;
}

export interface SiteMarker {
  id: string;
  name: string;
  lat: number;
  lng: number;
  onShift: number;
  needsLook: number;
}

/**
 * Every workplace at once, placed from its real coordinates, for when no map is available. It shows
 * where the sites lie and how many people are on shift at each, and opens one for its detail.
 */
export function SiteOverview({ sites, onOpen, height = 380 }: { sites: SiteMarker[]; onOpen: (id: string) => void; height?: number }) {
  const lats = sites.map((s) => s.lat);
  const lngs = sites.map((s) => s.lng);
  const mid = { lat: (Math.min(...lats) + Math.max(...lats)) / 2, lng: (Math.min(...lngs) + Math.max(...lngs)) / 2 };
  const local = sites.map((s) => ({ ...s, ...toLocalMeters(mid, s) }));
  const w = 640;
  const h = 400;
  const pad = 80;
  const span = Math.max(...local.map((p) => Math.abs(p.x)), ...local.map((p) => Math.abs(p.y) * 1.6), 1);
  const scale = (w / 2 - pad) / span;
  const km = [1, 2, 5, 10, 20, 50, 100, 200, 500].find((r) => r * 1000 * scale > 60) ?? 500;
  return (
    <figure className="relative w-full overflow-hidden rounded-md border border-dashed border-gray-300 bg-gray-50" style={{ height }}>
      <svg viewBox={`0 0 ${w} ${h}`} className="h-full w-full" role="group" aria-label="Workplaces by real position. Select one for its detail.">
        {local.map((p) => {
          const x = w / 2 + p.x * scale;
          const y = h / 2 - p.y * scale;
          const left = x > w - 170;
          return (
            <g key={p.id} onClick={() => onOpen(p.id)} onKeyDown={pressed(() => onOpen(p.id))} tabIndex={0} role="button" aria-label={`${p.name}: ${p.onShift} on shift${p.needsLook ? `, ${p.needsLook} need a look` : ''}. Open.`} className="cursor-pointer">
              <circle cx={x} cy={y} r={Math.min(26, 13 + p.onShift)} fill="#083e5a" />
              <text x={x} y={y + 4} textAnchor="middle" fontSize={12} fontWeight={700} fill="#ffffff">{p.onShift}</text>
              {p.needsLook > 0 && <circle cx={x + 12} cy={y - 12} r={6} fill="#b45309" stroke="#ffffff" strokeWidth={2} />}
              <text x={left ? x - 30 : x + 30} y={y + 4} textAnchor={left ? 'end' : 'start'} fontSize={12} fontWeight={600} fill="#172b3a">{p.name}</text>
            </g>
          );
        })}
        <g transform={`translate(16 ${h - 18})`}>
          <line x1={0} y1={0} x2={km * 1000 * scale} y2={0} stroke="#374151" strokeWidth={2} />
          <text x={0} y={-5} fontSize={11} fill="#374151">{km} km</text>
        </g>
        <text x={w - 16} y={22} fontSize={11} textAnchor="end" fill="#374151">N ↑</text>
      </svg>
      <figcaption className="absolute left-2 top-2 rounded bg-white/90 px-2 py-0.5 text-caption font-medium text-gray-600 ring-1 ring-gray-200">Diagram of your workplaces — not a map</figcaption>
    </figure>
  );
}

export function SchematicMap({ center, radiusM, points = [], selectedId, onSelect, height = 380 }: { center: { lat: number; lng: number }; radiusM: number; points?: SchematicPoint[]; selectedId?: string | null; onSelect?: (id: string) => void; height?: number }) {
  const local = points.map((p) => ({ ...p, ...toLocalMeters(center, p) }));
  const extent = Math.max(radiusM * 2.2, ...local.map((p) => Math.hypot(p.x, p.y) * 1.15), 60);
  const size = 400;
  const scale = size / 2 / extent;
  const sx = (x: number) => size / 2 + x * scale;
  const sy = (y: number) => size / 2 - y * scale;
  const ruler = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000].find((r) => r * scale > 50) ?? 5000;

  return (
    <figure className="relative w-full overflow-hidden rounded-md border border-dashed border-gray-300 bg-[repeating-linear-gradient(0deg,#f8fafc,#f8fafc_19px,#eef2f7_20px),repeating-linear-gradient(90deg,transparent,transparent_19px,#eef2f7_20px)]" style={{ height: `min(${height}px, 90vw)` }}>
      <svg viewBox={`0 0 ${size} ${size}`} className="h-full w-full" role="group" aria-label="Schematic diagram of positions relative to the workplace centre">
        <circle cx={size / 2} cy={size / 2} r={radiusM * scale} fill="#1668a0" fillOpacity={0.1} stroke="#1668a0" strokeWidth={2} />
        <line x1={size / 2 - 6} y1={size / 2} x2={size / 2 + 6} y2={size / 2} stroke="#083e5a" strokeWidth={2} />
        <line x1={size / 2} y1={size / 2 - 6} x2={size / 2} y2={size / 2 + 6} stroke="#083e5a" strokeWidth={2} />
        <text x={size / 2} y={size / 2 + radiusM * scale + 14} textAnchor="middle" fontSize={10} fill="#083e5a">
          permitted radius {radiusM} m
        </text>
        {local.map((p) => {
          const st = MARKER_STYLE[p.kind];
          const sel = p.id === selectedId;
          return (
            <g key={p.id} onClick={() => onSelect?.(p.id)} onKeyDown={pressed(() => onSelect?.(p.id))} tabIndex={onSelect ? 0 : undefined} role={onSelect ? 'button' : undefined} aria-label={`${p.label}, ${st.label}`} className={onSelect ? 'cursor-pointer' : ''}>
              {p.accuracyM ? <circle cx={sx(p.x)} cy={sy(p.y)} r={Math.max(2, p.accuracyM * scale)} fill={st.color} fillOpacity={0.08} stroke={st.color} strokeOpacity={0.3} /> : null}
              <circle cx={sx(p.x)} cy={sy(p.y)} r={sel ? 8 : 6} fill={st.hollow ? '#ffffff' : st.color} stroke={st.color} strokeWidth={st.hollow ? 3 : 1.5} />
              <text x={sx(p.x) + 10} y={sy(p.y) + 4} fontSize={11} fontWeight={sel ? 700 : 500} fill="#111827">
                {p.label}
              </text>
              <title>{`${p.label} — ${st.label}`}</title>
            </g>
          );
        })}
        <g transform={`translate(16 ${size - 20})`}>
          <line x1={0} y1={0} x2={ruler * scale} y2={0} stroke="#374151" strokeWidth={2} />
          <text x={0} y={-5} fontSize={10} fill="#374151">
            {ruler} m
          </text>
        </g>
        <text x={size - 16} y={22} fontSize={11} textAnchor="end" fill="#374151">
          N ↑
        </text>
      </svg>
      <figcaption className="absolute left-2 top-2 rounded bg-white/90 px-2 py-0.5 text-caption font-medium text-gray-600 ring-1 ring-gray-200">Schematic view — not a map</figcaption>
    </figure>
  );
}
