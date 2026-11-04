'use client';
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { post } from '@/lib/api';
import { Button, Card, Field, InlineError, Input } from '@/components/ui';

/** Shown instead of the dashboard while an administrator is on a temporary password; the API refuses other changes until then. */
export function ChangePassword() {
  const qc = useQueryClient();
  const [f, setF] = useState({ currentPassword: '', newPassword: '' });
  const change = useMutation({
    meta: { success: 'Password changed' },
    mutationFn: () => post('/auth/change-password', f),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['me'] }),
  });
  return (
    <div className="mx-auto mt-20 max-w-md px-4">
      <Card title="Choose your own password" description="You signed in with a temporary password. Choose a new one to continue.">
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); change.mutate(); }}>
          <Field label="Temporary password"><Input type="password" autoComplete="current-password" required value={f.currentPassword} onChange={(e) => setF({ ...f, currentPassword: e.target.value })} /></Field>
          <Field label="New password" hint="At least 10 characters, with letters and numbers."><Input type="password" autoComplete="new-password" required minLength={10} value={f.newPassword} onChange={(e) => setF({ ...f, newPassword: e.target.value })} /></Field>
          <InlineError error={change.error} />
          <Button type="submit" variant="primary" loading={change.isPending}>Change password</Button>
        </form>
      </Card>
    </div>
  );
}
