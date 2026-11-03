import { afterEach, describe, expect, it, vi } from 'vitest';
import { log, setLogLevel } from './log.js';

describe('log', () => {
  afterEach(() => {
    setLogLevel('info');
    vi.restoreAllMocks();
  });

  it('writes messages at or above the level and drops the rest', () => {
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});

    setLogLevel('warn');
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');

    expect(out).not.toHaveBeenCalled();
    expect(err.mock.calls).toEqual([['w'], ['e']]);
  });

  it('defaults to info', () => {
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    log.debug('d');
    log.info('i');
    expect(out.mock.calls).toEqual([['i']]);
  });
});
