'use client';
import clsx from 'clsx';
import Link from 'next/link';
import * as Dialog from '@radix-ui/react-dialog';
import { createPortal } from 'react-dom';
import { AlertTriangle, ArrowDown, ArrowUp, ArrowUpDown, CheckCircle2, ChevronLeft, ChevronRight, Inbox, Info, Loader2, Search, X } from 'lucide-react';
import {
  Children,
  cloneElement,
  forwardRef,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type AnchorHTMLAttributes,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type InputHTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { errorMessage } from '@/lib/api';

export const cx = clsx;

/**
 * Base control classes, with the caller's height replacing the base height and the caller's
 * width applied from `sm` up. Simply appending both `w-full` and `w-auto` left the winner to
 * CSS order, which silently stretched every "w-auto" filter across the page. Widths used here
 * must be listed in the @source inline() line of app/globals.css.
 */
function withSize(base: string, className?: string) {
  const own = (className ?? '').split(/\s+/).filter(Boolean);
  const ownH = own.some((c) => c.startsWith('h-'));
  return cx(
    base
      .split(' ')
      .filter((c) => !(ownH && (c.startsWith('h-') || c.startsWith('sm:h-'))))
      .join(' '),
    // A width set by the caller (filter bars: "w-auto", "w-72") applies from `sm` up; on phones
    // controls stay full width, one per row, which is easier to tap than a ragged wrap.
    own.map((c) => (c.startsWith('w-') ? `sm:${c}` : c)).join(' '),
  );
}

// Primary actions wear the brand orange (accent-600 behind white text passes AA); `accent` is an
// alias for older call sites. `navy` is the solid brand button for secondary emphasis.
type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'accent' | 'subtle' | 'navy';
const buttonClass = (variant: Variant, size: 'sm' | 'md') =>
  cx(
    'inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition-[color,background-color,border-color,transform] duration-100 active:translate-y-px disabled:cursor-not-allowed disabled:opacity-50 disabled:active:translate-y-0',
    // slightly taller on phones for comfortable touch targets
    size === 'sm' ? 'h-9 px-3 text-body-sm sm:h-8 sm:px-2.5' : 'h-10 px-3.5 text-sm sm:h-9.5',
    (variant === 'primary' || variant === 'accent') && 'bg-accent-600 font-semibold text-white shadow-xs hover:bg-accent-700',
    variant === 'navy' && 'bg-navy-800 text-white shadow-xs hover:bg-navy-900',
    variant === 'secondary' && 'border border-gray-300 bg-white text-gray-800 shadow-xs hover:border-gray-400 hover:bg-gray-50',
    variant === 'ghost' && 'text-gray-700 hover:bg-gray-100',
    variant === 'subtle' && 'bg-gray-100 text-gray-800 hover:bg-gray-200',
    variant === 'danger' && 'bg-red-600 text-white shadow-xs hover:bg-red-700',
  );

/** A link that looks like a button: pages through the router, downloads (/api/…) as a plain link. */
export function LinkButton({ href, variant = 'secondary', size = 'md', className, children, ...rest }: Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> & { href: string; variant?: Variant; size?: 'sm' | 'md' }) {
  const cls = cx(buttonClass(variant, size), className);
  return href.startsWith('/api/') ? <a href={href} className={cls} {...rest}>{children}</a> : <Link href={href} className={cls} {...rest}>{children}</Link>;
}

export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md'; loading?: boolean }>(
  ({ variant = 'secondary', size = 'md', loading, className, children, disabled, ...rest }, ref) => (
    <button
      ref={ref}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cx(buttonClass(variant, size), className)}
      {...rest}
    >
      {loading && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
      {children}
    </button>
  ),
);
Button.displayName = 'Button';

