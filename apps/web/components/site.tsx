import Link from 'next/link';
import {
  ArrowRight,
  BellRing,
  Building,
  Camera,
  Check,
  ChevronDown,
  Clock,
  FileSpreadsheet,
  History,
  Languages,
  MapPinned,
  Menu,
  MessageCircle,
  Phone,
  Mail,
  WifiOff,
  X,
} from 'lucide-react';
import { copy, type Lang } from '@/lib/i18n';
import { hasContact, site } from '@/lib/site';
import { DashboardLink } from './dashboard-link';
import { HeroVisual } from './hero-visual';
import { AccuracyDiagram } from './accuracy-diagram';

const FEATURE_ICONS = [MapPinned, BellRing, Camera, Clock, WifiOff, History, FileSpreadsheet, Building];

const btnPrimary = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-accent-600 px-5 py-2.5 font-semibold text-white transition-colors hover:bg-accent-700';
const btnGhost = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-md px-5 py-2.5 font-semibold text-navy-900 ring-1 ring-inset ring-gray-300 transition-colors hover:bg-white';

function Logo({ dark }: { dark?: boolean }) {
  return (
    <span className="flex items-center gap-2">
      <span className="flex h-8 w-8 items-center justify-center rounded-md bg-navy-800 text-white">
        <MapPinned className="h-4 w-4" aria-hidden />
      </span>
      <span className={`text-lg font-bold tracking-tight ${dark ? 'text-white' : 'text-navy-900'}`}>GeoAttend</span>
    </span>
  );
}

function Section({ id, className = '', children }: { id?: string; className?: string; children: React.ReactNode }) {
  return (
    <section id={id} className={`px-4 py-16 sm:px-6 sm:py-24 ${className}`}>
      <div className="mx-auto max-w-6xl">{children}</div>
    </section>
  );
}

function H2({ children, light, className = '' }: { children: React.ReactNode; light?: boolean; className?: string }) {
  return <h2 className={`max-w-3xl text-3xl font-bold tracking-tight text-balance sm:text-4xl ${light ? 'text-white' : 'text-navy-900'} ${className}`}>{children}</h2>;
}

/** Small label above a section heading; it names the section in the page outline. */
function Kicker({ children, light }: { children: React.ReactNode; light?: boolean }) {
  return <p className={`mb-3 text-sm font-semibold ${light ? 'text-accent-500' : 'text-accent-700'}`}>{children}</p>;
}

