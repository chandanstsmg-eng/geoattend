import { useEffect, useState, useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNetInfo } from '@react-native-community/netinfo';
import { api, ApiError } from './api/client';
import type { Assignment, SessionStatus } from './api/types';
import { qk } from './queryClient';
import { reconcile } from './tracking/runtime';
import { getSnapshot, subscribe } from './tracking/store';

/**
 * The open session's server status (null when no session is open). The query
 * function also reconciles the device's location collection with the server.
 */
export function useStatus(opts: { poll?: boolean } = {}) {
  return useQuery<SessionStatus | null>({
    queryKey: qk.status,
    queryFn: async () => {
      const r = await reconcile();
      if (r.offline) throw new ApiError(0, 'NETWORK_ERROR', 'Offline — showing the last known status.');
      return r.status && r.status.tracking.shouldTrack ? r.status : null;
    },
    refetchInterval: opts.poll ? 15_000 : false,
    staleTime: 5_000,
  });
}

export function useAssignment() {
  return useQuery<Assignment>({ queryKey: qk.assignment, queryFn: () => api<Assignment>('/me/assignment') });
}

export function useTrackingSnapshot() {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function useOnline(): boolean {
  const net = useNetInfo();
  if (net.isConnected === null) return true; // unknown yet: do not alarm
  return net.isConnected && net.isInternetReachable !== false;
}

/** Re-render every `ms` (for "x min ago" labels). */
export function useNow(ms = 15_000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}
