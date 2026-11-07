'use client';
/**
 * Google Maps building blocks. Maps are used for visualisation, address search
 * and picking coordinates only — attendance eligibility is decided on the
 * server with geodesic distance, never by what the map draws.
 */
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { APIProvider, AdvancedMarker, Map, Pin, useMap, useMapsLibrary } from '@vis.gl/react-google-maps';
import { MapPinOff } from 'lucide-react';

export const MAPS_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? '';
export const MAP_ID = process.env.NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID || 'DEMO_MAP_ID';
export const mapsConfigured = MAPS_KEY.length > 0;

/**
 * Google calls gm_authFailure when it refuses the key (wrong address, billing, quota). Without this
 * the page kept a grey "Oops" box; with it the same fallback as an unconfigured key takes over.
 */
let refused = false;
const listeners = new Set<() => void>();
if (typeof window !== 'undefined') {
  (window as unknown as { gm_authFailure?: () => void }).gm_authFailure = () => {
    refused = true;
    listeners.forEach((l) => l());
  };
}
export function useMapsRefused() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => refused,
    () => false,
  );
}

export function MapsProvider({ children }: { children: ReactNode }) {
  if (!mapsConfigured) return <>{children}</>;
  return (
    <APIProvider apiKey={MAPS_KEY} libraries={['places', 'geocoding', 'marker']}>
      {children}
    </APIProvider>
  );
}

export function MapSetupNotice({ compact, refused: wasRefused }: { compact?: boolean; refused?: boolean }) {
  if (wasRefused)
    return (
      <div role="note" className="flex gap-3 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
        <MapPinOff className="mt-0.5 h-5 w-5 shrink-0" aria-hidden />
        <p className="min-w-0 font-medium">Google Maps refused this site’s key, so positions are shown on a diagram instead.</p>
      </div>
    );
  return (
    <div role="note" className="flex gap-3 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
      <MapPinOff className="mt-0.5 h-5 w-5 shrink-0" aria-hidden />
      <div className="min-w-0 break-words [&_code]:break-all">
        <p className="font-medium">Google Maps is not configured</p>
        {!compact && (
          <p className="mt-1">
            Set <code className="rounded bg-amber-100 px-1">NEXT_PUBLIC_GOOGLE_MAPS_API_KEY</code> in <code className="rounded bg-amber-100 px-1">.env</code> (Maps JavaScript API + Places API enabled, restricted to
            this site&apos;s HTTP referrer) and restart the dashboard. Until then, coordinates can be entered manually and positions are shown on a schematic diagram — not a map. See docs/GOOGLE-MAPS.md.
          </p>
        )}
      </div>
    </div>
  );
}

