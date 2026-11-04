/**
 * Builds the sample company used for demos: 90 days of history ending today, in its OWN local
 * database (PG_DATABASE ending in "_demo", default geoattend_demo). Re-running drops and rebuilds it.
 *
 *   npm run demo:seed                          # live state built for 30 minutes from now
 *   DEMO_PRESENT_AT=15:30 npm run demo:seed    # live state built for 15:30 IST
 *
 * To look at it: set PG_DATABASE=geoattend_demo and DEMO_MODE=true in .env, restart, and sign in
 * as owner@sample.test (or sup1..5@sample.test, emp001..042@sample.test) with DEMO_PASSWORD.
 *
 * "Right now" is built around the presentation time P: exactly 14 people are rostered on the shifts
 * running at P — 11 checked in (2 of them outside the geofence, 1 whose phone goes quiet 11 minutes
 * before P), 1 on approved leave and 2 no-shows from the five chronic absentees. Shift sizes are
 * chosen from P so that this holds at any hour. Check-ins that fall between seeding and P are
 * written to a `sample_plan` table that the sample heartbeat (jobs/sample-heartbeat.ts) carries out
 * on time, so nothing is replayed from a fixed clock.
 *
 * Everything else comes from a fixed random seed. Names, places and records are invented; workspace
 * pins sit at area centres, not real premises. Refuses to run in production, on an external database,
 * or on a database not named *_demo. Rows are written in the same shape the app writes them, so every
 * page computes from them normally.
 */
import { DateTime } from 'luxon'; // reads no configuration, so a static import is fine

process.env.PG_DATABASE ||= 'geoattend_demo';

const { config } = await import('../src/config.js');
const { dropDatabase, ensureDatabase } = await import('../src/db/postgres.js');
const { closePool, initPool, q } = await import('../src/db/pool.js');
const { migrate } = await import('../src/db/migrate.js');
const { hashPassword } = await import('../src/lib/password.js');
const { DEFAULT_ORG_ID } = await import('../src/lib/tenancy.js');

if (!config.dbName.endsWith('_demo')) throw new Error(`Refusing to write sample data into "${config.dbName}": the database name must end in _demo.`);
if (config.isProduction) throw new Error('Refusing to build sample data with NODE_ENV=production.');
if (config.externalDatabaseUrl) throw new Error('Sample data is only built in the local built-in database (DATABASE_URL is set).');
if (!config.demoPassword) throw new Error('Set DEMO_PASSWORD in .env: it is the password of every sample login.');

const TZ = 'Asia/Kolkata';
const DAYS = 90;
const ORG = DEFAULT_ORG_ID;

// ── generator targets (tuned against `npm run demo:verify`) ─────────────────────────────────
/** Chance a rostered shift is missed: chronic absentees vs everyone else (Mondays ×1.3). */
const P_ABSENT_PROBLEM = 0.31;
const P_ABSENT = 0.05;
/** Chance of a late check-in before multipliers (Monday ×2, day after a night shift ×2.3, chronic ×1.6). */
const P_LATE_AT_8_NIGHT = 0.0843; // normalised below by the Night headcount, which depends on P
/** Chance a finished shift has no check-out. */
const P_MISSING_CHECKOUT = 0.057;

