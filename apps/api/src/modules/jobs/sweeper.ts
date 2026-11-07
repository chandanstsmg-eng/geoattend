/**
 * Periodic background work, driven by the database (no in-memory timers per
 * employee, so restarts lose nothing). runner.ts runs each job once across all
 * API instances, one company at a time on the restricted login, and each step
 * re-checks state under a row lock before acting:
 *
 *  - stale location updates  → TRACKING_INTERRUPTED (never "left the workplace")
 *  - away beyond threshold   → PROLONGED_ABSENCE (+ cooldown-limited reminders)
 *  - break beyond its limit  → one BREAK_OVERDUE alert
 *  - shift window closed     → session closed, location collection stops (not while on overtime)
 *  - shift ended             → "still working?" prompt; overtime with no location for an hour → ended
 *  - unfinished attendance submissions → back to ATTENDANCE_READY
 *  - notification deliveries with retry
 *  - retention (hourly)
 *  - backups still proven (hourly), and alerts for whoever runs the server (each minute)
 */
import { TRACKING_STATES } from '@geoattend/shared';
import { logger } from '../../lib/logger.js';
import { q, tx } from '../../db/pool.js';
import { eachCompany, eachRecord, jobsStopping, recoverInterruptedJobs, resumeJobs, runJob, stopJobs, throwIfAny } from './runner.js';
import { config } from '../../config.js';
import { getSettings } from '../settings/settings.service.js';
import { notify } from '../notifications/notify.js';
import { Outbox } from '../notifications/live-hub.js';
import { processDeliveries } from '../notifications/delivery.js';
import { finalizeLocked, lockSession, transition } from '../tracking/tracking.service.js';
import { sweepOverdueBreaks } from '../tracking/breaks.service.js';
import { onOvertime, sweepOvertime } from '../tracking/overtime.service.js';
import { expireStaleIntents } from '../attendance/attendance.service.js';
import { runRetention } from './retention.js';
import { sweepNoShows } from './no-show.js';
import { sweepShiftReminders } from './shift-reminders.js';
import { sweepOverdueApprovals } from './escalation.js';
import { sweepDigests } from '../digest/digest.js';
import { sweepFaceChecks } from '../faces/faces.js';
import { checkBackups, evaluateAlerts } from '../ops/alerts.js';

const mins = (ms: number) => Math.round(ms / 60000);

/** Best guess at why a phone went quiet, from the battery / network state it last reported. */
export function likelyCause(s: { last_battery_level?: number | null; last_battery_charging?: boolean | null; last_low_power_mode?: boolean | null; last_network?: string | null; last_device_status_at?: Date | null }) {
  const generic = 'Possible causes: no network, battery restrictions, app closed or GPS off.';
  if (!s.last_device_status_at) return generic;
  const pct = s.last_battery_level != null ? Math.round(s.last_battery_level * 100) : null;
  const battery = pct != null ? `Battery was ${pct}%${s.last_battery_charging ? ' and charging' : ''}${s.last_low_power_mode ? ' in power-saving mode' : ''}` : null;
  if (pct != null && pct <= 10 && !s.last_battery_charging) return `Likely cause: the phone battery was almost empty (${pct}%).`;
  if (s.last_network === 'none') return `Likely cause: the phone had no internet connection${battery ? ` (${battery.toLowerCase()})` : ''}. Readings are saved on the phone and will arrive when it reconnects.`;
  if (s.last_low_power_mode) return `Likely cause: power-saving mode may have paused the app. ${battery}.`;
  return `${generic}${battery ? ` ${battery}, network ${s.last_network ?? 'unknown'}.` : ''}`;
}

/** Companies with at least one open session, the only ones these sweeps need to visit. */
async function orgsWithOpenSessions(): Promise<string[]> {
  return (await q(`SELECT DISTINCT u.org_id FROM tracking_sessions s JOIN users u ON u.id = s.employee_id WHERE s.ended_at IS NULL`)).map((r) => r.org_id);
}

export const sweepStale = (realNow = new Date()) => eachCompany((orgId) => sweepStaleOrg(orgId, realNow), orgsWithOpenSessions);

