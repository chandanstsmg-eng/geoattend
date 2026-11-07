'use client';
import { useSyncExternalStore } from 'react';
import { AlertTriangle, CheckCircle2, X } from 'lucide-react';
import { cx } from './ui';

type Toast = { id: number; text: string; tone: 'success' | 'error' };

// A small module-level store: toast() can be called from anywhere, including the query cache.
let items: Toast[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const publish = (next: Toast[]) => {
  items = next;
  listeners.forEach((l) => l());
};
const dismiss = (id: number) => publish(items.filter((t) => t.id !== id));

/** Brief confirmation that something finished, or that it failed. Errors stay longer. */
export function toast(text: string, tone: Toast['tone'] = 'success') {
  const id = nextId++;
  publish([...items.slice(-2), { id, text, tone }]);
  setTimeout(() => dismiss(id), tone === 'error' ? 8000 : 4000);
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const EMPTY: Toast[] = [];

export function Toaster() {
  const list = useSyncExternalStore(subscribe, () => items, () => EMPTY);
  return (
    <div aria-live="polite" className="pointer-events-none fixed inset-x-4 bottom-4 z-[60] flex flex-col items-center gap-2 sm:inset-x-auto sm:right-5 sm:items-end">
      {list.map((t) => (
        <div key={t.id} role={t.tone === 'error' ? 'alert' : 'status'} className={cx('ga-toast pointer-events-auto flex w-full max-w-sm items-start gap-2.5 rounded-md border bg-white px-3.5 py-2.5 text-sm text-gray-800 shadow-lg', t.tone === 'error' ? 'border-red-200' : 'border-gray-200')}>
          {t.tone === 'error' ? <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" aria-hidden /> : <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-teal-600" aria-hidden />}
          <p className="min-w-0 flex-1">{t.text}</p>
          <button type="button" aria-label="Dismiss" className="-mr-1 rounded p-0.5 text-gray-500 hover:text-gray-700" onClick={() => dismiss(t.id)}>
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
      ))}
    </div>
  );
}
