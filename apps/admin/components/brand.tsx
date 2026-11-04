/**
 * GeoAttend brand mark and lockup. The DhishaAI logo itself is not redrawn here: set
 * NEXT_PUBLIC_BRAND_LOGO_URL to the official file (e.g. /brand/dhishaai.svg in apps/admin/public)
 * and it replaces the text wordmark.
 */
export const BRAND_LOGO = process.env.NEXT_PUBLIC_BRAND_LOGO_URL ?? '';

/** A location pin on brand navy with an orange centre. */
export function Mark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden>
      <rect width="32" height="32" rx="7" fill="#083e5a" />
      <path d="M16 6a7 7 0 0 0-7 7c0 5.2 7 13 7 13s7-7.8 7-13a7 7 0 0 0-7-7zm0 9.5a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5z" fill="#fff" />
      <circle cx="16" cy="13" r="2.5" fill="#ee7600" />
    </svg>
  );
}

/** "GeoAttend / by DhishaAI". `inverse` for navy backgrounds. */
export function Lockup({ inverse, size = 'md' }: { inverse?: boolean; size?: 'md' | 'lg' }) {
  return (
    <span className="flex min-w-0 items-center gap-2.5">
      <Mark className={`${size === 'lg' ? 'h-11 w-11' : 'h-9 w-9'} shrink-0 rounded-[7px] ${inverse ? 'ring-1 ring-white/25' : ''}`} />
      <span className="min-w-0 leading-tight">
        <span className={`block truncate font-bold tracking-tight ${size === 'lg' ? 'text-xl' : 'text-[16px]'} ${inverse ? 'text-white' : 'text-navy-800'}`}>GeoAttend</span>
        {BRAND_LOGO ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={BRAND_LOGO} alt="DhishaAI" className="mt-0.5 h-3.5 w-auto" />
        ) : (
          <span className={`block truncate text-caption font-medium ${inverse ? 'text-navy-100' : 'text-gray-500'}`}>
            by <span className={`font-semibold ${inverse ? 'text-white' : 'text-navy-800'}`}>Dhisha</span>
            <span className={`font-semibold ${inverse ? 'text-accent-200' : 'text-accent-600'}`}>AI</span>
          </span>
        )}
      </span>
    </span>
  );
}
