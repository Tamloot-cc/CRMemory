import { describe, expect, it } from 'vitest';
import { generateApiKey, hashApiKey, keyPrefix, parseActor, parseScopes } from './keys.js';

describe('API keys', () => {
  it('generates distinct, prefixed keys with 256 bits of randomness', () => {
    const keys = new Set(Array.from({ length: 200 }, generateApiKey));
    expect(keys.size).toBe(200);
    for (const key of keys) expect(key).toMatch(/^rtn_[0-9A-Za-z]{43}$/);
  });

  it('stores only a SHA-256 hex digest and a short display prefix', () => {
    const key = generateApiKey();
    expect(hashApiKey(key)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashApiKey(key)).toBe(hashApiKey(key));
    expect(keyPrefix(key)).toBe(key.slice(0, 12));
  });
});

describe('parseActor', () => {
  it('reads type:id', () => {
    expect(parseActor('agent:front-desk')).toEqual({ type: 'agent', id: 'front-desk' });
    expect(parseActor('user:dana@acme.com', 'Dana')).toEqual({
      type: 'user',
      id: 'dana@acme.com',
      name: 'Dana',
    });
  });

  it('rejects unknown types and missing IDs', () => {
    expect(() => parseActor('robot:x')).toThrow('type:id');
    expect(() => parseActor('agent')).toThrow('type:id');
    expect(() => parseActor('agent:')).toThrow('type:id');
  });
});

describe('parseScopes', () => {
  it('accepts known scopes, deduplicated', () => {
    expect(parseScopes('read, write,read')).toEqual(['read', 'write']);
  });

  it('rejects unknown or empty scopes', () => {
    expect(() => parseScopes('read,delete')).toThrow('scopes must be some of');
    expect(() => parseScopes('')).toThrow();
  });
});
