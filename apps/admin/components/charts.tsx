'use client';
/**
 * Small, dependency-free SVG charts for the dashboards.
 *
 * Colour: DhishaAI categorical slots in a fixed order — brand blue, brand orange, sky — checked
 * with the dataviz validator (lightness band, chroma, CVD ΔE ≥ 20 on all pairs). Orange and sky
 * are below 3:1 against white, so every chart has a legend and a table view. Colour follows the
 * series, never its rank. One y-axis per chart.
 * Marks: bars with 4px rounded data ends and 2px gaps, 2px lines, hover tooltips on every mark
 * (the hit target is the whole x band, larger than the mark).
 */
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { ArrowDownRight, ArrowRight, ArrowUpRight, BarChart3, Table2, Info } from 'lucide-react';
import { cx } from './ui';

export const SERIES_COLORS = ['#1668A0', '#B45309', '#5BB0D9'] as const;

export interface SeriesDef {
  key: string;
  label: string;
  color: string;
}

type Row = Record<string, any>;

const INK = { muted: '#64748b', grid: '#edf1f5', axis: '#cbd5e1', text: '#172b3a', hover: '#f1f5f9' };
const PAD = { top: 12, right: 8, bottom: 26, left: 40 };

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.floor(e!.contentRect.width)));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

/** 0 and ~4 round steps up to max. */
function ticks(max: number) {
  if (max <= 0) return [0, 1];
  const raw = max / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw)!;
  const out: number[] = [];
  for (let v = 0; v <= max + step * 0.001; v += step) out.push(Math.round(v * 1000) / 1000);
  if (out[out.length - 1]! < max) out.push(out[out.length - 1]! + step);
  return out;
}

/** A bar with only its data end rounded (4px), anchored to the baseline. */
function barPath(x: number, y: number, w: number, h: number) {
  if (h <= 0 || w <= 0) return '';
  const r = Math.min(4, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

export function Legend({ series }: { series: SeriesDef[] }) {
  if (series.length < 2) return null;
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-600" aria-label="Legend">
      {series.map((s) => (
        <li key={s.key} className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: s.color }} aria-hidden />
          {s.label}
        </li>
      ))}
    </ul>
  );
}

function Tooltip({ x, y, width, children }: { x: number; y: number; width: number; children: ReactNode }) {
  const left = Math.min(Math.max(8, x + 12), Math.max(8, width - 190));
  return (
    <div role="status" className="pointer-events-none absolute z-10 w-[180px] rounded-md border border-gray-200 bg-white px-2.5 py-2 text-xs shadow-lg" style={{ left, top: Math.max(0, y - 8) }}>
      {children}
    </div>
  );
}

function TipRows({ title, series, row, format }: { title: ReactNode; series: SeriesDef[]; row: Row; format: (v: number) => string }) {
  return (
    <>
      <div className="mb-1 font-medium text-gray-900">{title}</div>
      {series.map((s) => (
        <div key={s.key} className="flex items-center gap-1.5 text-gray-600">
          <span className="h-2 w-2 shrink-0 rounded-sm" style={{ background: s.color }} aria-hidden />
          <span className="flex-1">{s.label}</span>
          <span className="tabular font-medium text-gray-900">{format(Number(row[s.key] ?? 0))}</span>
        </div>
      ))}
    </>
  );
}

interface XYProps {
  data: Row[];
  x: string;
  series: SeriesDef[];
  height?: number;
  format?: (v: number) => string;
  /** Short tick label for an x value. */
  xLabel?: (v: any) => string;
  /** Full label in the tooltip. */
  xTitle?: (v: any) => string;
  onSelect?: (row: Row) => void;
  label: string;
}

const plain = (v: number) => String(Math.round(v * 10) / 10);

