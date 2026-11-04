/**
 * Check-ins and check-outs saved on the phone until the server answers. The rules are in engine.ts;
 * this file adds the phone's storage, the saved photos and the real requests.
 *
 * The photo is copied out of the cache into the app's documents folder, where Android will not clear it.
 * Nothing here is removed when the sign-in is lost or the employee signs out.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Directory, File, Paths } from 'expo-file-system';
import { api } from '../api/client';
import type { IntentResponse, SessionStatus } from '../api/types';
import { qk, queryClient } from '../queryClient';
import { getCachedUser } from '../secure';
import { publish, withLock } from '../tracking/store';
import { addEvent, dismissEvent, emptyOutbox, pendingFor, retryEvent, runOutbox, trimSynced, type CheckInPayload, type EventKind, type OutboxEvent, type OutboxResult, type OutboxState } from './engine';
import { putPhoto } from './upload';

const KEY = 'geoattend.outbox.v1';
const folder = () => new Directory(Paths.document, 'outbox');

async function read(): Promise<OutboxState> {
  const raw = await AsyncStorage.getItem(KEY); // a read failure throws: never treat it as an empty list
  if (!raw) return emptyOutbox();
  try {
    const s = JSON.parse(raw) as OutboxState;
    return Array.isArray(s.events) ? s : emptyOutbox();
  } catch {
    await AsyncStorage.setItem(`${KEY}.corrupt.${Date.now()}`, raw); // kept for support, and never overwritten
    return emptyOutbox();
  }
}

function show(s: OutboxState) {
  publish({ events: s.events });
}

function update(fn: (s: OutboxState) => OutboxState): Promise<OutboxState> {
  return withLock(async () => {
    const before = await read();
    const next = fn(before);
    if (next !== before) {
      await AsyncStorage.setItem(KEY, JSON.stringify(next));
      show(next);
    }
    return next;
  });
}

export const reloadOutbox = async () => show(await read());
export const hasPending = (s: OutboxState, sessionId: string, kind: EventKind) => pendingFor(s, sessionId, kind) !== null;

function removePhoto(e: OutboxEvent) {
  if (!e.checkIn) return;
  const f = new File(e.checkIn.photoUri);
  if (f.exists) f.delete();
}

/** Saves a check-in that could not reach the server. Throws if it could not be stored, so the employee is never told otherwise. */
export async function saveCheckIn(input: { id: string; status: SessionStatus; photoUri: string; sizeBytes: number; evidence: CheckInPayload['evidence']; device: CheckInPayload['device'] }) {
  const user = await getCachedUser();
  if (!user) throw new Error('You are signed out. Sign in and try again.');
  const dir = folder();
  dir.create({ intermediates: true, idempotent: true });
  const saved = new File(dir, `${input.id}.jpg`);
  if (!saved.exists) new File(input.photoUri).copy(saved);
  await update((s) =>
    addEvent(s, {
      id: input.id,
      kind: 'CHECK_IN',
      userId: user.id,
      sessionId: input.status.session.id,
      shiftName: input.status.session.shiftName,
      capturedAt: input.evidence.clientTime,
      checkIn: { photoUri: saved.uri, sizeBytes: input.sizeBytes, evidence: input.evidence, device: input.device },
    }),
  );
}

export async function saveCheckOut(id: string, status: SessionStatus, endedAt: string) {
  const user = await getCachedUser();
  if (!user) throw new Error('You are signed out. Sign in and try again.');
  await update((s) => addEvent(s, { id, kind: 'CHECK_OUT', userId: user.id, sessionId: status.session.id, shiftName: status.session.shiftName, capturedAt: endedAt, checkOut: { endedAt } }));
}

async function send(e: OutboxEvent, progress: (p: Pick<OutboxEvent, 'photoId' | 'uploaded'>) => Promise<void>) {
  if (e.kind === 'CHECK_OUT') {
    await api(`/tracking/sessions/${e.sessionId}/end`, { method: 'POST', body: { endedAt: e.checkOut!.endedAt } });
    return;
  }
  const c = e.checkIn!;
  if (!new File(c.photoUri).exists) throw { status: 422, code: 'PHOTO_LOST', message: 'The saved photo is no longer on this phone. Ask your manager to correct the record.' };
  let { photoId, uploaded } = e;
  if (!photoId || !uploaded) {
    const intent = await api<IntentResponse>('/attendance/intents', { method: 'POST', body: { sessionId: e.sessionId, idempotencyKey: e.id, contentType: 'image/jpeg', sizeBytes: c.sizeBytes, capturedOffline: true } });
    photoId = intent.photoId;
    await putPhoto(c.photoUri, intent.upload);
    uploaded = true;
    await progress({ photoId, uploaded });
  }
  await api('/attendance', { method: 'POST', timeoutMs: 45_000, body: { sessionId: e.sessionId, photoId, idempotencyKey: e.id, evidence: c.evidence, device: c.device, capturedOffline: true } });
}

let running: Promise<OutboxResult> | null = null;

/** Sends what is due. Single-flight, and safe to call from anywhere, including the background task. */
export function syncOutbox(): Promise<OutboxResult> {
  running ??= (async () => {
    publish({ syncing: true });
    try {
      const r = await runOutbox({
        update,
        send,
        userId: async () => (await getCachedUser())?.id ?? null,
        now: Date.now,
        cleanup: async (e) => removePhoto(e),
      });
      publish({ syncBlocked: r.stopped === 'blocked' ? r.message : null });
      if (r.sent) {
        void queryClient.invalidateQueries({ queryKey: qk.status });
        void queryClient.invalidateQueries({ queryKey: qk.history });
        void queryClient.invalidateQueries({ queryKey: qk.assignment });
      }
      await update((s) => {
        const { state, removed } = trimSynced(s);
        return removed.length ? state : s;
      });
      return r;
    } finally {
      publish({ syncing: false });
    }
  })().finally(() => {
    running = null;
  });
  return running;
}

export async function retrySaved(id: string) {
  await update((s) => retryEvent(s, id));
  return syncOutbox();
}

/** Removes a refused or sent event, and its photo, at the employee's request. A pending event cannot be removed. */
export async function dismissSaved(id: string) {
  let gone: OutboxEvent | undefined;
  await update((s) => {
    gone = s.events.find((e) => e.id === id && e.status !== 'PENDING');
    return dismissEvent(s, id);
  });
  if (gone) removePhoto(gone);
}