async function sweepStaleOrg(orgId: string, realNow: Date) {
  const settings = await getSettings(orgId);
  const outbox = new Outbox();
  // Each session is judged on its own clock: real time + sim_clock_offset_sec (always 0 for real sessions).
  const candidates = await q(
    `SELECT id FROM tracking_sessions
     WHERE ended_at IS NULL AND state = ANY($1) AND employee_id IN (SELECT id FROM users WHERE org_id = $4)
       AND COALESCE(last_location_at, started_at) < $2::timestamptz + make_interval(secs => sim_clock_offset_sec) - make_interval(secs => $3)`,
    [TRACKING_STATES, realNow, settings.tracking.staleAfterSec, orgId],
  );
  const failures = await eachRecord(candidates, ({ id }) =>
    tx(async (db) => {
      const s = await lockSession(db, id);
      if (!s || s.ended_at || !TRACKING_STATES.includes(s.state)) return;
      const now = new Date(realNow.getTime() + s.sim_clock_offset_sec * 1000);
      const last = new Date(s.last_location_at ?? s.started_at);
      if (now.getTime() - last.getTime() < settings.tracking.staleAfterSec * 1000) return;
      const prev = s.state;
      const changedAt = Date.now();
      await q('UPDATE absence_intervals SET tracking_gap = true WHERE session_id = $1 AND status = $2', [id, 'OPEN'], db);
      await transition(db, outbox, s, 'TRACKING_INTERRUPTED', `no location received for ${mins(now.getTime() - last.getTime())} min`, 'SYSTEM', null, { resumeState: prev });
      await notify(db, outbox, {
        type: 'TRACKING_INTERRUPTED',
        severity: 'WARNING',
        body:
          `${s.employee_name}: no location update since ${s.last_location_at ? new Date(s.last_location_at).toISOString() : 'the shift started'} (${mins(now.getTime() - last.getTime())} min). ` +
          `${likelyCause(s)} This does not mean the employee left the workplace.`,
        employeeId: s.employee_id,
        workplaceId: s.workplace_id,
        sessionId: id,
        data: {
          previousState: prev,
          device: s.last_device_status_at ? { batteryLevel: s.last_battery_level, charging: s.last_battery_charging, lowPowerMode: s.last_low_power_mode, network: s.last_network, at: s.last_device_status_at } : null,
          lastKnown: s.last_latitude != null ? { lat: s.last_latitude, lng: s.last_longitude, accuracyM: s.last_accuracy_m, at: s.last_location_client_at } : null,
        },
        dedupeKey: `stale:${id}:${changedAt}`,
        simulated: s.is_simulated,
      });
    }),
  );
  outbox.flush();
  throwIfAny(failures);
}

export const sweepAbsences = (realNow = new Date()) => eachCompany(() => absencesForCompany(realNow), orgsWithOpenSessions);

async function absencesForCompany(realNow: Date) {
  const outbox = new Outbox();
  const due = await q(
    `SELECT a.id, a.session_id FROM absence_intervals a JOIN tracking_sessions s ON s.id = a.session_id
     WHERE a.status = 'OPEN' AND s.ended_at IS NULL AND s.state IN ('TEMPORARILY_AWAY', 'PROLONGED_ABSENCE')
       AND a.started_at + make_interval(mins => a.threshold_minutes) <= $1::timestamptz + make_interval(secs => s.sim_clock_offset_sec)`,
    [realNow],
  );
  const failures = await eachRecord(due, (row) =>
    tx(async (db) => {
      const s = await lockSession(db, row.session_id);
      if (!s || s.ended_at) return;
      const now = new Date(realNow.getTime() + s.sim_clock_offset_sec * 1000);
      const a = (await q(`SELECT * FROM absence_intervals WHERE id = $1 AND status = 'OPEN' FOR UPDATE`, [row.id], db))[0];
      if (!a) return;
      const awayMin = mins(now.getTime() - new Date(a.started_at).getTime());
      const lastAt = s.last_location_at ? new Date(s.last_location_at) : null;
      const freshness = lastAt ? `${mins(now.getTime() - lastAt.getTime())} min ago` : 'unknown';
      const data = {
        intervalId: a.id,
        departedAt: a.started_at,
        awayMinutes: awayMin,
        thresholdMinutes: a.threshold_minutes,
        lastKnown: { lat: a.last_known_latitude, lng: a.last_known_longitude, at: a.last_known_at },
        lastUpdateAt: s.last_location_at,
      };
      if (s.state === 'TEMPORARILY_AWAY') {
        await q('UPDATE absence_intervals SET prolonged_at = $2 WHERE id = $1', [a.id, now], db);
        await transition(db, outbox, s, 'PROLONGED_ABSENCE', `away for ${awayMin} min (threshold ${a.threshold_minutes} min)`, 'SYSTEM');
        await notify(db, outbox, {
          type: 'PROLONGED_ABSENCE',
          severity: 'CRITICAL',
          body: `${s.employee_name} has been away from ${s.workplace_name} for ${awayMin} min (threshold ${a.threshold_minutes} min). Departed ${new Date(a.started_at).toISOString()}; last location update ${freshness}.`,
          employeeId: s.employee_id,
          workplaceId: s.workplace_id,
          sessionId: s.id,
          data,
          dedupeKey: `prolonged:${a.id}`,
          simulated: s.is_simulated,
        });
      } else if (a.prolonged_at) {
        const cooldownMs = (await getSettings(s.org_id)).alerts.prolongedReminderCooldownMin * 60_000;
        const k = Math.floor((now.getTime() - new Date(a.prolonged_at).getTime()) / cooldownMs);
        if (k >= 1) {
          await notify(db, outbox, {
            type: 'PROLONGED_ABSENCE',
            severity: 'CRITICAL',
            title: 'Prolonged absence continues',
            body: `${s.employee_name} is still away from ${s.workplace_name}: ${awayMin} min so far. Last location update ${freshness}.`,
            employeeId: s.employee_id,
            workplaceId: s.workplace_id,
            sessionId: s.id,
            data: { ...data, reminder: k },
            dedupeKey: `prolonged:${a.id}:r${k}`,
            simulated: s.is_simulated,
          });
        }
      }
    }),
  );
  outbox.flush();
  throwIfAny(failures);
}

