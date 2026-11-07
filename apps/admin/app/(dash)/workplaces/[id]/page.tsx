'use client';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import { get, patch, post, put } from '@/lib/api';
import { useSupervisors } from '@/components/filters';
import { ConfirmButton, Badge, Button, Card, cx, DemoTag, ErrorState, Field, InlineError, Input, PageHeader, Spinner, Textarea } from '@/components/ui';
import { GeofenceEditorMap, MapSetupNotice, mapsConfigured, PlaceSearch, useMapsRefused } from '@/components/maps/google';
import { SchematicMap } from '@/components/maps/schematic';

const TIMEZONES = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : ['UTC', 'Asia/Kolkata'];

interface Form {
  name: string;
  address: string;
  latitude: number;
  longitude: number;
  radiusM: number;
  timezone: string;
  defaultGraceMinutes: number;
  absenceThresholdMinutes: number;
  placeId: string | null;
  minStaff: string;
  reason: string;
}

/** Which supervisors manage this workplace (it is added to or removed from their sites). */
function SupervisorsCard({ workplaceId, current }: { workplaceId: string; current: string[] }) {
  const qc = useQueryClient();
  const sups = useSupervisors();
  const [picked, setPicked] = useState<string[] | null>(null);
  const value = picked ?? current;
  const save = useMutation({
    mutationFn: () => put(`/workplaces/${workplaceId}/supervisors`, { supervisorIds: value }),
    onSuccess: () => {
      setPicked(null);
      qc.invalidateQueries({ queryKey: ['workplaces'] });
      qc.invalidateQueries({ queryKey: ['team'] });
    },
  });
  const dirty = picked !== null && (picked.length !== current.length || picked.some((x) => !current.includes(x)));
  return (
    <Card className="mt-6" title="Supervisors" actions={<Link className="text-xs font-medium text-primary-700 hover:underline" href="/team">Manage supervisors</Link>}>
      {sups.data?.length ? (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2">
            {sups.data.map((s: any) => {
              const on = value.includes(s.id);
              return (
                <button
                  key={s.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setPicked(on ? value.filter((x) => x !== s.id) : [...value, s.id])}
                  className={cx('h-8 rounded-md border px-3 text-body-sm font-medium', on ? 'border-navy-700 bg-navy-50 text-navy-800' : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50')}
                >
                  {s.full_name}
                </button>
              );
            })}
          </div>
          <InlineError error={save.error} />
          <div className="flex items-center gap-2">
            <Button size="sm" variant="primary" disabled={!dirty} loading={save.isPending} onClick={() => save.mutate()}>Save supervisors</Button>
            {dirty && <Button size="sm" variant="ghost" onClick={() => setPicked(null)}>Undo</Button>}
            {save.isSuccess && !dirty && <span className="text-xs text-teal-700">Saved</span>}
          </div>
        </div>
      ) : (
        <p className="text-sm text-gray-500">No supervisors yet. Add one under Supervisors.</p>
      )}
    </Card>
  );
}

export default function WorkplaceEditorPage() {
  const refused = useMapsRefused();
  const mapsUsable = mapsConfigured && !refused;
  const { id } = useParams<{ id: string }>();
  const isNew = id === 'new';
  const router = useRouter();
  const qc = useQueryClient();
  const wp = useQuery({ queryKey: ['workplaces', id], queryFn: () => get(`/workplaces/${id}`), enabled: !isNew });
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => get('/settings') });
  const [f, setF] = useState<Form | null>(isNew ? { name: '', address: '', latitude: 12.971599, longitude: 77.594566, radiusM: 100, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone.replace('Asia/Calcutta', 'Asia/Kolkata'), defaultGraceMinutes: 10, absenceThresholdMinutes: 15, placeId: null, minStaff: '', reason: '' } : null);
  const [placed, setPlaced] = useState(!isNew);

  useEffect(() => {
    if (wp.data && !f) {
      const w = wp.data;
      setF({ name: w.name, address: w.address ?? '', latitude: w.latitude, longitude: w.longitude, radiusM: w.radius_m, timezone: w.timezone, defaultGraceMinutes: w.default_grace_minutes, absenceThresholdMinutes: w.absence_threshold_minutes, placeId: w.place_id ?? null, minStaff: w.min_staff == null ? '' : String(w.min_staff), reason: '' });
    }
  }, [wp.data, f]);

  const save = useMutation({ meta: { success: 'Workplace saved' },
    mutationFn: () => {
      const body = { ...f!, address: f!.address || null, minStaff: f!.minStaff === '' ? null : Number(f!.minStaff), reason: f!.reason || undefined };
      if (isNew) {
        const { reason: _r, ...create } = body;
        return post('/workplaces', create);
      }
      return patch(`/workplaces/${id}`, body);
    },
    onSuccess: (w: any) => {
      qc.invalidateQueries({ queryKey: ['workplaces'] });
      if (isNew) router.replace(`/workplaces/${w.id}`);
      else setF((cur) => (cur ? { ...cur, reason: '' } : cur));
    },
  });
  const toggle = useMutation({ meta: { success: 'Workplace updated', toastError: true },
    mutationFn: (isActive: boolean) => post(`/workplaces/${id}/status`, { isActive }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['workplaces'] }),
  });

  if (!isNew && wp.error) return <ErrorState error={wp.error} onRetry={() => wp.refetch()} />;
  if (!f) return <Spinner />;
  const geo = settings.data?.settings.geofence ?? { presetsM: [50, 100, 200, 500], minRadiusM: 50, maxRadiusM: 1000 };
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF({ ...f, [k]: v });
  const center = { lat: f.latitude, lng: f.longitude };

  return (
    <>
      <Link href="/workplaces" className="mb-3 inline-flex items-center gap-1 text-sm text-primary-700 hover:underline">
        <ArrowLeft className="h-4 w-4" aria-hidden /> All workplaces
      </Link>
      <PageHeader
        title={isNew ? 'New workplace' : f.name || 'Workplace'}
        description="The circle on the map is the attendance area. Attendance is verified on the server from each phone's GPS reading."
        actions={
          !isNew && wp.data ? (
            <>
              {wp.data.is_demo && <DemoTag />}
              <Badge dot tone={wp.data.is_active ? 'green' : 'gray'}>{wp.data.is_active ? 'Active' : 'Disabled'}</Badge>
              {wp.data.is_active ? (
                <ConfirmButton title="Disable this workplace?" description="People can no longer start shifts here and it leaves the roster and the map. Past attendance is kept, and you can enable it again." confirmLabel="Disable workplace" danger loading={toggle.isPending} onConfirm={() => toggle.mutate(false)}>Disable workplace</ConfirmButton>
              ) : (
                <Button onClick={() => toggle.mutate(true)} loading={toggle.isPending}>Enable workplace</Button>
              )}
            </>
          ) : null
        }
      />
      <div className="grid items-start gap-5 xl:grid-cols-5">
        <Card className="xl:sticky xl:top-[5.5rem] xl:col-span-3 xl:self-start" title="Location and geofence" description="Search, then drag the orange pin to the exact point. Drag the circle edge to resize.">
          {mapsUsable ? (
            <div className="space-y-3">
              <PlaceSearch
                onPlace={(p) => {
                  setF({ ...f, latitude: p.lat, longitude: p.lng, address: p.address || f.address, name: f.name || p.name || '', placeId: p.placeId ?? null });
                  setPlaced(true);
                }}
              />
              <GeofenceEditorMap
                value={center}
                radius={f.radiusM}
                onChange={(p) => {
                  // A hand-adjusted point is no longer exactly the searched place.
                  setF({ ...f, latitude: p.lat, longitude: p.lng, placeId: null });
                  setPlaced(true);
                }}
                onRadiusChange={(r) => set('radiusM', Math.min(geo.maxRadiusM, Math.max(geo.minRadiusM, r)))}
                onAddress={(a) => setF((cur) => (cur && !cur.address ? { ...cur, address: a } : cur))}
              />
              <div className="flex flex-wrap items-center gap-2 rounded-md bg-gray-50 px-3 py-2 text-body-sm">
                <Badge dot tone={f.placeId ? 'green' : placed ? 'blue' : 'gray'}>{f.placeId ? 'Resolved from Google place' : placed ? 'Placed on the map' : 'Not placed yet'}</Badge>
                <span className="tabular text-gray-700">{f.latitude.toFixed(6)}, {f.longitude.toFixed(6)}</span>
                {f.address && <span className="min-w-0 truncate text-gray-500">· {f.address}</span>}
              </div>
              <p className="text-xs text-gray-500">Map imagery can be a few metres off GPS. Check the point on site before relying on a small radius.</p>
            </div>
          ) : (
            <div className="space-y-3">
              <MapSetupNotice refused={refused} />
              <SchematicMap center={center} radiusM={f.radiusM} height={300} />
            </div>
          )}
        </Card>

        <Card className="xl:col-span-2" title="Details">
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate();
            }}
          >
            <Field label="Name">
              <Input required value={f.name} onChange={(e) => set('name', e.target.value)} />
            </Field>
            <Field label="Address">
              <Input value={f.address} onChange={(e) => set('address', e.target.value)} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Latitude">
                <Input type="number" step="any" min={-90} max={90} required value={f.latitude} onChange={(e) => set('latitude', Number(e.target.value))} className="tabular" />
              </Field>
              <Field label="Longitude">
                <Input type="number" step="any" min={-180} max={180} required value={f.longitude} onChange={(e) => set('longitude', Number(e.target.value))} className="tabular" />
              </Field>
            </div>
            <Field label="Permitted radius" hint={`Allowed ${geo.minRadiusM}–${geo.maxRadiusM} m. Smaller radii need good GPS accuracy; readings worse than the configured accuracy limit never unlock attendance.`}>
              <div className="flex flex-wrap items-center gap-2">
                {geo.presetsM.map((r: number) => (
                  <button
                    type="button"
                    key={r}
                    onClick={() => set('radiusM', r)}
                    aria-pressed={f.radiusM === r}
                    className={cx('h-9 rounded-md border px-3 text-sm font-medium', f.radiusM === r ? 'border-navy-700 bg-navy-50 text-navy-800' : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50')}
                  >
                    {r} m
                  </button>
                ))}
                <Input type="number" aria-label="Custom radius in metres" min={geo.minRadiusM} max={geo.maxRadiusM} step="any" value={f.radiusM} onChange={(e) => set('radiusM', Number(e.target.value))} className="w-24 tabular" />
                <span className="text-sm text-gray-500">m</span>
              </div>
              {f.radiusM < 50 && (
                <p className="mt-2 text-xs text-amber-800">
                  Under the 50 m minimum. Indoor phone GPS is often 30–60 m off, so genuine workers would be rejected at the door. Choose 100 m (recommended) or at least 50 m before saving.
                </p>
              )}
            </Field>
            <Field label="Time zone">
              <Input list="tz-list" value={f.timezone} onChange={(e) => set('timezone', e.target.value)} required />
              <datalist id="tz-list">
                {TIMEZONES.map((tz) => (
                  <option key={tz} value={tz} />
                ))}
              </datalist>
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Default arrival grace (min)">
                <Input type="number" min={0} max={240} value={f.defaultGraceMinutes} onChange={(e) => set('defaultGraceMinutes', Number(e.target.value))} />
              </Field>
              <Field label="Prolonged-absence alert after (min)" hint="Shifts can override this.">
                <Input type="number" min={1} max={480} list="absence-presets" value={f.absenceThresholdMinutes} onChange={(e) => set('absenceThresholdMinutes', Number(e.target.value))} />
                <datalist id="absence-presets">
                  {[5, 10, 15, 30].map((m) => (
                    <option key={m} value={m} />
                  ))}
                </datalist>
              </Field>
            </div>
            <Field label="Staff needed per day" hint="Optional. Rosters flag days with fewer people.">
              <Input type="number" min={0} max={10000} value={f.minStaff} onChange={(e) => set('minStaff', e.target.value)} className="w-28 tabular" placeholder="—" />
            </Field>
            {!isNew && (
              <Field label="Reason for change (audit log)" hint={wp.data?.open_sessions ? `${wp.data.open_sessions} employee session(s) are open. Geofence changes apply from their next location update; recorded attendance is not changed.` : undefined}>
                <Textarea value={f.reason} onChange={(e) => set('reason', e.target.value)} placeholder="e.g. Marker moved to the main gate" />
              </Field>
            )}
            {isNew && !placed && mapsUsable && <p className="text-xs text-amber-700">Search for an address or click the map to place the workplace.</p>}
            <InlineError error={save.error ?? toggle.error} />
            <div className="flex items-center gap-2">
              <Button type="submit" variant="primary" loading={save.isPending}>
                {isNew ? 'Create workplace' : 'Save changes'}
              </Button>
              {save.isSuccess && !isNew && <span className="text-xs text-teal-700">Saved — version {(save.data as any)?.config_version}</span>}
            </div>
          </form>
        </Card>
      </div>
      {!isNew && wp.data && <SupervisorsCard workplaceId={id} current={(wp.data.supervisors ?? []).map((s: any) => s.id)} />}
      {!isNew && wp.data && (
        <div className="mt-6 grid gap-6 lg:grid-cols-2">
          <Card title="Shifts at this workplace" actions={<Link className="text-xs font-medium text-primary-700 hover:underline" href="/shifts">Manage shifts</Link>}>
            {wp.data.shifts.length ? (
              <ul className="space-y-1 text-sm">
                {wp.data.shifts.map((s: any) => (
                  <li key={s.id} className="flex justify-between">
                    <span>{s.name}</span>
                    <span className="tabular text-gray-600">
                      {s.start_time.slice(0, 5)}–{s.end_time.slice(0, 5)} {s.is_active ? '' : '(disabled)'}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-gray-500">No shifts yet.</p>
            )}
          </Card>
          <Card title="Assigned employees" actions={<Link className="text-xs font-medium text-primary-700 hover:underline" href="/employees">Manage employees</Link>}>
            {wp.data.employees.length ? (
              <ul className="space-y-1 text-sm">
                {wp.data.employees.map((e: any) => (
                  <li key={e.id}>
                    {e.full_name} <span className="text-xs text-gray-500">{e.employee_code}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-gray-500">Nobody is assigned yet.</p>
            )}
          </Card>
        </div>
      )}
    </>
  );
}
