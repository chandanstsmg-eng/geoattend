/**
 * Route definitions. Each route declares its auth requirement and zod schemas
 * once; the same definition drives request validation, the role guard and the
 * generated OpenAPI document (GET /api/v1/openapi.json).
 */
import type { NextFunction, Request, Response, Router } from 'express';
import { z } from 'zod';
import { asSystem, withOrg } from '../db/pool.js';
import { HttpError } from './errors.js';
import { requireAuth, type AuthUser } from './auth.js';
import { assertInOrg, type Scope } from './tenancy.js';

export type Access = 'public' | 'authenticated' | 'admin' | 'employee';

export interface RouteDef<B extends z.ZodType = z.ZodType, Q extends z.ZodType = z.ZodType, P extends z.ZodType = z.ZodType> {
  method: 'get' | 'post' | 'put' | 'patch' | 'delete';
  path: string;
  summary: string;
  access: Access;
  body?: B;
  query?: Q;
  params?: P;
  /** Response is produced by the handler itself (CSV, SSE, files). */
  raw?: boolean;
  /** Extra middleware run before validation (e.g. rate limiters, raw body parsers). */
  pre?: Array<(req: Request, res: Response, next: NextFunction) => void>;
  /** Admin routes with `:id`: what the id refers to. Ids from another company (or a supervisor's other sites) are refused (404). */
  scope?: Scope;
  /** Company owners only — supervisors get 403 (settings, payroll, audit log, setup changes, exports). */
  ownerOnly?: boolean;
  handler: (ctx: {
    req: Request;
    res: Response;
    user: AuthUser;
    body: z.infer<B>;
    query: z.infer<Q>;
    params: z.infer<P>;
  }) => Promise<unknown> | unknown;
}

interface Registered {
  tag: string;
  fullPath: string;
  def: RouteDef<any, any, any>;
}
export const registry: Registered[] = [];

export function route<B extends z.ZodType = z.ZodType, Q extends z.ZodType = z.ZodType, P extends z.ZodType = z.ZodType>(def: RouteDef<B, Q, P>) {
  return def;
}

function parse<T extends z.ZodType>(schema: T | undefined, value: unknown, where: string) {
  if (!schema) return value;
  const result = schema.safeParse(value ?? {});
  if (!result.success) {
    throw new HttpError(400, 'VALIDATION_FAILED', `Invalid ${where}`, z.flattenError(result.error));
  }
  return result.data;
}

export function mount(router: Router, basePath: string, tag: string, defs: RouteDef<any, any, any>[]) {
  for (const def of defs) {
    registry.push({ tag, fullPath: basePath + def.path, def });
    const guards = def.access === 'public' ? [] : [requireAuth(def.access === 'authenticated' ? undefined : def.access === 'admin' ? 'ADMIN' : 'EMPLOYEE')];
    router[def.method](def.path, ...(def.pre ?? []), ...guards, async (req: Request, res: Response, next: NextFunction) => {
      const user = (req as any).user as AuthUser | undefined;
      const run = async () => {
        if (def.ownerOnly && user?.access !== 'OWNER') throw new HttpError(403, 'OWNER_ONLY', 'Only the company owner can do this.');
        const params = parse(def.params, req.params, 'path parameters');
        // Before body validation, so another company's ids always answer 404 and nothing else.
        if (def.scope) await assertInOrg(def.scope, (params as { id: string }).id, user!.orgId, user!.sites);
        const body = parse(def.body, req.body, 'request body');
        const query = parse(def.query, req.query, 'query parameters');
        const result = await def.handler({ req, res, user: (req as any).user, body, query, params });
        if (def.raw || res.headersSent) return;
        if (result === undefined) res.status(204).end();
        else res.json(result);
      };
      try {
        // A signed-in user's request reaches only their company's rows, enforced by the database.
        // Public routes (sign-in, sign-up, refresh) work before anyone is known.
        await (user ? withOrg(user.orgId, run) : asSystem(run));
      } catch (err) {
        next(err);
      }
    });
  }
}

// ── shared schema helpers ──
export const uuid = z.uuid();
export const idParams = z.object({ id: z.uuid() });
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');
export const paging = {
  limit: z.coerce.number().int().min(1).max(500).default(50),
  offset: z.coerce.number().int().min(0).default(0),
};
export const boolish = z.preprocess((v) => (v === 'true' ? true : v === 'false' ? false : v), z.boolean());
