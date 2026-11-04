/**
 * Phone health check: everything on the phone that silently stops shift tracking.
 * The biggest cause in India is the phone maker's own battery manager (Xiaomi, Oppo,
 * Vivo, Realme, Samsung…) killing the app — so we add brand-specific steps.
 */
import { Linking, Platform } from 'react-native';
import Constants, { ExecutionEnvironment } from 'expo-constants';
import * as Battery from 'expo-battery';
import * as Device from 'expo-device';
import * as Location from 'expo-location';
import * as Notifications from 'expo-notifications';
import NetInfo from '@react-native-community/netinfo';

export type CheckLevel = 'ok' | 'warn' | 'fail';
export interface HealthCheck {
  key: string;
  level: CheckLevel;
  title: string;
  detail: string;
  fixLabel?: string;
  fix?: () => Promise<unknown> | void;
}

const safe = <T>(p: Promise<T>): Promise<T | null> => p.catch(() => null);
/** Running inside the Expo Go app: it cannot keep location running in the background. */
export const isExpoGo = Constants.executionEnvironment === ExecutionEnvironment.StoreClient;

const openSettings = () => Linking.openSettings();
const openBatteryOptimisation = () =>
  Linking.sendIntent('android.settings.IGNORE_BATTERY_OPTIMIZATION_SETTINGS').catch(() => Linking.openSettings());

export async function runPhoneChecks(): Promise<HealthCheck[]> {
  const [fg, bg, services, notif, lowPower, optimised, net] = await Promise.all([
    safe(Location.getForegroundPermissionsAsync()),
    safe(Location.getBackgroundPermissionsAsync()),
    safe(Location.hasServicesEnabledAsync()),
    safe(Notifications.getPermissionsAsync()),
    safe(Battery.isLowPowerModeEnabledAsync()),
    Platform.OS === 'android' ? safe(Battery.isBatteryOptimizationEnabledAsync()) : Promise.resolve(null),
    safe(NetInfo.fetch()),
  ]);
  const checks: HealthCheck[] = [];

  checks.push(
    fg?.status === 'granted'
      ? { key: 'location', level: 'ok', title: 'Location permission', detail: 'Allowed.' }
      : {
          key: 'location',
          level: 'fail',
          title: 'Location permission',
          detail: 'Attendance cannot be checked without location. Allow it while using the app.',
          fixLabel: fg?.canAskAgain === false ? 'Open settings' : 'Allow location',
          fix: fg?.canAskAgain === false ? openSettings : () => Location.requestForegroundPermissionsAsync(),
        },
  );

  const precise = Platform.OS === 'android' ? fg?.android?.accuracy === 'fine' : fg?.ios?.accuracy === 'full';
  if (fg?.status === 'granted') {
    checks.push(
      precise
        ? { key: 'precise', level: 'ok', title: 'Precise location', detail: 'On.' }
        : { key: 'precise', level: 'fail', title: 'Precise location', detail: 'Approximate location is off by hundreds of metres, so attendance will not unlock. Turn on “Precise location”.', fixLabel: 'Open settings', fix: openSettings },
    );
  }

  checks.push(
    services
      ? { key: 'gps', level: 'ok', title: 'GPS / Location services', detail: 'On.' }
      : {
          key: 'gps',
          level: 'fail',
          title: 'GPS / Location services',
          detail: 'Location is switched off for the whole phone. Turn it on from the quick settings panel.',
          fixLabel: 'Turn on',
          fix: Platform.OS === 'android' ? () => Location.enableNetworkProviderAsync().catch(openSettings) : openSettings,
        },
  );

  if (isExpoGo) {
    checks.push({ key: 'background', level: 'warn', title: 'Tracking with the screen off', detail: 'This is the test app (Expo Go): tracking only runs while GeoAttend is open on screen. The GeoAttend app from the Play Store / App Store tracks with the screen off.' });
  } else {
    checks.push(
      bg?.status === 'granted'
        ? { key: 'background', level: 'ok', title: 'Location “Allow all the time”', detail: 'Tracking keeps working with the screen off during your shift.' }
        : { key: 'background', level: 'warn', title: 'Location “Allow all the time”', detail: 'Without it, tracking pauses when you lock the phone and your manager may see “tracking stopped”. Only used during your shift.', fixLabel: 'Open settings', fix: openSettings },
    );
  }

  checks.push(
    notif?.granted
      ? { key: 'notifications', level: 'ok', title: 'Notifications', detail: 'On — you will hear when attendance is ready or before an absence alert.' }
      : { key: 'notifications', level: 'warn', title: 'Notifications', detail: 'Turn them on to be told when attendance is ready and before your manager is alerted.', fixLabel: notif?.canAskAgain === false ? 'Open settings' : 'Turn on', fix: notif?.canAskAgain === false ? openSettings : () => Notifications.requestPermissionsAsync() },
  );

  if (lowPower) {
    checks.push({ key: 'saver', level: 'warn', title: 'Battery saver is on', detail: 'Battery saver can pause location updates. Turn it off during your shift, or keep the phone charged.' });
  } else if (lowPower === false) {
    checks.push({ key: 'saver', level: 'ok', title: 'Battery saver', detail: 'Off.' });
  }

  if (Platform.OS === 'android' && optimised !== null) {
    checks.push(
      optimised
        ? { key: 'optimisation', level: 'warn', title: 'Battery optimisation', detail: 'Android may stop GeoAttend in the background. Choose “Don’t optimise” / “Unrestricted” for GeoAttend.', fixLabel: 'Change', fix: openBatteryOptimisation }
        : { key: 'optimisation', level: 'ok', title: 'Battery optimisation', detail: 'GeoAttend is allowed to run in the background.' },
    );
  }

  checks.push(
    net?.isConnected === false
      ? { key: 'internet', level: 'warn', title: 'Internet', detail: 'No connection right now. Locations are saved on the phone and sent when you are back online.' }
      : { key: 'internet', level: 'ok', title: 'Internet', detail: net?.type === 'wifi' ? 'Connected (Wi-Fi).' : 'Connected.' },
  );
  return checks;
}

