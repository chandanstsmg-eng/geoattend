'use client';
import { MutationCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { ApiError, errorMessage } from '@/lib/api';
import { Toaster, toast } from '@/components/toast';

declare module '@tanstack/react-query' {
  interface Register {
    /**
     * Feedback for a mutation, in one place: `success` is shown when it finishes; `toastError`
     * reports a failure for mutations that have no inline error of their own.
     */
    mutationMeta: { success?: string; toastError?: boolean };
  }
}

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        mutationCache: new MutationCache({
          onSuccess: (_d, _v, _c, m) => {
            if (m.meta?.success) toast(m.meta.success);
          },
          onError: (err, _v, _c, m) => {
            if (m.meta?.toastError) toast(errorMessage(err), 'error');
          },
        }),
        defaultOptions: {
          queries: {
            staleTime: 10_000,
            refetchOnWindowFocus: true,
            retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
          },
        },
      }),
  );
  return (
    <QueryClientProvider client={client}>
      {children}
      <Toaster />
    </QueryClientProvider>
  );
}
