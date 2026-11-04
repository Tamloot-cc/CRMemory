import { readFile } from 'node:fs/promises';
import { quote } from './schema.mjs';

export async function queryFile(database, file, variables) {
  const query = await readFile(new URL(`queries/${file}.surql`, import.meta.url), 'utf8');
  const bindings = Object.entries(variables)
    .map(([key, value]) => {
      if (!/^[A-Za-z]+$/.test(key)) throw new Error('Invalid parameter name');
      return `LET $${key} = ${quote(value)};`;
    })
    .join('\n');
  return (await database.query(`${bindings}\n${query}`)).at(-1);
}
export function normalizeEvents(rows) {
  return rows.map(({ uid, occurredAt, paths, ...via }) => {
    const winner = paths
      ? paths.sort(
          (a, b) =>
            a.priority - b.priority ||
            a.field.localeCompare(b.field) ||
            a.record.localeCompare(b.record),
        )[0]
      : via;
    const attachment = { kind: winner.kind };
    if (winner.kind === 'field' || winner.kind === 'rollup') attachment.field = winner.field;
    if (winner.kind === 'rollup') attachment.record = winner.record;
    return { uid, occurredAt: Number(occurredAt), via: attachment };
  });
}
export const events = async (
  database,
  target,
  { beforeTime = Number.MAX_SAFE_INTEGER, beforeUid = '~', limit = 20 } = {},
) => {
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    !Number.isSafeInteger(beforeTime) ||
    typeof beforeUid !== 'string'
  )
    throw new Error('Invalid event page');
  return normalizeEvents(
    await queryFile(database, 'events', { target, beforeTime, beforeUid, limit }),
  );
};
export async function introductions(database, deal, limit = 20) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new Error('Invalid introduction limit');
  const rows = await queryFile(database, 'introductions', { deal, limit });
  return rows
    .flatMap(({ buyer, meetings }) =>
      meetings.flatMap((meeting) =>
        meeting.contacts
          .filter((uid) => uid !== buyer)
          .map((introducer) => ({ buyer, meeting: meeting.uid, introducer })),
      ),
    )
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
    .slice(0, limit);
}
