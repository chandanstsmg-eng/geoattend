'use client';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, Circle } from 'lucide-react';
import { get } from '@/lib/api';
import { cx } from './ui';

/** Setup checklist for a new company; disappears once attendance has been recorded. */
export function GettingStarted({ welcome }: { welcome?: boolean }) {
  const org = useQuery({ queryKey: ['organization'], queryFn: () => get('/organization') });
  const o = org.data;
  if (!o || o.attendance_records > 0) return null;
  const steps = [
    { done: o.workplaces > 0, label: 'Add your workplace', hint: 'Search the address and set the attendance radius.', href: '/workplaces/new' },
    { done: o.shifts > 0, label: 'Create a shift', hint: 'Working hours and days, with a grace time for late arrival.', href: '/shifts' },
    { done: o.employees > 0, label: 'Add your staff', hint: 'One by one, or import a list from Excel.', href: '/employees' },
    { done: o.shift_assignments > 0, label: 'Assign staff to the shift', hint: 'Open an employee and choose their workplace and shift.', href: '/employees' },
    { done: false, label: 'Staff install the app and mark attendance', hint: 'They sign in with their email and the temporary password you share.', href: '/map' },
  ];
  const next = steps.findIndex((s) => !s.done);
  return (
    <section className="mb-6 rounded-lg border border-gray-200 bg-white p-4 sm:p-5" aria-label="Getting started">
      <h2 className="text-title font-semibold text-gray-900">{welcome ? `Welcome, ${o.name}!` : 'Finish setting up'}</h2>
      <p className="mt-0.5 text-sm text-gray-500">Five steps and your team is marking attendance.</p>
      <ol className="mt-4 grid gap-2 md:grid-cols-5">
        {steps.map((s, i) => (
          <li key={s.label}>
            <Link
              href={s.href}
              className={cx('flex h-full gap-2 rounded-md border p-3 text-sm transition-colors hover:bg-gray-50', i === next ? 'border-primary-600 bg-primary-50/40 ring-1 ring-primary-600' : 'border-gray-200')}
            >
              {s.done ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-teal-600" aria-label="Done" /> : <Circle className="mt-0.5 h-4 w-4 shrink-0 text-gray-500" aria-label="To do" />}
              <span>
                <span className={cx('block font-medium', s.done ? 'text-gray-500 line-through' : 'text-gray-900')}>{i + 1}. {s.label}</span>
                <span className="mt-0.5 block text-xs text-gray-500">{s.hint}</span>
              </span>
            </Link>
          </li>
        ))}
      </ol>
    </section>
  );
}
