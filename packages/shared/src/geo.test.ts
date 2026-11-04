import { describe, expect, it } from 'vitest';
import { distanceMeters, haversineMeters, isValidLatLng, offsetMeters } from './geo';
import { classifyReading } from './geofence';

describe('distanceMeters (Vincenty, WGS-84)', () => {
  it('matches the published Flinders Peak → Buninyong test vector', () => {
    // Vincenty (1975) / Geoscience Australia example: 54 972.271 m
    const d = distanceMeters({ lat: -(37 + 57 / 60 + 3.7203 / 3600), lng: 144 + 25 / 60 + 29.5244 / 3600 }, { lat: -(37 + 39 / 60 + 10.1561 / 3600), lng: 143 + 55 / 60 + 35.3839 / 3600 });
    expect(d).toBeCloseTo(54972.271, 2);
  });

  it('is zero for identical points and symmetric', () => {
    const a = { lat: 12.9716, lng: 77.5946 };
    const b = { lat: 12.9719, lng: 77.5949 };
    expect(distanceMeters(a, a)).toBe(0);
    expect(distanceMeters(a, b)).toBeCloseTo(distanceMeters(b, a), 6);
  });

  it('agrees with the spherical approximation within 0.7 % at workplace scale', () => {
    // Near the equator the ellipsoid's meridional radius is ~0.56 % below the mean
    // spherical radius, so a real (small) difference is expected here.
    const a = { lat: 12.9716, lng: 77.5946 };
    for (const [n, e] of [[30, 0], [0, 30], [-20, 15], [400, -300]] as const) {
      const b = offsetMeters(a, n, e);
      const v = distanceMeters(a, b);
      expect(Math.abs(v - haversineMeters(a, b)) / v).toBeLessThan(0.007);
      expect(v).toBeGreaterThan(Math.hypot(n, e) * 0.99);
      expect(v).toBeLessThan(Math.hypot(n, e) * 1.01);
    }
  });

  it('falls back gracefully for nearly antipodal points', () => {
    const d = distanceMeters({ lat: 0, lng: 0 }, { lat: 0.5, lng: 179.7 });
    expect(Number.isFinite(d)).toBe(true);
    expect(d).toBeGreaterThan(19_900_000);
  });

  it('validates coordinates', () => {
    expect(isValidLatLng(12, 77)).toBe(true);
    expect(isValidLatLng(91, 77)).toBe(false);
    expect(isValidLatLng(12, -181)).toBe(false);
    expect(isValidLatLng(Number.NaN, 0)).toBe(false);
    expect(isValidLatLng('12', 77)).toBe(false);
  });
});

describe('classifyReading', () => {
  const rules = { radiusM: 30, maxAccuracyM: 25, boundaryFactor: 0.5, exitHysteresisM: 10 };

  it('rejects readings worse than the accuracy limit', () => {
    expect(classifyReading(5, 40, rules, 'ENTRY')).toBe('INSUFFICIENT_ACCURACY');
  });
  it('is inside only when the uncertainty margin still fits', () => {
    expect(classifyReading(20, 10, rules, 'ENTRY')).toBe('INSIDE'); // 20 + 5 ≤ 30
    expect(classifyReading(28, 10, rules, 'ENTRY')).toBe('AMBIGUOUS'); // 33 > 30, 23 ≤ 30
    expect(classifyReading(42, 10, rules, 'ENTRY')).toBe('OUTSIDE'); // 37 > 30
  });
  it('applies exit hysteresis once inside', () => {
    expect(classifyReading(36, 8, rules, 'ENTRY')).toBe('OUTSIDE');
    expect(classifyReading(36, 8, rules, 'EXIT')).toBe('INSIDE'); // 40 ≤ 40
    expect(classifyReading(46, 8, rules, 'EXIT')).toBe('OUTSIDE'); // 42 > 40
  });
});
