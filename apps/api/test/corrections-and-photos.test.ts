/**
 * The owner's decisions on Phase C: voided records stay as history but never count, supervisors
 * propose corrections an owner approves, only an owner deletes a photo, and nothing deletes photos
 * automatically until the server switch and the company's choice are both on.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { DateTime } from 'luxon';
import { config } from '../src/config.js';
import { one, q } from '../src/db/pool.js';
import { createApp } from '../src/app.js';
import { writeLocalObject } from '../src/lib/storage.js';
import { runRetention } from '../src/modules/jobs/retention.js';
import { DEFAULT_SETTINGS, invalidateSettings, saveSettingsSection } from '../src/modules/settings/settings.service.js';
import { DEFAULT_ORG_ID } from '../src/lib/tenancy.js';
import { adminAgent, createEmployee, createTestDatabase, fakeJpeg, mobileLogin, seedBase } from './helpers.js';

let app: Express;
let db: Awaited<ReturnType<typeof createTestDatabase>>;
let base: Awaited<ReturnType<typeof seedBase>>;
let owner: Awaited<ReturnType<typeof adminAgent>>;
let sup: Awaited<ReturnType<typeof adminAgent>>;
let supId: string;
let shiftId: string;

beforeAll(async () => {
  db = await createTestDatabase();
  base = await seedBase();
  app = createApp();
  owner = await adminAgent(app);
  const s = await one(`INSERT INTO users (email, password_hash, role, full_name, org_id) SELECT $1, password_hash, 'ADMIN', 'Site Supervisor', org_id FROM users WHERE id = $2 RETURNING id, email`, [`sup-${crypto.randomUUID()}@test.local`, base.adminId]);
  await q(`INSERT INTO administrator_profiles (user_id, access, site_ids) VALUES ($1,'SUPERVISOR',$2)`, [s.id, [base.workplaceId]]);
  supId = s.id;
  sup = await adminAgent(app, s.email);
  shiftId = (await one(`INSERT INTO shifts (workplace_id, name, start_time, end_time, timezone, days_of_week, arrival_grace_minutes) VALUES ($1,'Day','09:00','17:00','UTC',$2,10) RETURNING id`, [base.workplaceId, [1, 2, 3, 4, 5, 6, 7]])).id;
});
afterAll(async () => {
  await db.drop();
});
afterEach(async () => {
  config.photoAutoDeleteEnabled = false;
  await saveSettingsSection(DEFAULT_ORG_ID, 'retention', DEFAULT_SETTINGS.retention, null);
  await saveSettingsSection(DEFAULT_ORG_ID, 'workforce', { ...DEFAULT_SETTINGS.workforce, faceEnrollment: 'OFF', deviceBinding: 'OFF' }, null);
  invalidateSettings();
});

const as = (who: typeof owner) => ({
  post: (p: string, body: object = {}) => who.agent.post(`/api/v1${p}`).set('X-CSRF-Token', who.csrf).send(body),
  get: (p: string) => who.agent.get(`/api/v1${p}`),
});
const byOwner = () => as(owner);
const bySup = () => as(sup);

let dayOffset = 40;
async function employee() {
  const emp = await createEmployee({ supervisorId: supId, workplaceId: base.workplaceId });
  await q(`INSERT INTO employee_shift_assignments (employee_id, shift_id, effective_from) VALUES ($1,$2,'2020-01-01')`, [emp.id, shiftId]);
  await q(`UPDATE employee_profiles SET joined_on = '2020-01-01' WHERE user_id = $1`, [emp.id]);
  return emp;
}
/** A finished, late shift with attendance. Each call uses a new date so totals can be read for that day alone. */
async function attended(employeeId: string, date = DateTime.utc().minus({ days: dayOffset++ }).toISODate()!) {
  const at = (t: string) => `${date}T${t}:00Z`;
  const s = await one(
    `INSERT INTO tracking_sessions (employee_id, shift_id, workplace_id, shift_date, scheduled_start_at, scheduled_end_at, state, started_at, ended_at, authorization_status)
     VALUES ($1,$2,$3,$4,$5,$6,'SHIFT_COMPLETED',$5,$6,'ENDED') RETURNING id`,
    [employeeId, shiftId, base.workplaceId, date, at('09:00'), at('17:00')],
  );
  const r = await one(
    `INSERT INTO attendance_records (employee_id, workplace_id, shift_id, session_id, shift_date, idempotency_key, radius_m_at_record, verification_status, recorded_at, is_late, late_by_minutes)
     VALUES ($1,$2,$3,$4,$5,$6,30,'VERIFIED',$7,true,30) RETURNING id`,
    [employeeId, base.workplaceId, shiftId, s.id, date, crypto.randomUUID(), at('09:30')],
  );
  return { date, sessionId: s.id as string, attendanceId: r.id as string };
}
async function overtime(a: Awaited<ReturnType<typeof attended>>, employeeId: string, status = 'APPROVED') {
  const minutes = status === 'APPROVED' ? 60 : null;
  return (await one(
    `INSERT INTO overtime_entries (session_id, attendance_id, employee_id, workplace_id, shift_date, started_at, ended_at, end_reason, start_latitude, start_longitude, start_accuracy_m, start_distance_m, status, approved_minutes, decided_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'EMPLOYEE',0,0,5,0,$8,$9,$10) RETURNING id`,
    [a.sessionId, a.attendanceId, employeeId, base.workplaceId, a.date, `${a.date}T17:00:00Z`, `${a.date}T18:00:00Z`, status, minutes, status === 'APPROVED' ? new Date() : null],
  )).id as string;
}
const record = (id: string) => one(`SELECT * FROM attendance_records WHERE id = $1`, [id]);
async function photo(employeeId: string, sessionId: string, opts: { pastDate?: boolean } = {}) {
  const key = `corr/${crypto.randomUUID()}.jpg`;
  await writeLocalObject(key, fakeJpeg());
  const p = await one(
    `INSERT INTO attendance_photos (employee_id, session_id, object_key, content_type, declared_bytes, idempotency_key, upload_expires_at, status, purpose, retention_until)
     VALUES ($1,$2,$3,'image/jpeg',100,$3,now(),'ATTACHED','ATTENDANCE',$4) RETURNING id`,
    [employeeId, sessionId, key, opts.pastDate ? DateTime.utc().minus({ days: 1 }).toISO() : DateTime.utc().plus({ days: 100 }).toISO()],
  );
  return { id: p.id as string, file: path.join(config.storage.localDir, key) };
}