// ── deterministic randomness ───────────────────────────────────────────────────────────────
let seed = 0x6a7e2026;
const rand = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const int = (a: number, b: number) => a + Math.floor(rand() * (b - a + 1));
const chance = (p: number) => rand() < p;
const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!;
const normal = (mean: number, sd: number) => mean + sd * Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
const shuffle = <T,>(xs: readonly T[]) => {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
};
const uuid = () => {
  const h = Array.from({ length: 32 }, () => Math.floor(rand() * 16).toString(16)).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h[16]!, 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

// ── clock and presentation time ────────────────────────────────────────────────────────────
const iso = (d: DateTime) => d.toISODate()!;
const js = (d: DateTime) => d.toUTC().toJSDate();
const now = DateTime.now().setZone(TZ).startOf('second');
const today = now.startOf('day');
const first = today.minus({ days: DAYS - 1 });

let presentAt = now.plus({ minutes: 30 }).startOf('minute');
const presentArg = process.env.DEMO_PRESENT_AT?.trim();
if (presentArg) {
  const t = DateTime.fromFormat(presentArg, 'H:mm', { zone: TZ });
  if (!t.isValid) throw new Error(`DEMO_PRESENT_AT must be a time like 15:30 (IST), got "${presentArg}".`);
  presentAt = today.set({ hour: t.hour, minute: t.minute });
  if (presentAt < now.plus({ minutes: 2 })) presentAt = presentAt.plus({ days: 1 });
  if (presentAt.diff(now, 'hours').hours > 12) throw new Error(`DEMO_PRESENT_AT ${presentArg} has already passed today. Use a time later than ${now.toFormat('HH:mm')}.`);
}

// ── holidays and shifts ────────────────────────────────────────────────────────────────────
const HOLIDAYS = [
  { date: '2026-11-01', name: 'Kannada Rajyotsava' },
  { date: '2026-11-08', name: 'Deepavali' },
  { date: '2026-11-10', name: 'Balipadyami' },
];
const holidayDates = new Set(HOLIDAYS.map((h) => h.date));
/** Mon–Sat, except holidays. */
const works = (d: DateTime) => d.weekday !== 7 && !holidayDates.has(iso(d));

type ShiftKind = 'EARLY' | 'GENERAL' | 'EVENING' | 'NIGHT';
const KINDS: ShiftKind[] = ['EARLY', 'GENERAL', 'EVENING', 'NIGHT'];
const SHIFT_DEF: Record<ShiftKind, { name: string; start: string; end: string; grace: number; minutes: number }> = {
  EARLY: { name: 'Early', start: '06:00', end: '14:00', grace: 10, minutes: 480 },
  GENERAL: { name: 'General', start: '09:00', end: '18:00', grace: 10, minutes: 540 },
  EVENING: { name: 'Evening', start: '14:00', end: '22:00', grace: 10, minutes: 480 },
  NIGHT: { name: 'Night', start: '22:00', end: '06:00', grace: 15, minutes: 480 },
};
const instance = (kind: ShiftKind, date: DateTime) => {
  const [h, m] = SHIFT_DEF[kind].start.split(':').map(Number) as [number, number];
  const start = date.startOf('day').set({ hour: h, minute: m });
  return { start, end: start.plus({ minutes: SHIFT_DEF[kind].minutes }) };
};
/** Start date of the `kind` shift running at `t`, if one is (night shifts belong to the day they start). */
const runningAt = (kind: ShiftKind, t: DateTime) => {
  for (const date of [t.startOf('day'), t.startOf('day').minus({ days: 1 })]) {
    if (!works(date)) continue;
    const { start, end } = instance(kind, date);
    if (start <= t && t < end) return date;
  }
  return null;
};
const ACTIVE = KINDS.filter((k) => runningAt(k, presentAt));
/** Headcount per shift so that exactly 14 people are rostered on whatever is running at P. */
const COUNTS: Record<string, Record<ShiftKind, number>> = {
  EARLY: { EARLY: 14, GENERAL: 12, EVENING: 8, NIGHT: 8 },
  'EARLY,GENERAL': { EARLY: 7, GENERAL: 7, EVENING: 15, NIGHT: 13 },
  'GENERAL,EVENING': { EARLY: 15, GENERAL: 7, EVENING: 7, NIGHT: 13 },
  EVENING: { EARLY: 10, GENERAL: 10, EVENING: 14, NIGHT: 8 },
  NIGHT: { EARLY: 10, GENERAL: 10, EVENING: 8, NIGHT: 14 },
};
const counts = COUNTS[ACTIVE.join(',')];
if (!counts) throw new Error(`No shift runs at ${presentAt.toFormat('ccc d LLL HH:mm')} IST (Sunday or a holiday). Choose another DEMO_PRESENT_AT.`);
/** "Late after a night shift" weighs more when more people work nights; keep the overall rate steady. */
const P_LATE = (P_LATE_AT_8_NIGHT * (1 + (1.3 * 8) / 42)) / (1 + (1.3 * counts.NIGHT) / 42);

// ── database ───────────────────────────────────────────────────────────────────────────────
await ensureDatabase('postgres');
await dropDatabase(config.dbName);
const pool = initPool(await ensureDatabase());
await migrate(pool);

/** Multi-row insert in chunks. */
async function insert(table: string, rows: Record<string, unknown>[], suffix = '') {
  if (!rows.length) return;
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  for (let i = 0; i < rows.length; i += 400) {
    const chunk = rows.slice(i, i + 400);
    const params: unknown[] = [];
    const values = chunk.map((r) => `(${cols.map((c) => { params.push(r[c] ?? null); return `$${params.length}`; }).join(',')})`);
    await q(`INSERT INTO ${table} (${cols.join(',')}) VALUES ${values.join(',')} ${suffix}`, params);
  }
}

// ── company, workspaces, shifts ───────────────────────────────────────────────────────────
await q(`UPDATE organizations SET name = 'Sample company', phone = '+91 80 0000 0000' WHERE id = $1`, [ORG]);
const hash = await hashPassword(config.demoPassword);
// 8-hour shifts take a paid 30-minute meal break; the 9-hour General shift an unpaid lunch.
await insert('application_settings', [{
  org_id: ORG, key: 'breaks', value: JSON.stringify({ types: [
    { key: 'LUNCH', label: 'Lunch', paid: false, maxMinutes: 45 },
    { key: 'MEAL', label: 'Meal break', paid: true, maxMinutes: 30 },
    { key: 'TEA', label: 'Tea break', paid: true, maxMinutes: 15 },
  ] }),
}]);

const ownerId = uuid();
await insert('users', [{ id: ownerId, email: 'owner@sample.test', password_hash: hash, role: 'ADMIN', full_name: 'Rohan Mehta', org_id: ORG, created_at: js(first.minus({ days: 400 })) }]);
await insert('administrator_profiles', [{ user_id: ownerId, title: 'Operations Director', access: 'OWNER', site_ids: [] }]);

type Site = 'WF' | 'PE' | 'EC';
type Wp = { id: string; key: Site; name: string; address: string; lat: number; lng: number; minStaff: number };
const WPS: Wp[] = [
  { id: uuid(), key: 'WF', name: 'Whitefield HQ', address: 'Whitefield, Bengaluru (sample location)', lat: 12.969800, lng: 77.750000, minStaff: 12 },
  { id: uuid(), key: 'PE', name: 'Peenya Plant', address: 'Peenya Industrial Area, Bengaluru (sample location)', lat: 13.028500, lng: 77.519700, minStaff: 10 },
  { id: uuid(), key: 'EC', name: 'Electronic City Site', address: 'Electronic City Phase 1, Bengaluru (sample location)', lat: 12.845200, lng: 77.660200, minStaff: 8 },
];
await insert('workplaces', WPS.map((w) => ({
  id: w.id, name: w.name, address: w.address, latitude: w.lat, longitude: w.lng, radius_m: 100, timezone: TZ, default_grace_minutes: 10,
  absence_threshold_minutes: 15, created_by: ownerId, org_id: ORG, min_staff: w.minStaff, created_at: js(first.minus({ days: 380 })),
})));
const wpOf = (key: string) => WPS.find((w) => w.key === key)!;

const shiftId: Record<string, string> = {};
const shiftRows: Record<string, unknown>[] = [];
for (const w of WPS) {
  for (const k of KINDS) {
    if (k === 'NIGHT' && w.key === 'WF') continue; // offices: no night shift
    const d = SHIFT_DEF[k];
    shiftId[`${w.key}:${k}`] = uuid();
    shiftRows.push({ id: shiftId[`${w.key}:${k}`], workplace_id: w.id, name: d.name, start_time: d.start, end_time: d.end, timezone: TZ, days_of_week: [1, 2, 3, 4, 5, 6], arrival_grace_minutes: d.grace, absence_threshold_minutes: 15 });
  }
}
await insert('shifts', shiftRows);

// ── supervisors (admin logins; they do not check in) ───────────────────────────────────────
const SUPS = [
  { name: 'Kavitha Menon', sites: ['WF'] },
  { name: 'Arjun Nair', sites: ['WF', 'EC'] },
  { name: 'Suresh Gowda', sites: ['PE'] },
  { name: 'Farah Khan', sites: ['PE'] },
  { name: 'Deepak Joshi', sites: ['EC'] },
].map((s, i) => ({ ...s, id: uuid(), email: `sup${i + 1}@sample.test` }));
await insert('users', SUPS.map((s) => ({ id: s.id, email: s.email, password_hash: hash, role: 'ADMIN', full_name: s.name, org_id: ORG, created_at: js(first.minus({ days: 300 })) })));
await insert('administrator_profiles', SUPS.map((s) => ({ user_id: s.id, title: 'Supervisor', access: 'SUPERVISOR', site_ids: s.sites.map((k) => wpOf(k).id) })));

// ── employees: 18 Field Executives, 14 Technicians, 10 Housekeeping ────────────────────────
const NAMES = [
  'Ramesh Kumar', 'Lakshmi Narayanan', 'Mohammed Irfan', 'Priya Sharma', 'Venkatesh Rao', 'Anjali Desai', 'Sandeep Patil', 'Fathima Begum',
  'Naveen Reddy', 'Kiran Hegde', 'Sunita Yadav', 'Joseph D’Souza', 'Manjunath Shetty', 'Divya Krishnan', 'Abdul Rahman', 'Pooja Iyer',
  'Harish Gowda', 'Meenakshi Sundaram', 'Rahul Verma', 'Shabana Sheikh', 'Prakash Naik', 'Kavya Bhat', 'Ganesh Murthy', 'Rekha Pillai',
  'Imran Pasha', 'Sneha Kulkarni', 'Chandrashekar B', 'Asha Thomas', 'Vijay Anand', 'Nandini Rao', 'Ravi Teja', 'Bhavana Hegde',
  'Syed Mustafa', 'Geetha Ramesh', 'Arun Prasad', 'Mary George', 'Sachin Jadhav', 'Rukmini Devi', 'Tanveer Ahmed', 'Shilpa Gowda',
  'Mahesh Babu', 'Aparna Sen',
];
type Role = 'Field Executive' | 'Technician' | 'Housekeeping';
const STAFF: Array<{ wp: Site; role: Role }> = [];
const staff = (wp: Site, role: Role, n: number) => { for (let i = 0; i < n; i++) STAFF.push({ wp, role }); };
staff('WF', 'Field Executive', 8); staff('WF', 'Technician', 4); staff('WF', 'Housekeeping', 4); // Whitefield HQ (16)
staff('PE', 'Technician', 8); staff('PE', 'Field Executive', 4); staff('PE', 'Housekeeping', 2); // Peenya Plant (14)
staff('EC', 'Field Executive', 6); staff('EC', 'Technician', 2); staff('EC', 'Housekeeping', 4); // Electronic City Site (12)
if (STAFF.length !== 42) throw new Error(`plan has ${STAFF.length} employees`);

// Shift allocation. Six Peenya technicians rotate Night ↔ General week by week (3 + 3, so every week
// has the same headcount per shift). Everyone else holds one shift; the shifts running at P are filled
// first, round-robin across the three workspaces so the live map spans all of them.
type Slot = ShiftKind | 'ROTA_A' | 'ROTA_B';
const slot: Array<Slot | undefined> = new Array(42).fill(undefined);
const peTech = STAFF.map((s, i) => ({ ...s, i })).filter((s) => s.wp === 'PE' && s.role === 'Technician').map((s) => s.i);
peTech.slice(0, 3).forEach((i) => (slot[i] = 'ROTA_A'));
peTech.slice(3, 6).forEach((i) => (slot[i] = 'ROTA_B'));
const need: Record<ShiftKind, number> = { ...counts, NIGHT: counts.NIGHT - 3, GENERAL: counts.GENERAL - 3 };
const ROLE_PREF: Record<ShiftKind, Role[]> = {
  NIGHT: ['Technician', 'Housekeeping', 'Field Executive'],
  EARLY: ['Housekeeping', 'Technician', 'Field Executive'],
  EVENING: ['Technician', 'Field Executive', 'Housekeeping'],
  GENERAL: ['Field Executive', 'Technician', 'Housekeeping'],
};
const fill = (kind: ShiftKind) => {
  const sites: Site[] = kind === 'NIGHT' ? ['PE', 'EC'] : ['WF', 'PE', 'EC'];
  let n = need[kind];
  const takeFrom = (site: Site) => {
    const c = STAFF.map((s, i) => ({ ...s, i }))
      .filter((s) => s.wp === site && slot[s.i] === undefined)
      .sort((a, b) => ROLE_PREF[kind].indexOf(a.role) - ROLE_PREF[kind].indexOf(b.role) || a.i - b.i)[0];
    if (c) slot[c.i] = kind;
    return !!c;
  };
  while (n > 0) {
    let progress = false;
    for (const s of sites) if (n > 0 && takeFrom(s)) { n--; progress = true; }
    if (!progress) throw new Error(`not enough people for the ${kind} shift`);
  }
};
const order: ShiftKind[] = [...ACTIVE, ...(['NIGHT', 'EARLY', 'EVENING', 'GENERAL'] as ShiftKind[]).filter((k) => !ACTIVE.includes(k))];
for (const k of order) fill(k);
if (slot.some((s) => s === undefined)) throw new Error('shift allocation left someone without a shift');

type Emp = { wp: Site; role: Role; shift: Slot; i: number; id: string; code: string; name: string; email: string; supervisorId: string; joined: DateTime; device: string; platform: 'ios' | 'android'; model: string; salary: number };
const supFor = (wp: string, i: number) => {
  const own = SUPS.filter((s) => s.sites.includes(wp));
  return own[i % own.length]!.id;
};
const ANDROID_MODELS = ['Redmi Note 12', 'Redmi 12C', 'Samsung Galaxy M14', 'Samsung Galaxy A15', 'vivo Y16', 'realme C55', 'OPPO A17', 'POCO M6 Pro', 'Redmi Note 13'];
const EMPS: Emp[] = STAFF.map((p, i) => {
  const code = `EMP-${String(i + 1).padStart(3, '0')}`;
  // Two recent joiners (tenure cohort); everyone else predates the window.
  const joined = i === 40 || i === 41 ? today.minus({ days: 38 + i - 40 }) : first.minus({ days: int(30, 1400) }).startOf('day');
  const base = p.role === 'Technician' ? int(26, 45) : p.role === 'Field Executive' ? int(19, 34) : int(18, 22);
  const senior = joined < today.minus({ years: 3 }) ? int(4, 20) : 0;
  const platform = i % 6 === 0 ? 'ios' : 'android';
  return {
    ...p, shift: slot[i]!, i, id: uuid(), code, name: NAMES[i]!, email: `emp${String(i + 1).padStart(3, '0')}@sample.test`, supervisorId: supFor(p.wp, i), joined,
    device: `sample-${platform}-${uuid().slice(0, 8)}`, platform, model: platform === 'ios' ? pick(['iPhone 12', 'iPhone 13', 'iPhone SE']) : pick(ANDROID_MODELS),
    salary: Math.min(65, base + senior) * 1000,
  };
});
await insert('users', EMPS.map((e) => ({ id: e.id, email: e.email, password_hash: hash, role: 'EMPLOYEE', full_name: e.name, org_id: ORG, created_at: js(e.joined) })));
await insert('employee_profiles', EMPS.map((e) => ({
  user_id: e.id, employee_code: e.code, phone: `+91 90000 ${String(10000 + e.i * 37).slice(-5)}`, department: e.role === 'Housekeeping' ? 'Facilities' : e.role === 'Technician' ? 'Maintenance' : 'Field operations',
  designation: e.role, org_id: ORG, supervisor_id: e.supervisorId, created_at: js(e.joined),
})));
await insert('workplace_assignments', EMPS.map((e) => ({ id: uuid(), employee_id: e.id, workplace_id: wpOf(e.wp).id, effective_from: iso(e.joined), created_by: ownerId })));
await insert('employee_pay', EMPS.map((e) => ({ employee_id: e.id, pay_type: 'MONTHLY', amount: e.salary, ot_multiplier: e.wp === 'PE' ? 2 : 1.5, hours_per_day: 8, updated_by: ownerId })));
// One approved phone each; the newest joiner has just switched phones (waiting for approval).
const pendingDeviceId = uuid();
await insert('device_registrations', [
  ...EMPS.map((e) => ({
    id: uuid(), user_id: e.id, device_id: e.device, platform: e.platform, os_version: e.platform === 'ios' ? pick(['17.5', '17.6', '18.1']) : pick(['13', '14', '14', '15']),
    model: e.model, app_version: pick(['2.4.1', '2.4.1', '2.4.0', '2.3.7']), status: 'APPROVED', last_seen_at: js(now.minus({ minutes: int(1, 600) })), created_at: js(e.joined.plus({ days: 1 })),
  })),
  { id: pendingDeviceId, user_id: EMPS[40]!.id, device_id: `sample-android-${uuid().slice(0, 8)}`, platform: 'android', os_version: '14', model: 'Samsung Galaxy A15', app_version: '2.4.1', status: 'PENDING', last_seen_at: js(now.minus({ days: 6, hours: 3 })), created_at: js(now.minus({ days: 6, hours: 3 })) },
]);

// ── rosters: fixed shifts are one open-ended entry; rotating people one entry per week ─────
const weekStart = (d: DateTime) => d.startOf('week');
const rosterEnd = weekStart(today).plus({ days: 13 }); // through the end of next week
/** Night on even ISO weeks for group A, odd weeks for group B; General otherwise. */
const kindOn = (e: Emp, d: DateTime): ShiftKind => {
  if (e.shift !== 'ROTA_A' && e.shift !== 'ROTA_B') return e.shift;
  const even = d.weekNumber % 2 === 0;
  return (e.shift === 'ROTA_A') === even ? 'NIGHT' : 'GENERAL';
};
const rosterRows: Record<string, unknown>[] = [];
for (const e of EMPS) {
  const from = e.joined > first ? e.joined : first.minus({ days: 7 });
  if (e.shift !== 'ROTA_A' && e.shift !== 'ROTA_B') {
    rosterRows.push({ id: uuid(), employee_id: e.id, shift_id: shiftId[`${e.wp}:${e.shift}`], effective_from: iso(from), effective_to: null, created_by: e.supervisorId, manager_id: e.supervisorId });
    continue;
  }
  for (let w = weekStart(from); w <= rosterEnd; w = w.plus({ weeks: 1 })) {
    const start = w < from ? from : w;
    rosterRows.push({ id: uuid(), employee_id: e.id, shift_id: shiftId[`${e.wp}:${kindOn(e, w)}`], effective_from: iso(start), effective_to: iso(w.plus({ days: 6 })), created_by: e.supervisorId, manager_id: e.supervisorId, notes: kindOn(e, w) === 'NIGHT' ? 'Night rotation week' : null });
  }
}
await insert('employee_shift_assignments', rosterRows);

// ── who plays which part right now ─────────────────────────────────────────────────────────
/** People rostered on the shifts running at P, with the start date of that shift. */
const members = new Map<number, DateTime>();
for (const k of ACTIVE) {
  const date = runningAt(k, presentAt)!;
  for (const e of EMPS) if (kindOn(e, date) === k && date >= e.joined) members.set(e.i, date);
}
if (members.size !== 14) throw new Error(`expected 14 people on the shifts running at P, found ${members.size}`);
const inShift = shuffle([...members.keys()].filter((i) => i < 40)); // recent joiners keep a clean record
const PROBLEM_NOW = inShift.slice(0, 2); // chronic absentees who are no-shows today
const LEAVE_NOW = inShift[2]!;
const QUIET = inShift[3]!; // the phone that keeps dropping out — goes silent 11 min before P
const AWAY = inShift.slice(4, 6); // outside the geofence at P: one long errand, one just left
const rest = shuffle(EMPS.map((e) => e.i).filter((i) => !members.has(i) && i < 40));
const PROBLEM = new Set([...PROBLEM_NOW, ...rest.slice(0, 3)]);
/** Integrity story: mock location, rooted phone, check-ins hugging the boundary. */
const MOCK = rest[3]!, ROOTED = rest[4]!, BOUNDARY = rest[5]!;
const FLAKY = QUIET;
const key = (i: number, d: DateTime) => `${i}|${iso(d)}`;
const forced = new Map<string, 'NOSHOW' | 'PRESENT'>();
for (const [i, d] of members) if (i !== LEAVE_NOW) forced.set(key(i, d), PROBLEM_NOW.includes(i) ? 'NOSHOW' : 'PRESENT');
const special = new Set([QUIET, ...AWAY]);

// ── holidays and leave ─────────────────────────────────────────────────────────────────────
await insert('holidays', HOLIDAYS.map((h) => ({ id: uuid(), workplace_id: null, holiday_date: h.date, name: h.name, created_by: ownerId, org_id: ORG })));

type Leave = { emp: Emp; from: DateTime; to: DateTime; type: string; status: 'APPROVED' | 'PENDING'; reason: string };
const leaveDay = members.get(LEAVE_NOW)!;
const LEAVES: Leave[] = [
  { emp: EMPS[2]!, from: today.minus({ days: 61 }), to: today.minus({ days: 59 }), type: 'CASUAL', status: 'APPROVED', reason: 'Family function in Mysuru' },
  { emp: EMPS[9]!, from: today.minus({ days: 47 }), to: today.minus({ days: 46 }), type: 'SICK', status: 'APPROVED', reason: 'Fever, doctor advised rest' },
  { emp: EMPS[17]!, from: today.minus({ days: 33 }), to: today.minus({ days: 29 }), type: 'EARNED', status: 'APPROVED', reason: 'Native place visit for Dasara' },
  { emp: EMPS[24]!, from: today.minus({ days: 20 }), to: today.minus({ days: 20 }), type: 'CASUAL', status: 'APPROVED', reason: 'Bank and property registration work' },
  { emp: EMPS[35]!, from: today.minus({ days: 12 }), to: today.minus({ days: 10 }), type: 'SICK', status: 'APPROVED', reason: 'Viral infection' },
  { emp: EMPS[LEAVE_NOW]!, from: leaveDay, to: leaveDay, type: 'CASUAL', status: 'APPROVED', reason: 'Child’s school admission' },
  { emp: EMPS[14]!, from: today.plus({ days: 4 }), to: today.plus({ days: 6 }), type: 'EARNED', status: 'APPROVED', reason: 'Deepavali with family' },
  { emp: EMPS[28]!, from: today.plus({ days: 9 }), to: today.plus({ days: 10 }), type: 'CASUAL', status: 'APPROVED', reason: 'Sister’s wedding' },
  { emp: EMPS[3]!, from: today.plus({ days: 3 }), to: today.plus({ days: 3 }), type: 'CASUAL', status: 'PENDING', reason: 'Personal work' },
  { emp: EMPS[20]!, from: today.plus({ days: 7 }), to: today.plus({ days: 8 }), type: 'SICK', status: 'PENDING', reason: 'Scheduled minor procedure' },
  { emp: EMPS[33]!, from: today.plus({ days: 12 }), to: today.plus({ days: 16 }), type: 'EARNED', status: 'PENDING', reason: 'Travel to hometown' },
];
const leaveIds = LEAVES.map(() => uuid());
const leaveCreated = LEAVES.map((l) => DateTime.min(now.minus({ hours: 2 }), l.from.minus({ days: int(3, 9) }).set({ hour: 10 })));
await insert('leave_requests', LEAVES.map((l, n) => ({
  id: leaveIds[n], employee_id: l.emp.id, leave_type: l.type, start_date: iso(l.from), end_date: iso(l.to), reason: l.reason, status: l.status, requested_by: l.emp.id,
  decided_by: l.status === 'APPROVED' ? l.emp.supervisorId : null, decided_at: l.status === 'APPROVED' ? js(DateTime.min(now.minus({ hours: 1 }), DateTime.max(leaveCreated[n]!.plus({ hours: 3 }), l.from.minus({ days: int(2, 6) }).set({ hour: 11 })))) : null,
  decision_note: l.status === 'APPROVED' ? 'Approved' : null, created_at: js(leaveCreated[n]!), updated_at: js(DateTime.min(now, l.from.minus({ days: 2 }))),
})));
const onLeave = (e: Emp, d: DateTime) => LEAVES.some((l) => l.emp === e && l.status === 'APPROVED' && d >= l.from && d <= l.to);

// ── shifts worked ──────────────────────────────────────────────────────────────────────────
const sessions: Record<string, unknown>[] = [];
const records: Record<string, unknown>[] = [];
const locations: Record<string, unknown>[] = [];
const breaks: Record<string, unknown>[] = [];
const absences: Record<string, unknown>[] = [];
const geoEvents: Record<string, unknown>[] = [];
/** Check-ins due after seeding, carried out by the sample heartbeat when their time comes. */
const plan: Record<string, unknown>[] = [];
/** `dedupe`: the key the app's own job would use, so the job sees the alert as already raised. */
type Note = { type: string; severity: 'INFO' | 'WARNING' | 'CRITICAL'; title: string; body: string; emp: Emp; at: DateTime; session?: string; dedupe?: string };
const notes: Note[] = [];
type Done = { emp: Emp; session: string; record: string; shiftDate: string; end: DateTime; kind: ShiftKind; normalEnd: boolean; wpLat: number; wpLng: number };
const doneShifts: Done[] = [];
type Worked = { emp: Emp; session: string; record: string; date: string; recorded: DateTime; late: number; flags: string[]; dist: number };
const worked: Worked[] = [];
/** The live instances of the people on shift at P: either a session written now, or a plan row. */
const liveRef = new Map<number, { session: Record<string, unknown> | null; planRow: Record<string, unknown> | null; recorded: DateTime }>();
/** Per-day counts for the Daily close snapshots. */
const perDay = new Map<string, { scheduled: number; present: number; late: number; absent: number; onLeave: number; holiday: number; leftEarly: number; overtimeMinutes: number }>();
const day = (date: string) => perDay.get(date) ?? perDay.set(date, { scheduled: 0, present: 0, late: 0, absent: 0, onLeave: 0, holiday: 0, leftEarly: 0, overtimeMinutes: 0 }).get(date)!;

const M_PER_DEG_LAT = 111_320;
const offset = (lat: number, lng: number, metres: number) => {
  const a = rand() * 2 * Math.PI;
  return { lat: lat + (metres * Math.cos(a)) / M_PER_DEG_LAT, lng: lng + (metres * Math.sin(a)) / (M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180)) };
};
const workedNight = new Set<string>(); // `${emp}|${date}` of night shifts worked
const BETA = EMPS.map(() => [rand(), rand(), rand()]);
const horizon = now.plus({ hours: 24 });

