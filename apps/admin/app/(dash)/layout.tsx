'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Bell,
  Building2,
  CalendarClock,
  CalendarRange,
  CalendarOff,
  ChevronDown,
  ChevronRight,
  ClipboardCheck,
  FileBarChart,
  FlaskConical,
  Hourglass,
  Inbox,
  LayoutDashboard,
  Megaphone,
  LogOut,
  Map as MapIcon,
  Menu as MenuIcon,
  PanelLeftClose,
  PanelLeftOpen,
  Plane,
  Search,
  Settings,
  ShieldCheck,
  Lock,
  TimerOff,
  UserCog,
  Users,
  Wallet,
  X,
} from 'lucide-react';
import { ApiError, get, post } from '@/lib/api';
import { fmtDate } from '@/lib/format';
import { LiveProvider, useLive } from '@/lib/live';
import type { Me } from '@/lib/me';
import { AwayDialog, isAway, useSetAway } from '@/components/away-control';
import { SosBanner } from '@/components/sos-banner';
import { cx, EmptyState, ErrorState, Menu, Spinner } from '@/components/ui';
import { Lockup, Mark } from '@/components/brand';

type NavItem = { href: string; label: string; icon: typeof Bell; owner?: boolean };
type NavGroup = { title: string; items: NavItem[] };

// The two monitoring views sit above the groups: they are where every day starts.
const TOP: NavItem[] = [
  { href: '/', label: 'Overview', icon: LayoutDashboard },
  { href: '/map', label: 'Live map', icon: MapIcon },
];

// Grouped by the job at hand. Tasks are no longer in the navigation; their records and the
// worker app's task list remain so open tasks can still be finished.
const NAV: NavGroup[] = [
  {
    title: 'Workforce',
    items: [
      { href: '/employees', label: 'Employees', icon: Users },
      { href: '/team', label: 'Supervisors', icon: UserCog, owner: true },
      { href: '/workplaces', label: 'Workplaces', icon: Building2, owner: true },
      { href: '/roster', label: 'Rosters', icon: CalendarRange },
      // Creating and editing shifts is owner-only; supervisors pick existing shifts in the roster.
      { href: '/shifts', label: 'Shifts', icon: CalendarClock, owner: true },
    ],
  },
  {
    title: 'Time & attendance',
    items: [
      { href: '/attendance', label: 'Attendance', icon: ClipboardCheck },
      { href: '/approvals', label: 'Approvals', icon: Inbox },
      { href: '/overtime', label: 'Overtime', icon: Hourglass },
      { href: '/leave', label: 'Leave & holidays', icon: CalendarOff },
      { href: '/absences', label: 'Absence events', icon: TimerOff },
    ],
  },
  {
    title: 'Insights',
    items: [
      { href: '/reports', label: 'Reports', icon: FileBarChart },
      { href: '/payroll', label: 'Payroll', icon: Wallet, owner: true },
    ],
  },
  {
    title: 'Communication',
    items: [
      { href: '/announcements', label: 'Announcements', icon: Megaphone },
      { href: '/notifications', label: 'Notifications', icon: Bell },
    ],
  },
  {
    title: 'Administration',
    items: [
      { href: '/settings', label: 'Settings', icon: Settings, owner: true },
      { href: '/audit', label: 'Audit log', icon: ShieldCheck, owner: true },
      { href: '/privacy', label: 'Privacy policy', icon: Lock },
    ],
  },
];

const isActive = (href: string, path: string) => (href === '/' ? path === '/' : path === href || path.startsWith(`${href}/`));

/** Sidebar preferences survive reloads; a blocked or empty storage just means the defaults. */
const PREFS_KEY = 'geoattend.nav';
function loadPrefs(): { rail: boolean; closed: string[] } {
  try {
    const v = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}');
    return { rail: !!v.rail, closed: Array.isArray(v.closed) ? v.closed : [] };
  } catch {
    return { rail: false, closed: [] };
  }
}
function savePrefs(p: { rail: boolean; closed: string[] }) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    /* storage unavailable: preferences last for this visit only */
  }
}

