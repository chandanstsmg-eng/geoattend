/** Sign-in rules, free of React Native so they can be tested on their own. */

/** Only these answers to a refresh mean the sign-in is over. Anything else is a passing problem. */
export const sessionIsGone = (status: number) => status === 400 || status === 401 || status === 403;

/**
 * Refresh tokens rotate on every use and re-using an old one revokes the whole family,
 * so concurrent callers must share one call.
 */
export function singleFlight<T>(fn: () => Promise<T>): () => Promise<T> {
  let inFlight: Promise<T> | null = null;
  return () => {
    inFlight ??= fn().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
}