for (let d = first; d <= today.plus({ days: 1 }); d = d.plus({ days: 1 })) {
  const date = iso(d);
  if (!works(d)) continue; // weekly off / holiday
  // Low-discrepancy draws: per person, day n uses frac(n·α + β) with a random start β. Each person's
  // absences, late arrivals and missing check-outs then match their rates over ANY window (the
  // Overview's 14 days included) instead of clumping, whichever presentation time we build for.
  const n = Math.round(d.diff(first, 'days').days);
  const weyl = (alpha: number, beta: number) => (n * alpha + beta) % 1;
  const uAbsent = EMPS.map((e) => weyl(0.6180339887, BETA[e.i]![0]!));
  const uLate = EMPS.map((e) => weyl(0.4142135624, BETA[e.i]![1]!));
  const uMissing = EMPS.map((e) => weyl(0.7320508076, BETA[e.i]![2]!));
  for (const e of EMPS) {
    if (d < e.joined) continue;
    const kind = kindOn(e, d);
    const def = SHIFT_DEF[kind];
    const { start, end } = instance(kind, d);
    if (start > horizon) continue;
    const started = start <= now;
    if (onLeave(e, d)) { if (started) day(date).onLeave++; continue; }
    const wp = wpOf(e.wp);
    const sid = shiftId[`${e.wp}:${kind}`]!;
    const problem = PROBLEM.has(e.i);
    const monday = d.weekday === 1;
    const afterNight = workedNight.has(`${e.id}|${iso(d.minus({ days: 1 }))}`) || (d.weekday === 1 && workedNight.has(`${e.id}|${iso(d.minus({ days: 2 }))}`));
    const force = forced.get(key(e.i, d));

    // Absent: five chronic absentees carry a large share; Mondays are worse. Today is an ordinary day:
    // the only no-shows come from the chronic group (2 on the shifts running at P, at most a few more).
    const pAbsent = start >= today ? (problem ? 0.3 : 0) : (problem ? P_ABSENT_PROBLEM : P_ABSENT) * (monday ? 1.3 : 1);
    const absent = force ? force === 'NOSHOW' : uAbsent[e.i]! < pAbsent;
    if (absent) {
      // A no-show only counts once the shift has been running for 15 minutes (the app works this out live).
      if (start.plus({ minutes: 15 }) <= now) {
        day(date).scheduled++;
        day(date).absent++;
        notes.push({ type: 'NO_SHOW', severity: 'WARNING', title: 'Shift not started', body: `${e.name} has not started the ${def.name} shift at ${wp.name} (${def.start}).`, emp: e, at: start.plus({ minutes: 15 }), dedupe: d >= today.minus({ days: 1 }) ? `no-show:${e.id}:${sid}:${date}` : undefined }); // the job looks back one day
      }
      continue;
    }

    // Arrival: usually a few minutes early; late more often on Mondays and after a night shift.
    const pLate = P_LATE * (monday ? 2 : 1) * (afterNight ? 2.3 : 1) * (problem ? 1.6 : 1);
    let arriveMin = uLate[e.i]! < pLate ? def.grace + 1 + Math.min(95, Math.round(-Math.log(1 - rand()) * 11)) : Math.max(-25, Math.min(def.grace - 1, Math.round(normal(-7, 4))));
    // People on shift at P must have arrived by then (the three with a part to play, well before).
    if (force) arriveMin = Math.min(arriveMin, Math.floor(presentAt.diff(start, 'minutes').minutes) - (special.has(e.i) ? 8 : 2));
    const isLate = arriveMin > def.grace;
    const recorded = start.plus({ minutes: arriveMin, seconds: int(0, 59) });

    // Evidence: inside the 100 m circle with ordinary phone accuracy.
    const boundary = e.i === BOUNDARY && d > today.minus({ days: 30 }) && chance(0.3);
    const accuracy = Math.round(boundary ? int(6, 9) : Math.max(5, normal(16, 7)));
    const dist = boundary ? 92 + rand() * 4 : Math.min(100 - accuracy / 2 - 1, Math.abs(normal(0, 28)));
    const ev = offset(wp.lat, wp.lng, dist);
    const battery = Math.round(Math.max(0.12, Math.min(1, normal(0.68, 0.18))) * 100) / 100;
    const session = uuid();
    const record = uuid();

    if (recorded > now) {
      // Not arrived yet: the heartbeat checks them in at `recorded`.
      const row = {
        session_id: session, record_id: record, employee_id: e.id, shift_id: sid, workplace_id: wp.id, shift_date: date, scheduled_start_at: js(start), scheduled_end_at: js(end),
        arrive_at: js(recorded), late_by: isLate ? arriveMin : 0, device_id: e.device, platform: e.platform, background_permission: e.i === FLAKY ? 'denied' : 'granted', battery,
        latitude: ev.lat, longitude: ev.lng, accuracy_m: accuracy, distance_m: dist, employee_name: e.name, workplace_name: wp.name, shift_name: def.name, arrived: false,
      };
      plan.push(row);
      if (members.get(e.i)?.equals(d)) liveRef.set(e.i, { session: null, planRow: row, recorded });
      continue;
    }

    day(date).scheduled++;
    day(date).present++;
    if (isLate) day(date).late++;
    const open = end > now;
    // How the shift ended.
    const missing = !open && uMissing[e.i]! < (problem ? 0.1 : P_MISSING_CHECKOUT);
    const leftEarly = !open && !missing && chance(0.035);
    const ended = open ? null : missing ? end.plus({ minutes: 30 }) : leftEarly ? end.minus({ minutes: int(20, 80) }) : end.plus({ minutes: int(0, 16) });
    if (leftEarly) day(date).leftEarly++;

    const flags: string[] = [];
    // Fixed days (not chance) so the integrity story is always there: ~4 fake-GPS check-ins, ~3 from a rooted phone.
    const ago = Math.round(today.diff(d, 'days').days);
    if (e.i === MOCK && ago > 0 && ago < 30 && ago % 7 === 2) flags.push('MOCK_LOCATION_REPORTED');
    if (e.i === ROOTED && ago > 0 && ago < 21 && ago % 6 === 4) flags.push('ROOTED_DEVICE');
    if (flags.includes('MOCK_LOCATION_REPORTED') && d > today.minus({ days: 14 })) {
      notes.push({ type: 'MOCK_LOCATION_FLAGGED', severity: 'CRITICAL', title: 'Mock location reported', body: `${e.name}'s phone reported a mock (simulated) location at check-in. Review the attendance record.`, emp: e, at: recorded, session });
    }

    const s: Record<string, unknown> = {
      id: session, employee_id: e.id, shift_id: sid, workplace_id: wp.id, shift_date: date, scheduled_start_at: js(start), scheduled_end_at: js(end),
      state: open ? 'PRESENT' : 'SHIFT_COMPLETED', state_changed_at: js(open ? recorded : ended!), authorization_status: open ? 'AUTHORIZED' : missing ? 'EXPIRED' : 'ENDED',
      termination_reason: open ? null : missing ? 'shift window ended' : null, started_at: js(recorded.minus({ minutes: int(3, 12) })), ended_at: ended ? js(ended) : null, device_id: e.device,
      foreground_permission: 'granted', background_permission: e.i === FLAKY ? 'denied' : 'granted', location_services_enabled: true,
      last_location_at: js(open ? now.minus({ seconds: int(8, 50) }) : ended!.minus({ minutes: 1 })), last_location_client_at: js(open ? now.minus({ seconds: int(10, 55) }) : ended!.minus({ minutes: 1 })),
      last_latitude: ev.lat, last_longitude: ev.lng, last_accuracy_m: accuracy, last_distance_m: dist, last_classification: 'INSIDE', last_is_mocked: flags.includes('MOCK_LOCATION_REPORTED'),
      last_battery_level: battery, last_battery_charging: chance(0.15), last_network: chance(0.8) ? 'cellular' : 'wifi', last_device_status_at: js(open ? now.minus({ minutes: 2 }) : ended!),
      created_at: js(recorded.minus({ minutes: 12 })), updated_at: js(ended ?? now),
    };
    sessions.push(s);
    records.push({
      id: record, employee_id: e.id, workplace_id: wp.id, shift_id: sid, session_id: session, shift_date: date, recorded_at: js(recorded), idempotency_key: `sample:${record}`,
      evidence_latitude: ev.lat, evidence_longitude: ev.lng, evidence_accuracy_m: accuracy, evidence_distance_m: dist, evidence_client_time: js(recorded.minus({ seconds: int(2, 20) })),
      radius_m_at_record: 100, is_late: isLate, late_by_minutes: isLate ? arriveMin : 0, verification_status: 'VERIFIED', risk_flags: flags,
      device_meta: JSON.stringify({ platform: e.platform, model: e.model, isPhysicalDevice: true, isRooted: flags.includes('ROOTED_DEVICE') }),
      face_status: 'NO_PHOTO', created_at: js(recorded), updated_at: js(recorded),
    });
    worked.push({ emp: e, session, record, date, recorded, late: isLate ? arriveMin : 0, flags, dist });
    if (members.get(e.i)?.equals(d)) liveRef.set(e.i, { session: s, planRow: null, recorded });
    if (isLate && d > today.minus({ days: 14 })) {
      notes.push({ type: 'LATE_ARRIVAL', severity: 'WARNING', title: 'Late arrival', body: `${e.name} marked attendance ${arriveMin} min after the ${def.name} shift start at ${wp.name}.`, emp: e, at: recorded, session });
    }
    if (d > today.minus({ days: 30 })) geoEvents.push({ employee_id: e.id, workplace_id: wp.id, session_id: session, event_type: 'ENTRY_VERIFIED', event_time: js(recorded.minus({ seconds: 20 })), latitude: ev.lat, longitude: ev.lng, accuracy_m: accuracy, distance_m: dist, created_at: js(recorded.minus({ seconds: 20 })) });

    // Location history: approach, arrival, during the shift, leaving.
    const trail = [
      { at: recorded.minus({ minutes: int(3, 12) }), m: int(160, 420), cls: 'OUTSIDE' },
      { at: recorded.minus({ seconds: 20 }), m: dist, cls: 'INSIDE' },
      { at: start.plus({ minutes: Math.round(def.minutes / 3) }), m: Math.abs(normal(0, 30)), cls: 'INSIDE' },
      { at: start.plus({ minutes: Math.round((def.minutes * 2) / 3) }), m: Math.abs(normal(0, 30)), cls: 'INSIDE' },
    ].filter((p) => p.at <= now && p.at >= recorded.minus({ minutes: 15 }));
    if (ended) trail.push({ at: ended.minus({ minutes: 1 }), m: Math.abs(normal(20, 25)), cls: 'INSIDE' });
    for (const p of trail) {
      const pos = offset(wp.lat, wp.lng, Math.min(p.m, p.cls === 'INSIDE' ? 95 : 2000));
      locations.push({ session_id: session, employee_id: e.id, client_event_id: uuid(), latitude: pos.lat, longitude: pos.lng, accuracy_m: Math.max(5, Math.round(normal(15, 6))), is_mocked: flags.includes('MOCK_LOCATION_REPORTED'), source: 'BACKGROUND', client_time: js(p.at), received_at: js(p.at.plus({ seconds: 3 })), distance_m: p.m, classification: p.cls, validation_status: 'EVALUATED', workplace_config_version: 1 });
    }

    // Breaks. General (9 h): unpaid lunch, the main reason its hours sit just above 8. Others (8 h): a
    // paid 30-minute meal. Only breaks already over are written, so no break is left running forever.
    const general = kind === 'GENERAL';
    const mealAt = start.plus({ minutes: general ? int(225, 260) : int(230, 250) });
    const mealLen = general ? int(35, 55) : int(24, 31);
    const mealEnd = mealAt.plus({ minutes: mealLen });
    if (mealEnd < now && (!ended || mealEnd < ended)) {
      const maxMin = general ? 45 : 30;
      breaks.push({ id: uuid(), session_id: session, employee_id: e.id, workplace_id: wp.id, type_key: general ? 'LUNCH' : 'MEAL', type_label: general ? 'Lunch' : 'Meal break', paid: !general, max_minutes: maxMin, started_at: js(mealAt), start_latitude: ev.lat, start_longitude: ev.lng, start_accuracy_m: accuracy, start_distance_m: dist, ended_at: js(mealEnd), end_reason: 'EMPLOYEE', overdue_at: mealLen > maxMin ? js(mealAt.plus({ minutes: maxMin })) : null, created_at: js(mealAt) });
      if (mealLen > maxMin + 5 && d > today.minus({ days: 14 })) notes.push({ type: 'BREAK_OVERDUE', severity: 'WARNING', title: 'Break overdue', body: `${e.name}'s ${general ? 'lunch' : 'meal break'} at ${wp.name} ran ${mealLen - maxMin} min over.`, emp: e, at: mealAt.plus({ minutes: maxMin }), session });
    }
    if (chance(0.4)) {
      const teaAt = start.plus({ minutes: int(100, 140) });
      if (teaAt.plus({ minutes: 15 }) < now && (!ended || teaAt < ended)) breaks.push({ id: uuid(), session_id: session, employee_id: e.id, workplace_id: wp.id, type_key: 'TEA', type_label: 'Tea break', paid: true, max_minutes: 15, started_at: js(teaAt), start_latitude: ev.lat, start_longitude: ev.lng, start_accuracy_m: accuracy, start_distance_m: dist, ended_at: js(teaAt.plus({ minutes: int(8, 14) })), end_reason: 'EMPLOYEE', created_at: js(teaAt) });
    }

    // Time away from the site during some shifts; a few become prolonged absences.
    if (!open && chance(0.07)) {
      const away = start.plus({ minutes: int(300, 420) });
      const len = chance(0.15) ? int(18, 40) : int(6, 14);
      const back = away.plus({ minutes: len });
      if (!ended || back < ended) {
        const pos = offset(wp.lat, wp.lng, int(180, 600));
        absences.push({ id: uuid(), session_id: session, employee_id: e.id, workplace_id: wp.id, started_at: js(away), verified_at: js(away.plus({ minutes: 1 })), ended_at: js(back), threshold_minutes: 15, prolonged_at: len >= 15 ? js(away.plus({ minutes: 15 })) : null, status: 'RETURNED', last_known_latitude: pos.lat, last_known_longitude: pos.lng, last_known_at: js(back.minus({ minutes: 1 })), created_at: js(away) });
        if (d > today.minus({ days: 30 })) {
          geoEvents.push({ employee_id: e.id, workplace_id: wp.id, session_id: session, event_type: 'EXIT_VERIFIED', event_time: js(away.plus({ minutes: 1 })), latitude: pos.lat, longitude: pos.lng, accuracy_m: 14, distance_m: 250, created_at: js(away.plus({ minutes: 1 })) });
          geoEvents.push({ employee_id: e.id, workplace_id: wp.id, session_id: session, event_type: 'RETURN_VERIFIED', event_time: js(back), latitude: ev.lat, longitude: ev.lng, accuracy_m: 12, distance_m: dist, created_at: js(back) });
        }
        if (d > today.minus({ days: 14 })) {
          if (len >= 15) notes.push({ type: 'PROLONGED_ABSENCE', severity: 'CRITICAL', title: 'Prolonged absence', body: `${e.name} has been away from ${wp.name} for more than 15 minutes.`, emp: e, at: away.plus({ minutes: 15 }), session });
          else notes.push({ type: 'GEOFENCE_EXIT', severity: 'INFO', title: 'Left the workplace area', body: `${e.name} left ${wp.name} during the shift.`, emp: e, at: away, session });
          notes.push({ type: 'RETURNED', severity: 'INFO', title: 'Returned', body: `${e.name} is back at ${wp.name} after ${len} min.`, emp: e, at: back, session });
        }
      }
    }
    if (e.i === FLAKY && d > today.minus({ days: 14 }) && d < today && chance(0.5)) {
      notes.push({ type: 'TRACKING_INTERRUPTED', severity: 'WARNING', title: 'Tracking interrupted', body: `${e.name}'s phone (${e.model}) stopped sending location for over 5 minutes. Battery optimisation may be closing the app.`, emp: e, at: start.plus({ minutes: int(60, 300) }), session });
    }
    if (d > today.minus({ days: 14 }) && chance(0.12)) {
      notes.push({ type: 'ATTENDANCE_MARKED', severity: 'INFO', title: 'Attendance marked', body: `${e.name} marked attendance at ${wp.name}.`, emp: e, at: recorded, session });
    }
    if (!open && !missing && d > today.minus({ days: 14 }) && chance(0.06)) {
      notes.push({ type: 'SHIFT_COMPLETED', severity: 'INFO', title: 'Shift completed', body: `${e.name} checked out of the ${def.name} shift at ${wp.name}.`, emp: e, at: ended!, session });
    }
    if (kind === 'NIGHT') workedNight.add(`${e.id}|${date}`);
    if (!open) doneShifts.push({ emp: e, session, record, shiftDate: date, end, kind, normalEnd: !missing && !leftEarly, wpLat: wp.lat, wpLng: wp.lng });
  }
}