function useXY({ data, series, height = 220 }: XYProps, width: number) {
  const max = Math.max(0, ...data.flatMap((r) => series.map((s) => Number(r[s.key] ?? 0))));
  const yt = ticks(max);
  const top = yt[yt.length - 1]!;
  const iw = Math.max(0, width - PAD.left - PAD.right);
  const ih = height - PAD.top - PAD.bottom;
  const band = data.length ? iw / data.length : 0;
  const y = (v: number) => PAD.top + ih - (top ? (v / top) * ih : 0);
  // Show at most ~8 x labels.
  const every = Math.max(1, Math.ceil(data.length / Math.max(1, Math.floor(iw / 64))));
  return { yt, iw, ih, band, y, every, height };
}

function Axes({ yt, y, iw, format, data, x, band, every, xLabel, height }: any) {
  return (
    <g aria-hidden>
      {yt.map((t: number) => (
        <g key={t}>
          <line x1={PAD.left} x2={PAD.left + iw} y1={y(t)} y2={y(t)} stroke={t === 0 ? INK.axis : INK.grid} strokeWidth={1} />
          <text x={PAD.left - 6} y={y(t)} dy="0.32em" textAnchor="end" fontSize={11} fill={INK.muted} className="tabular">
            {format(t)}
          </text>
        </g>
      ))}
      {data.map((r: Row, i: number) =>
        i % every === 0 ? (
          <text key={i} x={PAD.left + band * i + band / 2} y={height - 8} textAnchor="middle" fontSize={11} fill={INK.muted}>
            {xLabel ? xLabel(r[x]) : String(r[x])}
          </text>
        ) : null,
      )}
    </g>
  );
}

/** Vertical bars, one per series side by side within each x band. */
export function BarChart(props: XYProps) {
  const { data, x, series, format = plain, xLabel, xTitle, onSelect, label } = props;
  const [ref, width] = useWidth<HTMLDivElement>();
  const g = useXY(props, width);
  const [hover, setHover] = useState<{ i: number; mx: number; my: number } | null>(null);
  const inner = Math.min(g.band * 0.72, 28 * series.length + 2 * (series.length - 1));
  const bw = series.length ? (inner - 2 * (series.length - 1)) / series.length : 0;
  return (
    <div ref={ref} className="relative w-full" onMouseLeave={() => setHover(null)}>
      {width > 0 && (
        <svg width={width} height={g.height} role="img" aria-label={label}>
          <Axes {...g} format={format} data={data} x={x} xLabel={xLabel} />
          {data.map((r, i) => {
            const x0 = PAD.left + g.band * i + (g.band - inner) / 2;
            return (
              <g key={i}>
                {hover?.i === i && <rect x={PAD.left + g.band * i} y={PAD.top} width={g.band} height={g.ih} fill={INK.hover} />}
                {series.map((s, k) => {
                  const v = Number(r[s.key] ?? 0);
                  return <path key={s.key} d={barPath(x0 + k * (bw + 2), g.y(v), bw, g.y(0) - g.y(v))} fill={s.color} />;
                })}
                <rect
                  x={PAD.left + g.band * i}
                  y={PAD.top}
                  width={g.band}
                  height={g.ih}
                  fill="transparent"
                  className={onSelect ? 'cursor-pointer' : undefined}
                  onMouseMove={(e) => {
                    const b = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
                    setHover({ i, mx: e.clientX - b.left, my: e.clientY - b.top });
                  }}
                  onClick={() => onSelect?.(r)}
                />
              </g>
            );
          })}
        </svg>
      )}
      {hover && data[hover.i] && (
        <Tooltip x={hover.mx} y={hover.my} width={width}>
          <TipRows title={xTitle ? xTitle(data[hover.i]![x]) : String(data[hover.i]![x])} series={series} row={data[hover.i]!} format={format} />
        </Tooltip>
      )}
    </div>
  );
}

