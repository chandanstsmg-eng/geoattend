/**
 * RFC 4180 CSV with spreadsheet formula-injection protection: cells that would
 * start with = + - @ (or tab/CR) are prefixed with an apostrophe.
 */
export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  let s = v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(headers: string[], rows: unknown[][]): string {
  return '﻿' + [headers, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

/** Consecutive date ranges covering [from, to], for reading a long period a piece at a time. */
export function dateChunks(from: string, to: string, days = 14) {
  const out: Array<{ from: string; to: string }> = [];
  const day = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 86_400_000;
  const iso = (n: number) => new Date(n * 86_400_000).toISOString().slice(0, 10);
  for (let d = day(from); d <= day(to); d += days) out.push({ from: iso(d), to: iso(Math.min(d + days - 1, day(to))) });
  return out;
}

/**
 * Writes a CSV as it is produced, one date range at a time, so a long export never sits in memory.
 * Stops if the client has gone. `record` runs with the row count before the response ends, so a
 * download never completes without its audit entry; if it fails, the connection is cut instead.
 */
export async function streamCsv(res: { write(s: string): boolean; once(e: string, f: () => void): unknown; writableEnded?: boolean; destroyed?: boolean; end(): unknown }, headers: string[], pieces: Array<() => Promise<unknown[][]>>, record?: (rows: number) => Promise<unknown>) {
  const line = (r: unknown[]) => `${r.map(csvCell).join(',')}\r\n`;
  const write = (s: string) => (res.write(s) ? Promise.resolve() : new Promise<void>((resolve) => { res.once('drain', resolve); res.once('close', resolve); }));
  let rows = 0;
  await write(`\uFEFF${line(headers)}`);
  for (const piece of pieces) {
    if (res.destroyed) break;
    const batch = await piece();
    rows += batch.length;
    if (batch.length) await write(batch.map(line).join(''));
  }
  await record?.(rows);
  res.end();
  return rows;
}
