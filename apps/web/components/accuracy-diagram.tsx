import type { Copy } from '@/lib/i18n';

// The workplace radius and three GPS readings, each drawn with its accuracy circle.
// Mirrors classifyReading() in packages/shared/src/geofence.ts: the whole circle must sit
// inside to count, a circle crossing the edge waits, a circle fully outside is refused.
const READINGS = [
  { n: 1, x: 150, y: 122, r: 26, color: '#0d9488' },
  { n: 2, x: 262, y: 176, r: 32, color: '#d97706' },
  { n: 3, x: 330, y: 58, r: 22, color: '#dc2626' },
];

export function AccuracyDiagram({ legend }: { legend: Copy['proof']['legend'] }) {
  const labels = [legend.inside, legend.unsure, legend.outside];
  return (
    <figure className="rounded-lg border border-gray-200 bg-white p-4 sm:p-6">
      <svg viewBox="0 0 380 270" className="h-auto w-full" role="img" aria-label={`${legend.zone}. 1: ${labels[0]}. 2: ${labels[1]}. 3: ${labels[2]}.`}>
        <defs>
          <pattern id="grid" width="20" height="20" patternUnits="userSpaceOnUse">
            <path d="M20 0H0V20" fill="none" stroke="#eef0f4" strokeWidth="1" />
          </pattern>
        </defs>
        <rect width="380" height="270" rx="12" fill="url(#grid)" />
        <circle cx="180" cy="140" r="100" fill="#eef4f8" stroke="#0b4f72" strokeWidth="2" strokeDasharray="6 5" />
        <g transform="translate(166 124)" aria-hidden>
          <rect width="28" height="24" y="8" rx="3" fill="#083e5a" />
          <path d="M-2 10 14 0l16 10z" fill="#083e5a" />
          <rect x="11" y="20" width="6" height="12" fill="#fff" />
        </g>
        {READINGS.map((p) => (
          <g key={p.n}>
            <circle cx={p.x} cy={p.y} r={p.r} fill={p.color} fillOpacity="0.12" stroke={p.color} strokeWidth="1.5" />
            <circle cx={p.x} cy={p.y} r="11" fill={p.color} />
            <text x={p.x} y={p.y + 4} textAnchor="middle" fontSize="12" fontWeight="700" fill="#fff">
              {p.n}
            </text>
          </g>
        ))}
      </svg>
      <figcaption className="mt-4 grid gap-2 text-sm sm:grid-cols-2">
        <span className="flex items-center gap-2 text-gray-700">
          <span className="h-3 w-5 shrink-0 rounded-sm border-2 border-dashed border-accent-600 bg-accent-50" aria-hidden />
          {legend.zone}
        </span>
        {READINGS.map((p, i) => (
          <span key={p.n} className="flex items-center gap-2 text-gray-700">
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-white" style={{ background: p.color }} aria-hidden>
              {p.n}
            </span>
            {labels[i]}
          </span>
        ))}
      </figcaption>
    </figure>
  );
}
