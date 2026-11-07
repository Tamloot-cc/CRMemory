import { describe, expect, it } from 'vitest';
import { loadConfig, ownerDatabaseUrl, publicOriginSchema } from './config.js';
import { RUNTIME_ROLE, runtimeConnection } from './db/client.js';

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
    expect(() => loadConfig({})).toThrow('set DATABASE_URL, RETAINER_RUNTIME_DATABASE_URL or both');
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

  it('refuses a runtime URL without a password or for another role', () => {
    expect(() =>
      loadConfig({ RETAINER_RUNTIME_DATABASE_URL: 'postgres://retainer_app@localhost/test' }),
    ).toThrow('include the password');
    const owner = loadConfig({
      RETAINER_RUNTIME_DATABASE_URL: 'postgres://retainer:pw@localhost/test',
    });
    expect(() => runtimeConnection(owner)).toThrow('must log in as retainer_app, not "retainer"');
  });
});
