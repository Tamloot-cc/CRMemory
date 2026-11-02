import { describe, expect, it } from 'vitest';
import { ConfigError, readConfig } from './bridge.js';

describe('readConfig', () => {
  const key = { RETAINER_API_KEY: 'rtn_x' };
  it.each([
    ['https://crm.acme.test', 'https://crm.acme.test/mcp'],
    ['https://crm.acme.test/', 'https://crm.acme.test/mcp'],
    ['https://crm.acme.test/mcp', 'https://crm.acme.test/mcp'],
    ['https://crm.acme.test/mcp/', 'https://crm.acme.test/mcp'],
    ['http://localhost:8787/retainer', 'http://localhost:8787/retainer/mcp'],
  ])('points %s at %s', (url, expected) => {
    expect(readConfig({ RETAINER_URL: url, ...key }).url.href).toBe(expected);
  });

  it.each([
    [{}, /RETAINER_URL is not set/],
    [{ RETAINER_URL: 'https://crm.acme.test' }, /RETAINER_API_KEY is not set/],
    [{ RETAINER_URL: ' ', ...key }, /RETAINER_URL is not set/],
    [{ RETAINER_URL: 'crm.acme.test', ...key }, /not a valid URL/],
    [{ RETAINER_URL: 'ftp://crm.acme.test', ...key }, /must use http or https/],
  ])('rejects %o', (env, message) => {
    expect(() => readConfig(env)).toThrow(ConfigError);
    expect(() => readConfig(env)).toThrow(message);
  });
});
