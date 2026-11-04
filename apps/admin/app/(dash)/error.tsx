'use client';
import { useEffect } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui';

/** A page crashed: the navigation stays, and the page can be retried without a full reload. */
export default function PageError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <div role="alert" className="mx-auto mt-16 max-w-md text-center">
      <AlertTriangle className="mx-auto h-6 w-6 text-amber-600" aria-hidden />
      <h1 className="mt-3 text-lg font-semibold text-navy-900">This page could not be shown</h1>
      <p className="mt-1 text-sm text-gray-500">Nothing was lost. Try again, or open another page from the menu. If it keeps happening, tell your administrator what you were doing.</p>
      <Button className="mt-4" onClick={reset}>Try again</Button>
    </div>
  );
}
