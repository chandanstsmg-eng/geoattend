/**
 * Same-origin proxy for the API's Server-Sent Events stream.
 *
 * The generic /api rewrite does not close the upstream connection when the
 * browser goes away, so every page load would leak one open stream on the API
 * until the proxy's sockets ran out. Here the upstream fetch is bound to the
 * browser request's abort signal: when the tab navigates or closes, the API
 * connection closes too.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const API = process.env.API_INTERNAL_URL || 'http://localhost:4400';

export async function GET(req: Request) {
  let upstream: Response;
  try {
    upstream = await fetch(`${API}/api/v1/notifications/stream`, {
      headers: { cookie: req.headers.get('cookie') ?? '', accept: 'text/event-stream' },
      signal: req.signal,
      cache: 'no-store',
    });
  } catch {
    // API not running (or restarting). 503 tells the browser to retry later; the
    // client backs off, so this does not repeat every few seconds.
    return new Response('API unavailable', { status: 503, headers: { 'Retry-After': '10' } });
  }
  if (!upstream.ok || !upstream.body) {
    return new Response(await upstream.text(), { status: upstream.status, headers: { 'Content-Type': upstream.headers.get('content-type') ?? 'application/json' } });
  }
  return new Response(upstream.body, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