describe('voided attendance stays as history and never counts', () => {
  let emp: { id: string; email: string };
  let a: Awaited<ReturnType<typeof attended>>;
  beforeAll(async () => {
    emp = await employee();
    a = await attended(emp.id);
    await overtime(a, emp.id);
  });
  const month = () => a.date.slice(0, 7);

  it('counts before the void, so the checks below prove something', async () => {
    const total = (await byOwner().get(`/overtime/summary?date=${a.date}`).expect(200)).body;
    expect(total.approved_minutes).toBe(60);
    const row = (await byOwner().get(`/reports/monthly?month=${month()}`).expect(200)).body.rows.find((r: any) => r.employee_id === emp.id);
    expect(row).toMatchObject({ present: 1, late: 1, overtime_minutes: 60 });
    expect(row.worked_minutes).toBeGreaterThan(0);
    const pay = (await byOwner().get(`/payroll/${month()}`).expect(200)).body.rows.find((r: any) => r.employee.id === emp.id);
    expect(pay.attendance).toMatchObject({ present: 1, overtimeMinutes: 60 });
  });

  it('leaves attendance, hours, lateness, overtime and pay, and the record stays', async () => {
    await byOwner().post(`/attendance/${a.attendanceId}/corrections`, { reason: 'Fraud confirmed', verificationStatus: 'VOIDED' }).expect(200);

    const row = (await byOwner().get(`/reports/monthly?month=${month()}`).expect(200)).body.rows.find((r: any) => r.employee_id === emp.id);
    expect(row).toMatchObject({ present: 0, late: 0, overtime_minutes: 0, worked_minutes: 0 });

    const summary = (await byOwner().get(`/overtime/summary?date=${a.date}`).expect(200)).body;
    expect(summary).toMatchObject({ approved_minutes: 0, claimed_minutes: 0, workers: 0 });
    expect(summary.byWorkplace).toHaveLength(0);

    const overview = (await byOwner().get(`/reports/overview?date=${a.date}`).expect(200)).body;
    expect(JSON.stringify(overview)).toContain('"overtimeApprovedTodayMinutes":0');

    const dash = (await byOwner().get(`/analytics/dashboard?from=${a.date}&to=${a.date}&employeeId=${emp.id}`).expect(200)).body;
    expect(dash.overtimeStatus.approved).toMatchObject({ count: 0, approvedMinutes: 0 });

    const list = (await byOwner().get(`/attendance?from=${a.date}&to=${a.date}&employeeId=${emp.id}`).expect(200)).body;
    expect(list.items[0].verification_status).toBe('VOIDED'); // still visible as history
    expect(list.summary).toMatchObject({ total: 1, late: 0 });

    const hours = (await byOwner().get(`/reports/hours?from=${a.date}&to=${a.date}&employeeId=${emp.id}`).expect(200)).body;
    expect(JSON.stringify(hours.rows ?? [])).not.toContain(emp.id);

    const pay = (await byOwner().get(`/payroll/${month()}`).expect(200)).body.rows.find((r: any) => r.employee.id === emp.id);
    expect(pay.attendance).toMatchObject({ present: 0, late: 0, workedMinutes: 0, overtimeMinutes: 0 });

    const token = await mobileLogin(app, emp.email);
    const mine = (await request(app).get(`/api/v1/overtime/mine?month=${month()}`).set({ Authorization: `Bearer ${token}` }).expect(200)).body;
    expect(mine.totals).toMatchObject({ approvedMinutes: 0, claimedMinutes: 0 });
    expect(mine.rows).toHaveLength(1); // the entry itself stays

    expect((await record(a.attendanceId)).verification_status).toBe('VOIDED');
    expect((await one(`SELECT status, approved_minutes FROM overtime_entries WHERE attendance_id = $1`, [a.attendanceId]))).toMatchObject({ status: 'APPROVED', approved_minutes: 60 });
    expect(await q(`SELECT 1 FROM review_requests WHERE attendance_id = $1 AND kind = 'ADMIN_CORRECTION'`, [a.attendanceId])).toHaveLength(1);
    expect(await q(`SELECT 1 FROM audit_logs WHERE action = 'attendance.correct' AND resource_id = $1`, [a.attendanceId])).toHaveLength(1);
  });

  it('waiting overtime on a voided shift leaves the queue and cannot be approved', async () => {
    const e = await employee();
    const s = await attended(e.id);
    const otId = await overtime(s, e.id, 'PENDING');
    const queue = async () => (await byOwner().get(`/overtime?status=PENDING&employeeId=${e.id}`).expect(200)).body;
    expect(await queue()).toHaveLength(1);
    await byOwner().post(`/attendance/${s.attendanceId}/corrections`, { reason: 'Not at work', verificationStatus: 'VOIDED' }).expect(200);
    expect(await queue()).toHaveLength(0);
    expect((await byOwner().post(`/overtime/${otId}/decision`, { decision: 'APPROVE' }).expect(409)).body.error.code).toBe('ATTENDANCE_VOIDED');
    expect((await byOwner().post('/overtime/decisions', { ids: [otId] }).expect(200)).body).toBeTruthy();
    expect((await one(`SELECT status FROM overtime_entries WHERE id = $1`, [otId])).status).toBe('PENDING');
    await byOwner().post(`/overtime/${otId}/decision`, { decision: 'REJECT', note: 'Shift voided' }).expect(200);
  });
});