/** Lines over time with a crosshair tooltip. */
export function LineChart(props: XYProps) {
  const { data, x, series, format = plain, xLabel, xTitle, label } = props;
  const [ref, width] = useWidth<HTMLDivElement>();
  const g = useXY(props, width);
  const [hover, setHover] = useState<{ i: number; mx: number; my: number } | null>(null);
  const cx0 = (i: number) => PAD.left + g.band * i + g.band / 2;
  return (
    <div ref={ref} className="relative w-full" onMouseLeave={() => setHover(null)}>
      {width > 0 && (
        <svg
          width={width}
          height={g.height}
          role="img"
          aria-label={label}
          onMouseMove={(e) => {
            const b = e.currentTarget.getBoundingClientRect();
            const mx = e.clientX - b.left;
            const i = Math.min(data.length - 1, Math.max(0, Math.floor((mx - PAD.left) / (g.band || 1))));
            if (data.length) setHover({ i, mx, my: e.clientY - b.top });
          }}
        >
          <Axes {...g} format={format} data={data} x={x} xLabel={xLabel} />
          {hover && <line x1={cx0(hover.i)} x2={cx0(hover.i)} y1={PAD.top} y2={PAD.top + g.ih} stroke={INK.axis} strokeWidth={1} />}
          {/* The first series gets a faint area so the main trend reads at a glance. */}
          {series[0] && data.length > 1 && (
            <path d={`M${cx0(0)},${g.y(0)}${data.map((r, i) => `L${cx0(i)},${g.y(Number(r[series[0]!.key] ?? 0))}`).join('')}L${cx0(data.length - 1)},${g.y(0)}Z`} fill={series[0].color} opacity={0.07} />
          )}
          {series.map((s) => (
            <polyline key={s.key} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" points={data.map((r, i) => `${cx0(i)},${g.y(Number(r[s.key] ?? 0))}`).join(' ')} />
          ))}
          {/* Markers on short series (≤ 16 points) so single days are visible, ringed by the surface. */}
          {data.length <= 16 &&
            series.map((s) => data.map((r, i) => <circle key={`${s.key}-${i}`} cx={cx0(i)} cy={g.y(Number(r[s.key] ?? 0))} r={3.5} fill={s.color} stroke="#fff" strokeWidth={2} />))}
          {hover &&
            series.map((s) => <circle key={s.key} cx={cx0(hover.i)} cy={g.y(Number(data[hover.i]![s.key] ?? 0))} r={4.5} fill={s.color} stroke="#fff" strokeWidth={2} />)}
        </svg>
      )}
      {hover && data[hover.i] && (
        <Tooltip x={hover.mx} y={hover.my} width={width}>
          <TipRows title={xTitle ? xTitle(data[hover.i]![x]) : String(data[hover.i]![x])} series={series} row={data[hover.i]!} format={format} />
        </Tooltip>
      )}
    </div>
  );
}

/**
 * Horizontal bars with the category name on the left — for ranked lists (workplaces, people).
 * Each row is a button when `onSelect` is given.
 */
