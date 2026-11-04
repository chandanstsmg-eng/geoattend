/**
 * Turning one GPS reading into an inside / outside judgement.
 *
 * A reading is an estimate: the device reports a point and a horizontal
 * accuracy (68 % confidence radius). We therefore never compare the raw point
 * with the radius alone:
 *
 *  - INSUFFICIENT_ACCURACY  accuracy worse than the configured maximum —
 *                           the reading cannot decide anything.
 *  - INSIDE                 the point, pushed `boundaryFactor × accuracy`
 *                           towards the boundary, is still inside.
 *  - OUTSIDE                the point, pulled the same amount towards the
 *                           centre, is still outside.
 *  - AMBIGUOUS              neither — the uncertainty straddles the boundary.
 *
 * Hysteresis: once an employee is counted inside (frame 'EXIT'), the boundary
 * used to decide that they have left is `radius + exitHysteresis`. This stops
 * a person standing near the edge from flapping between states.
 */

export type Classification = 'INSIDE' | 'OUTSIDE' | 'AMBIGUOUS' | 'INSUFFICIENT_ACCURACY';
export type Frame = 'ENTRY' | 'EXIT';

export interface ClassificationRules {
  radiusM: number;
  maxAccuracyM: number;
  boundaryFactor: number;
  exitHysteresisM: number;
}

export function classifyReading(distanceM: number, accuracyM: number, rules: ClassificationRules, frame: Frame): Classification {
  if (!(accuracyM > 0) || accuracyM > rules.maxAccuracyM) return 'INSUFFICIENT_ACCURACY';
  const margin = rules.boundaryFactor * accuracyM;
  const boundary = frame === 'EXIT' ? rules.radiusM + rules.exitHysteresisM : rules.radiusM;
  if (distanceM + margin <= boundary) return 'INSIDE';
  if (distanceM - margin > boundary) return 'OUTSIDE';
  return 'AMBIGUOUS';
}
