import { Platform } from 'react-native';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { api } from './api/client';
import { APP_VERSION, EAS_PROJECT_ID } from './config';
import { getDeviceId } from './secure';

export async function deviceInfo() {
  return {
    deviceId: await getDeviceId(),
    platform: (Device.isDevice ? Platform.OS : 'simulator') as 'android' | 'ios' | 'simulator',
    osVersion: String(Device.osVersion ?? Platform.Version ?? '').slice(0, 40) || undefined,
    model: [Device.manufacturer, Device.modelName].filter(Boolean).join(' ').slice(0, 80) || undefined,
    appVersion: APP_VERSION,
  };
}

/**
 * Register this device after sign-in. An Expo push token is only requested
 * when an EAS projectId is configured; otherwise it is skipped (local
 * notifications still work). Failures are non-fatal.
 */
export async function registerDevice(): Promise<void> {
  const info = await deviceInfo();
  let pushToken: string | null = null;
  if (EAS_PROJECT_ID && Device.isDevice) {
    try {
      const perm = await Notifications.getPermissionsAsync();
      if (perm.granted) pushToken = (await Notifications.getExpoPushTokenAsync({ projectId: EAS_PROJECT_ID })).data;
    } catch {
      pushToken = null;
    }
  }
  await api('/me/devices', { method: 'POST', body: { ...info, pushToken } });
}

/**
 * Flat device metadata attached to an attendance submission. `isPhysicalDevice` (false on emulators)
 * and `isRooted` (rooted / jailbroken) let the server refuse phones whose location can be faked silently.
 */
export async function deviceMeta(extra: Record<string, string | number | boolean | null> = {}) {
  const info = await deviceInfo();
  const isRooted = await Device.isRootedExperimentalAsync().catch(() => null);
  return {
    deviceId: info.deviceId,
    platform: info.platform,
    osVersion: info.osVersion ?? null,
    model: info.model ?? null,
    appVersion: info.appVersion,
    isPhysicalDevice: Device.isDevice,
    isRooted,
    ...extra,
  };
}