// ── right now: two outside the geofence at P, one phone going quiet 11 minutes before P ────
const planFor = (i: number) => {
  const ref = liveRef.get(i);
  if (!ref) throw new Error(`no live shift for ${EMPS[i]!.name}`);
  if (ref.planRow) return ref.planRow;
  const s = ref.session!;
  const row: Record<string, unknown> = {
    session_id: s.id, record_id: uuid(), employee_id: s.employee_id, shift_id: s.shift_id, workplace_id: s.workplace_id, shift_date: s.shift_date,
    scheduled_start_at: s.scheduled_start_at, scheduled_end_at: s.scheduled_end_at, arrive_at: js(ref.recorded), late_by: 0, device_id: s.device_id, platform: EMPS[i]!.platform,
    background_permission: s.background_permission, battery: s.last_battery_level, latitude: s.last_latitude, longitude: s.last_longitude, accuracy_m: s.last_accuracy_m,
    distance_m: s.last_distance_m, employee_name: EMPS[i]!.name, workplace_name: wpOf(EMPS[i]!.wp).name, shift_name: '', arrived: true,
  };
  ref.planRow = row;
  plan.push(row);
  return row;
};
for (const [n, i] of AWAY.entries()) {
  const ref = liveRef.get(i)!;
  const e = EMPS[i]!;
  const wp = wpOf(e.wp);
  const wantAt = presentAt.minus({ minutes: n === 0 ? 28 : 6 });
  const awayAt = DateTime.max(wantAt, ref.recorded.plus({ minutes: 5 }));
  const m = n === 0 ? int(320, 480) : int(170, 260);
  const pos = offset(wp.lat, wp.lng, m);
  if (awayAt <= now && ref.session) {
    Object.assign(ref.session, { state: 'TEMPORARILY_AWAY', state_changed_at: js(awayAt), last_latitude: pos.lat, last_longitude: pos.lng, last_distance_m: m, last_classification: 'OUTSIDE' });
    absences.push({ id: uuid(), session_id: ref.session.id, employee_id: e.id, workplace_id: wp.id, started_at: js(awayAt), verified_at: js(awayAt.plus({ minutes: 1 })), ended_at: null, threshold_minutes: 15, prolonged_at: null, status: 'OPEN', last_known_latitude: pos.lat, last_known_longitude: pos.lng, last_known_at: js(now.minus({ seconds: 30 })), created_at: js(awayAt) });
    notes.push({ type: 'GEOFENCE_EXIT', severity: 'INFO', title: 'Left the workplace area', body: `${e.name} left ${wp.name} during the shift.`, emp: e, at: awayAt, session: ref.session.id as string });
  } else {
    Object.assign(planFor(i), { away_at: js(awayAt), away_latitude: pos.lat, away_longitude: pos.lng, away_m: m });
  }
}
{
  const ref = liveRef.get(QUIET)!;
  const quietAt = DateTime.max(presentAt.minus({ minutes: 11 }), ref.recorded.plus({ minutes: 3 }));
  if (quietAt <= now && ref.session) {
    // The ":quiet" device suffix tells the heartbeat to leave this phone silent.
    Object.assign(ref.session, { device_id: `${ref.session.device_id}:quiet`, last_location_at: js(quietAt), last_location_client_at: js(quietAt.minus({ seconds: 4 })), last_battery_level: 0.09 });
  } else {
    Object.assign(planFor(QUIET), { quiet_at: js(quietAt) });
  }
}