describe('supervisor corrections', () => {
  it('need a reason', async () => {
    const e = await employee();
    const { attendanceId } = await attended(e.id);
    await bySup().post(`/attendance/${attendanceId}/corrections`, { isLate: false }).expect(400);
  });

  it('must change something', async () => {
    const e = await employee();
    const { attendanceId } = await attended(e.id);
    expect((await bySup().post(`/attendance/${attendanceId}/corrections`, { reason: 'Nothing in particular' }).expect(400)).body.error.code).toBe('NOTHING_TO_CORRECT');
  });

  it('change nothing until an owner approves, then keep the original and both names', async () => {
    const e = await employee();
    const { attendanceId, date } = await attended(e.id);
    const before = await record(attendanceId);

    const res = await bySup().post(`/attendance/${attendanceId}/corrections`, { reason: 'Bus strike that morning', recordedAt: `${date}T09:05:00Z` }).expect(202);
    expect(res.body.pending).toBe(true);
    expect(await record(attendanceId)).toEqual(before);
    const reviewId = res.body.review.id;
    expect(res.body.review).toMatchObject({ kind: 'ADMIN_CORRECTION', status: 'OPEN', requested_by: supId });
    expect(await q(`SELECT 1 FROM audit_logs WHERE action = 'attendance.correction_request' AND resource_id = $1 AND actor_id = $2`, [attendanceId, supId])).toHaveLength(1);

    // A second proposal cannot pile up, and a supervisor cannot approve one.
    expect((await bySup().post(`/attendance/${attendanceId}/corrections`, { reason: 'Second thoughts here', isLate: false }).expect(409)).body.error.code).toBe('CORRECTION_OPEN');
    expect((await bySup().post(`/attendance/reviews/${reviewId}/resolve`, { decision: 'APPROVE', note: 'Looks right' }).expect(403)).body.error.code).toBe('OWNER_ONLY');
    expect(await record(attendanceId)).toEqual(before);

    await byOwner().post(`/attendance/reviews/${reviewId}/resolve`, { decision: 'APPROVE', note: 'Checked the gate log' }).expect(200);
    const after = await record(attendanceId);
    expect(after.verification_status).toBe('CORRECTED');
    expect(new Date(after.recorded_at).toISOString()).toBe(`${date}T09:05:00.000Z`);
    expect(new Date(after.original_recorded_at).toISOString()).toBe(new Date(before.recorded_at).toISOString());
    expect(after.is_late).toBe(false);

    const review = await one(`SELECT * FROM review_requests WHERE id = $1`, [reviewId]);
    expect(review).toMatchObject({ status: 'APPLIED', requested_by: supId, resolved_by: base.adminId, resolution_note: 'Checked the gate log', reason: 'Bus strike that morning' });
    expect(review.before_data.verification_status).toBe('VERIFIED');
    expect(new Date(review.before_data.recorded_at).toISOString()).toBe(new Date(before.recorded_at).toISOString());
    expect(review.after_data.proposed.recordedAt).toBe(`${date}T09:05:00Z`);

    const log = await one(`SELECT actor_id, after_data FROM audit_logs WHERE action = 'attendance.correct' AND resource_id = $1`, [attendanceId]);
    expect(log.actor_id).toBe(base.adminId);
    expect(log.after_data).toMatchObject({ requestedBy: supId, approvedBy: base.adminId });

    const shown = (await byOwner().get(`/attendance/${attendanceId}`).expect(200)).body.history[0];
    expect(shown).toMatchObject({ requested_by_name: 'Site Supervisor', status: 'APPLIED' });
    expect(shown.resolved_by_name).toBeTruthy();
    await byOwner().post(`/attendance/reviews/${reviewId}/resolve`, { decision: 'APPROVE', note: 'Twice' }).expect(409);
  });

  it('rejected leaves the record exactly as it was and keeps the request', async () => {
    const e = await employee();
    const { attendanceId } = await attended(e.id);
    const before = await record(attendanceId);
    const { review } = (await bySup().post(`/attendance/${attendanceId}/corrections`, { reason: 'Please void this one', verificationStatus: 'VOIDED' }).expect(202)).body;
    await byOwner().post(`/attendance/reviews/${review.id}/resolve`, { decision: 'REJECT', note: 'Evidence is good' }).expect(200);
    expect(await record(attendanceId)).toEqual(before);
    expect(await one(`SELECT status, requested_by, resolved_by FROM review_requests WHERE id = $1`, [review.id])).toEqual({ status: 'REJECTED', requested_by: supId, resolved_by: base.adminId });
  });

  it('a supervisor can only propose a void, and an approved void cannot then be changed', async () => {
    const e = await employee();
    const { attendanceId } = await attended(e.id);
    const { review } = (await bySup().post(`/attendance/${attendanceId}/corrections`, { reason: 'Proxy attendance', verificationStatus: 'VOIDED' }).expect(202)).body;
    expect((await record(attendanceId)).verification_status).toBe('VERIFIED');
    await byOwner().post(`/attendance/reviews/${review.id}/resolve`, { decision: 'APPROVE', note: 'Agreed' }).expect(200);
    expect((await record(attendanceId)).verification_status).toBe('VOIDED');
    expect((await bySup().post(`/attendance/${attendanceId}/corrections`, { reason: 'Changed my mind', verificationStatus: 'VERIFIED' }).expect(409)).body.error.code).toBe('ATTENDANCE_VOIDED');
  });

  it('cannot be approved once the record has been voided another way', async () => {
    const e = await employee();
    const { attendanceId } = await attended(e.id);
    const { review } = (await bySup().post(`/attendance/${attendanceId}/corrections`, { reason: 'Time looks wrong', isLate: false }).expect(202)).body;
    await byOwner().post(`/attendance/${attendanceId}/corrections`, { reason: 'Fraud confirmed', verificationStatus: 'VOIDED' }).expect(200);
    expect((await byOwner().post(`/attendance/reviews/${review.id}/resolve`, { decision: 'APPROVE', note: 'Fine' }).expect(409)).body.error.code).toBe('ATTENDANCE_VOIDED');
    expect((await one(`SELECT status FROM review_requests WHERE id = $1`, [review.id])).status).toBe('OPEN');
  });

  it('a supervisor of another workplace cannot propose one', async () => {
    const e = await employee();
    const { attendanceId } = await attended(e.id);
    const other = await one(`INSERT INTO workplaces (name, latitude, longitude, radius_m, timezone, absence_threshold_minutes, org_id) VALUES ('Elsewhere', 1, 1, 100, 'UTC', 5, $1) RETURNING id`, [DEFAULT_ORG_ID]);
    await q(`UPDATE administrator_profiles SET site_ids = $2 WHERE user_id = $1`, [supId, [other.id]]);
    try {
      await bySup().post(`/attendance/${attendanceId}/corrections`, { reason: 'Not my site though', isLate: false }).expect(404);
    } finally {
      await q(`UPDATE administrator_profiles SET site_ids = $2 WHERE user_id = $1`, [supId, [base.workplaceId]]);
    }
  });

  it("an owner's own correction still applies at once, recorded as both requester and approver", async () => {
    const e = await employee();
    const { attendanceId } = await attended(e.id);
    await byOwner().post(`/attendance/${attendanceId}/corrections`, { reason: 'Known bus strike', isLate: false, lateByMinutes: 0 }).expect(200);
    expect((await record(attendanceId)).is_late).toBe(false);
    expect(await one(`SELECT status, requested_by, resolved_by FROM review_requests WHERE attendance_id = $1`, [attendanceId])).toEqual({ status: 'APPLIED', requested_by: base.adminId, resolved_by: base.adminId });
  });

  it('wait in the owner\'s approvals, not the supervisor\'s', async () => {
    const e = await employee();
    const { attendanceId } = await attended(e.id);
    const { review } = (await bySup().post(`/attendance/${attendanceId}/corrections`, { reason: 'Time looks wrong', isLate: false }).expect(202)).body;
    const owners = (await byOwner().get('/approvals').expect(200)).body;
    expect(owners.reviews.find((r: any) => r.id === review.id)).toMatchObject({ kind: 'ADMIN_CORRECTION', requested_by_name: 'Site Supervisor' });
    expect((await bySup().get('/approvals').expect(200)).body.reviews.find((r: any) => r.id === review.id)).toBeUndefined();
    await byOwner().post(`/attendance/reviews/${review.id}/resolve`, { decision: 'REJECT', note: 'Clearing this up' }).expect(200);
  });
});

