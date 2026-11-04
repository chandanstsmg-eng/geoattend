/**
 * Background location task. Defined at module top level and imported from the
 * root layout so the definition exists whenever the OS wakes the JS runtime
 * (including headless starts after the app was swiped away).
 *
 * The task NEVER opens UI or the camera; it only queues + uploads readings and
 * may post local notifications.
 */
import * as TaskManager from 'expo-task-manager';
import type { LocationObject } from 'expo-location';
import { LOCATION_TASK } from '../config';
import { recordLocations } from './runtime';
import { updateMeta } from './store';

if (!TaskManager.isTaskDefined(LOCATION_TASK)) {
  TaskManager.defineTask<{ locations?: LocationObject[] }>(LOCATION_TASK, async ({ data, error }) => {
    if (error) {
      await updateMeta((m) => ({ ...m, lastError: `Location error: ${error.message}` })).catch(() => undefined);
      return;
    }
    const locations = data?.locations ?? [];
    if (locations.length === 0) return;
    try {
      await recordLocations(locations);
    } catch (e) {
      await updateMeta((m) => ({ ...m, lastError: e instanceof Error ? e.message : String(e) })).catch(() => undefined);
    }
  });
}
