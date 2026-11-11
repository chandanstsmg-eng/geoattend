import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import { pinoHttp } from 'pino-http';
import swaggerUi from 'swagger-ui-dist';
import { config } from './config.js';
import { logger } from './lib/logger.js';
import { HttpError } from './lib/errors.js';
import { buildOpenApi } from './lib/openapi.js';
import { getPool } from './db/pool.js';
import { jobHealth } from './modules/jobs/runner.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { meRouter } from './modules/employees/me.routes.js';
import { employeesRouter } from './modules/employees/employees.routes.js';
import { workplacesRouter } from './modules/workplaces/workplaces.routes.js';
import { shiftsRouter } from './modules/shifts/shifts.routes.js';
import { trackingRouter } from './modules/tracking/tracking.routes.js';
import { attendanceRouter, storageRouter } from './modules/attendance/attendance.routes.js';
import { absenceRouter, auditRouter, geofenceEventsRouter } from './modules/events/events.routes.js';
import { notificationsRouter } from './modules/notifications/notifications.routes.js';
import { reportsRouter } from './modules/reports/reports.routes.js';
import { settingsRouter } from './modules/settings/settings.routes.js';
import { demoRouter } from './modules/demo/demo.routes.js';
import { leaveRouter } from './modules/leave/leave.routes.js';
import { devicesRouter } from './modules/devices/devices.routes.js';
import { holidaysRouter } from './modules/holidays/holidays.routes.js';
import { approvalsRouter } from './modules/approvals/approvals.routes.js';
import { organizationRouter } from './modules/organization/organization.routes.js';
import { payrollRouter } from './modules/payroll/payroll.routes.js';
import { insightsRouter } from './modules/reports/insights.routes.js';
import { teamRouter } from './modules/team/team.routes.js';
import { rosterRouter } from './modules/roster/roster.js';
import { facesRouter } from './modules/faces/faces.routes.js';
import { digestRouter } from './modules/digest/digest.routes.js';
import { tasksRouter } from './modules/tasks/tasks.routes.js';
import { broadcastsRouter, sosRouter } from './modules/sos/sos.routes.js';
import { overtimeRouter } from './modules/overtime/overtime.routes.js';
import { analyticsRouter } from './modules/reports/analytics.routes.js';
import { hasOpsToken, opsRouter } from './modules/ops/ops.routes.js';
import { platformAuthRouter, platformRouter } from './modules/platform/platform.routes.js';

