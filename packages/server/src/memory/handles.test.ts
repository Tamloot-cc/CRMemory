import { describe, expect, it } from 'vitest';
import { parseHandle } from './handles.js';

describe('parseHandle', () => {
  it('lowercases and trims emails, as record identifiers store them', () => {
    expect(parseHandle('  Dana@Acme.COM ')).toEqual({ kind: 'email', value: 'dana@acme.com' });
  });

  it('normalizes international phones to E.164', () => {
    expect(parseHandle('+972 54-123-4567')).toEqual({ kind: 'phone', value: '+972541234567' });
    expect(parseHandle('00972541234567')).toEqual({ kind: 'phone', value: '+972541234567' });
    expect(parseHandle('+1 (415) 555-0100')).toEqual({ kind: 'phone', value: '+14155550100' });
  });

  it('keeps the digits of a phone without a country code', () => {
    expect(parseHandle('054-123-4567')).toEqual({ kind: 'phone', value: '0541234567' });
  });

  it('rejects anything that is neither an email nor a phone', () => {
    for (const raw of ['', 'Dana Levi', 'dana@', '@acme.com', 'dana@acme', '12-34', 'call me']) {
      expect(parseHandle(raw)).toBeNull();
    }
  });
});
