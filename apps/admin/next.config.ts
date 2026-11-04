import os from 'node:os';
import path from 'node:path';
import dotenv from 'dotenv';
import type { NextConfig } from 'next';

// One .env at the repository root serves the API and the dashboard.
dotenv.config({ path: path.resolve(process.cwd(), '../../.env'), quiet: true });

const apiUrl = process.env.API_INTERNAL_URL || 'http://localhost:4400';
const isDev = process.env.NODE_ENV !== 'production';

const google = 'https://maps.googleapis.com https://maps.gstatic.com https://*.googleapis.com https://*.gstatic.com https://*.google.com';
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline' ${isDev ? "'unsafe-eval'" : ''} ${google}`,
  `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com`,
  `img-src 'self' data: blob: ${google}`,
  `font-src 'self' data: https://fonts.gstatic.com`,
  `connect-src 'self' ${google}${isDev ? ' ws: http://localhost:*' : ''}`,
  "worker-src 'self' blob:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

// Dev only: allow opening the dashboard via this machine's own private-network IPs
// (e.g. http://192.168.1.20:3400 from a phone or another PC on the same Wi-Fi).
const lanAddresses = Object.values(os.networkInterfaces())
  .flat()
  .filter((i): i is os.NetworkInterfaceInfo => !!i && i.family === 'IPv4' && !i.internal)
  .map((i) => i.address);

const nextConfig: NextConfig = {
  transpilePackages: ['@geoattend/shared'],
  allowedDevOrigins: lanAddresses,
  // Expose only browser-safe values. The Maps key is a referrer-restricted browser key.
  env: {
    NEXT_PUBLIC_GOOGLE_MAPS_API_KEY: process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? '',
    NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID: process.env.NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID ?? '',
    // Optional: path or URL of the DhishaAI logo (e.g. /brand/dhishaai.svg placed in apps/admin/public).
    NEXT_PUBLIC_BRAND_LOGO_URL: process.env.NEXT_PUBLIC_BRAND_LOGO_URL ?? '',
  },
  // The browser only ever talks to this origin; /api is proxied to the API server,
  // so auth cookies stay first-party (SameSite=Strict) and CORS is not needed.
  async rewrites() {
    return [
      { source: '/api/:path*', destination: `${apiUrl}/api/:path*` },
      { source: '/health', destination: `${apiUrl}/health` },
    ];
  },
  // "Messages" was renamed "Announcements"; old links and bookmarks keep working.
  async redirects() {
    return [{ source: '/messages', destination: '/announcements', permanent: false }];
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: csp },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          { key: 'X-Frame-Options', value: 'DENY' },
          // HTTPS only once deployed (browsers ignore it over plain http, but local dev stays http).
          ...(process.env.NODE_ENV === 'production' ? [{ key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' }] : []),
        ],
      },
    ];
  },
  compress: false, // keeps the proxied Server-Sent Events stream unbuffered
  poweredByHeader: false,
};

export default nextConfig;