export function Site({ lang }: { lang: Lang }) {
  const t = copy[lang];
  const home = lang === 'en' ? '/' : '/hi';
  const other = lang === 'en' ? '/hi' : '/';
  const navLinks = [
    ['#how', t.nav.how],
    ['#proof', t.nav.proof],
    ['#features', t.nav.features],
    ['#faq', t.nav.faq],
  ] as const;
  const talkHref = site.whatsapp ? `https://wa.me/${site.whatsapp}` : site.phone ? `tel:${site.phone}` : site.email ? `mailto:${site.email}` : '';

  return (
    <>
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded focus:bg-white focus:px-3 focus:py-2">
        Skip to content
      </a>

      {/* Header */}
      <header className="sticky top-0 z-40 border-b border-gray-200 bg-[#f4f7fa] pt-[env(safe-area-inset-top)]">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-6 px-4 sm:px-6">
          <Link href={home} aria-label="GeoAttend home">
            <Logo />
          </Link>
          <nav className="hidden items-center gap-6 text-sm text-gray-700 lg:flex" aria-label="Sections">
            {navLinks.map(([href, label]) => (
              <a key={href} href={href} className="hover:text-navy-900">
                {label}
              </a>
            ))}
          </nav>
          <div className="ml-auto hidden items-center gap-2 lg:flex">
            <Link href={other} hrefLang={lang === 'en' ? 'hi' : 'en'} className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-2 text-sm text-gray-700 hover:bg-white">
              <Languages className="h-4 w-4" aria-hidden /> {t.nav.lang}
            </Link>
            <DashboardLink className="rounded-md px-3 py-2 text-sm font-medium text-navy-900 hover:bg-white">{t.nav.login}</DashboardLink>
            <DashboardLink path="/signup" className="rounded-md bg-navy-900 px-4 py-2 text-sm font-semibold text-white hover:bg-navy-800">{t.nav.demo}</DashboardLink>
          </div>

          {/* Phone menu: no JavaScript needed */}
          <details className="group ml-auto lg:hidden">
            <summary className="flex cursor-pointer items-center gap-1 rounded-md p-2.5 text-navy-900" aria-label={t.nav.menu}>
              <Menu className="h-6 w-6 group-open:hidden" aria-hidden />
              <X className="hidden h-6 w-6 group-open:block" aria-hidden />
            </summary>
            <div className="absolute inset-x-0 top-full border-b border-gray-200 bg-[#f4f7fa] px-4 pb-5 pt-2 shadow-lg">
              <nav className="flex flex-col text-base" aria-label="Sections">
                {navLinks.map(([href, label]) => (
                  <a key={href} href={href} className="border-b border-gray-100 py-3 text-gray-800">
                    {label}
                  </a>
                ))}
                <Link href={other} className="flex items-center gap-2 py-3 text-gray-800">
                  <Languages className="h-4 w-4" aria-hidden /> {t.nav.lang}
                </Link>
              </nav>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <DashboardLink className={btnGhost}>{t.nav.login}</DashboardLink>
                <DashboardLink path="/signup" className={btnPrimary}>{t.nav.demo}</DashboardLink>
              </div>
            </div>
          </details>
        </div>
      </header>

      <main id="main">
        {/* Hero */}
        <section className="overflow-hidden px-4 pb-16 pt-10 sm:px-6 sm:pt-16 lg:pb-24">
          <div className="mx-auto grid max-w-6xl items-center gap-14 lg:grid-cols-[1.1fr_1fr]">
            <div>
              <p className="text-sm font-medium text-gray-600">{t.hero.badge}</p>
              <h1 className="mt-4 text-4xl font-extrabold tracking-tight text-balance text-navy-900 sm:text-5xl lg:text-[3.5rem] lg:leading-[1.05]">
                {t.hero.title1} <span className="text-accent-600">{t.hero.titleMark}</span> {t.hero.title2}
              </h1>
              <p className="mt-6 max-w-xl text-lg leading-relaxed text-gray-600">{t.hero.lead}</p>
              <div className="mt-8 flex flex-col gap-3 sm:flex-row">
                <DashboardLink path="/signup" className={btnPrimary}>
                  {t.hero.primary} <ArrowRight className="h-4 w-4" aria-hidden />
                </DashboardLink>
                <a href="#how" className={btnGhost}>
                  {t.hero.secondary}
                </a>
              </div>
              <ul className="mt-8 flex flex-col gap-2 border-t border-gray-200 pt-6 text-sm text-gray-700 sm:flex-row sm:flex-wrap sm:gap-x-6">
                {t.hero.points.map((p) => (
                  <li key={p} className="flex items-center gap-2">
                    <Check className="h-4 w-4 shrink-0 text-emerald-600" aria-hidden /> {p}
                  </li>
                ))}
              </ul>
            </div>
            <HeroVisual phone={t.phone} live={t.live} />
          </div>
        </section>

        {/* Who it's for: a plain line of trades, not a wall of pills */}
        <section className="border-y border-gray-200 bg-white px-4 py-6 sm:px-6">
          <div className="mx-auto flex max-w-6xl flex-col gap-2 text-sm sm:flex-row sm:items-baseline sm:gap-6">
            <h2 className="shrink-0 font-semibold text-navy-900">{t.who.title}</h2>
            <p className="leading-relaxed text-gray-600">{t.who.items.join(' · ')}</p>
          </div>
        </section>

        {/* Before / after: a real comparison, so it stays a table */}
        <Section>
          <H2>{t.compare.title}</H2>
          <div className="mt-10 overflow-hidden rounded-lg border border-gray-200 bg-white">
            <div className="hidden grid-cols-2 border-b border-gray-200 text-sm font-semibold sm:grid">
              <p className="px-6 py-3 text-gray-500">{t.compare.before}</p>
              <p className="border-l border-gray-200 px-6 py-3 text-emerald-800">{t.compare.after}</p>
            </div>
            {t.compare.rows.map(([before, after]) => (
              <div key={before} className="grid border-b border-gray-100 last:border-0 sm:grid-cols-2">
                <p className="flex gap-3 px-5 pb-1 pt-4 text-gray-500 sm:px-6 sm:py-4">
                  <X className="mt-0.5 h-4 w-4 shrink-0 text-red-500" aria-label={t.compare.before} />
                  {before}
                </p>
                <p className="flex gap-3 px-5 pb-4 pt-1 font-medium text-navy-900 sm:border-l sm:border-gray-200 sm:px-6 sm:py-4">
                  <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" aria-label={t.compare.after} />
                  {after}
                </p>
              </div>
            ))}
          </div>
        </Section>

        {/* How it works: a sequence, drawn as one */}
        <Section id="how" className="border-t border-gray-200 bg-white">
          <H2>{t.how.title}</H2>
          <ol className="mt-12 grid gap-10 md:grid-cols-3 md:gap-8">
            {t.how.steps.map((s, i) => (
              <li key={s.t} className="border-t-2 border-navy-900 pt-5">
                <span className="text-sm font-semibold tabular-nums text-accent-700">0{i + 1}</span>
                <h3 className="mt-2 text-xl font-semibold text-navy-900">{s.t}</h3>
                <p className="mt-2 leading-relaxed text-gray-600">{s.d}</p>
              </li>
            ))}
          </ol>
        </Section>

        {/* Accuracy: the differentiator. Diagram beside the rules it illustrates. */}
        <Section id="proof" className="border-t border-gray-200">
          <Kicker>{t.proof.kicker}</Kicker>
          <div className="grid items-start gap-12 lg:grid-cols-[1fr_1.05fr]">
            <div>
              <H2>{t.proof.title}</H2>
              <p className="mt-4 text-lg leading-relaxed text-gray-600">{t.proof.lead}</p>
              <div className="mt-8">
                <AccuracyDiagram legend={t.proof.legend} />
              </div>
            </div>
            <dl className="grid gap-x-8 sm:grid-cols-2 lg:mt-1">
              {t.proof.points.map((p, i) => (
                <div key={p.t} className="border-t border-gray-200 py-5">
                  <dt className="flex items-baseline gap-2 font-semibold text-navy-900">
                    <span className="text-xs font-semibold tabular-nums text-gray-400" aria-hidden>
                      {i + 1}
                    </span>
                    {p.t}
                  </dt>
                  <dd className="mt-1.5 text-sm leading-relaxed text-gray-600">{p.d}</dd>
                </div>
              ))}
            </dl>
          </div>
        </Section>

        {/* Features: a reference list on the dark band, without a box around every item */}
        <Section id="features" className="bg-navy-900">
          <H2 light>{t.features.title}</H2>
          <ul className="mt-12 grid gap-x-8 sm:grid-cols-2 lg:grid-cols-4">
            {t.features.items.map((f, i) => {
              const Icon = FEATURE_ICONS[i];
              return (
                <li key={f.t} className="border-t border-white/15 py-6">
                  <h3 className="flex items-center gap-2.5 font-semibold text-white">
                    <Icon className="h-5 w-5 shrink-0 text-accent-500" aria-hidden />
                    {f.t}
                  </h3>
                  <p className="mt-2 text-sm leading-relaxed text-navy-100/75">{f.d}</p>
                </li>
              );
            })}
          </ul>
        </Section>

        {/* Privacy */}
        <Section className="bg-white">
          <div className="grid gap-8 lg:grid-cols-[1fr_1.4fr] lg:gap-16">
            <div>
              <H2>{t.privacy.title}</H2>
              <p className="mt-3 text-lg text-gray-600">{t.privacy.lead}</p>
            </div>
            <ul className="divide-y divide-gray-200 border-y border-gray-200">
              {t.privacy.points.map((p) => (
                <li key={p} className="flex gap-3 py-4 text-gray-800">
                  <Check className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" aria-hidden /> {p}
                </li>
              ))}
            </ul>
          </div>
        </Section>

        {/* FAQ */}
        <Section id="faq" className="border-t border-gray-200">
          <div className="grid gap-8 lg:grid-cols-[1fr_2fr] lg:gap-16">
            <H2>{t.faq.title}</H2>
            <div className="divide-y divide-gray-200 border-y border-gray-200">
              {t.faq.items.map((f) => (
                <details key={f.q} className="group">
                  <summary className="flex min-h-11 cursor-pointer items-center justify-between gap-4 py-5 font-semibold text-navy-900">
                    {f.q}
                    <ChevronDown className="h-5 w-5 shrink-0 text-gray-500 transition-transform group-open:rotate-180" aria-hidden />
                  </summary>
                  <p className="-mt-1 max-w-2xl pb-5 leading-relaxed text-gray-600">{f.a}</p>
                </details>
              ))}
            </div>
          </div>
        </Section>

        {/* Closing call to action */}
        <section className="border-t border-gray-200 bg-white px-4 py-16 sm:px-6 sm:py-20">
          <div className="mx-auto flex max-w-6xl flex-col gap-8 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <H2>{t.cta.title}</H2>
              <p className="mt-4 max-w-xl text-lg text-gray-600">{t.cta.lead}</p>
            </div>
            <div className="flex shrink-0 flex-col gap-3 sm:flex-row">
              <DashboardLink path="/signup" className={btnPrimary}>
                {t.cta.primary} <ArrowRight className="h-4 w-4" aria-hidden />
              </DashboardLink>
              {talkHref && (
                <a href={talkHref} className={btnGhost}>
                  <MessageCircle className="h-4 w-4" aria-hidden /> {t.cta.talk}
                </a>
              )}
            </div>
          </div>
        </section>
      </main>

      {/* Footer */}
      <footer className="bg-navy-950 px-4 pb-[max(2rem,env(safe-area-inset-bottom))] pt-12 text-sm text-navy-100/70 sm:px-6">
        <div className="mx-auto grid max-w-6xl gap-10 sm:grid-cols-2 lg:grid-cols-[2fr_1fr_1fr]">
          <div>
            <Logo dark />
            <p className="mt-3 max-w-xs">{t.footer.tagline}</p>
            <p className="mt-4">
              {t.footer.by} <span className="font-semibold text-white">Dhisha AI</span>
            </p>
          </div>
          <div>
            <h2 className="font-semibold text-white">{t.footer.product}</h2>
            <ul className="mt-3 space-y-2">
              {navLinks.map(([href, label]) => (
                <li key={href}>
                  <a href={href} className="hover:text-white">
                    {label}
                  </a>
                </li>
              ))}
              <li>
                <DashboardLink className="hover:text-white">{t.nav.login}</DashboardLink>
              </li>
            </ul>
          </div>
          {hasContact && (
            <div>
              <h2 className="font-semibold text-white">{t.footer.contact}</h2>
              <ul className="mt-3 space-y-2">
                {site.phone && (
                  <li>
                    <a href={`tel:${site.phone}`} className="inline-flex items-center gap-2 hover:text-white">
                      <Phone className="h-4 w-4" aria-hidden /> {site.phone}
                    </a>
                  </li>
                )}
                {site.whatsapp && (
                  <li>
                    <a href={`https://wa.me/${site.whatsapp}`} className="inline-flex items-center gap-2 hover:text-white">
                      <MessageCircle className="h-4 w-4" aria-hidden /> {t.footer.whatsapp}
                    </a>
                  </li>
                )}
                {site.email && (
                  <li>
                    <a href={`mailto:${site.email}`} className="inline-flex items-center gap-2 break-all hover:text-white">
                      <Mail className="h-4 w-4 shrink-0" aria-hidden /> {site.email}
                    </a>
                  </li>
                )}
              </ul>
            </div>
          )}
        </div>
        <div className="mx-auto mt-10 flex max-w-6xl flex-col gap-2 border-t border-white/10 pt-6 text-xs sm:flex-row sm:justify-between">
          <p>
            © {new Date().getFullYear()} Dhisha AI. {t.footer.rights}
          </p>
          <Link href={other} className="inline-flex items-center gap-1.5 hover:text-white">
            <Languages className="h-3.5 w-3.5" aria-hidden /> {t.nav.lang}
          </Link>
        </div>
      </footer>
    </>
  );
}
