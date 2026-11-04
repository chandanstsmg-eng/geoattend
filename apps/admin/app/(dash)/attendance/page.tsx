'use client';
import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, ImageOff, Plus } from 'lucide-react';
import { get, post, qs, errorMessage } from '@/lib/api';
import { localDateTime, daysAgoISO, fmtClock, fmtDate, fmtDateTime, metres, minutes, todayISO } from '@/lib/format';
import { rowKeys, LinkButton, Badge, Button, Callout, Card, Drawer, EmptyState, Field, InlineError, Input, KeyValue, Modal, PageHeader, Pagination, QueryState, rowLink, Select, SimBadge, Spinner, Table, Tabs, Td, Textarea, Th, Toolbar } from '@/components/ui';
import { FACE_RESULT, VerificationBadge } from '@/components/state-badge';
import { EmployeeSelect, WorkplaceSelect, useEmployees } from '@/components/filters';
import { useMe } from '@/lib/me';
import { Kpi, StatStrip, StatStripSkeleton } from '@/components/charts';
import { SchematicMap } from '@/components/maps/schematic';

/** Lateness as a compact chip: amber up to 30 minutes, red beyond (red is kept for real exceptions). */
function LateChip({ minutes: m }: { minutes: number }) {
  const text = m < 60 ? `+${m}m` : `+${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
  return (
    <span title={`Late by ${m} min (after the grace period)`} className={`inline-flex rounded-full px-1.5 py-px text-caption font-semibold tabular ${m > 30 ? 'bg-red-50 text-red-700' : 'bg-amber-50 text-amber-800'}`}>
      {text}
    </span>
  );
}

/** Recorded on the record but not risks: simulated data, and location shared only while the app was open. */
const INFO_FLAGS = new Set(['SIMULATED', 'BACKGROUND_LOCATION_UNAVAILABLE']);

/** 32 px selfie; a placeholder when there is no viewable photo. */
function Selfie({ url, name }: { url?: string; name: string }) {
  if (!url) return <span aria-hidden className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-gray-100 text-gray-400"><ImageOff className="h-3.5 w-3.5" /></span>;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={url} alt={`Check-in photo of ${name}`} className="h-8 w-8 shrink-0 rounded-full border border-gray-200 object-cover" referrerPolicy="no-referrer" loading="lazy" />;
}

const REVIEW: Record<string, { tone: 'amber' | 'green' | 'red'; label: string }> = {
  PENDING: { tone: 'amber', label: 'Waiting for a manager (Approvals)' },
  APPROVED: { tone: 'green', label: 'Manager confirmed same person' },
  REJECTED: { tone: 'red', label: 'Manager rejected — marked absent' },
};

function FaceBadge({ status, score }: { status: string; score: number | null }) {
  const f = FACE_RESULT[status] ?? { tone: 'gray' as const, label: status };
  return <Badge tone={f.tone}>{f.label}{score != null ? ` · ${Math.round(score)}%` : ''}</Badge>;
}

/** The liveness instruction, the start/end face results, and the enrolled photo side by side. */
function FaceCheck({ record: r }: { record: any }) {
  const ref = useMutation({ mutationFn: () => post(`/attendance/${r.id}/reference-photo-url`) });
  const end = useMutation({ mutationFn: () => post(`/attendance/${r.id}/end-photo-url`) });
  const d = ref.data as any;
  return (
    <div className="space-y-2 rounded-md border border-gray-200 p-3">
      {r.challenge && <p className="text-sm text-gray-700">The app asked: <strong>{r.challenge}</strong> — check the photo shows it.</p>}
      <dl className="grid gap-1 text-sm sm:grid-cols-[8rem_1fr]">
        <dt className="text-gray-500">Start of shift</dt>
        <dd>{r.face_status ? <FaceBadge status={r.face_status} score={r.face_score} /> : <span className="text-gray-500">Checking…</span>}</dd>
        <dt className="text-gray-500">End of shift</dt>
        <dd>{r.end_face_status ? <FaceBadge status={r.end_face_status} score={r.end_face_score} /> : <span className="text-gray-500">{r.end_photo_id ? 'Checking…' : 'No end photo'}</span>}</dd>
        {r.face_review && (
          <>
            <dt className="text-gray-500">Review</dt>
            <dd><Badge tone={REVIEW[r.face_review]!.tone}>{REVIEW[r.face_review]!.label}</Badge>{r.face_review_note ? <span className="ml-1 text-gray-600">“{r.face_review_note}”</span> : null}</dd>
          </>
        )}
      </dl>
      <p className="text-xs text-gray-500">Photos that match are deleted straight away; only the result is kept.</p>
      <div className="flex flex-wrap gap-2">
        {!d && <Button size="sm" onClick={() => ref.mutate()} loading={ref.isPending}>Show enrolled face (audited)</Button>}
        {r.end_photo_id && !end.data && <Button size="sm" onClick={() => end.mutate()} loading={end.isPending}>Show end-of-shift photo (audited)</Button>}
      </div>
      <div className="flex flex-wrap gap-3">
        {d?.url && (
          <figure>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={d.url} alt="Enrolled face" className="max-h-60 rounded-md border border-gray-200" referrerPolicy="no-referrer" />
            <figcaption className="mt-1 text-xs text-gray-500">Enrolled face</figcaption>
          </figure>
        )}
        {d && !d.url && <p className="text-xs text-gray-500">This employee has not enrolled their face yet.</p>}
        {(end.data as any)?.url && (
          <figure>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={(end.data as any).url} alt="End-of-shift photo" className="max-h-60 rounded-md border border-gray-200" referrerPolicy="no-referrer" />
            <figcaption className="mt-1 text-xs text-gray-500">End of shift</figcaption>
          </figure>
        )}
      </div>
      <InlineError error={ref.error ?? end.error} />
    </div>
  );
}

export default function AttendancePage() {
  return (
    <Suspense fallback={<Spinner />}>
      <Attendance />
    </Suspense>
  );
}

function Attendance() {
  const params = useSearchParams();
  const [tab, setTab] = useState<'records' | 'reviews'>(params.get('tab') === 'reviews' ? 'reviews' : 'records');
  const [manual, setManual] = useState(false);
  return (
    <>
      <PageHeader
        title="Attendance"
        description="Attendance times are server-recorded. Corrections require a reason and keep the original values in the review history and audit log."
        actions={
          <Button onClick={() => setManual(true)}>
            <Plus className="h-4 w-4" aria-hidden /> Manual attendance
          </Button>
        }
      />
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'records', label: 'Records' }, { value: 'reviews', label: 'Reviews, disputes & issues' }]} />
      {tab === 'records' ? <Records employeeId={params.get('employeeId') ?? ''} late={params.get('late') ?? ''} record={params.get('record')} /> : <Reviews />}
      {manual && <ManualDialog onClose={() => setManual(false)} />}
    </>
  );
}

/** Filters can be preset from links elsewhere (overview row menu, "late today"). */
function Records({ employeeId, late, record }: { employeeId: string; late: string; record: string | null }) {
  const [f, setF] = useState({ from: daysAgoISO(7), to: todayISO(), workplaceId: '', employeeId, status: '', late: late === 'true' || late === 'false' ? late : '' });
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<string | null>(record);
  const { isOwner } = useMe();
  const limit = 50;
  const list = useQuery({ queryKey: ['attendance', f, offset], queryFn: () => get(`/attendance${qs({ ...f, limit, offset })}`) });
  const set = (k: keyof typeof f) => (v: string) => {
    setOffset(0);
    setF({ ...f, [k]: v });
  };

  // One audited request per page for the thumbnails (signed links that expire shortly).
  const photoIds: string[] = (list.data?.items ?? []).filter((r: any) => r.photo_id && r.photo_status === 'ATTACHED' && !r.is_simulated).map((r: any) => r.id);
  const thumbs = useQuery({
    queryKey: ['attendance', 'thumbs', photoIds],
    queryFn: () => post('/attendance/photo-thumbnails', { ids: photoIds }),
    enabled: photoIds.length > 0,
    staleTime: 4 * 60_000,
  });
  const thumbUrls: Record<string, string> = (thumbs.data as any)?.urls ?? {};

  const sm = list.data?.summary;
  return (
    <>
    {/* Exception counts over all records matching the filters. They overlap (a record can be late and miss its check-out). */}
    {list.error && !sm ? null : !sm ? (
      <StatStripSkeleton label="Records summary" count={6} className="mb-4" />
    ) : (
      <StatStrip label="Records summary" count={6} className="mb-4">
          <Kpi label="Records" value={sm.total} sub={`${fmtDate(f.from)} – ${fmtDate(f.to)}`} />
          <Kpi label="Verified by GPS" value={sm.verified} sub={sm.total ? `${Math.round((sm.verified / sm.total) * 100)}% of records` : '—'} onClick={() => set('status')(f.status === 'VERIFIED' ? '' : 'VERIFIED')} title="Show verified records only (click again to clear)" />
          <Kpi label="Late arrivals" value={sm.late} tone={sm.late ? 'warn' : undefined} sub="after start + grace" onClick={() => set('late')(f.late === 'true' ? '' : 'true')} title="Show late records only (click again to clear)" />
          <Kpi label="Missing check-out" value={sm.missing_checkout} tone={sm.missing_checkout ? 'warn' : undefined} sub="closed by the system" />
          <Kpi label="Location flags" value={sm.location_exceptions} tone={sm.location_exceptions ? 'warn' : undefined} sub="risk indicators to check" title="Records with at least one risk indicator (e.g. mock location, rooted phone). Foreground-only location is shown on the record but not counted. Prompts to check, not conclusions." />
          <Kpi label="Needs review" value={sm.disputed} tone={sm.disputed ? 'bad' : undefined} sub={`disputed · ${sm.manual} manual`} onClick={() => set('status')(f.status === 'DISPUTED' ? '' : 'DISPUTED')} title="Disputed records (click to filter). Manual entries have no GPS evidence." />
      </StatStrip>
    )}
    <Card padded={false}>
      <Toolbar>
        <div className="flex w-full items-center gap-2 sm:w-auto">
          <Input type="date" aria-label="From" value={f.from} onChange={(e) => set('from')(e.target.value)} className="min-w-0 flex-1 px-2 w-auto sm:flex-none sm:px-3" />
          <span className="text-sm text-gray-500">to</span>
          <Input type="date" aria-label="To" value={f.to} onChange={(e) => set('to')(e.target.value)} className="min-w-0 flex-1 px-2 w-auto sm:flex-none sm:px-3" />
        </div>
        <WorkplaceSelect value={f.workplaceId} onChange={set('workplaceId')} />
        <EmployeeSelect value={f.employeeId} onChange={set('employeeId')} />
        <Select aria-label="Verification status" value={f.status} onChange={(e) => set('status')(e.target.value)} className="w-auto">
          <option value="">Any status</option>
          {['VERIFIED', 'MANUAL_APPROVED', 'CORRECTED', 'DISPUTED', 'VOIDED'].map((s) => (
            <option key={s} value={s}>{s.replace('_', ' ').toLowerCase()}</option>
          ))}
        </Select>
        <Select aria-label="Late" value={f.late} onChange={(e) => set('late')(e.target.value)} className="w-auto">
          <option value="">Late or on time</option>
          <option value="true">Late only</option>
          <option value="false">On time only</option>
        </Select>
        {/* The detailed export is owner-only on the server. */}
        {isOwner && (
          <LinkButton className="sm:ml-auto" href={`/api/v1/reports/attendance.csv${qs({ from: f.from, to: f.to, workplaceId: f.workplaceId, employeeId: f.employeeId, includeSimulated: 'true' })}`} title="Download these records as CSV (includes simulated records, marked SIMULATED)" size="sm" variant="ghost"><Download className="h-4 w-4" aria-hidden /> Export CSV</LinkButton>
        )}
      </Toolbar>
      <QueryState query={list} isEmpty={(d: any) => d.items.length === 0} empty={<EmptyState title="No attendance records in this range">Widen the dates or clear a filter.</EmptyState>}>
        {(d: any) => (
          <>
            <Table minWidth={980}>
              <thead>
                <tr>
                  <Th>Date</Th>
                  <Th>Employee</Th>
                  <Th>Check-in</Th>
                  <Th>Check-out</Th>
                  <Th className="text-right">Breaks</Th>
                  <Th className="text-right">Hours</Th>
                  <Th className="text-right">Overtime</Th>
                  <Th>Attendance</Th>
                  <Th label="Location evidence">Location</Th>
                </tr>
              </thead>
              <tbody>
                {d.items.map((r: any) => {
                  const flags = (r.risk_flags ?? []).filter((x: string) => !INFO_FLAGS.has(x)).map((x: string) => x.toLowerCase().replaceAll('_', ' '));
                  const foregroundOnly = (r.risk_flags ?? []).includes('BACKGROUND_LOCATION_UNAVAILABLE');
                  return (
                    <tr key={r.id} className={rowLink} onClick={() => setSelected(r.id)} tabIndex={0} onKeyDown={rowKeys(() => setSelected(r.id))} aria-label={`${r.full_name}, ${fmtDate(r.shift_date)}, open record`}>
                      <Td className="whitespace-nowrap tabular">{fmtDate(r.shift_date)}</Td>
                      <Td>
                        <div className="flex items-center gap-2.5">
                          <Selfie url={thumbUrls[r.id]} name={r.full_name} />
                          <div className="min-w-0">
                            <span className="flex flex-wrap items-center gap-1.5">
                              <span className="font-medium text-gray-900">{r.full_name}</span>
                              <span className="text-xs text-gray-500">{r.employee_code}</span>
                              {r.is_simulated && <SimBadge />}
                            </span>
                            <div className="text-xs text-gray-500">{r.workplace_name} · {r.shift_name}</div>
                          </div>
                        </div>
                      </Td>
                      <Td className="whitespace-nowrap tabular">
                        <span className="flex items-center gap-1.5">
                          <span className="text-gray-900">{fmtClock(r.recorded_at)}</span>
                          {r.is_late && <LateChip minutes={r.late_by_minutes} />}
                        </span>
                      </Td>
                      <Td className="whitespace-nowrap tabular">
                        {r.checked_out_at ? (
                          <span className="text-gray-900">{fmtClock(r.checked_out_at)}</span>
                        ) : r.incomplete ? (
                          <Badge dot tone="amber" title="The shift closed without a check-out">Missing</Badge>
                        ) : r.in_progress ? (
                          <span className="text-xs text-gray-500">On shift</span>
                        ) : (
                          <span className="text-gray-400">—</span>
                        )}
                      </Td>
                      <Td className="whitespace-nowrap text-right tabular text-gray-600">{r.break_minutes ? minutes(r.break_minutes) : '—'}</Td>
                      <Td className="whitespace-nowrap text-right tabular">
                        {r.worked_minutes != null ? (
                          <>
                            <span className="text-gray-900">{minutes(r.worked_minutes)}</span>
                            {r.in_progress && <div className="text-xs text-gray-500">so far</div>}
                          </>
                        ) : (
                          <span className="text-gray-400">—</span>
                        )}
                      </Td>
                      <Td className="whitespace-nowrap text-right tabular">
                        {r.overtime_minutes > 0 ? (
                          <span className="font-medium text-navy-800">{minutes(r.overtime_minutes)}</span>
                        ) : r.overtime_status && r.overtime_status !== 'APPROVED' ? (
                          <span className="text-xs text-gray-500">{r.overtime_status === 'RUNNING' ? 'running' : r.overtime_status.toLowerCase()}</span>
                        ) : (
                          <span className="text-gray-400">—</span>
                        )}
                      </Td>
                      <Td><VerificationBadge status={r.verification_status} /></Td>
                      <Td className="tabular text-xs text-gray-600">
                        {r.evidence_distance_m != null ? (
                          <span title={`Distance from the workspace centre at check-in; geofence radius ${r.radius_m_at_record} m`} className="inline-flex whitespace-nowrap rounded-full bg-navy-50 px-1.5 py-px font-medium text-navy-800">
                            {metres(r.evidence_distance_m)} · ±{Math.round(r.evidence_accuracy_m)} m
                          </span>
                        ) : (
                          'Manual entry'
                        )}
                        {(flags.length > 0 || r.photo_status === 'DELETED' || foregroundOnly) && (
                          <span className="mt-1 flex flex-wrap gap-1">
                            {foregroundOnly && <Badge tone="gray" title="The phone shared location only while the app was open (background location not allowed). Not a risk on its own.">foreground only</Badge>}
                            {flags.length > 0 && <Badge tone="amber" title={`Risk indicators (prompts to check, not conclusions): ${flags.join(', ')}`}>{flags.length === 1 ? flags[0] : `${flags.length} risk indicators`}</Badge>}
                            {r.photo_status === 'DELETED' && <Badge title="The photo was removed (retention policy, face check setting or an administrator)">photo deleted</Badge>}
                          </span>
                        )}
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
            <Pagination offset={offset} limit={limit} total={d.total} onChange={setOffset} />
          </>
        )}
      </QueryState>
      <Drawer open={!!selected} onOpenChange={(o) => !o && setSelected(null)} title="Attendance record" subtitle="Evidence, photo, corrections and review history">
        {selected && <RecordDetail id={selected} />}
      </Drawer>
    </Card>
    </>
  );
}

function RecordDetail({ id }: { id: string }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['attendance', 'detail', id], queryFn: () => get(`/attendance/${id}`) });
  const [photo, setPhoto] = useState<{ url: string; isSimulated: boolean } | null>(null);
  const [photoErr, setPhotoErr] = useState<string | null>(null);
  const [corr, setCorr] = useState({ reason: '', verificationStatus: '', isLate: '' });
  const [delReason, setDelReason] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: ['attendance'] });

  const loadPhoto = useMutation({
    mutationFn: () => post(`/attendance/${id}/photo-url`),
    onSuccess: (r: any) => { setPhoto(r); setPhotoErr(null); },
    onError: (e) => setPhotoErr(errorMessage(e)),
  });
  const correct = useMutation({ meta: { success: 'Record corrected' },
    mutationFn: () => post(`/attendance/${id}/corrections`, { reason: corr.reason, ...(corr.verificationStatus ? { verificationStatus: corr.verificationStatus } : {}), ...(corr.isLate ? { isLate: corr.isLate === 'true', ...(corr.isLate === 'false' ? { lateByMinutes: 0 } : {}) } : {}) }),
    onSuccess: () => { setCorr({ reason: '', verificationStatus: '', isLate: '' }); refresh(); },
  });
  const delPhoto = useMutation({ meta: { success: 'Photo deleted' },
    mutationFn: () => post(`/attendance/${id}/photo/delete`, { reason: delReason }),
    onSuccess: () => { setConfirmDelete(false); setPhoto(null); refresh(); },
  });
  const canShow = !!q.data?.record?.photo_id && q.data?.record?.photo_status === 'ATTACHED';
  // Opening a record shows its photo next to the capture point (the view is audited).
  useEffect(() => {
    if (canShow && !photo && !loadPhoto.isPending && !photoErr) loadPhoto.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canShow]);

  return (
    <QueryState query={q}>
      {(d: any) => {
        const r = d.record;
        return (
          <div className="space-y-5">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-lg font-semibold text-gray-900">{r.full_name}</h3>
              <VerificationBadge status={r.verification_status} />
              {r.is_simulated && <SimBadge />}
            </div>
            <KeyValue
              items={[
                ['Shift', `${r.shift_name} · ${fmtDate(r.shift_date)}`],
                ['Workplace', r.workplace_name],
                ['Recorded at (server time)', fmtDateTime(r.recorded_at)],
                ['Late', r.is_late ? `Yes, ${r.late_by_minutes} min` : 'No'],
                ['Evidence position', r.evidence_latitude != null ? `${r.evidence_latitude.toFixed(6)}, ${r.evidence_longitude.toFixed(6)}` : 'None (manual)'],
                ['Distance / accuracy', r.evidence_distance_m != null ? `${metres(r.evidence_distance_m)} from centre, ±${Math.round(r.evidence_accuracy_m)} m (radius ${r.radius_m_at_record} m)` : '—'],
                ['Device fix time', fmtDateTime(r.evidence_client_time)],
                ['Risk indicators', (r.risk_flags ?? []).join(', ') || 'None'],
              ]}
            />
            <Callout tone="neutral">GPS evidence and a photo support, but do not prove, physical presence or identity. Treat risk indicators as prompts to investigate, not as conclusions.</Callout>

            {r.evidence_latitude != null && r.wp_lat != null && (
              <Card title="Where the check-in was captured" description={`Geofence radius ${r.radius_m_at_record} m. The ring around the point is the GPS accuracy (±${Math.round(r.evidence_accuracy_m)} m).`}>
                <SchematicMap
                  center={{ lat: r.wp_lat, lng: r.wp_lng }}
                  radiusM={Number(r.radius_m_at_record)}
                  points={[{ id: r.id, lat: r.evidence_latitude, lng: r.evidence_longitude, label: 'Check-in', kind: 'present', accuracyM: r.evidence_accuracy_m }]}
                  height={260}
                />
              </Card>
            )}

            <Card title="Attendance photo">
              {!r.photo_id ? (
                <p className="text-sm text-gray-500">No photo (manual or review-approved record).</p>
              ) : r.photo_status === 'DELETED' ? (
                <p className="flex items-center gap-2 text-sm text-gray-500"><ImageOff className="h-4 w-4" aria-hidden /> Photo deleted under the retention policy or by an administrator.</p>
              ) : photo ? (
                <div className="space-y-2">
                  <div className="relative inline-block">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={photo.url} alt={`Attendance photo of ${r.full_name}`} className="max-h-80 rounded-md border border-gray-200" referrerPolicy="no-referrer" />
                    {photo.isSimulated && <span className="absolute left-2 top-2 rounded bg-violet-600 px-2 py-0.5 text-xs font-bold text-white">SIMULATED CAPTURE — not a photograph</span>}
                  </div>
                  <p className="text-xs text-gray-500">Signed link valid for a short time. This view was recorded in the audit log. Retained until {fmtDate(r.photo_retention_until)}.</p>
                  <FaceCheck record={r} />
                  <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(true)}>Delete photo…</Button>
                </div>
              ) : (
                <div className="space-y-2">
                  {(r.challenge || r.face_status) && (
                    <p className="text-sm text-gray-700">
                      {r.challenge && <>Asked to: <strong>{r.challenge}</strong>. </>}
                      {r.face_status && <FaceBadge status={r.face_status} score={r.face_score} />}
                    </p>
                  )}
                  <Button onClick={() => loadPhoto.mutate()} loading={loadPhoto.isPending}>View photo (audited)</Button>
                  {photoErr && <p className="text-sm text-red-600">{photoErr}</p>}
                </div>
              )}
            </Card>

            <Card title="Correct this record">
              <form className="grid gap-3 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); correct.mutate(); }}>
                <Field label="Verification status">
                  <Select value={corr.verificationStatus} onChange={(e) => setCorr({ ...corr, verificationStatus: e.target.value })}>
                    <option value="">Keep ({r.verification_status.toLowerCase()})</option>
                    {['CORRECTED', 'MANUAL_APPROVED', 'VERIFIED', 'DISPUTED', 'VOIDED'].map((s) => <option key={s} value={s}>{s.replace('_', ' ').toLowerCase()}</option>)}
                  </Select>
                </Field>
                <Field label="Late">
                  <Select value={corr.isLate} onChange={(e) => setCorr({ ...corr, isLate: e.target.value })}>
                    <option value="">Keep</option>
                    <option value="false">Not late</option>
                    <option value="true">Late</option>
                  </Select>
                </Field>
                <div className="sm:col-span-2">
                  <Field label="Reason (required, audited)"><Textarea required minLength={5} value={corr.reason} onChange={(e) => setCorr({ ...corr, reason: e.target.value })} /></Field>
                </div>
                <div className="sm:col-span-2"><InlineError error={correct.error} /></div>
                <div className="sm:col-span-2"><Button type="submit" variant="primary" loading={correct.isPending}>Apply correction</Button></div>
              </form>
            </Card>

            <Card title="Review history">
              {d.history.length === 0 ? (
                <p className="text-sm text-gray-500">No corrections, disputes or reviews.</p>
              ) : (
                <ol className="space-y-3 text-sm">
                  {d.history.map((h: any) => (
                    <li key={h.id} className="rounded-md border border-gray-200 p-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge tone="navy">{h.kind.replace('_', ' ').toLowerCase()}</Badge>
                        <Badge>{h.status.toLowerCase()}</Badge>
                        <span className="text-xs text-gray-500">{fmtDateTime(h.created_at)} · {h.by_name}</span>
                      </div>
                      <p className="mt-1 text-gray-700">{h.reason}</p>
                      {h.resolution_note && <p className="mt-1 text-xs text-gray-500">Resolution: {h.resolution_note}</p>}
                    </li>
                  ))}
                </ol>
              )}
            </Card>

            <Modal open={confirmDelete} onOpenChange={setConfirmDelete} title="Delete attendance photo?" description="The image is permanently removed from storage. The attendance record is kept. A reason is required.">
              <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); delPhoto.mutate(); }}>
                <Field label="Reason"><Textarea required minLength={5} value={delReason} onChange={(e) => setDelReason(e.target.value)} /></Field>
                <InlineError error={delPhoto.error} />
                <div className="flex justify-end gap-2">
                  <Button type="button" onClick={() => setConfirmDelete(false)}>Cancel</Button>
                  <Button type="submit" variant="danger" loading={delPhoto.isPending}>Delete photo</Button>
                </div>
              </form>
            </Modal>
          </div>
        );
      }}
    </QueryState>
  );
}

function Reviews() {
  const qc = useQueryClient();
  const [status, setStatus] = useState('OPEN');
  const list = useQuery({ queryKey: ['reviews', status], queryFn: () => get<any[]>(`/attendance/reviews${qs({ status })}`) });
  const [acting, setActing] = useState<{ r: any; decision: 'APPROVE' | 'REJECT' | 'ACKNOWLEDGE' } | null>(null);
  const [note, setNote] = useState('');
  const resolve = useMutation({ meta: { success: 'Review resolved' },
    mutationFn: () => post(`/attendance/reviews/${acting!.r.id}/resolve`, { decision: acting!.decision, note }),
    onSuccess: () => { setActing(null); setNote(''); qc.invalidateQueries({ queryKey: ['reviews'] }); qc.invalidateQueries({ queryKey: ['attendance'] }); qc.invalidateQueries({ queryKey: ['overview'] }); },
  });

  return (
    <Card padded={false}>
      <Toolbar>
        <Select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)} className="w-auto">
          <option value="OPEN">Open</option>
          <option value="">All</option>
          <option value="APPROVED">Approved</option>
          <option value="REJECTED">Rejected</option>
          <option value="ACKNOWLEDGED">Acknowledged</option>
          <option value="APPLIED">Applied corrections</option>
          <option value="CANCELLED">Cancelled</option>
        </Select>
      </Toolbar>
      <QueryState query={list} isEmpty={(d) => d.length === 0} empty={<EmptyState title="Nothing waiting for review" />}>
        {(rows) => (
          <Table>
            <thead><tr><Th>Requested</Th><Th>Employee</Th><Th>Type</Th><Th>Reason</Th><Th>Status</Th><Th /></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <Td className="text-xs">{fmtDateTime(r.created_at)}</Td>
                  <Td>{r.full_name} {r.is_simulated && <SimBadge />}</Td>
                  <Td><Badge tone={r.kind === 'MANUAL_REVIEW' ? 'purple' : r.kind === 'DISPUTE' ? 'amber' : 'gray'}>{r.kind.replace('_', ' ').toLowerCase()}</Badge></Td>
                  <Td className="max-w-md text-sm">
                    {r.reason}
                    {r.kind === 'MANUAL_REVIEW' && r.before_data && <div className="mt-1 text-xs text-gray-500">At request: {r.before_data.state?.toLowerCase().replaceAll('_', ' ')}, {metres(r.before_data.lastDistanceM)} ±{r.before_data.lastAccuracyM ? Math.round(r.before_data.lastAccuracyM) : '?'} m</div>}
                    {r.resolution_note && <div className="mt-1 text-xs text-gray-500">Resolution: {r.resolution_note} {r.resolved_by_name && `— ${r.resolved_by_name}`}</div>}
                  </Td>
                  <Td><Badge>{r.status.toLowerCase()}</Badge></Td>
                  <Td className="whitespace-nowrap">
                    {r.status === 'OPEN' && (r.kind === 'TECHNICAL_ISSUE' ? (
                      <Button size="sm" onClick={() => setActing({ r, decision: 'ACKNOWLEDGE' })}>Acknowledge</Button>
                    ) : (
                      <div className="flex gap-1">
                        <Button size="sm" variant="primary" onClick={() => setActing({ r, decision: 'APPROVE' })}>{r.kind === 'DISPUTE' ? 'Accept' : 'Approve'}</Button>
                        <Button size="sm" onClick={() => setActing({ r, decision: 'REJECT' })}>Reject</Button>
                      </div>
                    ))}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </QueryState>
      <Modal
        open={!!acting}
        onOpenChange={(o) => !o && setActing(null)}
        title={acting ? `${acting.decision === 'APPROVE' ? 'Approve' : acting.decision === 'REJECT' ? 'Reject' : 'Acknowledge'} request` : ''}
        description={acting?.r.kind === 'MANUAL_REVIEW' && acting.decision === 'APPROVE' ? 'Approving creates a MANUAL_APPROVED attendance record using the last known location as evidence.' : acting?.r.kind === 'DISPUTE' && acting.decision === 'APPROVE' ? 'Accepting a dispute marks it resolved; apply the actual change with a correction on the record.' : 'Your note is shown to the employee and kept in the audit log.'}
      >
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); resolve.mutate(); }}>
          <Field label="Note (required)"><Textarea required minLength={3} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
          <InlineError error={resolve.error} />
          <div className="flex justify-end gap-2">
            <Button type="button" onClick={() => setActing(null)}>Cancel</Button>
            <Button type="submit" variant="primary" loading={resolve.isPending}>Confirm</Button>
          </div>
        </form>
      </Modal>
    </Card>
  );
}

function ManualDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const emps = useEmployees();
  const [f, setF] = useState({ employeeId: '', shiftId: '', shiftDate: todayISO(), recordedAt: localDateTime(), reason: '' });
  const emp = emps.data?.find((e: any) => e.id === f.employeeId);
  const create = useMutation({ meta: { success: 'Attendance added' },
    mutationFn: () => post('/attendance/manual', { ...f, recordedAt: new Date(f.recordedAt).toISOString() }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['attendance'] }); qc.invalidateQueries({ queryKey: ['overview'] }); onClose(); },
  });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title="Manual attendance" description="For cases without device evidence (e.g. a broken phone). Recorded as MANUAL_APPROVED with your name and reason in the audit log.">
      <form className="grid gap-3 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
        <div className="sm:col-span-2">
          <Field label="Employee">
            <Select required value={f.employeeId} onChange={(e) => setF({ ...f, employeeId: e.target.value, shiftId: '' })}>
              <option value="">Select…</option>
              {emps.data?.filter((e: any) => e.is_active).map((e: any) => <option key={e.id} value={e.id}>{e.full_name} ({e.employee_code})</option>)}
            </Select>
          </Field>
        </div>
        <div className="sm:col-span-2">
          <Field label="Shift">
            <Select required value={f.shiftId} onChange={(e) => setF({ ...f, shiftId: e.target.value })}>
              <option value="">Select…</option>
              {(emp?.shifts ?? []).map((s: any) => <option key={s.shiftId} value={s.shiftId}>{s.name}</option>)}
            </Select>
          </Field>
        </div>
        <Field label="Shift date"><Input type="date" required value={f.shiftDate} onChange={(e) => setF({ ...f, shiftDate: e.target.value })} /></Field>
        <Field label="Attendance time"><Input type="datetime-local" required value={f.recordedAt} onChange={(e) => setF({ ...f, recordedAt: e.target.value })} /></Field>
        <div className="sm:col-span-2"><Field label="Reason (required)"><Textarea required minLength={5} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></Field></div>
        <div className="sm:col-span-2"><InlineError error={create.error} /></div>
        <div className="sm:col-span-2 flex justify-end gap-2">
          <Button type="button" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={create.isPending}>Create record</Button>
        </div>
      </form>
    </Modal>
  );
}
