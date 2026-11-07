'use client';
import type { ReactNode } from 'react';
import { MapsProvider } from '@/components/maps/google';

/** Only the pages that show a map load Google's script. */
export default function WorkplaceEditorLayout({ children }: { children: ReactNode }) {
  return <MapsProvider>{children}</MapsProvider>;
}
