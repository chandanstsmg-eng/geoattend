'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { NOTIFICATION_LABELS, NOTIFICATION_TYPES } from '@geoattend/shared';
import { api, get, post, put } from '@/lib/api';
import { Badge, Button, Card, ConfirmButton, Field, InlineError, Input, PageHeader, QueryState, Select, Tabs, Textarea } from '@/components/ui';
import { mapsConfigured } from '@/components/maps/google';
import { AlertTriangle, CheckCircle2, MinusCircle, ShieldAlert } from 'lucide-react';

const TRACKING_FIELDS: Array<[string, string, string]> = [
  ['updateIntervalSec', 'Location update interval (s)', 'How often the app reports while on shift. Lower = fresher data, more battery.'],
  ['distanceFilterM', 'Minimum movement between updates (m)', 'Keep 0: with a movement filter a stationary phone stops reporting and is shown as interrupted.'],
  ['maxAccuracyM', 'Worst acceptable GPS accuracy (m)', 'Readings less accurate than this can never unlock attendance or record an exit.'],
  ['boundaryFactor', 'Boundary safety factor (× accuracy)', 'Inside only if distance + factor × accuracy ≤ radius.'],
  ['exitHysteresisM', 'Exit hysteresis (m)', 'Extra distance beyond the radius needed to count as having left.'],
  ['entryStabilizationSec', 'Entry stabilisation (s)', 'Time the employee must stay inside before attendance unlocks.'],
  ['entryMinReadings', 'Entry: minimum inside readings', ''],
  ['exitStabilizationSec', 'Exit stabilisation (s)', 'Time outside before a departure is recorded.'],
  ['exitMinReadings', 'Exit: minimum outside readings', ''],
  ['returnStabilizationSec', 'Return stabilisation (s)', ''],
  ['returnMinReadings', 'Return: minimum inside readings', ''],
  ['staleAfterSec', 'Mark tracking interrupted after (s)', 'No update for this long → TRACKING_INTERRUPTED (never “left”).'],
  ['evidenceMaxAgeSec', 'Max age of attendance GPS evidence (s)', ''],
  ['earlyStartMinutes', 'Shift can be started early by (min)', ''],
  ['endGraceMinutes', 'Tracking stops after shift end + (min)', 'Hard stop for location collection.'],
  ['uncertainReviewAfterSec', 'Suggest manual review after uncertain GPS for (s)', ''],
  ['offlineQueueMax', 'Offline queue size on device (readings)', 'Oldest readings are dropped beyond this.'],
  ['entryMinServerSpanSec', 'Arrival must also be seen by the server for (s)', 'Readings must arrive in separate uploads over this time, so a phone with a changed clock cannot unlock attendance at once. 0 turns it off.'],
];

function SectionForm({ section, value, children, reasonRequired }: { section: string; value: any; children: (v: any, set: (v: any) => void) => React.ReactNode; reasonRequired?: boolean }) {
  const qc = useQueryClient();
  const [v, setV] = useState(value);
  const [reason, setReason] = useState('');
  useEffect(() => setV(value), [value]);
  const save = useMutation({
    mutationFn: () => put(`/settings/${section}`, { value: v, reason: reason || undefined }),
    onSuccess: () => {
      setReason('');
      qc.invalidateQueries({ queryKey: ['settings'] });
    },
  });
  return (
    <form onSubmit={(e) => { e.preventDefault(); save.mutate(); }} className="space-y-4">
      {children(v, setV)}
      <Field label={`Reason for change${reasonRequired ? '' : ' (optional, audited)'}`}><Input value={reason} onChange={(e) => setReason(e.target.value)} required={reasonRequired} /></Field>
      <InlineError error={save.error} />
      <div className="flex items-center gap-2">
        <Button type="submit" variant="primary" loading={save.isPending}>Save</Button>
        {save.isSuccess && <span className="text-xs text-teal-700">Saved</span>}
      </div>
    </form>
  );
}

