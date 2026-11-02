import { describe, expect, it } from 'vitest';
import { loadConfig, publicOriginSchema } from './config.js';

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
