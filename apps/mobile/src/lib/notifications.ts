/**
 * Local notifications. Used for "Attendance is ready" (arrival) and "Location
 * tracking stopped". Tapping a notification only opens the app on the shift
 * screen — it never opens the camera.
 */
import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import { NOTIFICATION_CHANNEL } from './config';

let handlerSet = false;
export function configureNotificationHandler() {
  if (handlerSet) return;
  handlerSet = true;
  Notifications.setNotificationHandler({
    handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }),
  });
}

let channelReady: Promise<void> | null = null;
export function ensureNotificationChannel(): Promise<void> {
  if (Platform.OS !== 'android') return Promise.resolve();
  if (!channelReady) {
    channelReady = Notifications.setNotificationChannelAsync(NOTIFICATION_CHANNEL, {
      name: 'Attendance and tracking',
      description: 'Attendance ready, tracking stopped and other shift alerts',
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 250, 150, 250],
      lightColor: '#EA580C',
    })
      .then(() => undefined)
      .catch(() => {
        channelReady = null;
      });
  }
  return channelReady;
}

/** Ask for notification permission (Android 13+ POST_NOTIFICATIONS). Never blocks tracking if denied. */
export async function requestNotificationPermission(): Promise<boolean> {
  await ensureNotificationChannel();
  const cur = await Notifications.getPermissionsAsync();
  if (cur.granted) return true;
  if (!cur.canAskAgain) return false;
  const res = await Notifications.requestPermissionsAsync();
  return res.granted;
}

/** Schedule (or replace) a notification with a fixed id at a given time. Never throws. */
export async function scheduleLocalAt(id: string, at: Date, title: string, body: string, data: Record<string, unknown> = {}) {
  try {
    await ensureNotificationChannel();
    await Notifications.scheduleNotificationAsync({
      identifier: id, // scheduling again with the same id replaces the earlier one
      content: { title, body, data: { ...data, route: '/shift' } },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: at, ...(Platform.OS === 'android' ? { channelId: NOTIFICATION_CHANNEL } : {}) },
    });
  } catch {
    // Permission denied: the shift screen still shows the countdown.
  }
}

export async function cancelLocal(id: string) {
  await Notifications.cancelScheduledNotificationAsync(id).catch(() => undefined);
}

export async function notifyLocal(title: string, body: string, data: Record<string, unknown> = {}) {
  try {
    await ensureNotificationChannel();
    await Notifications.scheduleNotificationAsync({
      content: { title, body, data: { ...data, route: '/shift' } },
      trigger: Platform.OS === 'android' ? { channelId: NOTIFICATION_CHANNEL } : null,
    });
  } catch {
    // Notification permission denied or unavailable: the in-app UI still shows the state.
  }
}
