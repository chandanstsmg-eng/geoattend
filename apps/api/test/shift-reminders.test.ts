/** Reminders before a shift: only when chosen, at the right local time, to the right people, once. */
import crypto from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { DateTime } from 'luxon';
import { one, q } from '../src/db/pool.js';
import { createApp } from '../src/app.js';
import { sweepShiftReminders } from '../src/modules/jobs/shift-reminders.js';
import { sweepNoShows } from '../src/modules/jobs/no-show.js';
import { DEFAULT_SETTINGS, saveSettingsSection } from '../src/modules/settings/settings.service.js';
import { createEmployee, createTestDatabase, mobileLogin, seedBase, testSettings } from './helpers.js';

let app: Express;
let db: Awaited<ReturnType<typeof createTestDatabase>>;
type Co = Awaited<ReturnType<typeof co>>;
let A: Co;
let B: Co;

async function co(name: string, zone = 'UTC', start = '09:00', end = '17:00') {
  const org = (await one(`INSERT INTO organizations (name) VALUES ($1) RETURNING id`, [name])).id as string;
  const base = await seedBase(org, `${name}-${crypto.randomUUID()}@test.local`);
  await testSettings(org);
  await q(`UPDATE workplaces SET timezone = $2 WHERE id = $1`, [base.workplaceId, zone]);
  await q(`UPDATE shifts SET start_time = $2, end_time = $3, timezone = $4 WHERE id = $1`, [base.shiftId, start, end, zone]);
  return { ...base, org };
}
const remind = (c: Co, minutes: number) => saveSettingsSection(c.org, 'alerts', { ...DEFAULT_SETTINGS.alerts, shiftReminderMinutes: minutes }, null);
async function rostered(c: Co) {
  const emp = await createEmployee({ workplaceId: c.workplaceId, orgId: c.org });
  await q(`INSERT INTO employee_shift_assignments (employee_id, shift_id, effective_from) VALUES ($1,$2,'2020-01-01')`, [emp.id, c.shiftId]);
  return emp;
}
const told = (id: string) => q(`SELECT audience, org_id, body, dedupe_key FROM notifications WHERE employee_id = $1 AND type = 'SHIFT_REMINDER'`, [id]);
const at = (iso: string, zone = 'UTC') => DateTime.fromISO(iso, { zone }).toJSDate();

beforeAll(async () => {
  db = await createTestDatabase();
  app = createApp();
  A = await co('Alpha');
  B = await co('Bravo');
});
afterEach(async () => {
  await remind(A, 0);
  await remind(B, 0);
  await q(`DELETE FROM notifications WHERE type IN ('SHIFT_REMINDER', 'NO_SHOW')`);
  await q(`DELETE FROM employee_shift_assignments`);
});
afterAll(async () => {
  await db.drop();
});

