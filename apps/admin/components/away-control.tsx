'use client';
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { put } from '@/lib/api';
import { todayISO } from '@/lib/format';
import { Button, Field, InlineError, Input, Modal } from './ui';

export const isAway = (awayUntil: string | null | undefined) => !!awayUntil && awayUntil >= todayISO();

/** Saves "I'm away until…" (or clears it with null). */
export function useSetAway(onDone?: () => void) {
  const qc = useQueryClient();
  return useMutation({ meta: { toastError: true },
    mutationFn: (value: string | null) => put('/team/me/away', { awayUntil: value }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['me'] });
      onDone?.();
    },
  });
}

/** "I'm away until…" — push and e-mail alerts pause; anything waiting a day goes to the owners. */
export function AwayDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [until, setUntil] = useState(todayISO());
  const save = useSetAway(() => onOpenChange(false));
  return (
    <Modal open={open} onOpenChange={onOpenChange} title="Going away?" description="Push and e-mail alerts stop until you are back. Anything waiting more than a day is raised to the company owners, so nothing gets stuck.">
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); save.mutate(until); }}>
        <Field label="Away until (including)" required><Input type="date" required min={todayISO()} value={until} onChange={(e) => setUntil(e.target.value)} /></Field>
        <InlineError error={save.error} />
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending}>Save</Button>
        </div>
      </form>
    </Modal>
  );
}
