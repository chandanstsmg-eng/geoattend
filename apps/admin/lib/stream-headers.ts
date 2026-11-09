/**
 * Headers for the dashboard's proxy of the API's live-updates stream.
 *
 * The API counts requests per client address and takes that address from X-Forwarded-For, as set by the
 * HTTPS proxy in front (TRUST_PROXY). The generic /api rewrite passes the header through; this proxy must
 * too, or every user's stream would come from the dashboard container's address and share one rate limit.
 * The front proxy (Caddy) replaces any X-Forwarded-For a browser sends, so this cannot be used to pose as
 * another address in production.
 */
export function streamUpstreamHeaders(incoming: Headers): Record<string, string> {
  const out: Record<string, string> = { cookie: incoming.get('cookie') ?? '', accept: 'text/event-stream' };
  for (const name of ['x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host']) {
    const value = incoming.get(name);
    if (value) out[name] = value;
  }
  return out;
}
