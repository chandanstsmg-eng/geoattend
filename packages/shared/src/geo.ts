/**
 * Geodesy used for every eligibility decision.
 *
 * Distances are computed on the WGS-84 ellipsoid with Vincenty's inverse
 * formula (sub-millimetre accuracy at workplace scales). If the iteration
 * fails to converge — only possible for nearly antipodal points — we fall
 * back to the haversine great-circle distance, which is within ~0.6 % of the
 * ellipsoidal value.
 *
 * When PostGIS is installed the database also stores a geography point for
 * each workplace (see migrations), but the server's decision does not depend
 * on it, so the same rules hold on a plain PostgreSQL deployment.
 */

const A = 6378137.0; // WGS-84 semi-major axis (m)
const F = 1 / 298.257223563; // WGS-84 flattening
const B = A * (1 - F);
const MEAN_EARTH_RADIUS = 6371008.8;

const toRad = (deg: number) => (deg * Math.PI) / 180;
const toDeg = (rad: number) => (rad * 180) / Math.PI;

export interface LatLng {
  lat: number;
  lng: number;
}

export function isValidLatLng(lat: unknown, lng: unknown): boolean {
  return (
    typeof lat === 'number' &&
    typeof lng === 'number' &&
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180
  );
}

export function haversineMeters(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * MEAN_EARTH_RADIUS * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Ellipsoidal distance in metres between two WGS-84 points. */
export function distanceMeters(a: LatLng, b: LatLng): number {
  if (a.lat === b.lat && a.lng === b.lng) return 0;
  const L = toRad(b.lng - a.lng);
  const U1 = Math.atan((1 - F) * Math.tan(toRad(a.lat)));
  const U2 = Math.atan((1 - F) * Math.tan(toRad(b.lat)));
  const sinU1 = Math.sin(U1);
  const cosU1 = Math.cos(U1);
  const sinU2 = Math.sin(U2);
  const cosU2 = Math.cos(U2);

  let lambda = L;
  let prev: number;
  let iterations = 0;
  let sinSigma = 0;
  let cosSigma = 0;
  let sigma = 0;
  let cosSqAlpha = 0;
  let cos2SigmaM = 0;
  do {
    const sinLambda = Math.sin(lambda);
    const cosLambda = Math.cos(lambda);
    sinSigma = Math.sqrt((cosU2 * sinLambda) ** 2 + (cosU1 * sinU2 - sinU1 * cosU2 * cosLambda) ** 2);
    if (sinSigma === 0) return 0; // coincident points
    cosSigma = sinU1 * sinU2 + cosU1 * cosU2 * cosLambda;
    sigma = Math.atan2(sinSigma, cosSigma);
    const sinAlpha = (cosU1 * cosU2 * sinLambda) / sinSigma;
    cosSqAlpha = 1 - sinAlpha * sinAlpha;
    cos2SigmaM = cosSqAlpha !== 0 ? cosSigma - (2 * sinU1 * sinU2) / cosSqAlpha : 0; // equatorial line
    const C = (F / 16) * cosSqAlpha * (4 + F * (4 - 3 * cosSqAlpha));
    prev = lambda;
    lambda = L + (1 - C) * F * sinAlpha * (sigma + C * sinSigma * (cos2SigmaM + C * cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM)));
  } while (Math.abs(lambda - prev) > 1e-12 && ++iterations < 200);

  if (iterations >= 200) return haversineMeters(a, b);

  const uSq = (cosSqAlpha * (A * A - B * B)) / (B * B);
  const bigA = 1 + (uSq / 16384) * (4096 + uSq * (-768 + uSq * (320 - 175 * uSq)));
  const bigB = (uSq / 1024) * (256 + uSq * (-128 + uSq * (74 - 47 * uSq)));
  const deltaSigma =
    bigB *
    sinSigma *
    (cos2SigmaM +
      (bigB / 4) *
        (cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM) -
          (bigB / 6) * cos2SigmaM * (-3 + 4 * sinSigma * sinSigma) * (-3 + 4 * cos2SigmaM * cos2SigmaM)));
  return B * bigA * (sigma - deltaSigma);
}

/**
 * Point reached by moving `north` and `east` metres from `origin`.
 * Used by the demo simulator and the schematic map; accurate for the short
 * distances involved (< a few km).
 */
export function offsetMeters(origin: LatLng, north: number, east: number): LatLng {
  const dLat = north / MEAN_EARTH_RADIUS;
  const dLng = east / (MEAN_EARTH_RADIUS * Math.cos(toRad(origin.lat)));
  return { lat: origin.lat + toDeg(dLat), lng: origin.lng + toDeg(dLng) };
}

/** Local east/north metres of `p` relative to `origin` (equirectangular, short range). */
export function toLocalMeters(origin: LatLng, p: LatLng): { x: number; y: number } {
  const x = toRad(p.lng - origin.lng) * MEAN_EARTH_RADIUS * Math.cos(toRad((origin.lat + p.lat) / 2));
  const y = toRad(p.lat - origin.lat) * MEAN_EARTH_RADIUS;
  return { x, y };
}