describe('reminders before a shift', () => {
  it('are off unless the company chose them', async () => {
    expect(DEFAULT_SETTINGS.alerts.shiftReminderMinutes).toBe(0);
    const emp = await rostered(A);
    await sweepShiftReminders(at('2026-11-09T08:45:00'));
    expect(await told(emp.id)).toEqual([]);
  });

  it('go out at the chosen time, not before, and not after the shift starts', async () => {
    await remind(A, 30);
    const emp = await rostered(A);
    await sweepShiftReminders(at('2026-11-09T08:29:00'));
    expect(await told(emp.id)).toEqual([]);
    await sweepShiftReminders(at('2026-11-09T08:31:00'));
    expect((await told(emp.id))[0]).toMatchObject({ audience: 'EMPLOYEE', org_id: A.org, body: 'All day at Test Site starts at 09:00.' });
  });

  it('a server that was down until after the start sends nothing late', async () => {
    await remind(A, 30);
    const emp = await rostered(A);
    await sweepShiftReminders(at('2026-11-09T09:01:00'));
    expect(await told(emp.id)).toEqual([]);
  });

  it('are sent once, however often the job runs, and by runners at once', async () => {
    await remind(A, 30);
    const emp = await rostered(A);
    const when = at('2026-11-09T08:40:00');
    await Promise.all([sweepShiftReminders(when), sweepShiftReminders(when), sweepShiftReminders(when)]);
    await sweepShiftReminders(at('2026-11-09T08:50:00'));
    expect(await told(emp.id)).toHaveLength(1);
  });

  it('follow the shift\'s own time zone', async () => {
    const india = await co('India', 'Asia/Kolkata');
    await remind(india, 30);
    const emp = await rostered(india);
    await sweepShiftReminders(at('2026-11-09T08:40:00')); // 14:10 in India: long after the start
    expect(await told(emp.id)).toEqual([]);
    await sweepShiftReminders(at('2026-11-09T08:40:00', 'Asia/Kolkata'));
    expect((await told(emp.id))[0].body).toContain('starts at 09:00');
  });

  it('a shift just after midnight is reminded the evening before', async () => {
    const night = await co('Night', 'UTC', '00:10', '08:00');
    await remind(night, 30);
    const emp = await rostered(night);
    await sweepShiftReminders(at('2026-11-09T23:50:00'));
    expect((await told(emp.id))[0].dedupe_key).toContain(':2026-11-10');
  });

  it('skip a day the shift does not run', async () => {
    const weekdays = await co('Weekdays');
    await q(`UPDATE shifts SET days_of_week = '{1,2,3,4,5}' WHERE id = $1`, [weekdays.shiftId]);
    await remind(weekdays, 30);
    const emp = await rostered(weekdays);
    await sweepShiftReminders(at('2026-11-08T08:40:00')); // a Sunday
    expect(await told(emp.id)).toEqual([]);
  });

  it('skip someone whose assignment has not begun or has ended', async () => {
    await remind(A, 30);
    const emp = await createEmployee({ workplaceId: A.workplaceId, orgId: A.org });
    await q(`INSERT INTO employee_shift_assignments (employee_id, shift_id, effective_from) VALUES ($1,$2,'2026-12-01')`, [emp.id, A.shiftId]);
    await sweepShiftReminders(at('2026-11-09T08:40:00'));
    expect(await told(emp.id)).toEqual([]);
  });

  it('skip someone on approved leave', async () => {
    await remind(A, 30);
    const emp = await rostered(A);
    await q(`INSERT INTO leave_requests (employee_id, leave_type, start_date, end_date, reason, requested_by, status) VALUES ($1,'SICK','2026-11-09','2026-11-09','Fever',$1,'APPROVED')`, [emp.id]);
    await sweepShiftReminders(at('2026-11-09T08:40:00'));
    expect(await told(emp.id)).toEqual([]);
  });

  it('skip a holiday at the workplace', async () => {
    await remind(A, 30);
    const emp = await rostered(A);
    await q(`INSERT INTO holidays (workplace_id, holiday_date, name, org_id) VALUES ($1,'2026-11-09','Festival',$2)`, [A.workplaceId, A.org]);
    await sweepShiftReminders(at('2026-11-09T08:40:00'));
    expect(await told(emp.id)).toEqual([]);
    await q(`DELETE FROM holidays WHERE workplace_id = $1`, [A.workplaceId]);
  });

  it('skip someone who has already started', async () => {
    await remind(A, 30);
    const emp = await rostered(A);
    await q(
      `INSERT INTO tracking_sessions (employee_id, shift_id, workplace_id, shift_date, scheduled_start_at, scheduled_end_at, state, started_at)
       VALUES ($1,$2,$3,'2026-11-09','2026-11-09T09:00:00Z','2026-11-09T17:00:00Z','PRESENT','2026-11-09T08:20:00Z')`,
      [emp.id, A.shiftId, A.workplaceId],
    );
    await sweepShiftReminders(at('2026-11-09T08:40:00'));
    expect(await told(emp.id)).toEqual([]);
  });

  it('skip an inactive employee', async () => {
    await remind(A, 30);
    const emp = await rostered(A);
    await q(`UPDATE users SET is_active = false WHERE id = $1`, [emp.id]);
    await sweepShiftReminders(at('2026-11-09T08:40:00'));
    expect(await told(emp.id)).toEqual([]);
  });

  it('stay in the company that chose them', async () => {
    await remind(A, 30);
    const other = await rostered(B);
    await sweepShiftReminders(at('2026-11-09T08:40:00'));
    expect(await told(other.id)).toEqual([]);
  });
});

describe('the employee\'s choice', () => {
  it('is on by default and can be changed by the employee, through the API', async () => {
    const emp = await rostered(A);
    const token = await mobileLogin(app, emp.email);
    const auth = { Authorization: `Bearer ${token}` };
    expect((await request(app).get('/api/v1/me/preferences').set(auth).expect(200)).body).toEqual({ shiftReminders: true });
    await request(app).put('/api/v1/me/preferences').set(auth).send({ shiftReminders: false }).expect(200);
    expect((await request(app).get('/api/v1/me/preferences').set(auth).expect(200)).body).toEqual({ shiftReminders: false });
  });

  it('turned off, no reminder goes, before or after the start, and the owner is still alerted', async () => {
    await remind(A, 30);
    const emp = await rostered(A);
    await q(`UPDATE employee_profiles SET shift_reminders = false WHERE user_id = $1`, [emp.id]);
    await sweepShiftReminders(at('2026-11-09T08:40:00'));
    expect(await told(emp.id)).toEqual([]);
    const noon = DateTime.utc().set({ hour: 12, minute: 0 }).toJSDate();
    await q(`UPDATE shifts SET start_time = '00:00', end_time = '23:59' WHERE id = $1`, [A.shiftId]);
    await sweepNoShows(noon);
    await sweepNoShows(noon);
    expect((await q(`SELECT audience FROM notifications WHERE employee_id = $1 AND type = 'NO_SHOW'`, [emp.id])).map((n) => n.audience)).toEqual(['ADMIN']);
    await q(`UPDATE shifts SET start_time = '09:00', end_time = '17:00' WHERE id = $1`, [A.shiftId]);
  });

  it('only an employee has this choice, and only their own', async () => {
    const one1 = await rostered(A);
    const two = await rostered(A);
    await request(app).put('/api/v1/me/preferences').set('Authorization', `Bearer ${await mobileLogin(app, one1.email)}`).send({ shiftReminders: false }).expect(200);
    expect((await one(`SELECT shift_reminders FROM employee_profiles WHERE user_id = $1`, [two.id])).shift_reminders).toBe(true);
    await request(app).put('/api/v1/me/preferences').send({ shiftReminders: false }).expect(401);
    await request(app).put('/api/v1/me/preferences').set('Authorization', `Bearer ${await mobileLogin(app, one1.email)}`).send({ shiftReminders: 'no' }).expect(400);
  });
});
