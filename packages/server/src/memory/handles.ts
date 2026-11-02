import { normalizeEmail, normalizePhone } from '../records/derive.js';

/**
 * A participant handle, normalized the way `record_identifiers` stores it
 * (4.1): a lowercased email or an E.164 phone. Writes and lookups share
 * `normalizeEmail` and `normalizePhone`, so a handle finds the identifier a
 * record write produced.
 */
export type Handle = { kind: 'email'; value: string } | { kind: 'phone'; value: string };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^\+?[\d\s().-]+$/;
const MIN_PHONE_DIGITS = 5;

/** Parses an email or phone handle; anything else is null. */
export function parseHandle(raw: string): Handle | null {
  const handle = raw.trim();
  if (handle.includes('@')) {
    return EMAIL.test(handle) ? { kind: 'email', value: normalizeEmail(handle) } : null;
  }
  if (!PHONE.test(handle)) return null;
  if (handle.replace(/\D/g, '').length < MIN_PHONE_DIGITS) return null;
  return { kind: 'phone', value: normalizePhone(handle) };
}