function LiveIndicator() {
  const { state } = useLive();
  const label = state === 'live' ? 'Live' : state === 'connecting' ? 'Connecting…' : 'Reconnecting…';
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-gray-200 px-2 py-0.5 text-xs font-medium" role="status" aria-live="polite" title={state === 'live' ? 'Receiving real-time updates' : 'Real-time updates paused; pages still refresh periodically'}>
      <span className={cx('h-1.5 w-1.5 rounded-full', state === 'live' ? 'bg-teal-500' : 'animate-pulse bg-amber-500')} aria-hidden />
      <span className={state === 'live' ? 'text-gray-600' : 'text-amber-800'}>{label}</span>
    </span>
  );
}

function BellButton() {
  const unread = useQuery({ queryKey: ['unread'], queryFn: () => get<{ unread: number; critical: number }>('/notifications/unread-count'), refetchInterval: 60_000 });
  const n = unread.data?.unread ?? 0;
  return (
    <Link href="/notifications" className="relative inline-flex h-9 w-9 items-center justify-center rounded-md text-gray-500 hover:bg-gray-100 hover:text-navy-800" aria-label={`Notifications, ${n} unread${unread.data?.critical ? `, ${unread.data.critical} critical` : ''}`}>
      <Bell className="h-[18px] w-[18px]" aria-hidden />
      {n > 0 && (
        <span className={cx('tabular absolute -right-0.5 top-0 min-w-[18px] rounded-full px-1 text-center text-[10px] font-semibold leading-[18px] text-white ring-2 ring-white', unread.data?.critical ? 'bg-red-600' : 'bg-accent-600')} aria-hidden>
          {n > 99 ? '99+' : n}
        </span>
      )}
    </Link>
  );
}

/** Jumps to the employee list filtered by name, email or ID. */
function FindEmployee() {
  const router = useRouter();
  const [q, setQ] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!q.trim()) return;
    router.push(`/employees?q=${encodeURIComponent(q.trim())}`);
    setQ('');
  };
  return (
    <form role="search" onSubmit={submit} className="relative hidden w-64 md:block">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-500" aria-hidden />
      <input
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Find an employee…"
        aria-label="Find an employee by name, email or ID"
        className="h-9 w-full rounded-md border border-gray-200 bg-gray-50 pl-8 pr-3 text-sm text-gray-900 placeholder:text-gray-500 hover:border-gray-300 focus:bg-white"
      />
    </form>
  );
}

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('');

