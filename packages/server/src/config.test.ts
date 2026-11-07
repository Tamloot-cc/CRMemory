import { describe, expect, it } from 'vitest';
import {
  accountsConfig,
  accountsMode,
  CONTROL_ROLE,
  loadConfig,
  ownerDatabaseUrl,
  publicOriginSchema,
  RUNTIME_ROLE,
} from './config.js';
import { runtimeConnection } from './db/client.js';

describe('public browser origin configuration', () => {
  it('normalizes an explicit origin and allows an unset Compose variable', () => {
    expect(publicOriginSchema.parse('https://Retainer.example:443/')).toBe(
      'https://retainer.example',
    );
    expect(
      loadConfig({ DATABASE_URL: 'postgres://localhost/test', RETAINER_PUBLIC_ORIGIN: '' })
        .RETAINER_PUBLIC_ORIGIN,
    ).toBeUndefined();
  });
  it('rejects values that are not HTTP origins', () => {
    for (const origin of [
      'null',
      'file:///tmp/app',
      'https://user:pass@retainer.example',
      'https://retainer.example/app',
      'https://retainer.example?x=1',
      'https://retainer.example/#x',
    ])
      expect(publicOriginSchema.safeParse(origin).success).toBe(false);
  });
});

describe('database URLs', () => {
  const runtime = 'postgres://retainer_app:s3cret@localhost/test';

  it('needs at least one of the two URLs', () => {
    expect(() => loadConfig({})).toThrow(
      'set DATABASE_URL, RETAINER_RUNTIME_DATABASE_URL or RETAINER_CONTROL_DATABASE_URL',
    );
    expect(() => loadConfig({ DATABASE_URL: '' })).toThrow('DATABASE_URL');
  });

  it('runs the API on the runtime URL alone, without the owner', () => {
    const config = loadConfig({ RETAINER_RUNTIME_DATABASE_URL: runtime });
    expect(runtimeConnection(config)).toEqual({ url: runtime });
    expect(() => ownerDatabaseUrl(config)).toThrow('DATABASE_URL is required');
  });

  it('switches to the runtime role on the owner URL when no runtime URL is set', () => {
    const config = loadConfig({ DATABASE_URL: 'postgres://retainer:pw@localhost/test' });
    expect(runtimeConnection(config)).toEqual({
      url: 'postgres://retainer:pw@localhost/test',
      role: RUNTIME_ROLE,
    });
  });

  it('refuses a runtime URL for another role, or without a usable password', () => {
    const load = (url: string) => () => loadConfig({ RETAINER_RUNTIME_DATABASE_URL: url });
    expect(load('postgres://retainer:pw@localhost/test')).toThrow('log in as retainer_app');
    for (const url of [
      'postgres://retainer_app@localhost/test',
      'postgres://retainer_app:two%20words@localhost/test',
      'postgres://retainer_app:p%C3%A4ss@localhost/test',
    ])
      expect(load(url)).toThrow('include a password of printable ASCII');
  });
});

describe('accounts mode', () => {
  const base = { DATABASE_URL: 'postgres://retainer:pw@localhost/test' };
  const secret = 'a'.repeat(32);

  it('is off without a secret, and on with one', () => {
    expect(accountsMode(loadConfig(base))).toBe(false);
    expect(accountsMode(loadConfig({ ...base, RETAINER_AUTH_SECRET: secret }))).toBe(true);
  });

  it('refuses a Google client without the secret, or half a client', () => {
    expect(() =>
      loadConfig({
        ...base,
        RETAINER_GOOGLE_CLIENT_ID: 'id',
        RETAINER_GOOGLE_CLIENT_SECRET: 'shh',
      }),
    ).toThrow('a Google client needs RETAINER_AUTH_SECRET too');
    expect(() =>
      loadConfig({ ...base, RETAINER_AUTH_SECRET: secret, RETAINER_GOOGLE_CLIENT_ID: 'id' }),
    ).toThrow('together');
    expect(() => loadConfig({ ...base, RETAINER_AUTH_SECRET: 'short' })).toThrow('32');
  });

  it('refuses to sign people in without the Google client', () => {
    const apiOnly = loadConfig({ ...base, RETAINER_AUTH_SECRET: secret });
    expect(() => accountsConfig(apiOnly)).toThrow('Set all three, or none');
    const full = loadConfig({
      ...base,
      RETAINER_AUTH_SECRET: secret,
      RETAINER_GOOGLE_CLIENT_ID: 'id',
      RETAINER_GOOGLE_CLIENT_SECRET: 'shh',
    });
    expect(accountsConfig(full)).toEqual({
      secret,
      google: { clientId: 'id', clientSecret: 'shh' },
    });
  });

  it('runs the control function on the control login alone', () => {
    const control = `postgres://${CONTROL_ROLE}:s3cret@localhost/test`;
    const config = loadConfig({
      RETAINER_CONTROL_DATABASE_URL: control,
      RETAINER_AUTH_SECRET: secret,
      RETAINER_GOOGLE_CLIENT_ID: 'id',
      RETAINER_GOOGLE_CLIENT_SECRET: 'shh',
    });
    expect(config.RETAINER_CONTROL_DATABASE_URL).toBe(control);
    expect(() => ownerDatabaseUrl(config)).toThrow('DATABASE_URL is required');
  });

  it('takes a control login only for the control role', () => {
    expect(() =>
      loadConfig({ ...base, RETAINER_CONTROL_DATABASE_URL: 'postgres://retainer_app:pw@h/db' }),
    ).toThrow(`log in as ${CONTROL_ROLE}`);
  });
});
