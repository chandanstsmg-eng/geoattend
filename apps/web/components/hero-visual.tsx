import { CheckCircle2, Navigation, Radio } from 'lucide-react';
import type { Copy } from '@/lib/i18n';

// Illustration only: a staff phone approaching the workplace, and the owner's live summary.
export function HeroVisual({ phone, live }: { phone: Copy['phone']; live: Copy['live'] }) {
  return (
    <div className="relative mx-auto w-full max-w-md" aria-hidden>
      {/* Phone */}
      <div className="mx-auto w-64 rounded-[2.25rem] border-[6px] border-navy-900 bg-navy-900 shadow-2xl sm:w-72">
        <div className="overflow-hidden rounded-[1.75rem] bg-white">
          <div className="flex items-center justify-between bg-navy-900 px-4 pb-2 pt-3 text-[11px] text-white">
            <span className="inline-flex items-center gap-1.5">
              <Radio className="h-3.5 w-3.5 text-emerald-400" /> {phone.shift}
            </span>
            <span className="tabular-nums">9:01</span>
          </div>
          <svg viewBox="0 0 260 190" className="block h-auto w-full bg-[#eef2f6]">
            <path d="M0 120 260 70M60 0l40 190M190 0l-20 190" stroke="#fff" strokeWidth="10" />
            <circle cx="120" cy="100" r="58" fill="#0b4f72" fillOpacity="0.1" stroke="#0b4f72" strokeWidth="1.5" strokeDasharray="5 4" />
            <rect x="108" y="88" width="24" height="22" rx="3" fill="#083e5a" />
            <circle cx="205" cy="40" r="22" fill="#1668a0" className="ping-soft" fillOpacity="0.25" />
            <circle cx="205" cy="40" r="7" fill="#1668a0" stroke="#fff" strokeWidth="3" />
            <path d="M198 47 135 92" stroke="#1668a0" strokeWidth="2" strokeDasharray="3 4" />
          </svg>
          <div className="space-y-2 p-3">
            <div className="rounded-lg bg-navy-50 p-3">
              <p className="flex items-center gap-1.5 text-sm font-semibold text-navy-900">
                <Navigation className="h-4 w-4 text-blue-600" /> {phone.away}
              </p>
              <p className="mt-0.5 text-xs text-gray-600">{phone.unlock}</p>
            </div>
            <div className="rounded-lg bg-emerald-50 p-3 ring-1 ring-emerald-200">
              <p className="flex items-center gap-1.5 text-sm font-semibold text-emerald-800">
                <CheckCircle2 className="h-4 w-4" /> {phone.marked}
              </p>
              <p className="mt-0.5 text-xs text-emerald-700">{phone.at}</p>
            </div>
          </div>
        </div>
      </div>

      {/* Owner's live card */}
      <div className="absolute -bottom-6 -right-2 w-48 rounded-lg bg-white p-3 shadow-lg ring-1 ring-gray-200 sm:-right-8 sm:w-56">
        <p className="text-xs font-semibold text-navy-900">{live.title}</p>
        <ul className="mt-2 space-y-1.5 text-xs">
          {[
            [live.present, 12, 'bg-emerald-500'],
            [live.away, 1, 'bg-red-500'],
            [live.notIn, 2, 'bg-gray-300'],
          ].map(([label, n, dot]) => (
            <li key={label as string} className="flex items-center gap-2 text-gray-700">
              <span className={`h-2 w-2 rounded-full ${dot}`} />
              <span className="flex-1">{label}</span>
              <span className="font-semibold tabular-nums text-navy-900">{n}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
