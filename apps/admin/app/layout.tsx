import type { Metadata, Viewport } from 'next';
import './globals.css';
import { Providers } from './providers';

export const metadata: Metadata = {
  title: { default: 'GeoAttend', template: '%s · GeoAttend' },
  description: 'Geofenced attendance and shift-scoped workforce tracking — administrator dashboard',
  robots: { index: false, follow: false },
};

// Fit phones, including notched screens (padding uses env(safe-area-inset-*)).
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#083e5a',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