describe('deleting a photo', () => {
  async function withPhoto() {
    const e = await employee();
    const a = await attended(e.id);
    const p = await photo(e.id, a.sessionId);
    await q(`UPDATE attendance_records SET photo_id = $2 WHERE id = $1`, [a.attendanceId, p.id]);
    return { ...a, ...p };
  }

  it('is refused for a supervisor, and the photo stays', async () => {
    const { attendanceId, id, file } = await withPhoto();
    expect((await bySup().post(`/attendance/${attendanceId}/photo/delete`, { reason: 'Blurry picture' }).expect(403)).body.error.code).toBe('OWNER_ONLY');
    expect((await one(`SELECT status FROM attendance_photos WHERE id = $1`, [id])).status).toBe('ATTACHED');
    expect(fs.existsSync(file)).toBe(true);
    expect(await q(`SELECT 1 FROM audit_logs WHERE action = 'attendance_photo.delete' AND resource_id = $1`, [id])).toHaveLength(0);
  });

  it('works for an owner with a reason, audited, and the record stays', async () => {
    const { attendanceId, id, file } = await withPhoto();
    await byOwner().post(`/attendance/${attendanceId}/photo/delete`, {}).expect(400);
    await byOwner().post(`/attendance/${attendanceId}/photo/delete`, { reason: 'Employee request, approved' }).expect(200);
    expect(await one(`SELECT status, deleted_reason FROM attendance_photos WHERE id = $1`, [id])).toEqual({ status: 'DELETED', deleted_reason: 'Employee request, approved' });
    expect(fs.existsSync(file)).toBe(false);
    const log = await one(`SELECT actor_id, reason, before_data FROM audit_logs WHERE action = 'attendance_photo.delete' AND resource_id = $1`, [id]);
    expect(log).toMatchObject({ actor_id: base.adminId, reason: 'Employee request, approved' });
    expect(log.before_data.attendanceId).toBe(attendanceId);
    expect(await record(attendanceId)).toBeTruthy();
  });
});

