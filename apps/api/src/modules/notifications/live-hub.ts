/**
 * Server-Sent Events hub for the admin dashboard. Events are published only
 * after the database transaction that produced them has committed (see Outbox),
 * so the dashboard never shows something that was rolled back. Each dashboard
 * connection belongs to one company and only receives that company's events.
 */
import type { Response } from 'express';
import { one } from '../../db/pool.js';
import { logger } from '../../lib/logger.js';

export type LiveEvent =
  | { type: 'session.updated'; sessionId: string; employeeId: string; state: string; simulated: boolean }
  | { type: 'notification.created'; notification: Record<string, unknown> }
  | { type: 'attendance.recorded'; attendanceId: string; employeeId: string }
  | { type: 'workplace.updated'; workplaceId: string };

const clients = new Map<Response, { orgId: string; sites: string[] | null; userId: string | null }>();
let seq = 0;
const MAX_STREAMS_PER_USER = 5;

export function addClient(res: Response, orgId: string, sites: string[] | null = null, userId: string | null = null) {
  if (userId) {
    const mine = [...clients].filter(([, c]) => c.userId === userId);
    if (mine.length >= MAX_STREAMS_PER_USER) mine[0]![0].end(); // the oldest gives way
  }
  clients.set(res, { orgId, sites, userId });
  res.on('close', () => clients.delete(res));
}

/** Streams outlive access tokens, so permission is checked again: anyone deactivated or moved loses theirs. */
export async function recheckClients() {
  for (const [res, c] of clients) {
    if (!c.userId) continue;
    const u = await one(
      // A suspended company counts as inactive: its open dashboards stop receiving events too.
      `SELECT u.is_active AND o.status = 'ACTIVE' AS is_active, u.org_id, ap.access, ap.site_ids FROM users u JOIN organizations o ON o.id = u.org_id LEFT JOIN administrator_profiles ap ON ap.user_id = u.id WHERE u.id = $1`,
      [c.userId],
    ).catch(() => undefined);
    if (u === undefined) continue; // database unavailable: keep the stream and look again
    const sites = u?.access === 'SUPERVISOR' ? (u.site_ids ?? []) : null;
    if (!u || !u.is_active || u.org_id !== c.orgId || JSON.stringify(sites) !== JSON.stringify(c.sites)) res.end();
  }
}
setInterval(() => void recheckClients(), 60_000).unref();

export function broadcast(event: LiveEvent, orgId: string) {
  const id = ++seq;
  const full = `id: ${id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
  // Supervisors get only the event type: their dashboard refetches through site-filtered endpoints,
  // so details of other sites never travel over their stream.
  const bare = `id: ${id}\nevent: ${event.type}\ndata: ${JSON.stringify({ type: event.type })}\n\n`;
  for (const [res, c] of clients) if (c.orgId === orgId) res.write(c.sites ? bare : full);
}

export function clientCount() {
  return clients.size;
}

setInterval(() => {
  for (const res of clients.keys()) res.write(`: keep-alive ${Date.now()}\n\n`);
}, 20_000).unref();

// Employees and workplaces never change company, so lookups can be cached for the process lifetime.
const orgOf = new Map<string, string>();
async function orgFor(e: LiveEvent): Promise<string | null> {
  if (e.type === 'notification.created') return (e.notification.org_id as string) ?? null;
  const [key, sql] = e.type === 'workplace.updated' ? [`w:${e.workplaceId}`, 'SELECT org_id FROM workplaces WHERE id = $1'] : [`u:${e.employeeId}`, 'SELECT org_id FROM users WHERE id = $1'];
  if (!orgOf.has(key)) {
    const row = await one(sql, [e.type === 'workplace.updated' ? e.workplaceId : e.employeeId]);
    if (!row) return null;
    orgOf.set(key, row.org_id);
  }
  return orgOf.get(key)!;
}

/** Collects live events during a transaction; flush() after COMMIT. */
export class Outbox {
  private events: LiveEvent[] = [];
  push(e: LiveEvent) {
    this.events.push(e);
  }
  flush() {
    const events = this.events;
    this.events = [];
    if (!events.length || clients.size === 0) return;
    void (async () => {
      for (const e of events) {
        const org = await orgFor(e).catch((err) => (logger.warn({ err }, 'live event: company lookup failed'), null));
        if (org) broadcast(e, org);
      }
    })();
  }
}
