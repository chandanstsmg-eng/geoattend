import { AppState } from 'react-native';
import { focusManager, QueryClient } from '@tanstack/react-query';
import { ApiError } from './api/client';

// Coming back to the app refreshes what is stale. The app is never reported as unfocused: react-query
// would then pause a failed query until it returned, and the tracking poll must keep running behind the lock screen.
focusManager.setEventListener(() => {
  const sub = AppState.addEventListener('change', (state) => {
    if (state === 'active') focusManager.onFocus();
  });
  return () => sub.remove();
});

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
