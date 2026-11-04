import type { ConfigContext, ExpoConfig } from 'expo/config';

/**
 * GeoAttend employee app configuration.
 *
 * Environment (read at build / bundle time):
 *   EXPO_PUBLIC_API_URL          API base URL, e.g. http://192.168.1.20:4400 (dev) or https://api.example.com (prod)
 *   GOOGLE_MAPS_ANDROID_API_KEY  Google Maps SDK for Android key (map screen falls back to a text panel without it)
 *   APP_VARIANT                  development | preview | production (set by eas.json profiles)
 *   ALLOW_CLEARTEXT              "1" to allow plain-HTTP API traffic in a non-development build (LAN testing only)
 *   EAS_PROJECT_ID               EAS project id (enables Expo push tokens); `eas init` can also write it here
 */
export default ({ config }: ConfigContext): ExpoConfig => {
  const variant = process.env.APP_VARIANT ?? 'development';
  const isProduction = variant === 'production';
  // Cleartext HTTP is only for talking to the API on the developer's LAN. Production must use HTTPS.
  const allowCleartext = !isProduction && (variant === 'development' || process.env.ALLOW_CLEARTEXT === '1');
  const googleMapsKey = process.env.GOOGLE_MAPS_ANDROID_API_KEY?.trim() || '';
  const projectId = process.env.EAS_PROJECT_ID?.trim() || undefined;
  // A store build without a secure server address would fail for every employee, so it must not build at all.
  if (isProduction && !/^https:\/\/\S+$/.test(process.env.EXPO_PUBLIC_API_URL?.trim() ?? '')) {
    throw new Error('EXPO_PUBLIC_API_URL must be an https:// address for a production build.');
  }

  return {
    ...config,
    name: variant === 'production' ? 'GeoAttend' : variant === 'preview' ? 'GeoAttend (Preview)' : 'GeoAttend (Dev)',
    slug: 'geoattend',
    scheme: 'geoattend',
    version: '1.0.0',
    orientation: 'portrait',
    icon: './assets/icon.png',
    userInterfaceStyle: 'light',
    platforms: ['android', 'ios'],
    ios: {
      supportsTablet: false,
      bundleIdentifier: isProduction ? 'com.geoattend.employee' : `com.geoattend.employee.${variant}`,
      infoPlist: {
        UIBackgroundModes: ['location'],
        NSLocationWhenInUseUsageDescription:
          'GeoAttend uses your location during a shift you start to check whether you are inside your workplace area so you can mark attendance.',
        NSLocationAlwaysAndWhenInUseUsageDescription:
          'GeoAttend shares your location with your employer only while a shift you started is open, including when the app is in the background. Tracking stops when the shift ends.',
        NSCameraUsageDescription: 'GeoAttend uses the camera only when you tap "Capture Attendance Photo" to take your attendance photo.',
        ...(allowCleartext ? { NSAppTransportSecurity: { NSAllowsArbitraryLoads: true, NSAllowsLocalNetworking: true } } : {}),
      },
    },
    android: {
      package: isProduction ? 'com.geoattend.employee' : `com.geoattend.employee.${variant}`,
      // Saved locations and photos must not leave the phone through Android's cloud backup.
      allowBackup: false,
      adaptiveIcon: {
        backgroundColor: '#1E2952',
        foregroundImage: './assets/android-icon-foreground.png',
        backgroundImage: './assets/android-icon-background.png',
        monochromeImage: './assets/android-icon-monochrome.png',
      },
      permissions: [
        'android.permission.ACCESS_FINE_LOCATION',
        'android.permission.ACCESS_COARSE_LOCATION',
        'android.permission.ACCESS_BACKGROUND_LOCATION',
        'android.permission.FOREGROUND_SERVICE',
        'android.permission.FOREGROUND_SERVICE_LOCATION',
        'android.permission.POST_NOTIFICATIONS',
        'android.permission.CAMERA',
      ],
      // No microphone, no gallery/storage access. SYSTEM_ALERT_WINDOW is only kept for the dev client overlay.
      blockedPermissions: [
        'android.permission.RECORD_AUDIO',
        'android.permission.READ_EXTERNAL_STORAGE',
        'android.permission.WRITE_EXTERNAL_STORAGE',
        ...(variant === 'development' ? [] : ['android.permission.SYSTEM_ALERT_WINDOW']),
      ],
      config: googleMapsKey ? { googleMaps: { apiKey: googleMapsKey } } : undefined,
      predictiveBackGestureEnabled: false,
    },
    plugins: [
      'expo-router',
      'expo-secure-store',
      [
        'expo-splash-screen',
        { image: './assets/splash-icon.png', imageWidth: 160, resizeMode: 'contain', backgroundColor: '#1E2952' },
      ],
      'expo-status-bar',
      [
        'expo-location',
        {
          isAndroidBackgroundLocationEnabled: true,
          isAndroidForegroundServiceEnabled: true,
          isIosBackgroundLocationEnabled: true,
          locationWhenInUsePermission:
            'GeoAttend uses your location during a shift you start to check whether you are inside your workplace area so you can mark attendance.',
          locationAlwaysAndWhenInUsePermission:
            'GeoAttend shares your location with your employer only while a shift you started is open, including when the app is in the background. Tracking stops when the shift ends.',
          locationAlwaysPermission:
            'GeoAttend shares your location with your employer only while a shift you started is open. Tracking stops when the shift ends.',
          motionUsagePermission: false,
        },
      ],
      [
        'expo-camera',
        {
          cameraPermission: 'GeoAttend uses the camera only when you tap "Capture Attendance Photo" to take your attendance photo.',
          microphonePermission: false,
          recordAudioAndroid: false,
          barcodeScannerEnabled: false,
        },
      ],
      ['expo-notifications', { color: '#EA580C' }],
      // Keep the Maps meta-data consistent with android.config.googleMaps (this plugin removes it when no key is given).
      ['react-native-maps', googleMapsKey ? { androidGoogleMapsApiKey: googleMapsKey } : {}],
      [
        'expo-build-properties',
        {
          android: { usesCleartextTraffic: allowCleartext },
        },
      ],
    ],
    experiments: { typedRoutes: false },
    extra: {
      appVariant: variant,
      googleMapsConfigured: googleMapsKey.length > 0,
      allowCleartext,
      ...(projectId ? { eas: { projectId } } : {}),
    },
  };
};
