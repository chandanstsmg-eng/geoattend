import type { Request } from 'express';
import { q, type Queryable } from '../db/pool.js';
import type { AuthUser } from './auth.js';

export interface AuditEntry {
  actor: (Pick<AuthUser, 'id' | 'role'> & { orgId?: string }) | null;
  /** Company the entry belongs to; defaults to the actor's. System entries without either are platform-level. */
  orgId?: string | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
  req?: Request;
}

/** Appends an audit entry (the table is append-only at the database level). */
export async function audit(e: AuditEntry, db?: Queryable) {
  await q(
    `INSERT INTO audit_logs (actor_id, actor_role, action, resource_type, resource_id, before_data, after_data, reason, ip, user_agent, org_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
             COALESCE($11::uuid, (SELECT org_id FROM users WHERE id = $1)))`,
    [
      e.actor?.id ?? null,
      e.actor?.role ?? 'SYSTEM',
      e.action,
      e.resourceType,
      e.resourceId ?? null,
      e.before === undefined ? null : JSON.stringify(e.before),
      e.after === undefined ? null : JSON.stringify(e.after),
      e.reason ?? null,
      e.req?.ip ?? null,
      e.req?.headers['user-agent']?.slice(0, 300) ?? null,
      e.orgId ?? e.actor?.orgId ?? null,
    ],
    db,
  );
}