/** Extra steps for phone makers whose battery managers close background apps. */
export function brandSteps(): { brand: string; steps: string[] } | null {
  if (Platform.OS !== 'android') return null;
  const m = `${Device.manufacturer ?? ''} ${Device.brand ?? ''}`.toLowerCase();
  if (/xiaomi|redmi|poco/.test(m))
    return { brand: 'Xiaomi / Redmi / POCO', steps: ['Settings → Apps → Manage apps → GeoAttend → Battery saver → No restrictions', 'Same screen → Autostart → turn ON', 'Open recent apps, long-press GeoAttend → tap the lock icon'] };
  if (/oppo|realme|oneplus/.test(m))
    return { brand: 'Oppo / Realme / OnePlus', steps: ['Settings → Battery → App battery management → GeoAttend → Allow background activity', 'Settings → Apps → GeoAttend → Auto launch / Allow auto-start → ON', 'Open recent apps, pull GeoAttend down to lock it'] };
  if (/vivo|iqoo/.test(m))
    return { brand: 'Vivo / iQOO', steps: ['Settings → Battery → Background power consumption management → GeoAttend → Allow', 'i Manager → App manager → Autostart manager → GeoAttend → ON'] };
  if (/samsung/.test(m))
    return { brand: 'Samsung', steps: ['Settings → Apps → GeoAttend → Battery → Unrestricted', 'Settings → Battery → Background usage limits → make sure GeoAttend is NOT in “Sleeping apps” or “Deep sleeping apps”'] };
  if (/huawei|honor/.test(m))
    return { brand: 'Huawei / Honor', steps: ['Settings → Battery → App launch → GeoAttend → Manage manually → turn on all three switches'] };
  if (/motorola|nokia|google|lenovo/.test(m)) return null; // close to stock Android: the battery-optimisation check above is enough
  return { brand: Device.manufacturer ?? 'Your phone', steps: ['Settings → Apps → GeoAttend → Battery → choose “Unrestricted” or “Don’t optimise”', 'If your phone has an “Autostart” or “Auto launch” setting, turn it on for GeoAttend'] };
}