// ── overtime: 38 approved, 6 waiting, 2 rejected — after General shifts that ended normally ─
const otPool = doneShifts.filter((x) => x.kind === 'GENERAL' && x.normalEnd && x.shiftDate >= iso(today.minus({ days: 60 })) && x.shiftDate < iso(today));
const otRows: Record<string, unknown>[] = [];
const recent = otPool.filter((x) => x.shiftDate >= iso(today.minus({ days: 4 })));
const older = otPool.filter((x) => x.shiftDate < iso(today.minus({ days: 4 })));
const used = new Set<string>();
const take = (from: Done[]) => {
  for (let tries = 0; tries < 500; tries++) {
    const x = pick(from);
    if (!used.has(x.session)) { used.add(x.session); return x; }
  }
  throw new Error('not enough shifts for overtime');
};
const OT_NOTES = ['Pending installation at client site', 'Month-end stock audit', 'Breakdown repair on line 2', 'Client visit ran late', 'Deep cleaning before inspection', 'Generator maintenance', 'Urgent service call'];
const otPlan: Array<'APPROVED' | 'PENDING' | 'REJECTED'> = [...Array(38).fill('APPROVED'), ...Array(6).fill('PENDING'), ...Array(2).fill('REJECTED')];
const otDecisions: Array<{ by: string; at: DateTime; id: string; status: string }> = [];
for (const status of otPlan) {
  const x = take(status === 'PENDING' ? recent : older);
  const startedOt = x.end.plus({ minutes: int(1, 4) });
  const claimed = Math.round(Math.min(170, 40 + -Math.log(1 - rand()) * 55));
  const endedOt = startedOt.plus({ minutes: claimed });
  const s = sessions.find((y) => y.id === x.session)!;
  Object.assign(s, { ended_at: js(endedOt), state_changed_at: js(endedOt), updated_at: js(endedOt) });
  const decider = x.emp.supervisorId;
  const id = uuid();
  const decidedAt = endedOt.plus({ hours: int(14, 30) });
  otRows.push({
    id, session_id: x.session, attendance_id: x.record, employee_id: x.emp.id, workplace_id: wpOf(x.emp.wp).id, shift_date: x.shiftDate, note: pick(OT_NOTES),
    started_at: js(startedOt), start_latitude: x.wpLat, start_longitude: x.wpLng, start_accuracy_m: 12, start_distance_m: int(5, 40), ended_at: js(endedOt), end_reason: 'EMPLOYEE',
    start_face_status: 'NO_PHOTO', status, approved_minutes: status === 'APPROVED' ? Math.max(15, Math.floor(claimed / 15) * 15) : null,
    decided_by: status === 'PENDING' ? null : decider, decided_at: status === 'PENDING' ? null : js(decidedAt),
    decision_note: status === 'REJECTED' ? 'Not pre-approved; work could wait until the next shift' : null, created_at: js(startedOt),
  });
  if (status !== 'PENDING') otDecisions.push({ by: decider, at: decidedAt, id, status });
  if (status === 'APPROVED') day(x.shiftDate).overtimeMinutes += Math.max(15, Math.floor(claimed / 15) * 15);
  if (status === 'PENDING') notes.push({ type: 'OVERTIME_ENDED', severity: 'INFO', title: 'Overtime waiting for approval', body: `${x.emp.name} worked ${claimed} min of overtime after the General shift. Approve or reject it on the Overtime page.`, emp: x.emp, at: endedOt });
  if (status !== 'PENDING' && decidedAt > now.minus({ days: 14 }) && decidedAt < now) notes.push({ type: 'OVERTIME_DECIDED', severity: 'INFO', title: `Overtime ${status === 'APPROVED' ? 'approved' : 'rejected'}`, body: `${x.emp.name}'s overtime on ${DateTime.fromISO(x.shiftDate).toFormat('d LLL')} was ${status.toLowerCase()}.`, emp: x.emp, at: decidedAt });
}

