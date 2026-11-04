'use client';
/**
 * Live connection to the API's Server-Sent Events stream. Each event
 * invalidates the affected react-query caches; the UI exposes the connection
 * state so a broken stream is shown as "Reconnecting", never as live data.
 */
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';

type LiveState = 'connecting' | 'live' | 'reconnecting';
const LiveContext = createContext<{ state: LiveState; lastEventAt: number | null }>({ state: 'connecting', lastEventAt: null });

export function LiveProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [state, setState] = useState<LiveState>('connecting');
  const [lastEventAt, setLast] = useState<number | null>(null);
  const pending = useRef(new Set<string>());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let es: EventSource | null = null;
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | null = null;
    // Back off 3 s → 6 → 12 → … → 60 s while the API is down, so a stopped API
    // does not flood both terminals with 502s; reset once the stream says hello.
    let delay = 3000;

    // Coalesce bursts (e.g. a batch upload of 50 readings) into one refetch per key.
    const invalidate = (...keys: string[]) => {
      keys.forEach((k) => pending.current.add(k));
      if (timer.current) return;
      timer.current = setTimeout(() => {
        for (const k of pending.current) qc.invalidateQueries({ queryKey: [k] });
        pending.current.clear();
        timer.current = null;
      }, 400);
    };

    const connect = () => {
      es = new EventSource('/api/v1/notifications/stream');
      es.addEventListener('hello', () => {
        setState('live');
        delay = 3000;
        // After a reconnect, anything may have changed.
        invalidate('live', 'overview', 'notifications', 'unread', 'attendance', 'absences', 'demo', 'overtime');
      });
      es.addEventListener('session.updated', () => {
        setLast(Date.now());
        invalidate('live', 'overview', 'demo', 'session');
      });
      es.addEventListener('notification.created', () => {
        setLast(Date.now());
        invalidate('notifications', 'unread', 'overview', 'absences', 'demo', 'reviews', 'overtime', 'approvals');
      });
      es.addEventListener('attendance.recorded', () => {
        setLast(Date.now());
        invalidate('attendance', 'overview', 'live', 'demo');
      });
      es.addEventListener('workplace.updated', () => invalidate('workplaces', 'live'));
      es.onerror = () => {
        setState('reconnecting');
        es?.close();
        if (closed) return;
        retry = setTimeout(connect, delay);
        delay = Math.min(delay * 2, 60_000);
      };
    };
    // A page kept in the back/forward cache would otherwise hold its stream open
    // (browsers allow only ~6 connections per host), so close on pagehide.
    const onHide = () => {
      es?.close();
      if (retry) clearTimeout(retry);
    };
    const onShow = (e: PageTransitionEvent) => {
      if (e.persisted && !closed) connect();
    };
    window.addEventListener('pagehide', onHide);
    window.addEventListener('pageshow', onShow);
    connect();
    return () => {
      closed = true;
      window.removeEventListener('pagehide', onHide);
      window.removeEventListener('pageshow', onShow);
      es?.close();
      if (retry) clearTimeout(retry);
    };
  }, [qc]);

  return <LiveContext.Provider value={{ state, lastEventAt }}>{children}</LiveContext.Provider>;
}

export const useLive = () => useContext(LiveContext);