/** What the owner will receive, whether the channels are set up, and a test send. */
function DigestPreview() {
  const qc = useQueryClient();
  const d = useQuery({ queryKey: ['digest'], queryFn: () => get('/digest') });
  const test = useMutation({ meta: { success: 'Test summary sent', toastError: true }, mutationFn: () => post('/digest/test'), onSuccess: () => qc.invalidateQueries({ queryKey: ['digest'] }) });
  if (!d.data) return null;
  return (
    <div className="mb-4 space-y-2">
      <div className="rounded-lg bg-[#e7ffdb] p-3 text-sm text-gray-800 shadow-inner">
        <p className="font-semibold">{d.data.preview.company} — {d.data.preview.when}</p>
        <p>{d.data.preview.line}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Badge tone={d.data.channels.whatsapp ? 'green' : 'amber'}>WhatsApp: {d.data.channels.whatsapp ? 'connected' : 'not connected'}</Badge>
        <Badge tone={d.data.channels.email ? 'green' : 'gray'}>E-mail: {d.data.channels.email ? 'connected' : 'off'}</Badge>
        <Button size="sm" className="ml-auto" loading={test.isPending} onClick={() => test.mutate()}>Send test now</Button>
      </div>
      {test.data && (
        <p className="text-xs text-gray-600">
          {Object.entries((test.data as any).results).map(([k, v]) => `${k}: ${v}`).join(' · ') || 'Add a WhatsApp number or e-mail below first.'}
        </p>
      )}
      <InlineError error={test.error} />
      {!d.data.channels.whatsapp && (
        <p className="text-xs text-gray-500">
          Until WhatsApp is connected, summaries are written to the server log instead of being sent. To send on WhatsApp, the server needs a WhatsApp Business (Cloud API) number and an approved template “daily_summary” with three variables — set WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID in .env.
        </p>
      )}
    </div>
  );
}

function CompanyCard() {
  const qc = useQueryClient();
  const org = useQuery({ queryKey: ['organization'], queryFn: () => get('/organization') });
  const [f, setF] = useState<{ name: string; phone: string } | null>(null);
  useEffect(() => {
    if (org.data) setF({ name: org.data.name, phone: org.data.phone ?? '' });
  }, [org.data]);
  const save = useMutation({
    mutationFn: () => api('/organization', { method: 'PATCH', body: { name: f!.name, phone: f!.phone || null } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['organization'] });
      qc.invalidateQueries({ queryKey: ['me'] });
    },
  });
  return (
    <Card title="Company">
      {f && (
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Business name"><Input required minLength={2} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
            <Field label="Contact phone"><Input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
          </div>
          <InlineError error={save.error} />
          <div className="flex items-center gap-2">
            <Button type="submit" variant="primary" loading={save.isPending}>Save</Button>
            {save.isSuccess && <span className="text-xs text-teal-700">Saved</span>}
          </div>
          <p className="text-xs text-gray-500">Your company’s employees, workplaces, settings and records are kept separate from every other company on GeoAttend.</p>
        </form>
      )}
    </Card>
  );
}

const INTEGRATION = {
  on: { cls: 'border-teal-200 bg-teal-50 text-teal-800', Icon: CheckCircle2, text: 'configured' },
  off: { cls: 'border-gray-200 bg-gray-50 text-gray-600', Icon: MinusCircle, text: 'off' },
  warn: { cls: 'border-amber-200 bg-amber-50 text-amber-900', Icon: AlertTriangle, text: '' },
  unsafe: { cls: 'border-red-200 bg-red-50 text-red-700', Icon: ShieldAlert, text: '' },
} as const;