/** google.maps.Circle bound to the current map. */
export function GeofenceCircle({ center, radius, color = '#1668a0', editable, onRadiusChange, onCenterChange }: { center: google.maps.LatLngLiteral; radius: number; color?: string; editable?: boolean; onRadiusChange?: (r: number) => void; onCenterChange?: (c: google.maps.LatLngLiteral) => void }) {
  const map = useMap();
  const circle = useRef<google.maps.Circle | null>(null);
  const cbs = useRef({ onRadiusChange, onCenterChange });
  cbs.current = { onRadiusChange, onCenterChange };

  useEffect(() => {
    if (!map) return;
    const c = new google.maps.Circle({ map, center, radius, strokeColor: color, strokeOpacity: 0.9, strokeWeight: 2, fillColor: color, fillOpacity: 0.12, editable: !!editable, clickable: false });
    circle.current = c;
    const l1 = c.addListener('radius_changed', () => cbs.current.onRadiusChange?.(Math.round(c.getRadius())));
    const l2 = c.addListener('center_changed', () => {
      const p = c.getCenter();
      if (p) cbs.current.onCenterChange?.({ lat: p.lat(), lng: p.lng() });
    });
    return () => {
      l1.remove();
      l2.remove();
      c.setMap(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, color, editable]);

  useEffect(() => {
    const c = circle.current;
    if (!c) return;
    const cur = c.getCenter();
    if (!cur || Math.abs(cur.lat() - center.lat) > 1e-9 || Math.abs(cur.lng() - center.lng) > 1e-9) c.setCenter(center);
    if (Math.abs(c.getRadius() - radius) > 0.01) c.setRadius(radius);
  }, [center, radius]);
  return null;
}

/** Address search using the Places API (new) autocomplete element. */
export function PlaceSearch({ onPlace }: { onPlace: (p: { lat: number; lng: number; address: string; name?: string; placeId?: string }) => void }) {
  const places = useMapsLibrary('places');
  const host = useRef<HTMLDivElement>(null);
  const cb = useRef(onPlace);
  cb.current = onPlace;
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0); // bump to rebuild the search box after a failure

  useEffect(() => {
    if (!places || !host.current) return;
    const Ctor = (places as any).PlaceAutocompleteElement;
    if (!Ctor) {
      setError('Places autocomplete is not available for this API key.');
      return;
    }
    const el: HTMLElement = new Ctor({});
    el.setAttribute('aria-label', 'Search for an address');
    el.style.width = '100%';
    const handler = async (ev: any) => {
      setError(null);
      try {
        const place = ev.placePrediction?.toPlace?.() ?? ev.place;
        await place.fetchFields({ fields: ['id', 'displayName', 'formattedAddress', 'location'] });
        const loc = place.location;
        // Only a resolved location counts: typed text alone is never saved as coordinates.
        if (!loc) {
          setError('That result has no map location. Pick another result or place the marker on the map.');
          return;
        }
        cb.current({ lat: loc.lat(), lng: loc.lng(), address: place.formattedAddress ?? '', name: place.displayName ?? undefined, placeId: place.id ?? undefined });
      } catch {
        setError('Could not load that place (network or Places API). Try again, or place the marker on the map.');
      }
    };
    el.addEventListener('gmp-select', handler);
    el.addEventListener('gmp-placeselect', handler);
    host.current.replaceChildren(el);
    return () => {
      el.removeEventListener('gmp-select', handler);
      el.removeEventListener('gmp-placeselect', handler);
      el.remove();
    };
  }, [places, attempt]);

  return (
    <div>
      <div ref={host} className="min-h-10" />
      {error && (
        <p role="alert" className="mt-1 flex flex-wrap items-center gap-2 text-xs text-red-700">
          {error}
          <button type="button" className="font-medium underline" onClick={() => { setError(null); setAttempt((n) => n + 1); }}>
            Try again
          </button>
        </p>
      )}
    </div>
  );
}

/** Interactive geofence editor: click to place, drag the marker, drag the circle edge to resize. */
export function GeofenceEditorMap({ value, radius, onChange, onRadiusChange, onAddress }: { value: google.maps.LatLngLiteral; radius: number; onChange: (p: google.maps.LatLngLiteral) => void; onRadiusChange: (r: number) => void; onAddress?: (a: string) => void }) {
  const geocoding = useMapsLibrary('geocoding');
  const map = useMap();
  const reverse = (p: google.maps.LatLngLiteral) => {
    if (!geocoding || !onAddress) return;
    new geocoding.Geocoder()
      .geocode({ location: p })
      .then((r) => r.results[0] && onAddress(r.results[0].formatted_address))
      .catch(() => undefined);
  };
  const set = (p: google.maps.LatLngLiteral) => {
    onChange(p);
    reverse(p);
  };
  useEffect(() => {
    map?.panTo(value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, value.lat, value.lng]);

  return (
    <Map
      className="h-[min(520px,60svh)] min-h-[300px] w-full overflow-hidden rounded-md"
      defaultCenter={value}
      defaultZoom={18}
      mapId={MAP_ID}
      gestureHandling="greedy"
      clickableIcons={false}
      onClick={(e) => e.detail.latLng && set(e.detail.latLng)}
    >
      <AdvancedMarker
        position={value}
        draggable
        title="Workplace centre — drag to adjust"
        onDragEnd={(e) => {
          const ll = e.latLng;
          if (ll) set({ lat: ll.lat(), lng: ll.lng() });
        }}
      >
        <Pin background="#0b4f72" borderColor="#083e5a" glyphColor="#ffffff" />
      </AdvancedMarker>
      <GeofenceCircle center={value} radius={radius} editable onRadiusChange={onRadiusChange} />
    </Map>
  );
}

export { AdvancedMarker, Map, Pin };
