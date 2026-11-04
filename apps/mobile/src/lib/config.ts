import Constants from 'expo-constants';

const extra = (Constants.expoConfig?.extra ?? {}) as {
  appVariant?: string;
  googleMapsConfigured?: boolean;
  allowCleartext?: boolean;
  eas?: { projectId?: string };
};

/** API base URL, inlined by Metro from EXPO_PUBLIC_API_URL. No trailing slash. */
export const API_URL = (process.env.EXPO_PUBLIC_API_URL ?? '').trim().replace(/\/+$/, '');
export const API_URL_CONFIGURED = API_URL.length > 0 && !API_URL.includes('192.168.x.x');

export const APP_VARIANT = extra.appVariant ?? 'development';
export const GOOGLE_MAPS_CONFIGURED = extra.googleMapsConfigured === true;
export const EAS_PROJECT_ID: string | undefined = extra.eas?.projectId ?? Constants.easConfig?.projectId ?? undefined;
export const APP_VERSION = Constants.expoConfig?.version ?? '1.0.0';

/** Background location task name. Must never change between releases (the OS persists it). */
export const LOCATION_TASK = 'geoattend-location-updates';
export const NOTIFICATION_CHANNEL = 'attendance';
