'use client';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, ArchiveRestore, Megaphone, Pencil, Pin, PinOff, Plus, Send } from 'lucide-react';
import { get, patch, post, qs } from '@/lib/api';
import { ago, fmtDateTime } from '@/lib/format';
import { Badge, Button, Callout, ConfirmButton, cx, EmptyState, Field, InlineError, Input, Modal, PageHeader, QueryState, SearchInput, Select, Tabs, Textarea, Toolbar } from '@/components/ui';
import { WorkplaceSelect, useWorkplaces } from '@/components/filters';
import { useMe } from '@/lib/me';

type Status = 'live' | 'archived';

function Composer({ initial, onDone }: { initial?: any; onDone: () => void }) {
  const qc = useQueryClient();
  const { isOwner } = useMe();
  const wps = useWorkplaces();
  const [f, setF] = useState({ title: initial?.title ?? '', body: initial?.body ?? '', workplaceId: initial?.workplace_id ?? '', pinned: initial?.pinned ?? false });
  const save = useMutation({ meta: { success: 'Announcement saved' },
    mutationFn: () => (initial ? patch(`/broadcasts/${initial.id}`, { title: f.title, body: f.body, pinned: f.pinned }) : post('/broadcasts', { title: f.title, body: f.body, workplaceId: f.workplaceId || null, pinned: f.pinned })),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['broadcasts'] });
      onDone();
    },
  });
  return (
    <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
      {!initial && (
        <Field label="Audience">
          <Select value={f.workplaceId} onChange={(e) => setF({ ...f, workplaceId: e.target.value })} required={!isOwner}>
            {isOwner ? <option value="">Everyone in the company</option> : <option value="">Choose a workspace…</option>}
            {wps.data?.filter((w: any) => w.is_active).map((w: any) => <option key={w.id} value={w.id}>Everyone at {w.name}</option>)}
          </Select>
        </Field>
      )}
      <Field label="Title"><Input required maxLength={120} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="e.g. Site closed on Friday" /></Field>
      <Field label="Announcement" hint={`${f.body.length} / 2000`}><Textarea required rows={6} maxLength={2000} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} /></Field>
      <label className="flex items-center gap-2 text-sm text-gray-700">
        <input type="checkbox" checked={f.pinned} onChange={(e) => setF({ ...f, pinned: e.target.checked })} /> Pin to the top
      </label>
      <InlineError error={save.error} />
      <div className="flex justify-end gap-2">
        <Button type="button" onClick={onDone}>Cancel</Button>
        <Button type="submit" variant="primary" loading={save.isPending}>
          {initial ? 'Save changes' : <><Send className="h-4 w-4" aria-hidden /> Publish</>}
        </Button>
      </div>
    </form>
  );
}

function Detail({ a, canManage, onEdit, onClose }: { a: any; canManage: boolean; onEdit: () => void; onClose: () => void }) {
  const qc = useQueryClient();
  const reads = useQuery({ queryKey: ['broadcasts', 'reads', a.id], queryFn: () => get<any[]>(`/broadcasts/${a.id}/reads`) });
  const act = useMutation({ meta: { success: 'Announcement updated', toastError: true },
    mutationFn: (body: { pinned?: boolean; archived?: boolean }) => ('archived' in body ? post(`/broadcasts/${a.id}/archive`, { archived: body.archived }) : patch(`/broadcasts/${a.id}`, body)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['broadcasts'] });
      onClose();
    },
  });
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-1.5 text-xs text-gray-500">
        {a.pinned && !a.archived_at && <Badge tone="blue"><Pin className="h-3 w-3" aria-hidden /> Pinned</Badge>}
        {a.archived_at && <Badge tone="gray">Archived</Badge>}
        <span>{a.workplace_name ? `Everyone at ${a.workplace_name}` : 'Everyone in the company'}</span>
        <span aria-hidden>·</span>
        <span>{a.sent_by ?? '—'}</span>
        {a.updated_at && <span>· edited {ago(a.updated_at)}{a.updated_by_name ? ` by ${a.updated_by_name}` : ''}</span>}
      </div>
      <p className="whitespace-pre-wrap text-title leading-relaxed text-gray-900">{a.body}</p>
      <details className="rounded-md border border-gray-200">
        <summary className="cursor-pointer px-3 py-2 text-body-sm font-medium text-gray-700">Read by {a.read_count} of {a.recipients}</summary>
        <div className="border-t border-gray-200 px-3 py-2">
          <QueryState query={reads} isEmpty={(r) => r.length === 0} empty={<p className="py-2 text-sm text-gray-500">No recipients.</p>}>
            {(rows) => (
              <ul className="max-h-60 divide-y divide-gray-100 overflow-y-auto text-sm">
                {rows.map((x) => (
                  <li key={x.employee_id} className="flex items-center gap-2 py-1.5">
                    <span className="flex-1">{x.full_name} <span className="text-xs text-gray-500">{x.employee_code}</span></span>
                    {x.read_at ? <Badge tone="green">read {ago(x.read_at)}</Badge> : <Badge tone="gray">unread</Badge>}
                  </li>
                ))}
              </ul>
            )}
          </QueryState>
        </div>
      </details>
      <InlineError error={act.error} />
      {canManage && (
        <div className="flex flex-wrap justify-end gap-2">
          {!a.archived_at && (
            <>
              <Button size="sm" onClick={() => act.mutate({ pinned: !a.pinned })} loading={act.isPending}>
                {a.pinned ? <><PinOff className="h-4 w-4" aria-hidden /> Unpin</> : <><Pin className="h-4 w-4" aria-hidden /> Pin</>}
              </Button>
              <Button size="sm" onClick={onEdit}><Pencil className="h-4 w-4" aria-hidden /> Edit</Button>
            </>
          )}
          {a.archived_at ? (
            <Button size="sm" onClick={() => act.mutate({ archived: false })}><ArchiveRestore className="h-4 w-4" aria-hidden /> Restore</Button>
          ) : (
            <ConfirmButton size="sm" title="Archive this announcement?" description="Workers will no longer see it. It stays in the archive with its read receipts and can be restored." confirmLabel="Archive" onConfirm={() => act.mutate({ archived: true })}>
              <Archive className="h-4 w-4" aria-hidden /> Archive
            </ConfirmButton>
          )}
        </div>
      )}
    </div>
  );
}

