import '../globals.css';
import { pageMetadata } from '@/lib/metadata';

export const metadata = pageMetadata('hi');
export { viewport } from '@/lib/metadata';

export default function HindiLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="hi">
      <body className="min-h-dvh antialiased">{children}</body>
    </html>
  );
}
