'use client';
import { useEffect, useState } from 'react';
import { useMe } from './me';

const KEY = 'ga.includeSimulated';

/**
 * Whether pages count demo and simulated records. Off by default; the switch exists only while the
 * server runs in demo mode (in production there is no simulated data and nothing to switch).
 * One choice for the Overview, Live map and Reports, so their figures always describe the same people.
 */
export function useIncludeSimulated(): { include: boolean; set: (v: boolean) => void; available: boolean } {
  const { me } = useMe();
  const available = !!me?.demoMode;
  const [value, setValue] = useState(false);
  useEffect(() => {
    try {
      setValue(sessionStorage.getItem(KEY) === '1');
    } catch {
      /* storage blocked: keep the default */
    }
  }, []);
  const set = (v: boolean) => {
    setValue(v);
    try {
      sessionStorage.setItem(KEY, v ? '1' : '0');
    } catch {
      /* not remembered, still applied */
    }
  };
  return { include: available && value, set, available };
}
