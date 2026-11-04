import '../globals.css';
import { pageMetadata } from '@/lib/metadata';

// Each language has its own root layout so <html lang> is right for screen readers and search engines.
export const metadata = pageMetadata('en');
export { viewport } from '@/lib/metadata';

export default function EnglishLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh antialiased">{children}</body>
    </html>
  );
}