describe('photo retention', () => {
  async function expired() {
    const e = await employee();
    const a = await attended(e.id);
    return photo(e.id, a.sessionId, { pastDate: true });
  }
  const status = async (id: string) => (await one(`SELECT status FROM attendance_photos WHERE id = $1`, [id])).status;
  const retention = (photoAutoDelete: boolean) => saveSettingsSection(DEFAULT_ORG_ID, 'retention', { ...DEFAULT_SETTINGS.retention, photoAutoDelete }, null);
  const run = async () => {
    invalidateSettings();
    return (await runRetention(null, DEFAULT_ORG_ID))!;
  };

  it('by default deletes no photo, even past its date, and says how many are waiting', async () => {
    const p = await expired();
    const summary = await run();
    expect(summary.photosDeleted).toBe(0);
    expect(summary.photosHeld).toBeGreaterThanOrEqual(1);
    expect(await status(p.id)).toBe('ATTACHED');
    expect(fs.existsSync(p.file)).toBe(true);
  });

  it('keeps abandoned uploads too, since they can hold a real picture', async () => {
    const e = await employee();
    const a = await attended(e.id);
    const p = await photo(e.id, a.sessionId);
    await q(`UPDATE attendance_photos SET status = 'UPLOADED', created_at = now() - interval '3 days' WHERE id = $1`, [p.id]);
    await run();
    expect(await status(p.id)).toBe('UPLOADED');
    expect(fs.existsSync(p.file)).toBe(true);
  });

  it('the company choice alone is not enough', async () => {
    const p = await expired();
    await retention(true);
    expect((await run()).photosDeleted).toBe(0);
    expect(await status(p.id)).toBe('ATTACHED');
  });

  it('the server switch alone is not enough', async () => {
    const p = await expired();
    config.photoAutoDeleteEnabled = true;
    expect((await run()).photosDeleted).toBe(0);
    expect(await status(p.id)).toBe('ATTACHED');
  });

  it('both on delete only photos past their date', async () => {
    const p = await expired();
    const e = await employee();
    const a = await attended(e.id);
    const kept = await photo(e.id, a.sessionId);
    config.photoAutoDeleteEnabled = true;
    await retention(true);
    expect((await run()).photosDeleted).toBeGreaterThanOrEqual(1);
    expect(await status(p.id)).toBe('DELETED');
    expect(fs.existsSync(p.file)).toBe(false);
    expect(await status(kept.id)).toBe('ATTACHED');
  });

  it('is set per company by the owner: the period yes, deletion not while on hold', async () => {
    const put = (who: typeof owner, value: object) => who.agent.put('/api/v1/settings/retention').set('X-CSRF-Token', who.csrf).send({ value });
    await put(owner, { ...DEFAULT_SETTINGS.retention, photoDays: 365 }).expect(200);
    expect((await byOwner().get('/settings').expect(200)).body.settings.retention).toMatchObject({ photoDays: 365, photoAutoDelete: false });
    expect((await put(owner, { ...DEFAULT_SETTINGS.retention, photoAutoDelete: true }).expect(409)).body.error.code).toBe('PHOTO_DELETION_ON_HOLD');
    await put(sup, { ...DEFAULT_SETTINGS.retention, photoDays: 30 }).expect(403);
    config.photoAutoDeleteEnabled = true;
    await put(owner, { ...DEFAULT_SETTINGS.retention, photoAutoDelete: true }).expect(200);
  });

  it('does not stop location history being deleted', async () => {
    const e = await employee();
    const a = await attended(e.id);
    await q(
      `INSERT INTO location_updates (session_id, employee_id, client_event_id, latitude, longitude, accuracy_m, source, client_time, received_at, distance_m, classification, validation_status, workplace_config_version)
       VALUES ($1,$2,$3,1,1,5,'FOREGROUND',now(),now() - interval '400 days',0,'INSIDE','EVALUATED',1)`,
      [a.sessionId, e.id, crypto.randomUUID()],
    );
    expect((await run()).locationUpdatesDeleted).toBeGreaterThanOrEqual(1);
  });

  it('employees are told the truth about it', async () => {
    const e = await employee();
    const token = await mobileLogin(app, e.email);
    const notice = async () => (await request(app).get('/api/v1/me/privacy-notice').set({ Authorization: `Bearer ${token}` }).expect(200)).body;
    expect((await notice()).retention.photoAutoDelete).toBe(false);
    expect((await notice()).text).not.toContain('Raw location history and attendance photos are deleted automatically');
    config.photoAutoDeleteEnabled = true;
    await retention(true);
    invalidateSettings();
    expect((await notice()).retention.photoAutoDelete).toBe(true);
  });
});