export function HBarList({ data, label, series, format = plain, name, onSelect, max: maxRows = 10 }: { data: Row[]; label: string; series: SeriesDef[]; format?: (v: number) => string; name: (r: Row) => ReactNode; onSelect?: (r: Row) => void; max?: number }) {
  const rows = data.slice(0, maxRows);
  const max = Math.max(1, ...rows.flatMap((r) => series.map((s) => Number(r[s.key] ?? 0))));
  return (
    <ul className="space-y-2.5" aria-label={label}>
      {rows.map((r, i) => {
        const body = (
          <>
            <span className="flex items-baseline justify-between gap-2 text-body-sm">
              <span className="truncate text-gray-800">{name(r)}</span>
              <span className="tabular shrink-0 text-gray-600">{series.map((s) => format(Number(r[s.key] ?? 0))).join(' / ')}</span>
            </span>
            <span className="mt-1 flex flex-col gap-0.5" aria-hidden>
              {series.map((s) => (
                <span key={s.key} className="block h-2 rounded-r bg-gray-100">
                  <span className="block h-2 rounded-r" style={{ width: `${(Number(r[s.key] ?? 0) / max) * 100}%`, background: s.color, minWidth: Number(r[s.key]) > 0 ? 2 : 0 }} />
                </span>
              ))}
            </span>
          </>
        );
        return (
          <li key={i}>
            {onSelect ? (
              <button type="button" onClick={() => onSelect(r)} className="block w-full rounded px-1 py-0.5 text-left hover:bg-gray-50">
                {body}
              </button>
            ) : (
              <div className="px-1 py-0.5">{body}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Parts of one whole (e.g. today's workforce by state) as a single segmented bar plus a labelled
 * list with counts and shares. Segments are separated by 2px surface gaps; each list row can
 * filter the records behind it.
 */
export function Composition({ parts, label, unit = '', onSelect }: { parts: Array<{ key: string; label: string; value: number; color: string; hint?: string }>; label: string; unit?: string; onSelect?: (key: string) => void }) {
  const total = parts.reduce((n, p) => n + p.value, 0);
  const shown = parts.filter((p) => p.value > 0);
  return (
    <div>
      <div className="flex h-3.5 w-full gap-[2px] overflow-hidden rounded-full bg-gray-100" role="img" aria-label={`${label}: ${parts.map((p) => `${p.label} ${p.value}`).join(', ')}`}>
        {shown.map((p) => (
          <span key={p.key} className="h-full first:rounded-l-full last:rounded-r-full" style={{ width: `${(p.value / total) * 100}%`, background: p.color, minWidth: 4 }} title={`${p.label}: ${p.value}`} />
        ))}
      </div>
      <ul className="mt-3.5 divide-y divide-gray-100">
        {parts.map((p) => {
          const body = (
            <>
              <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: p.color }} aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="block text-body-sm text-gray-800">{p.label}</span>
                {p.hint && <span className="block text-xs text-gray-500">{p.hint}</span>}
              </span>
              <span className="tabular text-title font-semibold text-navy-800">{p.value}{unit}</span>
              <span className="tabular w-11 text-right text-xs text-gray-500">{total ? `${Math.round((p.value / total) * 100)}%` : '—'}</span>
            </>
          );
          return (
            <li key={p.key}>
              {onSelect ? (
                <button type="button" onClick={() => onSelect(p.key)} className="flex w-full items-center gap-2.5 rounded px-1 py-2 text-left hover:bg-gray-50">{body}</button>
              ) : (
                <div className="flex items-center gap-2.5 px-1 py-2">{body}</div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** The same data as a compact table (accessibility and exact values). */
export function DataTable({ data, x, series, format = plain, xTitle }: { data: Row[]; x: string; series: SeriesDef[]; format?: (v: number) => string; xTitle?: (v: any) => string }) {
  return (
    <div className="max-h-64 overflow-auto">
      <table className="w-full text-left text-body-sm">
        <thead className="sticky top-0 bg-white">
          <tr className="border-b border-gray-200 text-xs text-gray-500">
            <th scope="col" className="py-1.5 pr-3 font-medium" />
            {series.map((s) => (
              <th key={s.key} scope="col" className="py-1.5 pl-3 text-right font-medium">{s.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.map((r, i) => (
            <tr key={i} className="border-b border-gray-100">
              <th scope="row" className="py-1.5 pr-3 font-normal text-gray-700">{xTitle ? xTitle(r[x]) : String(r[x])}</th>
              {series.map((s) => (
                <td key={s.key} className="tabular py-1.5 pl-3 text-right text-gray-900">{format(Number(r[s.key] ?? 0))}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A dashboard panel: title, legend, chart ⇄ table toggle, and an empty state. */
export function ChartCard({ title, subtitle, series, children, table, empty, actions, className }: { title: string; subtitle?: ReactNode; series?: SeriesDef[]; children: ReactNode; table?: ReactNode; empty?: boolean; actions?: ReactNode; className?: string }) {
  const [view, setView] = useState<'chart' | 'table'>('chart');
  return (
    <section className={cx('flex flex-col rounded-lg border border-gray-200 bg-white shadow-card', className)}>
      <header className="flex flex-wrap items-start justify-between gap-2 px-4 pt-3.5 sm:px-5">
        <div className="min-w-0">
          <h2 className="text-title font-semibold text-navy-900">{title}</h2>
          {subtitle && <p className="text-xs text-gray-500">{subtitle}</p>}
        </div>
        <div className="flex items-center gap-1">
          {actions}
          {table && !empty && (
            <div className="inline-flex rounded-md bg-gray-100 p-0.5" role="group" aria-label={`${title}: view`}>
              {(['chart', 'table'] as const).map((v) => (
                <button key={v} type="button" aria-pressed={view === v} aria-label={v === 'chart' ? 'Chart view' : 'Table view'} title={v === 'chart' ? 'Chart' : 'Table'} onClick={() => setView(v)} className={cx('rounded p-1.5', view === v ? 'bg-white text-gray-900 shadow-xs' : 'text-gray-500 hover:text-gray-800')}>
                  {v === 'chart' ? <BarChart3 className="h-3.5 w-3.5" aria-hidden /> : <Table2 className="h-3.5 w-3.5" aria-hidden />}
                </button>
              ))}
            </div>
          )}
        </div>
      </header>
      <div className="flex-1 px-4 pb-4 pt-3 sm:px-5">
        {empty ? (
          <p className="flex h-40 items-center justify-center text-sm text-gray-500">No data for this period</p>
        ) : (
          <>
            {series && <div className="mb-2"><Legend series={series} /></div>}
            {view === 'chart' || !table ? children : table}
          </>
        )}
      </div>
    </section>
  );
}

/**
 * Change against the previous equal period. `better` says which direction is good for this
 * metric (more attendance is good, more absences are not); null when there is nothing to compare.
 */
export type Delta = { text: string; dir: 'up' | 'down' | 'flat'; good: boolean | null; title: string } | null;

/** Relative change for amounts (hours), in percent. */
export function pctDelta(cur: number | null | undefined, prev: number | null | undefined, better: 'up' | 'down', label: string): Delta {
  if (cur == null || prev == null || prev === 0) return null;
  const ch = Math.round(((cur - prev) / prev) * 100);
  const dir = ch > 0 ? 'up' : ch < 0 ? 'down' : 'flat';
  return { text: `${ch > 0 ? '+' : ''}${ch}%`, dir, good: dir === 'flat' ? null : dir === better, title: `${label}: ${ch > 0 ? '+' : ''}${ch}% vs the previous period` };
}
/** Absolute change for rates (percentage points) and counts. */
export function absDelta(cur: number | null | undefined, prev: number | null | undefined, better: 'up' | 'down', unit: string, label: string): Delta {
  if (cur == null || prev == null) return null;
  const ch = Math.round((cur - prev) * 10) / 10;
  const dir = ch > 0 ? 'up' : ch < 0 ? 'down' : 'flat';
  return { text: `${ch > 0 ? '+' : ''}${ch}${unit}`, dir, good: dir === 'flat' ? null : dir === better, title: `${label}: ${ch > 0 ? '+' : ''}${ch}${unit} vs the previous period` };
}

function DeltaChip({ d }: { d: NonNullable<Delta> }) {
  const Icon = d.dir === 'up' ? ArrowUpRight : d.dir === 'down' ? ArrowDownRight : ArrowRight;
  return (
    <span title={d.title} className={cx('inline-flex shrink-0 items-center gap-0.5 whitespace-nowrap font-semibold tabular', d.good === null ? 'text-gray-500' : d.good ? 'text-teal-700' : 'text-red-700')}>
      <Icon className="h-3 w-3" aria-hidden />
      {d.text}
      <span className="sr-only"> {d.title}</span>
    </span>
  );
}

/** A thin bar under a figure in a table. Decorative: the figure beside it carries the meaning. */
export function Meter({ value, max = 1, tone = 'navy' }: { value: number; max?: number; tone?: 'navy' | 'warn' }) {
  const share = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
  return (
    <span className="mt-1 block h-1.5 w-full overflow-hidden rounded-full bg-gray-100" aria-hidden>
      <span className={cx('block h-full rounded-full', tone === 'warn' ? 'bg-amber-500' : 'bg-navy-600')} style={{ width: `${share * 100}%` }} />
    </span>
  );
}

/** A tiny trend line beside a figure (decorative: the number and the change carry the meaning). */
export function Sparkline({ values, className }: { values: number[]; className?: string }) {
  if (values.length < 2) return null;
  const w = 64, h = 20;
  const max = Math.max(...values), min = Math.min(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => `${((i / (values.length - 1)) * w).toFixed(1)},${(h - 2 - ((v - min) / span) * (h - 4)).toFixed(1)}`).join(' ');
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className={cx('shrink-0 overflow-visible', className)} aria-hidden>
      <polyline points={pts} fill="none" stroke={SERIES_COLORS[0]} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

const STRIP_COLS: Record<number, string> = { 3: 'sm:grid-cols-3', 4: 'sm:grid-cols-4', 5: 'sm:grid-cols-3 lg:grid-cols-5', 6: 'sm:grid-cols-3 xl:grid-cols-6' };

/**
 * One panel of figures separated by hairlines, instead of a row of separate cards: the figures read
 * as a single summary and the page keeps its visual weight for the content below it. The gaps show
 * the panel's background as the lines; a lone last cell on a phone takes the whole row.
 */
export function StatStrip({ label, count, children, className, busy }: { label: string; count: number; children: ReactNode; className?: string; busy?: boolean }) {
  return (
    <section aria-label={label} aria-busy={busy || undefined} className={cx('grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-gray-200 bg-gray-200 shadow-card [&>*:last-child:nth-child(odd)]:col-span-2 sm:[&>*:last-child:nth-child(odd)]:col-span-1', STRIP_COLS[count], className)}>
      {children}
    </section>
  );
}

/** Placeholder with the strip's own shape, so nothing jumps when the figures arrive. */
export function StatStripSkeleton({ label, count, className }: { label: string; count: number; className?: string }) {
  return (
    <StatStrip label={label} count={count} className={className} busy>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="bg-white px-4 py-3">
          <div className="h-3 w-20 animate-pulse rounded bg-gray-100" />
          <div className="mt-2.5 h-6 w-14 animate-pulse rounded bg-gray-100" />
          <div className="mt-2.5 h-3 w-24 animate-pulse rounded bg-gray-100" />
        </div>
      ))}
    </StatStrip>
  );
}

/**
 * One figure in a StatStrip: label, value (with an optional smaller unit), context line; a link or
 * button only when it leads somewhere. Colour means something: amber = watch, red = a breach.
 * `delta` shows the change against the previous period only when it could be calculated.
 */
export function Kpi({ label, value, unit, sub, tone, title, onClick, href, delta, info, spark }: { label: string; value: ReactNode; unit?: string; sub?: ReactNode; tone?: 'warn' | 'bad' | 'good'; title?: string; onClick?: () => void; href?: string; delta?: Delta; info?: string; spark?: number[] }) {
  const body = (
    <>
      <span className="flex items-center gap-1 text-body-sm font-medium text-gray-600">
        {label}
        {info && (
          <span title={info} className="inline-flex text-gray-500 hover:text-gray-600">
            <Info className="h-3.5 w-3.5" aria-hidden />
            <span className="sr-only">{info}</span>
          </span>
        )}
      </span>
      <span className="mt-0.5 flex items-end justify-between gap-2">
        <span className={cx('text-2xl font-semibold leading-8 tracking-tight tabular', tone === 'bad' ? 'text-red-700' : tone === 'warn' ? 'text-amber-700' : tone === 'good' ? 'text-teal-700' : 'text-navy-800')}>
          {value}
          {unit && <span className="ml-0.5 text-sm font-medium text-gray-500">{unit}</span>}
        </span>
        {spark && <Sparkline values={spark} className="mb-1.5 hidden min-[1100px]:block" />}
      </span>
      {(sub || delta) && (
        <span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs leading-[18px] text-gray-500">
          {delta && <DeltaChip d={delta} />}
          {sub && <span>{sub}</span>}
        </span>
      )}
    </>
  );
  const cls = 'flex h-full w-full flex-col items-stretch justify-start bg-white px-4 py-3 text-left';
  const hover = 'transition-colors hover:bg-gray-50';
  if (href)
    return (
      <Link href={href} title={title} className={cx(cls, hover)}>
        {body}
      </Link>
    );
  if (onClick)
    return (
      <button type="button" title={title} onClick={onClick} className={cx(cls, hover)}>
        {body}
      </button>
    );
  return (
    <div title={title} className={cls}>
      {body}
    </div>
  );
}
