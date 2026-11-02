import { describe, expect, it } from 'vitest';
import { estimateTokens, fitSections } from './budget.js';

/** A value whose JSON is exactly `tokens * 4` characters. */
const item = (tokens: number) => 'x'.repeat(tokens * 4 - 2);

describe('estimateTokens', () => {
  it('counts about four characters of JSON per token, rounding up', () => {
    expect(estimateTokens(item(10))).toBe(10);
    expect(estimateTokens('abc')).toBe(2); // "abc" is 5 characters
    expect(estimateTokens({})).toBe(1);
  });
});

describe('fitSections', () => {
  it('fills sections in key order until the budget is spent', () => {
    const { included, used } = fitSections(
      { a: [item(10), item(10)], b: [item(10)], c: [item(10)] },
      30,
    );
    expect(included).toEqual({ a: [item(10), item(10)], b: [item(10)], c: [] });
    expect(used).toBe(30);
  });

  it('stops a section at the first item that does not fit, and lets the next one continue', () => {
    const { included } = fitSections({ a: [item(5), item(50), item(5)], b: [item(5)] }, 20);
    // The third item of a would fit, but a section never skips ahead.
    expect(included).toEqual({ a: [item(5)], b: [item(5)] });
  });

  it('never cuts an item, and includes nothing with no budget', () => {
    expect(fitSections({ a: [item(11)] }, 10).included).toEqual({ a: [] });
    expect(fitSections({ a: [item(1)], b: [] }, 0)).toEqual({
      included: { a: [], b: [] },
      used: 0,
    });
  });
});