// ── location integrity: reviews and disputes ───────────────────────────────────────────────
const reviews: Record<string, unknown>[] = [];
const recordById = new Map(records.map((r) => [r.id as string, r]));
const mockRecs = worked.filter((w) => w.flags.includes('MOCK_LOCATION_REPORTED')).sort((a, b) => a.date.localeCompare(b.date));
for (const [n, w] of mockRecs.entries()) {
  const latest = n >= mockRecs.length - 2;
  const createdAt = w.recorded.plus({ minutes: 2 });
  const sup = w.emp.supervisorId;
  if (!latest) Object.assign(recordById.get(w.record)!, { verification_status: 'VOIDED', updated_at: js(createdAt.plus({ days: 1 })) });
  reviews.push({
    id: uuid(), kind: 'MANUAL_REVIEW', employee_id: w.emp.id, session_id: w.session, attendance_id: w.record, reason: 'Mock (simulated) location reported by the phone at check-in.',
    status: latest ? 'OPEN' : 'REJECTED', requested_by: w.emp.id, resolved_by: latest ? null : sup, resolved_at: latest ? null : js(createdAt.plus({ days: 1 })),
    resolution_note: latest ? null : 'Not on site per supervisor; attendance voided and employee counselled.', created_at: js(createdAt),
  });
  if (latest) notes.push({ type: 'MANUAL_REVIEW_REQUESTED', severity: 'WARNING', title: 'Attendance needs review', body: `${w.emp.name}'s check-in was flagged for a mock location and needs a decision.`, emp: w.emp, at: createdAt, session: w.session });
}
for (const w of worked.filter((x) => x.flags.includes('ROOTED_DEVICE'))) {
  Object.assign(recordById.get(w.record)!, { verification_status: 'MANUAL_APPROVED' });
  reviews.push({ id: uuid(), kind: 'MANUAL_REVIEW', employee_id: w.emp.id, session_id: w.session, attendance_id: w.record, reason: 'Check-in from a rooted phone.', status: 'APPROVED', requested_by: w.emp.id, resolved_by: w.emp.supervisorId, resolved_at: js(w.recorded.plus({ hours: 5 })), resolution_note: 'Seen on site by supervisor. Personal phone; asked to switch to a company handset.', created_at: js(w.recorded.plus({ minutes: 1 })) });
}
const lastBoundary = worked.filter((w) => w.emp.i === BOUNDARY && w.dist > 90).at(-1);
if (lastBoundary) reviews.push({ id: uuid(), kind: 'MANUAL_REVIEW', employee_id: lastBoundary.emp.id, session_id: lastBoundary.session, attendance_id: lastBoundary.record, reason: 'Check-ins repeatedly land at the edge of the geofence (92–96 m of 100 m).', status: 'OPEN', requested_by: ownerId, created_at: js(lastBoundary.recorded.plus({ hours: 2 })) });
const disputed = worked.filter((w) => w.late > 15 && !PROBLEM.has(w.emp.i) && w.date >= iso(today.minus({ days: 6 })) && w.date < iso(today)).at(-1);
if (disputed) {
  reviews.push({ id: uuid(), kind: 'DISPUTE', employee_id: disputed.emp.id, session_id: disputed.session, attendance_id: disputed.record, reason: 'BMTC bus broke down on Hosur Road; I informed my supervisor by phone at 8:50. Please excuse the late mark.', status: 'OPEN', requested_by: disputed.emp.id, created_at: js(disputed.recorded.plus({ hours: 3 })) });
  notes.push({ type: 'MANUAL_REVIEW_REQUESTED', severity: 'INFO', title: 'Late mark disputed', body: `${disputed.emp.name} disputed a late arrival on ${DateTime.fromISO(disputed.date).toFormat('d LLL')}.`, emp: disputed.emp, at: disputed.recorded.plus({ hours: 3 }), session: disputed.session });
}
const flakyLast = worked.filter((w) => w.emp.i === FLAKY && w.date < iso(today)).at(-1);
if (flakyLast) {
  reviews.push({ id: uuid(), kind: 'TECHNICAL_ISSUE', employee_id: flakyLast.emp.id, session_id: flakyLast.session, attendance_id: null, reason: `The app stops tracking when the screen locks (${EMPS[FLAKY]!.model}).`, status: 'ACKNOWLEDGED', requested_by: flakyLast.emp.id, resolved_by: flakyLast.emp.supervisorId, resolved_at: js(flakyLast.recorded.plus({ hours: 6 })), resolution_note: 'Asked to turn off battery optimisation for GeoAttend; will check again next week.', created_at: js(flakyLast.recorded.plus({ hours: 4 })) });
  notes.push({ type: 'TECHNICAL_ISSUE_REPORTED', severity: 'WARNING', title: 'Technical issue reported', body: `${flakyLast.emp.name}: the app stops tracking when the screen locks.`, emp: flakyLast.emp, at: flakyLast.recorded.plus({ hours: 4 }), session: flakyLast.session });
  notes.push({ type: 'BACKGROUND_UNAVAILABLE', severity: 'WARNING', title: 'Background location off', body: `${flakyLast.emp.name}'s phone does not allow location in the background, so tracking stops when the app is closed.`, emp: flakyLast.emp, at: flakyLast.recorded.plus({ minutes: 3 }), session: flakyLast.session });
}

