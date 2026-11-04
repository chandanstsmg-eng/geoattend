import type { Metadata, Viewport } from 'next';
import { copy, type Lang } from './i18n';
import { site } from './site';

export function pageMetadata(lang: Lang): Metadata {
  const t = copy[lang].meta;
  return {
    metadataBase: new URL(site.url),
    title: t.title,
    description: t.description,
    alternates: { canonical: lang === 'en' ? '/' : '/hi', languages: { en: '/', hi: '/hi' } },
    openGraph: { title: t.title, description: t.description, siteName: 'GeoAttend', locale: lang === 'en' ? 'en_IN' : 'hi_IN', type: 'website' },
  };
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#f4f7fa',
};
