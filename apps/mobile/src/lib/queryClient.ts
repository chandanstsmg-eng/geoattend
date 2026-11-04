import { QueryClient } from '@tanstack/react-query';
import { ApiError } from './api/client';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      retry: (count, err) => !(err instanceof ApiError && err.status >= 400 && err.status < 500) && count < 2,
    },
    mutations: { retry: false },
  },
});

export const qk = {
  status: ['tracking', 'current'] as const,
  assignment: ['me', 'assignment'] as const,
  history: ['me', 'attendance'] as const,
  reviews: ['me', 'reviews'] as const,
  leave: ['me', 'leave'] as const,
  earnings: ['me', 'earnings'] as const,
  tasks: ['me', 'tasks'] as const,
  privacy: ['me', 'privacy-notice'] as const,
  me: ['auth', 'me'] as const,
};