function UserMenu({ me, isOwner, onAway, onSignOut }: { me: Me; isOwner: boolean; onAway: () => void; onSignOut: () => void }) {
  const away = isAway(me.access?.awayUntil);
  const back = useSetAway();
  return (
    <Menu
      label={`Account menu for ${me.user.fullName}`}
      width={260}
      triggerClassName="flex items-center gap-2 rounded-md py-1 pl-1 pr-1.5 text-left hover:bg-gray-100"
      trigger={
        <>
          <span className="relative flex h-8 w-8 items-center justify-center rounded-full bg-navy-800 text-xs font-semibold text-white" aria-hidden>
            {initials(me.user.fullName)}
            {away && <span className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full bg-amber-500 ring-2 ring-white" />}
          </span>
          <span className="hidden min-w-0 leading-tight md:block">
            <span className="block max-w-40 truncate text-body-sm font-semibold text-gray-900">{me.user.fullName}</span>
            <span className="block text-xs text-gray-500">{isOwner ? 'Owner' : 'Supervisor'}{away ? ' · away' : ''}</span>
          </span>
          <ChevronDown className="hidden h-4 w-4 text-gray-500 md:block" aria-hidden />
        </>
      }
      items={[
        {
          heading: (
            <span className="block leading-snug">
              <span className="block truncate font-medium text-gray-900">{me.user.fullName}</span>
              <span className="block truncate">{me.user.email}</span>
              <span className="mt-0.5 block truncate">
                {isOwner ? 'Owner' : 'Supervisor'}
                {me.organization ? ` · ${me.organization.name}` : ''}
              </span>
            </span>
          ),
        },
        'separator',
        away
          ? { label: <>I’m back <span className="ml-auto text-xs text-gray-500">away until {fmtDate(me.access!.awayUntil)}</span></>, icon: <Plane />, onSelect: () => back.mutate(null) }
          : { label: 'Set away status…', icon: <Plane />, onSelect: onAway },
        { label: 'Notifications', icon: <Bell />, href: '/notifications' },
        ...(isOwner ? [{ label: 'Settings', icon: <Settings />, href: '/settings' }] : []),
        'separator',
        { label: 'Sign out', icon: <LogOut />, onSelect: onSignOut },
      ]}
    />
  );
}

function Shell({ children, me }: { children: ReactNode; me: Me }) {
  const path = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false); // phone / tablet drawer
  const [prefs, setPrefs] = useState(loadPrefs);
  const [awayOpen, setAwayOpen] = useState(false);
  const [tip, setTip] = useState<{ label: string; top: number } | null>(null);
  // Phone menu as a dialog: focus moves into it when it opens, the page behind is inert while it is open,
  // and closing it yourself (Escape, the X, the backdrop) returns focus to the menu button.
  const menuButton = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const drawer = useRef<HTMLElement>(null);
  const returnFocus = useRef(false);
  const closeMenu = () => {
    returnFocus.current = true; // focused after the re-render: the menu button is inert until then
    setOpen(false);
  };
  useEffect(() => setOpen(false), [path]);
  useEffect(() => {
    if (!open) {
      if (returnFocus.current) menuButton.current?.focus();
      returnFocus.current = false;
      return;
    }
    closeButton.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') return closeMenu();
      if (e.key !== 'Tab' || !drawer.current) return;
      // Keep Tab inside the open menu: from the last item back to the first, and the other way round.
      const items = [...drawer.current.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])')].filter((el) => el.offsetParent !== null);
      if (!items.length) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const inside = drawer.current.contains(document.activeElement);
      if (e.shiftKey && (document.activeElement === first || !inside)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (document.activeElement === last || !inside)) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);
  const update = (p: typeof prefs) => {
    setPrefs(p);
    savePrefs(p);
  };

  const isOwner = me.access?.role !== 'SUPERVISOR';
  // The API refuses these for supervisors; without this a typed address showed controls that fail on save.
  const ownerPage = NAV.flatMap((g) => g.items).some((n) => n.owner && isActive(n.href, path));
  // Supervisors see day-to-day pages only (the API refuses the rest anyway).
  const groups = (me.demoMode ? [...NAV, { title: 'Demo', items: [{ href: '/demo', label: 'Demo simulator', icon: FlaskConical, owner: true }] }] : NAV)
    .map((g) => ({ ...g, items: g.items.filter((n) => (isOwner || !n.owner) && (n.href !== '/payroll' || me.features?.payroll)) }))
    .filter((g) => g.items.length > 0);
  // Arriving on a page inside a collapsed group (a link, the back button) opens that group again.
  const currentGroup = groups.find((g) => g.items.some((n) => isActive(n.href, path)))?.title;
  const current = [...TOP, ...groups.flatMap((g) => g.items)].find((n) => isActive(n.href, path));
  useEffect(() => {
    if (currentGroup && prefs.closed.includes(currentGroup)) update({ ...prefs, closed: prefs.closed.filter((t) => t !== currentGroup) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);
  const waiting = useQuery({ queryKey: ['approvals', 'count'], queryFn: () => get<{ total: number }>('/approvals/count'), refetchInterval: 60_000 }).data?.total ?? 0;
  // The rail only applies on wide screens; the phone drawer always shows labels.
  const rail = prefs.rail && !open;

  async function signOut() {
    await post('/auth/logout').catch(() => undefined);
    router.replace('/login');
  }

  const showTip = (label: string) => (e: { currentTarget: HTMLElement }) => {
    const r = e.currentTarget.getBoundingClientRect();
    setTip({ label, top: r.top + r.height / 2 });
  };

  const item = ({ href, label, icon: Icon }: NavItem) => {
    const active = isActive(href, path);
    const count = href === '/approvals' && waiting > 0 ? (waiting > 99 ? '99+' : String(waiting)) : null;
    return (
      <li key={href}>
        <Link
          href={href}
          aria-current={active ? 'page' : undefined}
          aria-label={rail ? `${label}${count ? `, ${count} waiting` : ''}` : undefined}
          onMouseEnter={rail ? showTip(label) : undefined}
          onFocus={rail ? showTip(label) : undefined}
          onMouseLeave={() => setTip(null)}
          onBlur={() => setTip(null)}
          className={cx(
            'relative flex items-center gap-3 rounded-md text-body-sm transition-colors',
            rail ? 'mx-auto h-9 w-10 justify-center' : 'h-10 px-3 lg:h-9',
            active ? 'bg-navy-50 font-semibold text-navy-800' : 'text-gray-600 hover:bg-gray-50 hover:text-navy-800',
          )}
        >
          {active && <span className={cx('absolute inset-y-1.5 w-[3px] rounded-full bg-navy-800', rail ? '-left-[3px]' : '-left-2')} aria-hidden />}
          <Icon className={cx('h-[18px] w-[18px] shrink-0', active ? 'text-navy-700' : 'text-gray-500')} aria-hidden />
          {!rail && <span className="truncate">{label}</span>}
          {count &&
            (rail ? (
              <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-amber-500 ring-2 ring-white" aria-hidden />
            ) : (
              <span className="tabular ml-auto min-w-5 rounded-full bg-amber-50 px-1.5 text-center text-caption font-semibold leading-5 text-amber-800" aria-label={`${count} waiting`}>
                {count}
              </span>
            ))}
        </Link>
      </li>
    );
  };

  return (
    <div className={cx('min-h-dvh pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] print:pl-0', prefs.rail ? 'lg:pl-16' : 'lg:pl-60')}>
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded-md focus:bg-navy-800 focus:px-3 focus:py-2 focus:text-sm focus:font-semibold focus:text-white">Skip to content</a>
      <aside
        className={cx(
          'fixed inset-y-0 left-0 z-40 flex w-[min(17rem,85vw)] flex-col border-r border-gray-200 bg-white pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] transition-[transform,width] duration-200 print:hidden lg:translate-x-0',
          prefs.rail ? 'lg:w-16' : 'lg:w-60',
          open ? 'translate-x-0 shadow-2xl' : '-translate-x-full max-lg:invisible', // closed on phones: out of the tab order too
        )}
        ref={drawer}
        aria-label="Main navigation"
        {...(open ? { role: 'dialog', 'aria-modal': true } : {})}
      >
        <div className={cx('flex h-16 shrink-0 items-center gap-2.5 border-b border-gray-100', rail ? 'justify-center px-2' : 'px-4')}>
          <Link href="/" className="flex min-w-0 items-center gap-2.5 rounded-md" aria-label="GeoAttend by DhishaAI — overview">
            {rail ? <Mark className="h-9 w-9 shrink-0" /> : <Lockup />}
          </Link>
          <button ref={closeButton} className="ml-auto rounded-md p-2 text-gray-500 hover:bg-gray-100 hover:text-gray-900 lg:hidden" onClick={closeMenu} aria-label="Close menu">
            <X className="h-5 w-5" aria-hidden />
          </button>
        </div>
        <nav className="flex-1 overflow-y-auto px-3 py-3" onScroll={() => setTip(null)}>
          <ul className="space-y-0.5">{TOP.map(item)}</ul>
          {groups.map((g) => {
            const expanded = rail || !prefs.closed.includes(g.title);
            const id = `nav-${g.title.toLowerCase().replace(/\W+/g, '-')}`;
            return (
              <div key={g.title} className={rail ? 'mt-3' : 'mt-5'}>
                {rail ? (
                  <div className="mx-3 mb-3 border-t border-gray-100" role="presentation" />
                ) : (
                  <button
                    type="button"
                    aria-expanded={expanded}
                    aria-controls={id}
                    onClick={() => update({ ...prefs, closed: expanded ? [...prefs.closed, g.title] : prefs.closed.filter((t) => t !== g.title) })}
                    className="flex w-full items-center justify-between rounded px-3 py-1 text-caption font-semibold uppercase tracking-wider text-gray-500 hover:text-gray-800"
                  >
                    {g.title}
                    <ChevronDown className={cx('h-3.5 w-3.5 transition-transform', !expanded && '-rotate-90')} aria-hidden />
                  </button>
                )}
                <ul id={id} hidden={!expanded} className="mt-1 space-y-0.5">
                  {g.items.map(item)}
                </ul>
              </div>
            );
          })}
        </nav>
        <div className="hidden shrink-0 border-t border-gray-100 p-3 lg:block">
          <button
            type="button"
            onClick={() => {
              setTip(null);
              update({ ...prefs, rail: !prefs.rail });
            }}
            aria-label={prefs.rail ? 'Expand sidebar' : 'Collapse sidebar'}
            onMouseEnter={prefs.rail ? showTip('Expand sidebar') : undefined}
            onMouseLeave={() => setTip(null)}
            className={cx('hidden h-9 items-center gap-3 rounded-md text-body-sm text-gray-500 hover:bg-gray-50 hover:text-navy-800 lg:flex', prefs.rail ? 'mx-auto w-10 justify-center' : 'w-full px-3')}
          >
            {prefs.rail ? <PanelLeftOpen className="h-[18px] w-[18px]" aria-hidden /> : <PanelLeftClose className="h-[18px] w-[18px]" aria-hidden />}
            {!prefs.rail && 'Collapse sidebar'}
          </button>
        </div>
      </aside>
      {tip && rail && (
        <div role="tooltip" className="pointer-events-none fixed left-[4.5rem] z-50 -translate-y-1/2 whitespace-nowrap rounded-md bg-navy-900 px-2 py-1 text-xs font-medium text-white shadow-lg" style={{ top: tip.top }}>
          {tip.label}
        </div>
      )}
      {open && <div className="fixed inset-0 z-30 bg-navy-950/40 lg:hidden" onClick={closeMenu} aria-hidden />}
      <header inert={open || undefined} className="sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-gray-200 bg-white/95 px-4 backdrop-blur-sm sm:px-6 lg:px-8 print:hidden">
        <button ref={menuButton} className="-ml-2 rounded-md p-2 text-gray-700 hover:bg-gray-100 lg:hidden" onClick={() => setOpen(true)} aria-label="Open menu" aria-expanded={open}>
          <MenuIcon className="h-5 w-5" aria-hidden />
        </button>
        <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-body-sm">
          <span className="hidden truncate text-gray-500 sm:inline">{me.organization?.name ?? 'GeoAttend'}</span>
          {currentGroup && (
            <>
              <ChevronRight className="hidden h-3.5 w-3.5 shrink-0 text-gray-300 sm:block" aria-hidden />
              <span className="hidden truncate text-gray-500 md:inline">{currentGroup}</span>
            </>
          )}
          {current && (
            <>
              <ChevronRight className="hidden h-3.5 w-3.5 shrink-0 text-gray-300 sm:block" aria-hidden />
              <span className="truncate font-semibold text-navy-800" aria-current="page">{current.label}</span>
            </>
          )}
        </nav>
        {me.sampleData && (
          <span className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-dashed border-gray-300 bg-gray-50 px-2 py-0.5 text-xs font-medium text-gray-700" title="Sample company: every name, place and record is generated">
            <FlaskConical className="h-3.5 w-3.5" aria-hidden />
            Sample data
          </span>
        )}
        {me.demoMode && (
          <span className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-dashed border-violet-300 bg-violet-50 px-2 py-0.5 text-xs font-medium text-violet-800" title="Demo mode — simulated data is labelled SIMULATED">
            <FlaskConical className="h-3.5 w-3.5" aria-hidden />
            Demo
          </span>
        )}
        <div className="ml-auto flex items-center gap-2 sm:gap-3">
          <FindEmployee />
          <span className="hidden sm:inline-flex"><LiveIndicator /></span>
          <BellButton />
          <span className="hidden h-6 w-px bg-gray-200 sm:block" aria-hidden />
          <UserMenu me={me} isOwner={isOwner} onAway={() => setAwayOpen(true)} onSignOut={signOut} />
        </div>
      </header>
      <SosBanner />
      {me.sampleData && <SampleBanner />}
      <main id="main" tabIndex={-1} inert={open || undefined} className="mx-auto max-w-[1600px] outline-none px-4 pb-[max(2rem,env(safe-area-inset-bottom))] pt-5 sm:px-6 lg:px-8 lg:pt-6">{ownerPage && !isOwner ? <EmptyState title="Not available">This page is for company owners.</EmptyState> : children}</main>
      <AwayDialog open={awayOpen} onOpenChange={setAwayOpen} />
    </div>
  );
}

/** One dismissible notice instead of labels on every row; the header chip stays after dismissing. */
function SampleBanner() {
  const [hidden, setHidden] = useState(true);
  useEffect(() => {
    try {
      setHidden(sessionStorage.getItem('ga.sampleBanner') === 'hidden');
    } catch {
      setHidden(false);
    }
  }, []);
  if (hidden) return null;
  return (
    <div role="note" className="border-b border-gray-200 bg-white">
      <div className="mx-auto flex max-w-[1600px] items-center gap-3 px-4 py-2 text-body-sm text-gray-700 sm:px-6 lg:px-8">
        <FlaskConical className="h-4 w-4 shrink-0 text-gray-500" aria-hidden />
        <p className="flex-1">
          <strong className="font-semibold text-navy-900">Sample company.</strong> All names, places and records here are generated for demonstration. They are not real people or real attendance.
        </p>
        <button
          type="button"
          className="rounded-md p-1 text-gray-500 hover:bg-gray-100 hover:text-gray-800"
          aria-label="Dismiss the sample data notice"
          onClick={() => {
            setHidden(true);
            try {
              sessionStorage.setItem('ga.sampleBanner', 'hidden');
            } catch {
              /* hidden for this page view only */
            }
          }}
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>
    </div>
  );
}

import { ChangePassword } from '@/components/change-password';

export default function DashLayout({ children }: { children: ReactNode }) {
  const me = useQuery({ queryKey: ['me'], queryFn: () => get<Me>('/auth/me'), retry: false, staleTime: 5 * 60_000 });
  if (me.error && !(me.error instanceof ApiError && me.error.status === 401)) {
    return (
      <div className="mx-auto mt-20 max-w-md">
        <ErrorState error={me.error} onRetry={() => me.refetch()} />
      </div>
    );
  }
  if (me.isLoading || !me.data) return <Spinner label="Loading dashboard…" />;
  if (me.data.user.mustChangePassword) return <ChangePassword />;
  return (
    <LiveProvider>
      <Shell me={me.data}>{children}</Shell>
    </LiveProvider>
  );
}
