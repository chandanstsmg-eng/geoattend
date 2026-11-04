/**
 * Invisible component mounted while signed in. Keeps the device honest:
 *  - on app foreground: reload queue state, reconcile with the server, report
 *    permission changes, flush the queue;
 *  - every 60 s while a session is open and the app is active: same checks,
 *    plus the local "shift window closed" stop;
 *  - on reconnect: send everything saved on the phone;
 *  - notification taps open the shift screen (never the camera).
 */
import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import * as Notifications from 'expo-notifications';
import { router } from 'expo-router';
import { qk, queryClient } from '../lib/queryClient';
import { reloadOutbox, syncOutbox } from '../lib/sync/outbox';
import { flush, reportPermissionsIfChanged, stopTracking } from '../lib/tracking/runtime';
import { loadMeta, reloadSnapshot } from '../lib/tracking/store';

/** Readings first, so a shift's trail is in before its check-in and end are judged. */
const sendSaved = () => flush().then(() => syncOutbox());

async function check() {
  await reloadSnapshot();
  await reloadOutbox();
  const meta = await loadMeta();
  if (meta.sessionId && meta.windowClosesAt && Date.now() > Date.parse(meta.windowClosesAt)) {
    await flush();
    await stopTracking({ reason: 'Your shift window has closed.', notify: true, byUser: false });
  }
  await queryClient.invalidateQueries({ queryKey: qk.status });
  const after = await loadMeta();
  if (after.sessionId) {
    try {
      await reportPermissionsIfChanged(after.sessionId);
    } catch {
      // offline — retried later
    }
  }
  void sendSaved().catch(() => undefined);
}

export function TrackingSupervisor() {
  const wasOffline = useRef(false);

  useEffect(() => {
    void check();
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') void check();
    });
    const timer = setInterval(() => {
      if (AppState.currentState !== 'active') return;
      void check();
    }, 60_000);
    return () => {
      sub.remove();
      clearInterval(timer);
    };
  }, []);

  useEffect(
    () =>
      NetInfo.addEventListener((s) => {
        const online = !!s.isConnected && s.isInternetReachable !== false;
        if (online && wasOffline.current) {
          void sendSaved().then(() => queryClient.invalidateQueries({ queryKey: qk.status }));
        }
        wasOffline.current = !online;
      }),
    [],
  );

  useEffect(() => {
    const open = () => router.push('/shift');
    // App launched by tapping a notification: show the shift screen once, then forget it.
    if (Notifications.getLastNotificationResponse()) {
      Notifications.clearLastNotificationResponse();
      open();
    }
    const sub = Notifications.addNotificationResponseReceivedListener(() => {
      Notifications.clearLastNotificationResponse();
      open();
    });
    return () => sub.remove();
  }, []);

  return null;
}