export function Card({ className, children, title, description, actions, padded = true }: { className?: string; children: ReactNode; title?: ReactNode; description?: ReactNode; actions?: ReactNode; padded?: boolean }) {
  return (
    <section className={cx('rounded-lg border border-gray-200 bg-white shadow-card', className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-gray-200 px-4 py-3 sm:px-5">
          <div className="min-w-0">
            {title && <h2 className="text-title font-semibold leading-6 text-navy-900">{title}</h2>}
            {description && <p className="text-body-sm text-gray-500">{description}</p>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={padded ? 'p-4 sm:p-5' : ''}>{children}</div>
    </section>
  );
}

export function PageHeader({ title, description, actions, eyebrow }: { title: string; description?: ReactNode; actions?: ReactNode; eyebrow?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
      <div className="min-w-0 max-w-3xl">
        {eyebrow && <div className="mb-1 text-body-sm text-gray-500">{eyebrow}</div>}
        <h1 className="text-[22px] font-semibold leading-tight tracking-tight text-navy-800">{title}</h1>
        {description && <p className="mt-1 text-sm text-gray-500">{description}</p>}
      </div>
      {/* Phones: two controls per row so filters do not push the content off the first screen. */}
      {actions && <div className="grid w-full grid-cols-2 items-center gap-2 [&>*:last-child:nth-child(odd)]:col-span-2 sm:flex sm:w-auto sm:flex-wrap">{actions}</div>}
    </div>
  );
}

type Tone = 'gray' | 'green' | 'amber' | 'red' | 'blue' | 'navy' | 'orange' | 'purple' | 'teal';
const toneClass: Record<Tone, string> = {
  teal: 'bg-teal-50 text-teal-800',
  gray: 'bg-gray-100 text-gray-700',
  green: 'bg-teal-50 text-teal-800',
  amber: 'bg-amber-50 text-amber-800',
  red: 'bg-red-50 text-red-700',
  blue: 'bg-primary-50 text-primary-700',
  navy: 'bg-navy-50 text-navy-800',
  orange: 'bg-amber-50 text-amber-800',
  purple: 'bg-violet-50 text-violet-700',
};
const dotClass: Record<Tone, string> = {
  teal: 'bg-teal-500',
  gray: 'bg-gray-400',
  green: 'bg-teal-500',
  amber: 'bg-amber-500',
  red: 'bg-red-500',
  blue: 'bg-primary-500',
  navy: 'bg-navy-600',
  orange: 'bg-amber-500',
  purple: 'bg-violet-500',
};
/** A compact status label. `dot` adds a coloured marker; the text always carries the meaning. */
export function Badge({ tone = 'gray', children, className, title, dot }: { tone?: Tone; children: ReactNode; className?: string; title?: string; dot?: boolean }) {
  return (
    <span title={title} className={cx('inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-1.5 py-0.5 text-xs font-medium leading-4', toneClass[tone], className)}>
      {dot && <span className={cx('h-1.5 w-1.5 shrink-0 rounded-full', dotClass[tone])} aria-hidden />}
      {children}
    </span>
  );
}

export function SimBadge() {
  return (
    <span title="Generated by the demo simulator — not a real device or location" className="inline-flex items-center whitespace-nowrap rounded-md border border-dashed border-violet-300 bg-violet-50 px-1.5 text-caption font-semibold leading-4 tracking-wide text-violet-700">
      SIMULATED
    </span>
  );
}

/** Marks a fictional demo person, workplace or shift. */
export function DemoTag() {
  return (
    <span title="Fictional demo record" className="inline-flex items-center whitespace-nowrap rounded border border-dashed border-violet-300 px-1 text-caption font-medium leading-4 text-violet-700">
      demo
    </span>
  );
}

/**
 * A caption, a control and its hint or error. The caption is a real <label for> only when the first
 * direct child is a form control. Anything else (a row of preset buttons, a list of checkboxes)
 * becomes a named group, because wrapping those in <label> made a click on the caption press the
 * first button inside: clicking "Permitted radius" changed the geofence.
 */
export function Field({ label, hint, children, error, required }: { label: string; hint?: ReactNode; children: ReactNode; error?: string; required?: boolean }) {
  const id = useId();
  const box = useRef<HTMLDivElement>(null);
  const noteId = hint || error ? `${id}-note` : undefined;
  const kids = Children.toArray(children);
  const at = kids.findIndex((k) => isValidElement(k) && CONTROLS.has(k.type));
  const control = kids[at] as ReactElement<{ id?: string; 'aria-describedby'?: string; 'aria-invalid'?: boolean }> | undefined;
  const controlId = control?.props.id ?? `${id}-control`;
  if (control) {
    kids[at] = cloneElement(control, { id: controlId, 'aria-describedby': noteId, 'aria-invalid': error ? true : undefined });
  }
  // In a group, a control with no label of its own takes its name from the caption.
  useEffect(() => {
    if (control) return;
    for (const c of box.current?.querySelectorAll<HTMLInputElement>('input, select, textarea') ?? []) {
      if (!c.labels?.length && !c.getAttribute('aria-label')) c.setAttribute('aria-labelledby', `${id}-caption`);
    }
  });
  const caption = (
    <>
      {label}
      {required && <span className="ml-0.5 text-red-600" aria-hidden>*</span>}
    </>
  );
  const captionCls = 'mb-1.5 block text-body-sm font-medium text-gray-700';
  return (
    <div ref={box} className="block" role={control ? undefined : 'group'} aria-labelledby={control ? undefined : `${id}-caption`} aria-describedby={control ? undefined : noteId}>
      {control ? <label htmlFor={controlId} className={captionCls}>{caption}</label> : <span id={`${id}-caption`} className={captionCls}>{caption}</span>}
      {kids}
      {hint && !error && <span id={noteId} className="mt-1 block text-xs text-gray-500">{hint}</span>}
      {error && <span id={noteId} className="mt-1 block text-xs text-red-700">{error}</span>}
    </div>
  );
}

// 16px text below `sm` stops iOS Safari from zooming the page when a field is focused.
const inputCls =
  'h-10 w-full rounded-md border border-gray-300 bg-white px-3 text-base text-gray-900 shadow-xs transition-colors sm:h-9.5 sm:text-sm placeholder:text-gray-500 hover:border-gray-400 disabled:cursor-not-allowed disabled:bg-gray-50 disabled:text-gray-500';
export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(({ className, ...rest }, ref) => <input ref={ref} className={withSize(inputCls, className)} {...rest} />);
Input.displayName = 'Input';
export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(({ className, children, ...rest }, ref) => (
  <select ref={ref} className={withSize(cx(inputCls, 'pr-8'), className)} {...rest}>
    {children}
  </select>
));
Select.displayName = 'Select';
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(({ className, ...rest }, ref) => (
  <textarea ref={ref} className={withSize(inputCls, cx('h-auto min-h-20 py-2', className))} {...rest} />
));
Textarea.displayName = 'Textarea';
/**
 * Several values in one text box. The typed text is kept as it is while the box has focus, because
 * rebuilding it from the parsed list on every keystroke removed the comma the moment it was typed.
 */
export function ListInput<T extends string | number>({ value, parse, onChange, ...rest }: Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> & { value: T[]; parse: (raw: string) => T[]; onChange: (v: T[]) => void }) {
  const [text, setText] = useState<string | null>(null);
  return (
    <Input
      {...rest}
      value={text ?? value.join(', ')}
      onChange={(e) => {
        setText(e.target.value);
        onChange(parse(e.target.value));
      }}
      onBlur={() => setText(null)}
    />
  );
}
const CONTROLS = new Set<unknown>([Input, Select, Textarea, ListInput, 'input', 'select', 'textarea']);

/** Text input with a leading search icon. */
export function SearchInput({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div className={cx('relative w-full', className)}>
      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-500" aria-hidden />
      <Input type="search" {...rest} className="pl-8" />
    </div>
  );
}

/** The filter row at the top of a table panel. */
export function Toolbar({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx('flex flex-wrap items-center gap-2 border-b border-gray-200 px-4 py-3', className)}>{children}</div>;
}

export function Spinner({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-12 text-sm text-gray-500" role="status">
      <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> {label}
    </div>
  );
}

/** A placeholder block for anything that is not a table: size it with classes. */
export function Skeleton({ className }: { className?: string }) {
  return <div className={cx('animate-pulse rounded bg-gray-100', className)} aria-hidden />;
}

/** Renders its children only once they are about to scroll into view, for anything heavy low on a page. */
export function WhenVisible({ children, className }: { children: ReactNode; className?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    if (seen || !box.current) return;
    const io = new IntersectionObserver(([e]) => e?.isIntersecting && setSeen(true), { rootMargin: '400px' });
    io.observe(box.current);
    return () => io.disconnect();
  }, [seen]);
  return <div ref={box} className={seen ? undefined : className}>{seen ? children : null}</div>;
}

/** The heading of a dashboard section: states what the section answers, with its controls on the right. */
export function SectionHeading({ title, description, actions, className }: { title: string; description?: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <div className={cx('mb-3 mt-8 flex flex-wrap items-end justify-between gap-x-4 gap-y-2', className)}>
      <div className="min-w-0">
        <h2 className="text-base font-semibold text-navy-900">{title}</h2>
        {description && <p className="text-body-sm text-gray-500">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/** Says so when a list stops short of everything that exists, so a cut list is never read as complete. */
export function CutNotice({ shown, cap, noun }: { shown: number; cap: number; noun: string }) {
  if (shown < cap) return null;
  return (
    <p role="note" className="border-t border-gray-100 px-4 py-2.5 text-body-sm text-gray-600">
      Only the first {cap} {noun} are shown. There may be more; narrow the filters to see them.
    </p>
  );
}

/** Rows of placeholder lines: a list is loading. Shaped like the tables most pages open with. */
export function LoadingRows({ rows = 6, label = 'Loading…' }: { rows?: number; label?: string }) {
  return (
    <div role="status" aria-label={label} className="divide-y divide-gray-100">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-6 px-4 py-3.5">
          <div className="h-3.5 w-1/4 animate-pulse rounded bg-gray-100" />
          <div className="h-3.5 w-1/6 animate-pulse rounded bg-gray-100" />
          <div className="hidden h-3.5 w-1/5 animate-pulse rounded bg-gray-100 sm:block" />
          <div className="ml-auto h-3.5 w-12 animate-pulse rounded bg-gray-100" />
        </div>
      ))}
    </div>
  );
}

export function EmptyState({ title, children, icon, action }: { title: string; children?: ReactNode; icon?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-4 py-12 text-center">
      <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-gray-100 text-gray-500 [&_svg]:h-5 [&_svg]:w-5">{icon ?? <Inbox aria-hidden />}</div>
      <p className="text-sm font-medium text-gray-900">{title}</p>
      {children && <div className="mt-1 max-w-md text-sm text-gray-500">{children}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div role="alert" className="m-4 flex flex-col items-center gap-2 rounded-md border border-red-200 bg-red-50 px-4 py-6 text-center text-sm text-red-800">
      <AlertTriangle className="h-5 w-5" aria-hidden />
      <p>{errorMessage(error)}</p>
      {onRetry && (
        <Button size="sm" onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}

/** Wraps a react-query result into loading / error / empty / content states. */
export function QueryState<T>({ query, empty, isEmpty, children }: { query: { data?: T; isLoading: boolean; error: unknown; refetch: () => void }; empty?: ReactNode; isEmpty?: (d: T) => boolean; children: (d: T) => ReactNode }) {
  if (query.isLoading) return <LoadingRows />;
  if (query.error) return <ErrorState error={query.error} onRetry={() => query.refetch()} />;
  if (query.data === undefined) return null;
  if (isEmpty?.(query.data)) return <>{empty ?? <EmptyState title="Nothing here yet" />}</>;
  return <>{children(query.data)}</>;
}

type CalloutTone = 'info' | 'warning' | 'success' | 'danger' | 'neutral';
const calloutCls: Record<CalloutTone, string> = {
  info: 'border-primary-200 bg-primary-50 text-primary-800',
  warning: 'border-amber-200 bg-amber-50 text-amber-900',
  success: 'border-teal-200 bg-teal-50 text-teal-900',
  danger: 'border-red-200 bg-red-50 text-red-800',
  neutral: 'border-gray-200 bg-gray-50 text-gray-700',
};
/** An inline notice: one line of context, optionally with an action on the right. */
export function Callout({ tone = 'info', children, action, className, icon = true }: { tone?: CalloutTone; children: ReactNode; action?: ReactNode; className?: string; icon?: boolean }) {
  const Icon = tone === 'warning' || tone === 'danger' ? AlertTriangle : tone === 'success' ? CheckCircle2 : Info;
  return (
    <div className={cx('flex flex-wrap items-start gap-x-3 gap-y-2 rounded-md border px-3.5 py-2.5 text-sm', calloutCls[tone], className)}>
      {icon && <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />}
      <div className="min-w-0 flex-1">{children}</div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

/** A box that scrolls sideways can be reached and scrolled with the keyboard, but only while it actually overflows. */
export function useKeyboardScroll<T extends HTMLElement>() {
  const stop = useRef<(() => void) | null>(null);
  // A callback ref, because the box can appear after the first render, once its data has loaded.
  return useCallback((el: T | null) => {
    stop.current?.();
    stop.current = null;
    if (!el) return;
    const update = () => {
      if (el.scrollWidth > el.clientWidth + 1) {
        el.tabIndex = 0;
        el.setAttribute('role', 'region');
        el.setAttribute('aria-label', 'Table, scrolls sideways');
      } else {
        el.removeAttribute('tabindex');
        el.removeAttribute('role');
        el.removeAttribute('aria-label');
      }
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    stop.current = () => ro.disconnect();
  }, []);
}

/**
 * On phones (< 640px) rows are shown as stacked cards (see `.rtable` in globals.css): each
 * body cell is labelled with its column header so the content stays readable without
 * sideways scrolling. Pass `stack={false}` to keep a horizontally scrolling table instead.
 */
export function Table({ children, className, stack = true, minWidth = 640 }: { children: ReactNode; className?: string; stack?: boolean; minWidth?: number }) {
  const ref = useRef<HTMLTableElement>(null);
  const scroller = useKeyboardScroll<HTMLDivElement>();
  useEffect(() => {
    const table = ref.current;
    if (!table || !stack) return;
    const label = () => {
      const heads = [...table.querySelectorAll('thead th')].map((th) => (th.getAttribute('data-label') ?? th.textContent ?? '').trim());
      for (const row of table.querySelectorAll('tbody tr')) {
        let col = 0;
        for (const cell of row.children) {
          const span = (cell as HTMLTableCellElement).colSpan || 1;
          const text = span === 1 ? (heads[col] ?? '') : '';
          if (cell.getAttribute('data-label') !== text) cell.setAttribute('data-label', text);
          col += span;
        }
      }
    };
    label();
    const observer = new MutationObserver(label);
    observer.observe(table, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [stack]);
  return (
    // `relative`: absolutely positioned content (sr-only text) stays inside the scroll box instead of widening the page.
    <div ref={scroller} className={cx('relative overflow-x-auto', className)}>
      {/* The minimum width goes through a variable, not an inline min-width, so the phone card layout (.rtable in globals.css) can drop it. */}
      <table ref={ref} className={cx('w-full min-w-[var(--table-min)] text-left text-sm', stack && 'rtable')} style={{ '--table-min': `${minWidth}px` } as CSSProperties}>
        {children}
      </table>
    </div>
  );
}
export const Th = ({ children, className, label }: { children?: ReactNode; className?: string; label?: string }) => (
  <th scope="col" data-label={label} className={cx('h-10 whitespace-nowrap border-b border-gray-200 bg-gray-50 px-4 text-xs font-semibold text-gray-500', className)}>
    {children}
  </th>
);
export const Td = ({ children, className, colSpan }: { children?: ReactNode; className?: string; colSpan?: number }) => (
  <td colSpan={colSpan} className={cx('border-b border-gray-100 px-4 py-3 align-middle text-gray-800', className)}>
    {children}
  </td>
);
/** Classes for a body row that opens a record. Pair with `tabIndex={0}` and an Enter handler. */
export const rowLink = 'cursor-pointer transition-colors hover:bg-gray-50 focus-visible:bg-gray-50';
/** Enter or Space on a focused row, like a button. */
export const rowKeys = (open: () => void) => (e: ReactKeyboardEvent) => {
  if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return; // not while typing in a control inside the row
  e.preventDefault();
  open();
};

export type SortDir = 'asc' | 'desc';
/** A column header that sorts the table. `aria-sort` tells screen readers the current order. */
export function SortTh<K extends string>({ children, k, sort, onSort, className }: { children: ReactNode; k: K; sort: { key: K; dir: SortDir }; onSort: (s: { key: K; dir: SortDir }) => void; className?: string }) {
  const active = sort.key === k;
  const Icon = !active ? ArrowUpDown : sort.dir === 'asc' ? ArrowUp : ArrowDown;
  return (
    <th scope="col" aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'} data-label={typeof children === 'string' ? children : undefined} className={cx('h-10 whitespace-nowrap border-b border-gray-200 bg-gray-50 px-4 text-xs font-semibold text-gray-500', className)}>
      <button type="button" onClick={() => onSort({ key: k, dir: active && sort.dir === 'asc' ? 'desc' : 'asc' })} className={cx('-mx-1 inline-flex min-h-8 items-center gap-1 rounded px-1 hover:text-gray-900', active && 'text-gray-900')}>
        {children}
        <Icon className={cx('h-3.5 w-3.5', active ? 'text-gray-700' : 'text-gray-500')} aria-hidden />
      </button>
    </th>
  );
}

/** "21–40 of 112" with previous / next. */
export function Pagination({ offset, limit, total, onChange, noun = 'record' }: { offset: number; limit: number; total: number; onChange: (offset: number) => void; noun?: string }) {
  const from = total ? offset + 1 : 0;
  const to = Math.min(offset + limit, total);
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-body-sm text-gray-500">
      <span className="tabular">
        {total > limit ? `${from}–${to} of ${total}` : total} {noun}
        {total === 1 ? '' : 's'}
      </span>
      {total > limit && (
        <div className="flex gap-1">
          <Button size="sm" aria-label="Previous page" disabled={offset === 0} onClick={() => onChange(Math.max(0, offset - limit))}>
            <ChevronLeft className="h-4 w-4" aria-hidden /> Previous
          </Button>
          <Button size="sm" aria-label="Next page" disabled={offset + limit >= total} onClick={() => onChange(offset + limit)}>
            Next <ChevronRight className="h-4 w-4" aria-hidden />
          </Button>
        </div>
      )}
    </div>
  );
}

export function Modal({ open, onOpenChange, title, description, children, wide }: { open: boolean; onOpenChange: (o: boolean) => void; title: string; description?: string; children: ReactNode; wide?: boolean }) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="ga-fade fixed inset-0 z-40 bg-navy-950/40" />
        <Dialog.Content className={cx('ga-pop fixed left-1/2 top-1/2 z-50 max-h-[90dvh] w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg bg-white p-5 shadow-xl sm:p-6', wide ? 'max-w-3xl' : 'max-w-lg')}>
          <div className="mb-5 flex items-start justify-between gap-4">
            <div>
              <Dialog.Title className="text-base font-semibold text-gray-900">{title}</Dialog.Title>
              {description ? <Dialog.Description className="mt-1 text-sm text-gray-500">{description}</Dialog.Description> : <Dialog.Description className="sr-only">{title}</Dialog.Description>}
            </div>
            <Dialog.Close className="-mr-2 -mt-2 rounded-md p-2 text-gray-500 hover:bg-gray-100 hover:text-gray-800" aria-label="Close">
              <X className="h-5 w-5" />
            </Dialog.Close>
          </div>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function Drawer({ open, onOpenChange, title, subtitle, children }: { open: boolean; onOpenChange: (o: boolean) => void; title: ReactNode; subtitle?: ReactNode; children: ReactNode }) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="ga-fade fixed inset-0 z-40 bg-navy-950/30" />
        <Dialog.Content className="ga-slide fixed inset-y-0 right-0 z-50 flex w-full max-w-2xl flex-col bg-white shadow-2xl">
          <div className="flex items-start justify-between gap-4 border-b border-gray-200 px-4 py-4 sm:px-6">
            <div className="min-w-0">
              <Dialog.Title className="text-base font-semibold text-gray-900">{title}</Dialog.Title>
              <Dialog.Description className={subtitle ? 'mt-0.5 text-sm text-gray-500' : 'sr-only'}>{subtitle ?? 'Details'}</Dialog.Description>
            </div>
            <Dialog.Close className="-mr-1.5 rounded-md p-1.5 text-gray-500 hover:bg-gray-100 hover:text-gray-800" aria-label="Close">
              <X className="h-5 w-5" />
            </Dialog.Close>
          </div>
          <div className="flex-1 overflow-y-auto px-4 py-5 sm:px-6">{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * A button that asks before doing something consequential. The dialog states the effect; the
 * action runs only after the second, explicit confirmation.
 */
export function ConfirmButton({ children, title, description, confirmLabel, onConfirm, danger, loading, ...button }: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'title' | 'onClick'> & { variant?: Variant; size?: 'sm' | 'md'; title: string; description: string; confirmLabel: string; onConfirm: () => void; danger?: boolean; loading?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" {...button} loading={loading} onClick={() => setOpen(true)}>
        {children}
      </Button>
      <Modal open={open} onOpenChange={setOpen} title={title} description={description}>
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={() => setOpen(false)}>Cancel</Button>
          <Button
            type="button"
            variant={danger ? 'danger' : 'primary'}
            onClick={() => {
              setOpen(false);
              onConfirm();
            }}
          >
            {confirmLabel}
          </Button>
        </div>
      </Modal>
    </>
  );
}

/**
 * Tabs with arrow-key navigation. `variant="segmented"` is the compact pill group used for
 * filtering one list; the default underline style switches between views.
 */
export function Tabs<T extends string>({ value, onChange, tabs, variant = 'underline', className, label }: { value: T; onChange: (v: T) => void; tabs: ReadonlyArray<{ value: T; label: ReactNode; count?: number; alert?: boolean }>; variant?: 'underline' | 'segmented'; className?: string; label?: string }) {
  const onKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const i = tabs.findIndex((t) => t.value === value);
    const next = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : null;
    if (next === null) return;
    e.preventDefault();
    const t = tabs[(next + tabs.length) % tabs.length]!;
    onChange(t.value);
    (e.currentTarget.querySelector(`[data-tab="${t.value}"]`) as HTMLElement | null)?.focus();
  };
  const count = (t: (typeof tabs)[number], selected: boolean) =>
    t.count !== undefined && (
      <span className={cx('tabular min-w-5 rounded px-1 text-center text-caption font-semibold leading-4', t.alert && t.count > 0 ? 'bg-amber-100 text-amber-800' : selected ? 'bg-gray-200 text-gray-800' : 'bg-gray-100 text-gray-600')}>{t.count}</span>
    );
  if (variant === 'segmented')
    return (
      <div role="tablist" aria-label={label} onKeyDown={onKey} className={cx('inline-flex max-w-full gap-0.5 overflow-x-auto rounded-md bg-gray-100 p-0.5', className)}>
        {tabs.map((t) => (
          <button
            key={t.value}
            type="button"
            role="tab"
            data-tab={t.value}
            aria-selected={value === t.value}
            tabIndex={value === t.value ? 0 : -1}
            onClick={() => onChange(t.value)}
            className={cx('inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded px-3 text-body-sm font-medium transition-colors', value === t.value ? 'bg-white text-gray-900 shadow-xs ring-1 ring-gray-200' : 'text-gray-600 hover:text-gray-900')}
          >
            {t.label}
            {count(t, value === t.value)}
          </button>
        ))}
      </div>
    );
  return (
    <div role="tablist" aria-label={label} onKeyDown={onKey} className={cx('mb-5 flex gap-4 overflow-x-auto border-b border-gray-200', className)}>
      {tabs.map((t) => (
        <button
          key={t.value}
          type="button"
          role="tab"
          data-tab={t.value}
          aria-selected={value === t.value}
          tabIndex={value === t.value ? 0 : -1}
          onClick={() => onChange(t.value)}
          className={cx('-mb-px inline-flex min-w-6 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap border-b-2 px-0.5 pb-2.5 pt-1 text-sm font-medium transition-colors', value === t.value ? 'border-navy-800 text-navy-800' : 'border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-800')}
        >
          {t.label}
          {count(t, value === t.value)}
        </button>
      ))}
    </div>
  );
}

export function InlineError({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <p role="alert" className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      {errorMessage(error)}
    </p>
  );
}

export function KeyValue({ items, cols = 2 }: { items: Array<[string, ReactNode]>; cols?: 1 | 2 }) {
  return (
    <dl className={cx('grid grid-cols-1 gap-x-6 gap-y-3 text-sm', cols === 2 && 'sm:grid-cols-2')}>
      {items.map(([k, v]) => (
        <div key={k} className="flex min-w-0 flex-col">
          <dt className="text-xs text-gray-500">{k}</dt>
          <dd className="break-words text-gray-900">{v ?? '—'}</dd>
        </div>
      ))}
    </dl>
  );
}

export type MenuItem = { label: ReactNode; onSelect?: () => void; href?: string; icon?: ReactNode; danger?: boolean; disabled?: boolean } | 'separator' | { heading: ReactNode };

/**
 * A dropdown of short actions. Opens with click, Enter, Space or ArrowDown; arrow keys move,
 * Escape and Tab close and return focus to the trigger. Positioned `fixed` from the trigger so
 * it is never clipped by a scrolling table or panel, and flips upward near the bottom edge.
 */
export function Menu({ trigger, items, label, align = 'end', triggerClassName, width = 224 }: { trigger: ReactNode; items: MenuItem[]; label: string; align?: 'start' | 'end'; triggerClassName?: string; width?: number }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top?: number; bottom?: number; left: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const id = useId();

  const place = useCallback(() => {
    const r = btn.current?.getBoundingClientRect();
    if (!r) return;
    const left = Math.max(8, Math.min(window.innerWidth - width - 8, align === 'end' ? r.right - width : r.left));
    const below = window.innerHeight - r.bottom;
    setPos(below < 260 && r.top > below ? { bottom: window.innerHeight - r.top + 4, left } : { top: r.bottom + 4, left });
  }, [align, width]);

  useLayoutEffect(() => {
    if (!open) return;
    place();
    const close = () => setOpen(false);
    const outside = (e: MouseEvent) => {
      if (!list.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node)) close();
    };
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    document.addEventListener('mousedown', outside);
    return () => {
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
      document.removeEventListener('mousedown', outside);
    };
  }, [open, place]);

  useEffect(() => {
    if (open && pos) (list.current?.querySelector('[role="menuitem"]:not([aria-disabled="true"])') as HTMLElement | null)?.focus();
  }, [open, pos]);

  const focusables = () => [...(list.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])') ?? [])];
  const onKey = (e: ReactKeyboardEvent) => {
    const els = focusables();
    const i = els.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'ArrowDown') (e.preventDefault(), els[(i + 1) % els.length]?.focus());
    else if (e.key === 'ArrowUp') (e.preventDefault(), els[(i - 1 + els.length) % els.length]?.focus());
    else if (e.key === 'Home') (e.preventDefault(), els[0]?.focus());
    else if (e.key === 'End') (e.preventDefault(), els[els.length - 1]?.focus());
    else if (e.key === 'Escape' || e.key === 'Tab') {
      if (e.key === 'Escape') e.preventDefault();
      setOpen(false);
      btn.current?.focus();
    }
  };
  const choose = (onSelect?: () => void) => {
    setOpen(false);
    btn.current?.focus();
    onSelect?.();
  };

  return (
    <>
      <button
        ref={btn}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={label}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setOpen(true);
          }
        }}
        className={triggerClassName ?? 'inline-flex h-8 w-8 items-center justify-center rounded-md text-gray-500 hover:bg-gray-100 hover:text-gray-900'}
      >
        {trigger}
      </button>
      {/* In a portal: a parent with a filter or transform (the blurred sticky header) would otherwise become the origin of `fixed`. */}
      {open && pos && createPortal(
        <div
          ref={list}
          id={id}
          role="menu"
          aria-label={label}
          onKeyDown={onKey}
          onClick={(e) => e.stopPropagation()}
          style={{ position: 'fixed', width, ...pos }}
          className="ga-fade z-50 max-h-[70vh] overflow-y-auto rounded-lg border border-gray-200 bg-white py-1 text-sm shadow-lg"
        >
          {items.map((it, i) => {
            if (it === 'separator') return <div key={i} role="separator" className="my-1 border-t border-gray-100" />;
            if ('heading' in it) return <div key={i} className="px-3 py-2 text-xs text-gray-500">{it.heading}</div>;
            const cls = cx(
              'flex w-full items-center gap-2.5 px-3 py-2 text-left outline-none focus-visible:bg-gray-100 [&_svg]:h-4 [&_svg]:w-4 [&_svg]:shrink-0',
              it.disabled ? 'cursor-not-allowed text-gray-500' : it.danger ? 'text-red-700 hover:bg-red-50 focus-visible:bg-red-50' : 'text-gray-800 hover:bg-gray-100',
            );
            const content = (
              <>
                {it.icon && <span className={it.danger ? 'text-red-600' : 'text-gray-500'}>{it.icon}</span>}
                {it.label}
              </>
            );
            return it.href && !it.disabled ? (
              <Link key={i} role="menuitem" tabIndex={-1} href={it.href} className={cls} onClick={() => setOpen(false)}>
                {content}
              </Link>
            ) : (
              <button key={i} type="button" role="menuitem" tabIndex={-1} aria-disabled={it.disabled || undefined} className={cls} onClick={() => !it.disabled && choose(it.onSelect)}>
                {content}
              </button>
            );
          })}
        </div>,
        document.body,
      )}
    </>
  );
}
