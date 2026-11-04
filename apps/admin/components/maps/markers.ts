import { markerKind, type MarkerKind, type SessionState } from '@geoattend/shared';

/**
 * Two separate encodings on every person marker:
 *  - `body`: navy = on shift as expected, orange = needs attention, hollow = no fresh position
 *    (stale, unavailable or shift ended — the marker is where the phone last reported);
 *  - `color`: the small status dot, the semantic attendance / location state.
 * The selected marker gets a brand-orange ring. Labels always carry the meaning too.
 */
export type MarkerBody = 'normal' | 'attention' | 'hollow';
export const MARKER_STYLE: Record<MarkerKind, { color: string; label: string; body: MarkerBody; hollow?: boolean }> = {
  present: { color: '#0d9488', label: 'Present (live)', body: 'normal' },
  break: { color: '#0891b2', label: 'On a declared break', body: 'normal' },
  overtime: { color: '#7c3aed', label: 'On overtime (may be off-site)', body: 'normal' },
  arriving: { color: '#1668a0', label: 'On shift, not yet present', body: 'normal' },
  away: { color: '#d97706', label: 'Temporarily away', body: 'attention' },
  prolonged: { color: '#dc2626', label: 'Prolonged absence', body: 'attention' },
  review: { color: '#7c3aed', label: 'Manual review', body: 'attention' },
  interrupted: { color: '#ea580c', label: 'Location unavailable', body: 'hollow', hollow: true },
  stale: { color: '#64748b', label: 'Stale — last known position', body: 'hollow', hollow: true },
  ended: { color: '#94a3b8', label: 'Shift ended — last known', body: 'hollow', hollow: true },
};

export const BODY_STYLE: Record<MarkerBody, { fill: string; border: string; text: string; label: string }> = {
  normal: { fill: '#083e5a', border: '#ffffff', text: '#ffffff', label: 'On shift' },
  attention: { fill: '#b45309', border: '#ffffff', text: '#ffffff', label: 'Needs attention' },
  hollow: { fill: '#ffffff', border: '#94a3b8', text: '#4e5d71', label: 'Last known position' },
};

export function kindFor(s: { state: string; is_stale: boolean }): MarkerKind {
  return markerKind(s.state as SessionState, s.is_stale);
}

export const initialsOf = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('');
