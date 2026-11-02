import { describe, expect, it } from 'vitest';
import { estimateTokens, fitSections } from './budget.js';

/** A value whose JSON is `chars` characters, so it costs `chars + 1` in an array. */
const item = (chars: number) => 'x'.repeat(chars - 2);

describe('estimateTokens', () => {
  it('counts about four characters of JSON per token, rounding up', () => {
    expect(estimateTokens(item(40))).toBe(10);
    expect(estimateTokens('abc')).toBe(2); // "abc" is 5 characters
    expect(estimateTokens({})).toBe(1);
  });
});

describe('fitSections', () => {
  it('fills sections in key order until the budget is spent, counting each comma', () => {
    const { included, used } = fitSections(
      { a: [item(9), item(9)], b: [item(9)], c: [item(9)] },
      30,
    );
    expect(included).toEqual({ a: [item(9), item(9)], b: [item(9)], c: [] });
    expect(used).toBe(30);
    // Without room for the comma, the third item does not fit.
    expect(fitSections({ a: [item(10), item(10), item(10)] }, 32).included.a).toHaveLength(2);
  });

  it('stops a section at the first item that does not fit, and lets the next one continue', () => {
    const { included } = fitSections({ a: [item(5), item(50), item(5)], b: [item(5)] }, 20);
    // The third item of a would fit, but a section never skips ahead.
    expect(included).toEqual({ a: [item(5)], b: [item(5)] });
  });

  it('never cuts an item, and includes nothing with no budget', () => {
    expect(fitSections({ a: [item(11)] }, 11).included).toEqual({ a: [] });
    expect(fitSections({ a: [item(2)], b: [] }, 0)).toEqual({
      included: { a: [], b: [] },
      used: 0,
    });
  });

  it('keeps the arrays within the budget once serialized', () => {
    const sections = { a: Array.from({ length: 50 }, () => item(7)), b: [item(3)] };
    for (const budget of [0, 1, 8, 9, 100, 401]) {
      const { included } = fitSections(sections, budget);
      const added = JSON.stringify(included).length - JSON.stringify({ a: [], b: [] }).length;
      expect(added, `budget ${budget}`).toBeLessThanOrEqual(budget);
    }
  });
});
