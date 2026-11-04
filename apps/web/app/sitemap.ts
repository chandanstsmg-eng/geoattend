import type { MetadataRoute } from 'next';
import { site } from '@/lib/site';

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: site.url + '/', alternates: { languages: { en: site.url + '/', hi: site.url + '/hi' } } },
    { url: site.url + '/hi', alternates: { languages: { en: site.url + '/', hi: site.url + '/hi' } } },
  ];
}
