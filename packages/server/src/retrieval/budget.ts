/**
 * Token budgeting for context packs (6.2). Retainer runs no tokenizer, so
 * tokens are estimated from characters: about four per token.
 */

export const CHARS_PER_TOKEN = 4;

/** Characters of a value as it is sent: its JSON. */
export function jsonLength(value: unknown): number {
  return JSON.stringify(value).length;
}

/** Estimated tokens of a value as it is sent. */
export function estimateTokens(value: unknown): number {
  return Math.ceil(jsonLength(value) / CHARS_PER_TOKEN);
}

/**
 * Fills sections, in the order of their keys, until `budget` characters are
 * spent. Each item costs its JSON plus the comma that separates it in its
 * array, so the fitted arrays never add more than `budget` characters to the
 * JSON they sit in. Items are never cut: a section takes items while the
 * next one fits, stops at the first that does not, and the next section
 * continues with what is left.
 */
export function fitSections<T extends Record<string, readonly unknown[]>>(
  sections: T,
  budget: number,
): { included: T; used: number } {
  const included: Record<string, unknown[]> = {};
  let used = 0;
  for (const [name, items] of Object.entries(sections)) {
    const taken: unknown[] = [];
    for (const item of items) {
      const cost = jsonLength(item) + 1;
      if (used + cost > budget) break;
      used += cost;
      taken.push(item);
    }
    included[name] = taken;
  }
  return { included: included as unknown as T, used };
}
