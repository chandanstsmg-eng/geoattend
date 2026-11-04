'use client';
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Upload } from 'lucide-react';
import { get, post } from '@/lib/api';
import { Badge, Button, Field, InlineError, Modal, Select, Textarea } from '@/components/ui';
import { useWorkplaces } from '@/components/filters';

type Row = { fullName: string; email: string; employeeCode: string; phone?: string; department?: string; designation?: string };
type Result = { row: number; ok: boolean; id?: string; fullName?: string; email: string; employeeCode?: string; temporaryPassword?: string; error?: string };

const TEMPLATE = 'Full name,Email,Employee ID,Phone,Department,Designation\nRavi Kumar,ravi@example.com,EMP-101,9800000001,Stores,Helper\n';

/** Minimal CSV reader: commas, quoted fields, doubled quotes, CRLF. */
export function parseCsv(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') (cell += '"'), i++;
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',' || ch === '\t') (row.push(cell), (cell = ''));
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      if (row.some((c) => c.trim())) out.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim())) out.push(row);
  return out;
}

// Header names people actually use, mapped to API fields.
const HEADERS: Record<string, keyof Row> = {
  'full name': 'fullName', name: 'fullName', 'employee name': 'fullName',
  email: 'email', 'e-mail': 'email', 'email address': 'email',
  'employee id': 'employeeCode', 'employee code': 'employeeCode', code: 'employeeCode', id: 'employeeCode', 'emp id': 'employeeCode',
  phone: 'phone', mobile: 'phone', 'phone number': 'phone', 'mobile number': 'phone',
  department: 'department', dept: 'department',
  designation: 'designation', role: 'designation', title: 'designation',
};

function toRows(text: string): { rows: Row[]; missing: string[] } {
  const [head, ...body] = parseCsv(text.trim());
  if (!head) return { rows: [], missing: [] };
  const cols = head.map((h) => HEADERS[h.trim().toLowerCase()]);
  const missing = (['fullName', 'email', 'employeeCode'] as const).filter((k) => !cols.includes(k)).map((k) => ({ fullName: 'Full name', email: 'Email', employeeCode: 'Employee ID' })[k]);
  const rows = body.map((cells) => {
    const r: any = {};
    cols.forEach((k, i) => k && (r[k] = (cells[i] ?? '').trim()));
    return r as Row;
  });
  return { rows, missing };
}

function download(name: string, csv: string) {
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  a.click();
  URL.revokeObjectURL(url);
}

const cell = (v: unknown) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) || /^[=+\-@]/.test(s) ? `"${s.replace(/^([=+\-@])/, "'$1").replaceAll('"', '""')}"` : s;
};

export function ImportEmployees({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const wps = useWorkplaces();
  const [text, setText] = useState('');
  const [workplaceId, setWorkplaceId] = useState('');
  const [shiftId, setShiftId] = useState('');
  const [results, setResults] = useState<{ created: number; failed: number; results: Result[] } | null>(null);
  const shifts = useQuery({ queryKey: ['shifts', workplaceId], queryFn: () => get<any[]>(`/shifts?workplaceId=${workplaceId}`), enabled: !!workplaceId });
  const parsed = useMemo(() => toRows(text), [text]);

  const run = useMutation({
    mutationFn: () => post('/employees/import', { rows: parsed.rows, workplaceId: workplaceId || undefined, shiftId: shiftId || undefined }),
    onSuccess: (r: any) => {
      setResults(r);
      qc.invalidateQueries({ queryKey: ['employees'] });
    },
  });

  const close = () => {
    setText('');
    setResults(null);
    run.reset();
    onClose();
  };

  return (
    <Modal open={open} onOpenChange={(o) => !o && close()} wide title="Import employees" description="Paste rows from Excel or upload a CSV. Each employee gets a temporary password and is asked to change it at first sign-in.">
      {results ? (
        <div className="space-y-3">
          <p className="text-sm">
            <Badge tone="green">{results.created} created</Badge> {results.failed > 0 && <Badge tone="red">{results.failed} not created</Badge>}
          </p>
          {results.created > 0 && (
            <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
              Download the sign-in details now. Temporary passwords are shown only once.
              <div className="mt-2">
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() =>
                    download(
                      'employee-sign-in-details.csv',
                      ['Full name,Email,Employee ID,Temporary password', ...results.results.filter((r) => r.ok).map((r) => [r.fullName, r.email, r.employeeCode, r.temporaryPassword].map(cell).join(','))].join('\n'),
                    )
                  }
                >
                  <Download className="h-4 w-4" aria-hidden /> Download sign-in details
                </Button>
              </div>
            </div>
          )}
          <div className="max-h-72 overflow-y-auto rounded-md border border-gray-200">
            <table className="w-full text-sm">
              <tbody>
                {results.results.map((r) => (
                  <tr key={r.row} className="border-b border-gray-100 last:border-0">
                    <td className="w-12 px-3 py-1.5 text-xs text-gray-500">#{r.row}</td>
                    <td className="px-3 py-1.5">{r.fullName ?? r.email}</td>
                    <td className="px-3 py-1.5">{r.ok ? <Badge tone="green">created</Badge> : <span className="text-xs text-red-700">{r.error}</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex justify-end">
            <Button variant="primary" onClick={close}>Done</Button>
          </div>
        </div>
      ) : (
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); run.mutate(); }}>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-gray-300 bg-white px-3 py-1.5 hover:bg-gray-50">
              <Upload className="h-4 w-4" aria-hidden /> Choose CSV file
              <input type="file" accept=".csv,text/csv,text/plain" className="sr-only" onChange={async (e) => setText((await e.target.files?.[0]?.text()) ?? '')} />
            </label>
            <button type="button" className="text-primary-700 underline" onClick={() => download('employees-template.csv', TEMPLATE)}>Download template</button>
          </div>
          <Field label="Rows" hint="First line must be the column names: Full name, Email, Employee ID (required), Phone, Department, Designation.">
            <Textarea rows={7} value={text} onChange={(e) => setText(e.target.value)} placeholder={TEMPLATE} className="font-mono text-xs" />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Assign everyone to workplace">
              <Select value={workplaceId} onChange={(e) => { setWorkplaceId(e.target.value); setShiftId(''); }}>
                <option value="">Later</option>
                {wps.data?.filter((w: any) => w.is_active).map((w: any) => <option key={w.id} value={w.id}>{w.name}</option>)}
              </Select>
            </Field>
            <Field label="…and shift">
              <Select value={shiftId} disabled={!workplaceId} onChange={(e) => setShiftId(e.target.value)}>
                <option value="">Later</option>
                {shifts.data?.filter((s) => s.is_active).map((s) => <option key={s.id} value={s.id}>{s.name} ({s.start_time.slice(0, 5)}–{s.end_time.slice(0, 5)})</option>)}
              </Select>
            </Field>
          </div>
          {text.trim() && (
            <p className="text-sm text-gray-700">
              {parsed.missing.length ? (
                <span className="text-red-700">Missing column{parsed.missing.length > 1 ? 's' : ''}: {parsed.missing.join(', ')}</span>
              ) : (
                <>Ready to import <strong>{parsed.rows.length}</strong> employee{parsed.rows.length === 1 ? '' : 's'}{parsed.rows.length > 500 ? ' — at most 500 at a time' : ''}.</>
              )}
            </p>
          )}
          <InlineError error={run.error} />
          <div className="flex justify-end gap-2">
            <Button type="button" onClick={close}>Cancel</Button>
            <Button type="submit" variant="primary" loading={run.isPending} disabled={!parsed.rows.length || parsed.missing.length > 0 || parsed.rows.length > 500}>
              Import
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