await insert('tracking_sessions', sessions);
await insert('attendance_records', records);
await insert('location_updates', locations);
await insert('session_breaks', breaks);
await insert('absence_intervals', absences);
await insert('overtime_entries', otRows);
await insert('review_requests', reviews);
await insert('geofence_events', geoEvents);

// ── the heartbeat's to-do list for check-ins and moments still to come ─────────────────────
await q(`CREATE TABLE sample_plan (
  session_id UUID PRIMARY KEY, record_id UUID NOT NULL, employee_id UUID NOT NULL, shift_id UUID NOT NULL, workplace_id UUID NOT NULL, shift_date DATE NOT NULL,
  scheduled_start_at TIMESTAMPTZ NOT NULL, scheduled_end_at TIMESTAMPTZ NOT NULL, arrive_at TIMESTAMPTZ NOT NULL, late_by INT NOT NULL DEFAULT 0,
  device_id TEXT NOT NULL, platform TEXT, background_permission TEXT, battery REAL,
  latitude DOUBLE PRECISION, longitude DOUBLE PRECISION, accuracy_m REAL, distance_m REAL,
  away_at TIMESTAMPTZ, away_latitude DOUBLE PRECISION, away_longitude DOUBLE PRECISION, away_m REAL, quiet_at TIMESTAMPTZ,
  employee_name TEXT, workplace_name TEXT, shift_name TEXT,
  arrived BOOLEAN NOT NULL DEFAULT false, away_done BOOLEAN NOT NULL DEFAULT false, quiet_done BOOLEAN NOT NULL DEFAULT false)`);
const PLAN_COLS = ['session_id', 'record_id', 'employee_id', 'shift_id', 'workplace_id', 'shift_date', 'scheduled_start_at', 'scheduled_end_at', 'arrive_at', 'late_by', 'device_id', 'platform', 'background_permission', 'battery', 'latitude', 'longitude', 'accuracy_m', 'distance_m', 'away_at', 'away_latitude', 'away_longitude', 'away_m', 'quiet_at', 'employee_name', 'workplace_name', 'shift_name', 'arrived'];
await insert('sample_plan', plan.map((r) => Object.fromEntries(PLAN_COLS.map((c) => [c, r[c] ?? null]))));
await q(`CREATE TABLE sample_meta (seeded_at TIMESTAMPTZ NOT NULL, present_at TIMESTAMPTZ NOT NULL, owner_id UUID NOT NULL, problem_ids UUID[] NOT NULL)`);
await insert('sample_meta', [{ seeded_at: js(now), present_at: js(presentAt), owner_id: ownerId, problem_ids: [...PROBLEM].map((i) => EMPS[i]!.id) }]);

// ── announcements ──────────────────────────────────────────────────────────────────────────
const activeEmps = (site: Site | null) => EMPS.filter((e) => !site || e.wp === site);
const BROADCASTS = [
  { site: 'PE' as Site, title: 'Safety shoes and helmets are mandatory on the shop floor', body: 'From Monday, nobody enters Line 1 or Line 2 at Peenya Plant without safety shoes and a helmet. Collect yours from the stores counter (Farah) if you do not have one.', daysAgo: 21, pinned: true, readRate: 0.95, by: SUPS[3]!.id },
  { site: 'WF' as Site, title: 'New uniforms: collect by Friday', body: 'Winter uniforms have arrived. Please collect yours from the admin desk at Whitefield HQ by Friday, 6 pm. Bring your employee ID.', daysAgo: 9, pinned: false, readRate: 0.81, by: SUPS[0]!.id },
  { site: null, title: 'Deepavali and Balipadyami holidays', body: 'Sunday 8 November (Deepavali) and Tuesday 10 November (Balipadyami) are company holidays. Night shift on 9 November ends at 6 am as usual. Wishing you and your families a happy Deepavali!', daysAgo: 4, pinned: false, readRate: 0.74, by: ownerId },
  { site: 'PE' as Site, title: 'Night rotation changes next week', body: 'Rotation groups A and B swap next Monday as planned. Please check your roster in the app and speak to Suresh if you have a clash.', daysAgo: 1, pinned: false, readRate: 0.46, by: SUPS[2]!.id },
];
const bRows: Record<string, unknown>[] = [];
const bRecipients: Record<string, unknown>[] = [];
const bIds: string[] = [];
for (const b of BROADCASTS) {
  const id = uuid();
  bIds.push(id);
  const at = now.minus({ days: b.daysAgo }).set({ hour: int(9, 11), minute: int(0, 59) });
  const people = activeEmps(b.site);
  bRows.push({ id, org_id: ORG, workplace_id: b.site ? wpOf(b.site).id : null, title: b.title, body: b.body, recipients: people.length, created_by: b.by, pinned: b.pinned, created_at: js(at) });
  for (const p of people) bRecipients.push({ broadcast_id: id, employee_id: p.id, read_at: chance(b.readRate) ? js(DateTime.min(now, at.plus({ minutes: int(5, 60 * 30) }))) : null });
}
await insert('broadcasts', bRows);
await insert('broadcast_recipients', bRecipients);

// ── notifications: a mixed feed over the last 14 days, no single type above ~20% ───────────
for (const l of LEAVES.filter((x) => x.status === 'PENDING')) notes.push({ type: 'LEAVE_REQUESTED', severity: 'INFO', title: 'Leave requested', body: `${l.emp.name} asked for ${l.type.toLowerCase()} leave from ${l.from.toFormat('d LLL')} to ${l.to.toFormat('d LLL')}.`, emp: l.emp, at: now.minus({ hours: int(3, 40) }) });
for (const l of LEAVES.filter((x) => x.status === 'APPROVED')) {
  const at = l.from.minus({ days: int(2, 6) }).set({ hour: 11 });
  if (at > now.minus({ days: 14 }) && at < now) notes.push({ type: 'LEAVE_DECIDED', severity: 'INFO', title: 'Leave approved', body: `${l.emp.name}'s ${l.type.toLowerCase()} leave for ${l.from.toFormat('d LLL')} was approved.`, emp: l.emp, at });
}
notes.push({ type: 'NEW_DEVICE', severity: 'WARNING', title: 'New phone', body: `${EMPS[40]!.name} signed in from a new phone. Approve it in Employees › Devices.`, emp: EMPS[40]!, at: now.minus({ days: 6, hours: 3 }) });
// Backup-approver escalations (jobs/escalation.ts): raised once, 24 h after a request was left waiting.
const overdue = (kind: string, id: string, emp: Emp, created: DateTime, what: string) => {
  const at = created.plus({ hours: 24, minutes: 1 });
  if (at <= now) notes.push({ type: 'APPROVAL_OVERDUE', severity: 'WARNING', title: 'Approval waiting over a day', body: `${emp.name}'s ${what} has been waiting 24 hours for a decision. Open Approvals to answer it.`, emp, at, dedupe: `overdue:${kind}:${id}` });
};
LEAVES.forEach((l, n) => { if (l.status === 'PENDING') overdue('leave', leaveIds[n]!, l.emp, leaveCreated[n]!, 'leave request'); });
for (const r of reviews.filter((x) => x.status === 'OPEN')) {
  const emp = EMPS.find((e) => e.id === r.employee_id)!;
  overdue('review', r.id as string, emp, DateTime.fromJSDate(r.created_at as Date).setZone(TZ), r.kind === 'DISPUTE' ? 'attendance dispute' : 'request to be marked present');
}
overdue('device', pendingDeviceId, EMPS[40]!, now.minus({ days: 6, hours: 3 }), 'new phone');
const since = now.minus({ days: 14 });
const feed = notes.filter((n) => (n.at >= since || n.dedupe) && n.at <= now).sort((a, b) => b.at.toMillis() - a.at.toMillis());
const CAP_PER_TYPE = 18;
const perType = new Map<string, number>();
const kept = feed.filter((n) => {
  if (n.dedupe) return true; // the app's jobs would raise these again if missing
  const c = perType.get(n.type) ?? 0;
  // Newest first: once a type has CAP_PER_TYPE notes, older ones of that type are left out.
  if (c >= CAP_PER_TYPE) return false;
  perType.set(n.type, c + 1);
  return true;
});
// An API already running against this database keeps working while it is rebuilt, and its jobs can
// raise alerts from half-built data (e.g. no-shows for shifts whose check-ins are not written yet).
// Drop whatever they wrote; the feed below is complete, and carries the jobs' dedupe keys.
await q(`DELETE FROM notifications WHERE created_at > $1`, [js(now)]);
await insert('notifications', kept.map((n) => ({
  id: uuid(), type: n.type, audience: 'ADMIN', severity: n.severity, title: n.title, body: n.body, employee_id: n.emp.id, workplace_id: wpOf(n.emp.wp).id,
  session_id: n.session ?? null, data: JSON.stringify({}), dedupe_key: n.dedupe ?? null, org_id: ORG, created_at: js(n.at),
})), 'ON CONFLICT (dedupe_key) DO NOTHING');