/** Green = configured, grey = off, amber = works but limited, red = unsafe for production. Icon + words, never colour alone. */
function Integration({ state, label }: { state: keyof typeof INTEGRATION; label: string }) {
  const { cls, Icon, text } = INTEGRATION[state];
  return (
    <li className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-medium ${cls}`}>
      <Icon className="h-3.5 w-3.5" aria-hidden />
      {label}
      {text && <span className="font-normal">: {text}</span>}
    </li>
  );
}

const SECTIONS = [
  { value: 'company', label: 'Company' },
  { value: 'tracking', label: 'Tracking & geofence' },
  { value: 'alerts', label: 'Alerts & summaries' },
  { value: 'workforce', label: 'Phones, hours & breaks' },
  { value: 'privacy', label: 'Privacy & retention' },
] as const;
type Section = (typeof SECTIONS)[number]['value'];

export default function SettingsPage() {
  const q = useQuery({ queryKey: ['settings'], queryFn: () => get('/settings') });
  const retention = useMutation({ meta: { success: 'Retention finished', toastError: true }, mutationFn: () => post('/settings/retention/run') });
  const [section, setSection] = useState<Section>(() => {
    const h = typeof window !== 'undefined' ? window.location.hash.slice(1) : '';
    return SECTIONS.some((s) => s.value === h) ? (h as Section) : 'company';
  });
  const vis = (s: Section) => (section === s ? undefined : 'hidden');
  const go = (s: Section) => {
    setSection(s);
    history.replaceState(null, '', `#${s}`);
  };

  return (
    <>
      <PageHeader title="Settings" description="Company details, tracking policy, alerts, working hours and privacy. Every change is recorded in the audit log." />
      <Tabs label="Settings sections" value={section} onChange={go} tabs={SECTIONS} />
      <QueryState query={q}>
        {(d: any) => (
          <div className="max-w-4xl space-y-6" role="tabpanel" aria-label={SECTIONS.find((s) => s.value === section)?.label}>
            <div className={vis('company')}><CompanyCard /></div>
            <Card title="Integrations" description="Configured on the server by whoever deploys GeoAttend" className={vis('company')}>
              <ul className="flex flex-wrap gap-2 text-sm" aria-label="Integration status">
                <Integration state={mapsConfigured ? 'on' : 'off'} label="Google Maps" />
                <Integration state={d.integrations.webPush ? 'on' : 'off'} label="Browser push" />
                <Integration state={d.integrations.email ? 'on' : 'off'} label="E-mail alerts" />
                <Integration state={d.integrations.expoPush ? 'on' : 'off'} label="Employee device push" />
                <Integration state={d.integrations.storageDriver === 's3' ? 'on' : 'warn'} label={d.integrations.storageDriver === 's3' ? 'Photo storage: private bucket' : 'Photo storage: this server’s disk'} />
                {d.integrations.demoMode && <Integration state="unsafe" label="Demo mode on — not for production" />}
              </ul>
            </Card>

            <Card title="Tracking & geofence rules" description="Change these only if you understand the effect on accuracy and battery." className={vis('tracking')}>
              <SectionForm section="tracking" value={d.settings.tracking}>
                {(v, setV) => (
                  <div className="grid gap-3 sm:grid-cols-2">
                    {TRACKING_FIELDS.map(([k, label, hint]) => (
                      <Field key={k} label={label} hint={hint || undefined}>
                        <Input type="number" step="any" value={v[k]} onChange={(e) => setV({ ...v, [k]: Number(e.target.value) })} />
                      </Field>
                    ))}
                    <Field label="Fake GPS (mock location)" hint="If the phone reports a fake-location app at any point in the shift.">
                      <Select value={v.mockLocationPolicy} onChange={(e) => setV({ ...v, mockLocationPolicy: e.target.value })}>
                        <option value="BLOCK_ATTENDANCE">Block attendance (manual review instead)</option>
                        <option value="FLAG">Allow, but flag for review</option>
                      </Select>
                    </Field>
                    <Field label="Rooted phones and emulators" hint="These can fake location without the phone reporting it.">
                      <Select value={v.deviceIntegrityPolicy} onChange={(e) => setV({ ...v, deviceIntegrityPolicy: e.target.value })}>
                        <option value="BLOCK_ATTENDANCE">Block attendance (manual review instead)</option>
                        <option value="FLAG">Allow, but flag for review</option>
                      </Select>
                    </Field>
                    <Field label="Location “Allow all the time”" hint="Without it, tracking stops whenever the phone is locked or the app is closed.">
                      <Select value={v.requireBackgroundLocation ? 'yes' : 'no'} onChange={(e) => setV({ ...v, requireBackgroundLocation: e.target.value === 'yes' })}>
                        <option value="yes">Required — tracking pauses until it is allowed</option>
                        <option value="no">Optional — accept gaps when the app is closed</option>
                      </Select>
                    </Field>
                    <Field label="Precise location" hint="Approximate location can be hundreds of metres off.">
                      <Select value={v.requirePreciseLocation ? 'yes' : 'no'} onChange={(e) => setV({ ...v, requirePreciseLocation: e.target.value === 'yes' })}>
                        <option value="yes">Required</option>
                        <option value="no">Optional</option>
                      </Select>
                    </Field>
                  </div>
                )}
              </SectionForm>
            </Card>

              <Card title="Alerts" className={vis('alerts')}>
                <SectionForm section="alerts" value={d.settings.alerts}>
                  {(v, setV) => {
                    const toggle = (list: string, t: string) => setV({ ...v, [list]: v[list].includes(t) ? v[list].filter((x: string) => x !== t) : [...v[list], t] });
                    return (
                      <div className="space-y-3">
                        <Field label="Repeat prolonged-absence alerts every (min)">
                          <Input type="number" min={5} value={v.prolongedReminderCooldownMin} onChange={(e) => setV({ ...v, prolongedReminderCooldownMin: Number(e.target.value) })} />
                        </Field>
                        <Field label="Alert when a shift has not been started after (min)" hint="Skips employees on approved leave. 0 turns the alert off.">
                          <Input type="number" min={0} max={240} value={v.noShowAfterMinutes} onChange={(e) => setV({ ...v, noShowAfterMinutes: Number(e.target.value) })} />
                        </Field>
                        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={v.notifyOnArrival} onChange={(e) => setV({ ...v, notifyOnArrival: e.target.checked })} /> Notify when an employee arrives</label>
                        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={v.notifyOnReturn} onChange={(e) => setV({ ...v, notifyOnReturn: e.target.checked })} /> Notify when an employee returns</label>
                        <div className="overflow-x-auto">
                          <table className="w-full text-sm">
                            <thead><tr className="text-left text-xs text-gray-500"><th className="py-1">Event</th><th>Browser push</th><th>E-mail</th></tr></thead>
                            <tbody>
                              {NOTIFICATION_TYPES.filter((t) => t !== 'ATTENDANCE_READY' && t !== 'LEAVE_DECIDED').map((t) => (
                                <tr key={t} className="border-t border-gray-100">
                                  <td className="py-1">{NOTIFICATION_LABELS[t]}</td>
                                  <td><input type="checkbox" aria-label={`Browser push for ${NOTIFICATION_LABELS[t]}`} checked={v.webPushTypes.includes(t)} onChange={() => toggle('webPushTypes', t)} /></td>
                                  <td><input type="checkbox" aria-label={`E-mail for ${NOTIFICATION_LABELS[t]}`} checked={v.emailTypes.includes(t)} onChange={() => toggle('emailTypes', t)} /></td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                        <p className="text-xs text-gray-500">All events always appear in the in-app inbox.</p>
                      </div>
                    );
                  }}
                </SectionForm>
              </Card>

              <Card title="Daily summary on WhatsApp & e-mail" className={vis('alerts')}>
                <DigestPreview />
                <SectionForm section="digest" value={d.settings.digest}>
                  {(v, setV) => {
                    const list = (s: string) => s.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
                    return (
                      <div className="space-y-3">
                        <Field label="Send at (local time)" hint="Up to four times a day. Morning shows who has not come in; evening shows the day’s result.">
                          <div className="flex flex-wrap gap-2">
                            {[0, 1, 2, 3].map((i) => (
                              <Input key={i} type="time" aria-label={`Time ${i + 1}`} className="w-auto" value={v.times[i] ?? ''} onChange={(e) => setV({ ...v, times: [...v.times.slice(0, i), e.target.value, ...v.times.slice(i + 1)].filter(Boolean) })} />
                            ))}
                          </div>
                        </Field>
                        <Field label="WhatsApp numbers" hint="With country code, digits only — e.g. 919800000000. Separate with commas.">
                          <Input value={v.whatsappNumbers.join(', ')} onChange={(e) => setV({ ...v, whatsappNumbers: list(e.target.value).map((x) => x.replace(/\D/g, '')) })} />
                        </Field>
                        <Field label="E-mail recipients" hint="Separate with commas.">
                          <Input value={v.emailRecipients.join(', ')} onChange={(e) => setV({ ...v, emailRecipients: list(e.target.value) })} />
                        </Field>
                        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={v.monthlyReport} onChange={(e) => setV({ ...v, monthlyReport: e.target.checked })} /> On the 1st, e-mail last month’s attendance (CSV) for payroll</label>
                      </div>
                    );
                  }}
                </SectionForm>
              </Card>

              <Card title="Phones & working hours" className={vis('workforce')}>
                <SectionForm section="workforce" value={d.settings.workforce}>
                  {(v, setV) => (
                    <div className="space-y-3">
                      <Field label="One phone per employee" hint="Stops one person marking attendance for another on a shared phone. Demo accounts are never restricted.">
                        <Select value={v.deviceBinding} onChange={(e) => setV({ ...v, deviceBinding: e.target.value })}>
                          <option value="ENFORCE">On — a new phone needs my approval before it can sign in</option>
                          <option value="ALERT">Alert only — allow, but tell me about new or shared phones</option>
                          <option value="OFF">Off</option>
                        </Select>
                      </Field>
                      <Field label="Face enrollment" hint="Five photos taken once in the app. Start- and end-of-shift photos are compared with them; mismatches wait for you in Approvals.">
                        <Select value={v.faceEnrollment} onChange={(e) => setV({ ...v, faceEnrollment: e.target.value })}>
                          <option value="REQUIRED">Required before the first shift</option>
                          <option value="OFF">Optional</option>
                        </Select>
                      </Field>
                      <div className="grid gap-3 sm:grid-cols-2">
                        <Field label="Flag “left early” when ended (min) before shift end" hint="0 turns the flag off.">
                          <Input type="number" min={0} max={240} value={v.leftEarlyMinutes} onChange={(e) => setV({ ...v, leftEarlyMinutes: Number(e.target.value) })} />
                        </Field>
                        <Field label="Round each shift’s hours to" hint="Applied in reports, dashboards and CSV exports.">
                          <Select value={v.roundingMinutes} onChange={(e) => setV({ ...v, roundingMinutes: Number(e.target.value) })}>
                            <option value={0}>Exact minutes</option>
                            {[5, 6, 10, 15, 30].map((m) => <option key={m} value={m}>Nearest {m} min</option>)}
                          </Select>
                        </Field>
                        <Field label="Weekly overtime after (hours)" hint="Regular time above this per Monday–Sunday week counts as overtime. 0 = off; approved overtime always counts.">
                          <Input type="number" min={0} max={168} step="0.5" value={v.weeklyRegularHours} onChange={(e) => setV({ ...v, weeklyRegularHours: Number(e.target.value) })} />
                        </Field>
                      </div>
                      <label className="flex items-center gap-2 text-sm text-gray-700">
                        <input type="checkbox" checked={v.supervisorAnnouncements} onChange={(e) => setV({ ...v, supervisorAnnouncements: e.target.checked })} />
                        Supervisors may publish announcements to their own workspaces
                      </label>
                      <label className="flex items-center gap-2 text-sm text-gray-700">
                        <input type="checkbox" checked={v.keepMatchedPhotos} onChange={(e) => setV({ ...v, keepMatchedPhotos: e.target.checked })} />
                        Keep check-in selfies after the face check matches (deleted when the photo retention period ends)
                      </label>
                      <p className="text-xs text-gray-500">
                        Worked hours stop at the scheduled end of each shift. Staying longer is overtime: the employee starts it in the app with a selfie when the shift ends, and it counts toward hours and pay only once approved on the{' '}
                        <Link href="/overtime" className="font-medium text-primary-700 hover:underline">Overtime</Link> page.
                      </p>
                    </div>
                  )}
                </SectionForm>
              </Card>

              <Card title="Breaks" className={vis('workforce')}>
                <SectionForm section="breaks" value={d.settings.breaks}>
                  {(v, setV) => {
                    const setType = (i: number, patch: any) => setV({ ...v, types: v.types.map((t: any, j: number) => (j === i ? { ...t, ...patch } : t)) });
                    return (
                      <div className="space-y-3">
                        <p className="text-xs text-gray-500">
                          Employees who are present start a break in the app from inside the workplace area. During a break, leaving the area raises no absence alert and location is still shared. Past the time limit you are alerted. Unpaid break time is subtracted from worked hours.
                        </p>
                        <div className="overflow-x-auto">
                          <table className="w-full text-sm">
                            <thead><tr className="text-left text-xs text-gray-500"><th className="py-1">Name</th><th>Limit (min)</th><th>Paid</th><th /></tr></thead>
                            <tbody>
                              {v.types.map((t: any, i: number) => (
                                <tr key={t.key} className="border-t border-gray-100">
                                  <td className="py-1 pr-2"><Input aria-label={`Name of break type ${i + 1}`} value={t.label} maxLength={60} onChange={(e) => setType(i, { label: e.target.value })} /></td>
                                  <td className="pr-2"><Input aria-label={`Limit for ${t.label}`} type="number" min={1} max={480} className="w-24" value={t.maxMinutes} onChange={(e) => setType(i, { maxMinutes: Number(e.target.value) })} /></td>
                                  <td><input type="checkbox" aria-label={`${t.label} is paid`} checked={t.paid} onChange={(e) => setType(i, { paid: e.target.checked })} /></td>
                                  <td className="text-right">
                                    <Button type="button" size="sm" disabled={v.types.length <= 1} onClick={() => setV({ ...v, types: v.types.filter((_: any, j: number) => j !== i) })}>Remove</Button>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                        <Button
                          type="button"
                          size="sm"
                          disabled={v.types.length >= 12}
                          onClick={() => {
                            let n = v.types.length + 1;
                            while (v.types.some((t: any) => t.key === `CUSTOM_${n}`)) n++;
                            setV({ ...v, types: [...v.types, { key: `CUSTOM_${n}`, label: 'New break', paid: false, maxMinutes: 15 }] });
                          }}
                        >
                          Add break type
                        </Button>
                        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={v.requirePhoto} onChange={(e) => setV({ ...v, requirePhoto: e.target.checked })} /> Require a selfie to start a break</label>
                      </div>
                    );
                  }}
                </SectionForm>
              </Card>

              <Card title="Data retention" className={vis('privacy')}>
                <SectionForm section="retention" value={d.settings.retention}>
                  {(v, setV) => (
                    <div className="grid gap-3 sm:grid-cols-3">
                      <Field label="Raw location history (days)"><Input type="number" min={1} value={v.locationDays} onChange={(e) => setV({ ...v, locationDays: Number(e.target.value) })} /></Field>
                      <Field label="Attendance photos (days)"><Input type="number" min={1} value={v.photoDays} onChange={(e) => setV({ ...v, photoDays: Number(e.target.value) })} /></Field>
                      <Field label="Notifications (days)"><Input type="number" min={7} value={v.notificationDays} onChange={(e) => setV({ ...v, notificationDays: Number(e.target.value) })} /></Field>
                    </div>
                  )}
                </SectionForm>
                <div className="mt-4 flex items-center gap-2 border-t border-gray-100 pt-4">
                  <ConfirmButton title="Run retention now?" description="Location history and photos older than the periods above are permanently deleted. This cannot be undone." confirmLabel="Delete expired data" danger onConfirm={() => retention.mutate()} loading={retention.isPending}>Run retention now</ConfirmButton>
                  {retention.data && (
                    <span className="text-xs text-gray-600">
                      Deleted {(retention.data as any).locationUpdatesDeleted} location records, {(retention.data as any).photosDeleted} photos, {(retention.data as any).notificationsDeleted} notifications.
                    </span>
                  )}
                  <InlineError error={retention.error} />
                </div>
                <p className="mt-2 text-xs text-gray-500">Runs automatically every hour. Attendance records themselves are kept for payroll and legal record keeping.</p>
              </Card>

              <Card title="Geofence radius options" className={vis('tracking')}>
                <SectionForm section="geofence" value={d.settings.geofence}>
                  {(v, setV) => (
                    <div className="grid gap-3 sm:grid-cols-3">
                      <Field label="Presets (m, comma separated)"><Input value={v.presetsM.join(', ')} onChange={(e) => setV({ ...v, presetsM: e.target.value.split(',').map((x) => Number(x.trim())).filter((x) => x > 0) })} /></Field>
                      <Field label="Minimum (m)"><Input type="number" value={v.minRadiusM} onChange={(e) => setV({ ...v, minRadiusM: Number(e.target.value) })} /></Field>
                      <Field label="Maximum (m)"><Input type="number" value={v.maxRadiusM} onChange={(e) => setV({ ...v, maxRadiusM: Number(e.target.value) })} /></Field>
                    </div>
                  )}
                </SectionForm>
              </Card>

            <Card title={<span>Privacy &amp; tracking notice <Badge tone="navy">version {d.settings.privacy.version}</Badge></span>} className={vis('privacy')}>
              <SectionForm section="privacy" value={d.settings.privacy} reasonRequired>
                {(v, setV) => (
                  <div className="space-y-3">
                    <p className="rounded-md bg-amber-50 p-3 text-sm text-amber-900">
                      Employees must read and acknowledge this notice before their first tracked shift. Saving any change creates a new version that every employee must acknowledge again. Have the text reviewed against the employment, privacy and data-protection law of your jurisdiction — an acknowledgement is not a substitute for that review.
                    </p>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <Field label="Data controller / employer"><Input value={v.controller} onChange={(e) => setV({ ...v, controller: e.target.value })} /></Field>
                      <Field label="Privacy contact"><Input value={v.contact} onChange={(e) => setV({ ...v, contact: e.target.value })} /></Field>
                    </div>
                    <Field label="Notice text"><Textarea rows={16} value={v.text} onChange={(e) => setV({ ...v, text: e.target.value })} className="font-mono text-xs" /></Field>
                  </div>
                )}
              </SectionForm>
            </Card>
          </div>
        )}
      </QueryState>
    </>
  );
}