export const sweepExpiredWindows = (now = new Date()) => eachCompany((orgId) => expiredWindowsForCompany(orgId, now), orgsWithOpenSessions);

async function expiredWindowsForCompany(orgId: string, now: Date) {
  const outbox = new Outbox();
  const settings = await getSettings(orgId);
  const due = await q(
    // Overtime is not bound to the window (sweepOvertime ends it if the phone goes quiet).
    `SELECT id FROM tracking_sessions WHERE ended_at IS NULL AND scheduled_end_at + make_interval(mins => $2) < $1 AND employee_id IN (SELECT id FROM users WHERE org_id = $3)
       AND state <> 'ON_OVERTIME' AND resume_state IS DISTINCT FROM 'ON_OVERTIME'`,
    [now, settings.tracking.endGraceMinutes, orgId],
  );
  const failures = await eachRecord(due, ({ id }) =>
    tx(async (db) => {
      const s = await lockSession(db, id);
      if (!s || s.ended_at || onOvertime(s)) return;
      await finalizeLocked(db, outbox, s, { actor: 'SYSTEM', actorId: null, authorization: 'EXPIRED', reason: 'shift window ended' });
    }),
  );
  outbox.flush();
  throwIfAny(failures);
}

const sweepStaleIntents = () =>
  eachCompany(async () => {
    const outbox = new Outbox();
    try {
      await expireStaleIntents(outbox);
    } finally {
      outbox.flush();
    }
  });

/** In order. Each job runs on its own: one failing never stops the ones after it. */
export const JOBS: Array<{ name: string; run: (now: Date) => Promise<unknown>; everyMs?: number }> = [
  { name: 'expired-windows', run: sweepExpiredWindows },
  { name: 'stale-tracking', run: sweepStale },
  { name: 'absences', run: sweepAbsences },
  { name: 'overdue-breaks', run: sweepOverdueBreaks },
  { name: 'overtime', run: sweepOvertime },
  { name: 'shift-reminders', run: sweepShiftReminders },
  { name: 'no-shows', run: sweepNoShows },
  { name: 'overdue-approvals', run: sweepOverdueApprovals },
  { name: 'digests', run: sweepDigests },
  { name: 'face-checks', run: () => sweepFaceChecks() },
  { name: 'stale-intents', run: sweepStaleIntents },
  { name: 'deliveries', run: () => processDeliveries() },
  { name: 'retention', run: () => runRetention(), everyMs: 3600_000 },
  { name: 'backup-check', run: checkBackups, everyMs: 3600_000 },
  { name: 'ops-alerts', run: evaluateAlerts, everyMs: 60_000 },
];

let current: Promise<void> | null = null;

async function sweep(now: Date) {
  try {
    await recoverInterruptedJobs();
    for (const job of JOBS) {
      if (jobsStopping()) break;
      await runJob(job.name, () => job.run(now), { everyMs: job.everyMs });
    }
  } catch (err) {
    logger.error({ err }, 'sweeper run failed'); // the job tables are unreachable: the database is down
  }
}

export async function sweepOnce(now = new Date()) {
  if (current || jobsStopping()) return;
  current = sweep(now).finally(() => {
    current = null;
  });
  await current;
}

/** Waits for the sweep in progress, for at most `waitMs`. Left unfinished, its lease runs out and it is recovered. */
export async function drainJobs(waitMs = 8_000) {
  stopJobs();
  let timer: NodeJS.Timeout | undefined;
  const finished = await Promise.race([
    (current ?? Promise.resolve()).then(() => true),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), waitMs);
    }),
  ]);
  clearTimeout(timer);
  if (!finished) logger.warn('a background job did not stop in time; it will be recovered when its lease runs out');
  return finished;
}

export function startSweeper() {
  resumeJobs();
  const timer = setInterval(() => void sweepOnce(), config.sweeperIntervalMs);
  timer.unref();
  return async () => {
    clearInterval(timer);
    await drainJobs();
  };
}