export function createApp() {
  const app = express();
  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          imgSrc: ["'self'", 'data:'],
          styleSrc: ["'self'", "'unsafe-inline'"], // swagger-ui
          scriptSrc: ["'self'"],
          connectSrc: ["'self'"],
          frameAncestors: ["'none'"],
        },
      },
      crossOriginResourcePolicy: { policy: 'same-site' },
      strictTransportSecurity: config.isProduction ? { maxAge: 31536000, includeSubDomains: true } : false,
    }),
  );

  // CORS: explicit allow-list only (the dashboard normally calls same-origin through its proxy;
  // native mobile apps are not subject to CORS).
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && config.corsOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-CSRF-Token');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      res.setHeader('Access-Control-Max-Age', '600');
    }
    if (req.method === 'OPTIONS') return res.status(origin && config.corsOrigins.includes(origin) ? 204 : 403).end();
    next();
  });

  if (!config.isTest) {
    app.use(
      pinoHttp({
        logger,
        autoLogging: { ignore: (req) => req.url === '/health' || req.url?.startsWith('/api/v1/notifications/stream') === true },
        customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
        serializers: { req: (r) => ({ method: r.method, url: r.url?.split('?')[0] }), res: (r) => ({ statusCode: r.statusCode }) },
      }),
    );
  }

  app.use(cookieParser());
  app.use(
    '/api/v1/storage',
    rateLimit({ windowMs: 60_000, limit: config.isTest ? 100_000 : 600, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: { code: 'RATE_LIMITED', message: 'Too many requests' } } }),
    storageRouter, // raw image bodies — must precede the JSON parser
  );
  app.use(express.json({ limit: '512kb' }));

  app.use(
    '/api/',
    rateLimit({ windowMs: 60_000, limit: config.isTest ? 100_000 : 1200, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: { code: 'RATE_LIMITED', message: 'Too many requests' } } }),
  );

  app.get('/health', async (_req, res) => {
    try {
      await getPool().query('SELECT 1');
      res.json({ status: 'ok', database: 'ok' });
    } catch {
      res.status(503).json({ status: 'degraded', database: 'unreachable' });
    }
  });

  // For monitoring: job counts, nothing about any company. Absent unless OPS_TOKEN is set, and to anyone without it.
  app.get('/health/jobs', async (req, res, next) => {
    try {
      if (!hasOpsToken(req)) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No such endpoint' } });
      res.json(await jobHealth());
    } catch (err) {
      next(err);
    }
  });

  app.use('/api/v1/auth', authRouter);
  app.use('/api/v1/me', meRouter);
  app.use('/api/v1/employees', employeesRouter);
  app.use('/api/v1/workplaces', workplacesRouter);
  app.use('/api/v1/shifts', shiftsRouter);
  app.use('/api/v1/roster', rosterRouter);
  app.use('/api/v1/faces', facesRouter);
  app.use('/api/v1/tracking', trackingRouter);
  app.use('/api/v1/attendance', attendanceRouter);
  app.use('/api/v1/geofence-events', geofenceEventsRouter);
  app.use('/api/v1/absence-intervals', absenceRouter);
  app.use('/api/v1/notifications', notificationsRouter);
  app.use('/api/v1/reports', reportsRouter);
  app.use('/api/v1/audit-logs', auditRouter);
  app.use('/api/v1/settings', settingsRouter);
  app.use('/api/v1/leave', leaveRouter);
  app.use('/api/v1/devices', devicesRouter);
  app.use('/api/v1/holidays', holidaysRouter);
  app.use('/api/v1/approvals', approvalsRouter);
  app.use('/api/v1/organization', organizationRouter);
  app.use('/api/v1/payroll', payrollRouter);
  app.use('/api/v1/insights', insightsRouter);
  app.use('/api/v1/team', teamRouter);
  app.use('/api/v1/digest', digestRouter);
  app.use('/api/v1/tasks', tasksRouter);
  app.use('/api/v1/sos', sosRouter);
  app.use('/api/v1/broadcasts', broadcastsRouter);
  app.use('/api/v1/overtime', overtimeRouter);
  app.use('/api/v1/analytics', analyticsRouter);
  app.use('/api/v1/ops', opsRouter);
  // Platform administration: separate accounts, separate sign-in (lib/platform-auth.ts).
  app.use('/api/v1/platform/auth', platformAuthRouter);
  app.use('/api/v1/platform', platformRouter);
  if (config.demoMode) app.use('/api/v1/demo', demoRouter);

  // The API map is for development; production does not publish it.
  if (!config.isProduction) {
    const openapi = buildOpenApi();
    app.get('/api/v1/openapi.json', (_req, res) => res.json(openapi));
    app.use('/api/docs/assets', express.static(swaggerUi.getAbsoluteFSPath(), { index: false }));
    app.get('/api/docs', (_req, res) => {
      res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><title>GeoAttend API</title>
<link rel="stylesheet" href="/api/docs/assets/swagger-ui.css"></head><body><div id="swagger-ui"></div>
<script src="/api/docs/assets/swagger-ui-bundle.js"></script><script src="/api/docs/init.js"></script></body></html>`);
    });
    app.get('/api/docs/init.js', (_req, res) => {
      res.type('application/javascript').send(`window.ui = SwaggerUIBundle({ url: '/api/v1/openapi.json', dom_id: '#swagger-ui' });`);
    });
  }

  app.use('/api', (_req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No such endpoint' } }));

  // Errors: never leak internals.
  app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
    // An export that fails part way has already sent its headers. Cutting the connection tells the
    // browser the download failed, instead of leaving a shorter file that looks complete.
    if (res.headersSent) {
      logger.error({ err, url: req.url?.split('?')[0] }, 'response failed part way through');
      return res.destroy();
    }
    if (err instanceof HttpError) {
      return res.status(err.status).json({ error: { code: err.code, message: err.message, ...(err.details !== undefined ? { details: err.details } : {}) } });
    }
    if (err?.type === 'entity.too.large') return res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body too large' } });
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: { code: 'BAD_JSON', message: 'Malformed JSON body' } });
    const connErr = (e: any) => ['ECONNREFUSED', 'ECONNRESET', '57P01', '57P03', 'ETIMEDOUT'].includes(e?.code);
    if (connErr(err) || (Array.isArray(err?.errors) && err.errors.some(connErr))) {
      logger.error({ url: req.url?.split('?')[0] }, 'database unavailable');
      return res.status(503).json({ error: { code: 'DATABASE_UNAVAILABLE', message: 'The database is temporarily unavailable. Please try again in a few seconds.' } });
    }
    if (err?.code === '23503') return res.status(409).json({ error: { code: 'IN_USE', message: 'This record is referenced by other records.' } });
    if (err?.code === '23505') return res.status(409).json({ error: { code: 'CONFLICT', message: 'A record with these values already exists.' } });
    if (err?.code === '23514' || err?.code === '22P02' || err?.code === '22007' || err?.code === '22008') {
      return res.status(400).json({ error: { code: 'INVALID_VALUE', message: 'A value is out of the permitted range or format.' } });
    }
    logger.error({ err, url: req.url?.split('?')[0] }, 'unhandled error');
    res.status(500).json({ error: { code: 'INTERNAL', message: 'Something went wrong. The error has been logged.' } });
  });

  return app;
}