export default function AnnouncementsPage() {
  const { me, isOwner } = useMe();
  const canPublish = !!me?.permissions?.publishAnnouncements;
  const [status, setStatus] = useState<Status>('live');
  const [search, setSearch] = useState('');
  const [workplaceId, setWorkplaceId] = useState('');
  const [compose, setCompose] = useState(false);
  const [open, setOpen] = useState<any | null>(null);
  const [editing, setEditing] = useState<any | null>(null);
  const list = useQuery({ queryKey: ['broadcasts', status, search, workplaceId], queryFn: () => get<any[]>(`/broadcasts${qs({ status, search, workplaceId })}`), placeholderData: (p) => p });
  const canManage = (a: any) => canPublish && (isOwner || a.created_by === me?.user.id);

  return (
    <>
      <PageHeader
        title="Announcements"
        actions={canPublish && <Button variant="primary" onClick={() => setCompose(true)}><Plus className="h-4 w-4" aria-hidden /> New announcement</Button>}
      />
      {!canPublish && <Callout tone="neutral" className="mb-4">The owner has turned off announcements by supervisors. You can still read them here.</Callout>}
      <section className="rounded-lg border border-gray-200 bg-white shadow-card">
        <Toolbar>
          <Tabs variant="segmented" label="Status" value={status} onChange={setStatus} tabs={[{ value: 'live', label: 'Published' }, { value: 'archived', label: 'Archived' }]} />
          <SearchInput aria-label="Search announcements" placeholder="Search" value={search} onChange={(e) => setSearch(e.target.value)} className="sm:w-64" />
          <WorkplaceSelect value={workplaceId} onChange={setWorkplaceId} allLabel="All audiences" />
        </Toolbar>
        <QueryState
          query={list}
          isEmpty={(d) => d.length === 0}
          empty={
            <EmptyState title={search || workplaceId ? 'Nothing matches' : status === 'archived' ? 'No archived announcements' : 'No announcements yet'} icon={<Megaphone aria-hidden />} action={canPublish && status === 'live' && !search ? <Button variant="primary" onClick={() => setCompose(true)}>Publish the first one</Button> : undefined} />
          }
        >
          {(rows) => (
            <ul className="divide-y divide-gray-100">
              {rows.map((a) => (
                <li key={a.id}>
                  <button type="button" onClick={() => setOpen(a)} className={cx('flex w-full gap-3 px-4 py-3.5 text-left hover:bg-gray-50 sm:px-5', a.pinned && !a.archived_at && 'bg-amber-50/50')}>
                    <span className={cx('mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full', a.pinned && !a.archived_at ? 'bg-amber-100 text-amber-700' : 'bg-navy-50 text-navy-700')} aria-hidden>
                      {a.pinned && !a.archived_at ? <Pin className="h-4 w-4" /> : <Megaphone className="h-4 w-4" />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-baseline gap-x-2">
                        <span className="font-semibold text-navy-900">{a.title}</span>
                        <span className="ml-auto whitespace-nowrap text-xs text-gray-500" title={fmtDateTime(a.created_at)}>{ago(a.created_at)}</span>
                      </span>
                      <span className="mt-0.5 line-clamp-2 block text-body-sm text-gray-600">{a.body}</span>
                      <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-gray-500">
                        <span>{a.workplace_name ?? 'Everyone'}</span>
                        <span aria-hidden>·</span>
                        <span>{a.sent_by ?? '—'}</span>
                        <Badge dot tone={a.read_count >= a.recipients && a.recipients > 0 ? 'green' : 'gray'}>{a.read_count}/{a.recipients} read</Badge>
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </QueryState>
      </section>

      <Modal open={compose} onOpenChange={setCompose} title="New announcement" description="Workers see it in their app straight away.">
        {compose && <Composer onDone={() => setCompose(false)} />}
      </Modal>
      <Modal open={!!open} onOpenChange={(o) => !o && setOpen(null)} title={open?.title ?? ''} description={open ? fmtDateTime(open.created_at) : undefined}>
        {open && <Detail a={open} canManage={canManage(open)} onEdit={() => { setEditing(open); setOpen(null); }} onClose={() => setOpen(null)} />}
      </Modal>
      <Modal open={!!editing} onOpenChange={(o) => !o && setEditing(null)} title="Edit announcement">
        {editing && <Composer initial={editing} onDone={() => setEditing(null)} />}
      </Modal>
    </>
  );
}
