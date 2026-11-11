'use client';
import type { ReactNode } from 'react';
import { Lockup } from './brand';

/** The plain centred card used by the sign-in side pages (forgotten password, reset, invitation). */
export function AuthShell({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <main className="flex min-h-dvh flex-col bg-gray-50 px-4 py-6 sm:px-8">
      <Lockup />
      <div className="flex flex-1 items-start justify-center pb-10 pt-12 sm:items-center sm:pt-10">
        <div className="w-full max-w-sm rounded-lg border border-gray-200 bg-white p-6 shadow-card">
          <h1 className="text-xl font-semibold tracking-tight text-navy-800">{title}</h1>
          {description ? <p className="mb-6 mt-1 text-sm text-gray-500">{description}</p> : <div className="mb-4" />}
          {children}
        </div>
      </div>
    </main>
  );
}

/** The one-time token from the link. It travels after `#`, so it never reaches the server in a page request. */
export function tokenFromHash() {
  if (typeof window === 'undefined') return '';
  const fromLink = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('token');
  // Kept once read: the address bar is cleared straight after, and a second read on the same page (React runs
  // effects twice in development, and again after a fast refresh) must still find it.
  if (fromLink) kept = { path: window.location.pathname, token: fromLink };
  return fromLink ?? (kept?.path === window.location.pathname ? kept.token : '');
}
let kept: { path: string; token: string } | null = null;

/** Removes the token from the address bar once read, so it is not left on screen or in history. */
export function clearHash() {
  if (typeof window !== 'undefined' && window.location.hash) window.history.replaceState(null, '', window.location.pathname);
}
