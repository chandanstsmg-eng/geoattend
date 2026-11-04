/**
 * Sample company only (see config.sampleData): keeps the generated "right now" believable while a
 * demo runs. Every minute:
 *   - check-ins the sample seed scheduled in `sample_plan` happen when their time comes (with the
 *     attendance record and, when late, the alert), so shifts starting after seeding are not no-shows;
 *   - planned moments happen on time: two people step outside the geofence, one phone goes quiet;
 *   - every sample phone except the quiet one sends a fresh position (inside the circle, or still
 *     outside for people who left) and reconnects if the sweeper marked it interrupted;
 *   - shifts past their scheduled end are checked out.
 * The quiet phone (device id ending ":quiet") stays silent, so the sweeper's "tracking interrupted"
 * remains visible. Never runs on real data.
 */
import { q } from '../../db/pool.js';
import { logger } from '../../lib/logger.js';

const M_PER_DEG_LAT = 111_320;

/** Carries out what the sample seed scheduled for after it ran (no-op on older sample databases). */
async function runPlan(at: Date) {
  const has = await q(`SELECT to_regclass('public.sample_plan') IS NOT NULL AS ok`);
  if (!has[0]?.ok) return;
  // Check-ins that are due (also catches up after the API was stopped, while the shift still runs).
  await q(
    `INSERT INTO tracking_sessions (id, employee_id, shift_id, workplace_id, shift_date, scheduled_start_at, scheduled_end_at, state, state_changed_at, authorization_status,
       started_at, device_id, foreground_permission, background_permission, location_services_enabled, last_location_at, last_location_client_at, last_latitude, last_longitude,
       last_accuracy_m, last_distance_m, last_classification, last_is_mocked, last_battery_level, last_battery_charging, last_network, last_device_status_at, created_at, updated_at)
     SELECT p.session_id, p.employee_id, p.shift_id, p.workplace_id, p.shift_date, p.scheduled_start_at, p.scheduled_end_at, 'PRESENT', p.arrive_at, 'AUTHORIZED',
       p.arrive_at - interval '6 minutes', p.device_id, 'granted', COALESCE(p.background_permission, 'granted'), true, $1, $1::timestamptz - interval '3 seconds', p.latitude, p.longitude,
       p.accuracy_m, p.distance_m, 'INSIDE', false, p.battery, false, 'cellular', $1, p.arrive_at - interval '10 minutes', $1
     FROM sample_plan p WHERE NOT p.arrived AND p.arrive_at <= $1 AND p.scheduled_end_at > $1
     ON CONFLICT DO NOTHING`,
    [at],
  );
  await q(
    `INSERT INTO attendance_records (id, employee_id, workplace_id, shift_id, session_id, shift_date, recorded_at, idempotency_key, evidence_latitude, evidence_longitude,
       evidence_accuracy_m, evidence_distance_m, evidence_client_time, radius_m_at_record, is_late, late_by_minutes, verification_status, risk_flags, device_meta, face_status, created_at, updated_at)
     SELECT p.record_id, p.employee_id, p.workplace_id, p.shift_id, p.session_id, p.shift_date, p.arrive_at, 'sample:' || p.record_id, p.latitude, p.longitude,
       p.accuracy_m, p.distance_m, p.arrive_at - interval '8 seconds', w.radius_m, p.late_by > 0, p.late_by, 'VERIFIED', '{}', jsonb_build_object('platform', p.platform, 'isPhysicalDevice', true), 'NO_PHOTO', p.arrive_at, p.arrive_at
     FROM sample_plan p JOIN workplaces w ON w.id = p.workplace_id
     WHERE NOT p.arrived AND p.arrive_at <= $1 AND EXISTS (SELECT 1 FROM tracking_sessions s WHERE s.id = p.session_id)
     ON CONFLICT DO NOTHING`,
    [at],
  );
  await q(
    `INSERT INTO notifications (type, audience, severity, title, body, employee_id, workplace_id, session_id, data, org_id, created_at)
     SELECT 'LATE_ARRIVAL', 'ADMIN', 'WARNING', 'Late arrival', p.employee_name || ' marked attendance ' || p.late_by || ' min after the ' || p.shift_name || ' shift start at ' || p.workplace_name || '.',
       p.employee_id, p.workplace_id, p.session_id, '{}', w.org_id, p.arrive_at
     FROM sample_plan p JOIN workplaces w ON w.id = p.workplace_id
     WHERE NOT p.arrived AND p.arrive_at <= $1 AND p.late_by > 0 AND EXISTS (SELECT 1 FROM attendance_records a WHERE a.id = p.record_id)`,
    [at],
  );
  await q(`UPDATE sample_plan p SET arrived = true WHERE NOT p.arrived AND p.arrive_at <= $1 AND (p.scheduled_end_at <= $1 OR EXISTS (SELECT 1 FROM tracking_sessions s WHERE s.id = p.session_id))`, [at]);

  // The phone that goes quiet: from now on the jitter below leaves it alone.
  await q(
    `UPDATE tracking_sessions s SET device_id = s.device_id || ':quiet', last_location_at = p.quiet_at, last_location_client_at = p.quiet_at - interval '4 seconds', last_battery_level = 0.09
     FROM sample_plan p WHERE p.session_id = s.id AND p.arrived AND NOT p.quiet_done AND p.quiet_at <= $1 AND s.ended_at IS NULL AND s.device_id NOT LIKE '%:quiet'`,
    [at],
  );
  await q(`UPDATE sample_plan SET quiet_done = true WHERE arrived AND NOT quiet_done AND quiet_at <= $1`, [at]);

  // Stepping outside the geofence (only from plain presence: someone on a break finishes it first).
  const left = await q(
    `UPDATE tracking_sessions s SET state = 'TEMPORARILY_AWAY', state_changed_at = p.away_at, last_latitude = p.away_latitude, last_longitude = p.away_longitude,
       last_distance_m = p.away_m, last_classification = 'OUTSIDE', updated_at = $1
     FROM sample_plan p WHERE p.session_id = s.id AND p.arrived AND NOT p.away_done AND p.away_at <= $1 AND s.ended_at IS NULL AND s.state = 'PRESENT'
     RETURNING s.id`,
    [at],
  );
  if (left.length) {
    const ids = left.map((r) => r.id);
    await q(
      `INSERT INTO absence_intervals (session_id, employee_id, workplace_id, started_at, verified_at, threshold_minutes, status, last_known_latitude, last_known_longitude, last_known_at, created_at)
       SELECT p.session_id, p.employee_id, p.workplace_id, p.away_at, p.away_at + interval '1 minute', 15, 'OPEN', p.away_latitude, p.away_longitude, $1, p.away_at
       FROM sample_plan p WHERE p.session_id = ANY($2::uuid[])
         AND NOT EXISTS (SELECT 1 FROM absence_intervals a WHERE a.session_id = p.session_id AND a.ended_at IS NULL)`,
      [at, ids],
    );
    await q(
      `INSERT INTO notifications (type, audience, severity, title, body, employee_id, workplace_id, session_id, data, org_id, created_at)
       SELECT 'GEOFENCE_EXIT', 'ADMIN', 'INFO', 'Left the workplace area', p.employee_name || ' left ' || p.workplace_name || ' during the shift.', p.employee_id, p.workplace_id, p.session_id, '{}', w.org_id, p.away_at
       FROM sample_plan p JOIN workplaces w ON w.id = p.workplace_id WHERE p.session_id = ANY($1::uuid[])`,
      [ids],
    );
    await q(`UPDATE sample_plan SET away_done = true WHERE session_id = ANY($1::uuid[])`, [ids]);
  }
}

