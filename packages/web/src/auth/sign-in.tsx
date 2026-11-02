import type { Session } from '@retainer/shared';
import { type FormEvent, useState } from 'react';
import { api } from '../api/client.js';
import { Button, Input, Label, Muted, Notice, SignInFrame, Stack } from '../ui/index.js';
export function SignIn({ onSession }: { onSession: (session: Session) => void }) {
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const input = form.elements.namedItem('key') as HTMLInputElement;
    let key = input.value.trim();
    input.value = '';
    setBusy(true);
    try {
      const request = api.signIn(key);
      key = '';
      onSession(await request);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <SignInFrame>
      <form onSubmit={(e) => void submit(e)}>
        <Stack>
          <Label htmlFor="key">
            Personal API key
            <Input
              id="key"
              name="key"
              type="password"
              autoComplete="off"
              required
              autoFocus
              disabled={busy}
            />
          </Label>
          {error ? <Notice error>{error}</Notice> : null}
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </Button>
          <Muted>
            Your operator can issue a personal user key. It is never saved in browser storage.
          </Muted>
        </Stack>
      </form>
    </SignInFrame>
  );
}