// ── Daily close: every past working day confirmed except the last two ──────────────────────
const closeRows: Record<string, unknown>[] = [];
const workDays: string[] = [];
for (let d = first; d < today; d = d.plus({ days: 1 })) if (works(d)) workDays.push(iso(d));
for (const date of workDays.slice(0, -2)) {
  closeRows.push({ org_id: ORG, close_date: date, closed_by: ownerId, closed_at: js(DateTime.fromISO(date, { zone: TZ }).plus({ days: 1, hours: 10, minutes: int(0, 50) })), note: null, summary: JSON.stringify({ date, counts: day(date), toDecide: [] }) });
}
await insert('day_closes', closeRows);

// ── payroll: September and October paid; November open with a few adjustments ─────────────
const thisMonth = today.startOf('month');
const months = [thisMonth.minus({ months: 2 }), thisMonth.minus({ months: 1 })].filter((m) => m >= first); // whole months of history only
const ym = (m: DateTime) => m.toFormat('yyyy-MM');
const fieldExecs = EMPS.filter((e) => e.role === 'Field Executive');
const ADJ: Array<{ e: Emp; month: DateTime; kind: string; amount: number; note: string }> = [
  { e: EMPS[6]!, month: thisMonth.minus({ months: 1 }), kind: 'ADVANCE', amount: 5000, note: 'Salary advance — medical expense' },
  { e: EMPS[23]!, month: thisMonth.minus({ months: 1 }), kind: 'ADVANCE', amount: 3000, note: 'Salary advance' },
  ...fieldExecs.slice(0, 4).map((e) => ({ e, month: thisMonth.minus({ months: 1 }), kind: 'ALLOWANCE', amount: 1500, note: 'Travel allowance — client visits' })),
  { e: EMPS[12]!, month: thisMonth.minus({ months: 1 }), kind: 'DEDUCTION', amount: 750, note: 'Lost ID card replacement' },
  { e: EMPS[1]!, month: thisMonth.minus({ months: 2 }), kind: 'BONUS', amount: 2000, note: 'Spot award — plant audit' },
  { e: EMPS[6]!, month: thisMonth, kind: 'DEDUCTION', amount: 2500, note: 'Advance recovery (1 of 2)' },
  { e: EMPS[23]!, month: thisMonth, kind: 'DEDUCTION', amount: 3000, note: 'Advance recovery' },
];
await insert('pay_adjustments', ADJ.map((a) => ({ id: uuid(), employee_id: a.e.id, month: ym(a.month), kind: a.kind, amount: a.amount, note: a.note, created_by: ownerId, created_at: js(DateTime.max(a.month.plus({ days: int(3, 20) }), first)) })));
const { computeMonth } = await import('../src/modules/payroll/payroll.routes.js');
const runs: Array<{ id: string; month: string; total: number; at: DateTime; paidAt: DateTime }> = [];
for (const m of months) {
  const rows = (await computeMonth(ORG, ym(m))).filter((r) => r.result);
  const total = rows.reduce((n, r) => n + r.result!.net, 0);
  const id = uuid();
  const approvedAt = m.plus({ months: 1, days: int(1, 3) }).set({ hour: 16 });
  const paidAt = approvedAt.plus({ days: int(1, 3) }).set({ hour: 11 });
  await insert('payroll_runs', [{ id, org_id: ORG, month: ym(m), status: 'PAID', total_net: total, employees: rows.length, approved_by: ownerId, approved_at: js(approvedAt), paid_at: js(paidAt) }]);
  await insert('payslips', rows.map((r) => ({ id: uuid(), run_id: id, employee_id: r.employee.id, month: ym(m), net_amount: r.result!.net, data: JSON.stringify({ ...r, companyName: 'Sample company', month: ym(m) }), created_at: js(approvedAt) })));
  runs.push({ id, month: ym(m), total, at: approvedAt, paidAt });
}

// ── audit log: what people did over the period (append-only table) ────────────────────────
const audits: Record<string, unknown>[] = [];
const auditRow = (actor: string, role: 'ADMIN' | 'EMPLOYEE', action: string, type: string, id: string | null, at: DateTime, after?: unknown) => {
  if (at > now) return;
  audits.push({ actor_id: actor, actor_role: role, action, resource_type: type, resource_id: id, after_data: after === undefined ? null : JSON.stringify(after), ip: `10.20.${int(1, 9)}.${int(10, 250)}`, user_agent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0', org_id: ORG, created_at: js(at) });
};
for (let d = first; d <= today; d = d.plus({ days: 1 })) {
  if (!works(d)) continue;
  if (chance(0.55)) auditRow(ownerId, 'ADMIN', 'auth.login', 'user', ownerId, d.set({ hour: 9, minute: int(5, 50) }));
  for (const s of SUPS) if (chance(0.3)) auditRow(s.id, 'ADMIN', 'auth.login', 'user', s.id, d.set({ hour: int(6, 9), minute: int(0, 59) }));
}
for (const c of closeRows) auditRow(ownerId, 'ADMIN', 'day.close', 'day_close', c.close_date as string, DateTime.fromJSDate(c.closed_at as Date).setZone(TZ), { date: c.close_date });
for (const [n, l] of LEAVES.entries()) {
  auditRow(l.emp.id, 'EMPLOYEE', 'leave.request', 'leave_request', leaveIds[n]!, leaveCreated[n]!, { type: l.type, from: iso(l.from), to: iso(l.to) });
}
for (const o of otDecisions) auditRow(o.by, 'ADMIN', 'overtime.approve_bulk', 'overtime_entry', o.id, o.at, { status: o.status, count: 1 });
for (let w = weekStart(first).plus({ weeks: 1 }); w <= weekStart(today); w = w.plus({ weeks: 1 })) {
  auditRow(SUPS[2]!.id, 'ADMIN', 'roster.bulk_assign', 'employee_shift_assignment', null, w.minus({ days: 2 }).set({ hour: 17, minute: int(0, 40) }), { week: iso(w), employees: 6, note: 'Night rotation' });
}
for (let k = 0; k < 14; k++) auditRow(pick([ownerId, ownerId, SUPS[0]!.id, SUPS[2]!.id]), 'ADMIN', 'report.export', 'report', pick(['attendance', 'hours', 'overtime', 'monthly-summary']), now.minus({ days: int(1, 88), hours: int(0, 6) }), { format: 'csv' });
for (const r of runs) {
  auditRow(ownerId, 'ADMIN', 'payroll.approve', 'payroll_run', r.id, r.at, { month: r.month, totalNet: r.total });
  auditRow(ownerId, 'ADMIN', 'payroll.paid', 'payroll_run', r.id, r.paidAt, { month: r.month });
}
for (const a of ADJ) auditRow(ownerId, 'ADMIN', 'payroll.adjustment', 'pay_adjustment', null, DateTime.max(a.month.plus({ days: 5 }), first), { employee: a.e.code, kind: a.kind, amount: a.amount });
for (const [n, b] of BROADCASTS.entries()) auditRow(b.by, 'ADMIN', 'broadcast.send', 'broadcast', bIds[n]!, DateTime.fromJSDate(bRows[n]!.created_at as Date).setZone(TZ), { title: b.title });
auditRow(ownerId, 'ADMIN', 'holiday.create', 'holiday', null, first.plus({ days: 2 }).set({ hour: 12 }), { name: 'Balipadyami', date: '2026-11-10' });
for (const r of reviews.filter((x) => x.resolved_by)) auditRow(r.resolved_by as string, 'ADMIN', 'attendance.correct', 'attendance_record', (r.attendance_id as string) ?? null, DateTime.fromJSDate(r.resolved_at as Date).setZone(TZ), { review: r.status, note: r.resolution_note });
audits.sort((a, b) => (a.created_at as Date).getTime() - (b.created_at as Date).getTime());
await insert('audit_logs', audits);

await closePool();

const live = [...members.keys()].filter((i) => i !== LEAVE_NOW && !PROBLEM_NOW.includes(i));
const bySite = (is: number[]) => WPS.map((w) => `${w.name} ${is.filter((i) => EMPS[i]!.wp === w.key).length}`).join(' · ');
console.log(`Sample company built in "${config.dbName}" — today ${iso(today)}, seeded ${now.toFormat('HH:mm')} IST, live state built for ${presentAt.toFormat('ccc HH:mm')} IST
  ${EMPS.length} employees, ${SUPS.length} supervisors, ${WPS.length} workspaces, ${shiftRows.length} shifts · headcount Early ${counts.EARLY} / General ${counts.GENERAL} / Evening ${counts.EVENING} / Night ${counts.NIGHT}
  at ${presentAt.toFormat('HH:mm')}: ${ACTIVE.map((k) => SHIFT_DEF[k].name).join(' + ')} running — ${live.length} on shift (${bySite(live)}), 2 outside the geofence, 1 phone silent since ${presentAt.minus({ minutes: 11 }).toFormat('HH:mm')}
  no-shows today: ${PROBLEM_NOW.map((i) => EMPS[i]!.name).join(', ')} · on leave today: ${EMPS[LEAVE_NOW]!.name} · quiet phone: ${EMPS[QUIET]!.name} · outside: ${AWAY.map((i) => EMPS[i]!.name).join(', ')}
  chronic absentees: ${[...PROBLEM].map((i) => `${EMPS[i]!.name} (${EMPS[i]!.code})`).join(', ')}
  ${plan.filter((p) => !p.arrived).length} check-ins scheduled for the heartbeat · overtime ${otRows.length} · leave ${LEAVES.length} · reviews ${reviews.length} · notifications ${kept.length} · audit ${audits.length} · payroll runs ${runs.map((r) => r.month).join(', ')}
Run "npm run demo:verify" for the measured rates.`);