export function startSampleHeartbeat() {
  const tick = async () => {
    try {
      await runPlan(new Date());
      // Every phone except the quiet one: a jitter of a few metres around the last fix, reconnecting if interrupted.
      await q(
        `UPDATE tracking_sessions s SET
           last_latitude = s.last_latitude + ((random() - 0.5) * 8) / ${M_PER_DEG_LAT},
           last_longitude = s.last_longitude + ((random() - 0.5) * 8) / (${M_PER_DEG_LAT} * cos(radians(s.last_latitude))),
           last_location_at = now(), last_location_client_at = now() - interval '3 seconds', last_device_status_at = now(), updated_at = now(),
           state = CASE WHEN s.state = 'TRACKING_INTERRUPTED' THEN CASE WHEN s.last_classification = 'OUTSIDE' THEN 'TEMPORARILY_AWAY' ELSE 'PRESENT' END ELSE s.state END,
           state_changed_at = CASE WHEN s.state = 'TRACKING_INTERRUPTED' THEN now() ELSE s.state_changed_at END
         WHERE s.ended_at IS NULL AND s.device_id LIKE 'sample-%' AND s.device_id NOT LIKE '%:quiet' AND s.scheduled_end_at > now()`,
      );
      // Check out at the scheduled end (a few minutes after), as people normally do.
      await q(
        `UPDATE tracking_sessions s SET ended_at = now(), state = 'SHIFT_COMPLETED', state_changed_at = now(), authorization_status = 'ENDED', updated_at = now()
         WHERE s.ended_at IS NULL AND s.device_id LIKE 'sample-%' AND s.scheduled_end_at + (abs(hashtext(s.id::text)) % 12) * interval '1 minute' < now()`,
      );
      await q(
        `UPDATE absence_intervals a SET ended_at = s.ended_at, status = 'SHIFT_ENDED'
         FROM tracking_sessions s WHERE s.id = a.session_id AND a.ended_at IS NULL AND s.ended_at IS NOT NULL AND s.device_id LIKE 'sample-%'`,
      );
    } catch (err) {
      logger.warn({ err }, 'sample heartbeat failed');
    }
  };
  void tick();
  const timer = setInterval(tick, 60_000);
  timer.unref();
  logger.info('Sample company: keeping sample positions fresh (geoattend *_demo database)');
  return () => clearInterval(timer);
}
