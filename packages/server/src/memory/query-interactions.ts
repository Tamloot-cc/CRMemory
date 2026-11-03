import type { InteractionQueryResult } from '@retainer/shared';
import type { Fragment } from 'postgres';
import { z } from 'zod';
import { INTERACTION_KINDS, PARTICIPANT_LINKS } from '../db/schema.js';
import type { Tx } from '../db/tx.js';
import { AppError } from '../errors.js';
import { resolveRecordId } from '../records/write.js';
import { after, page } from '../web/pagination.js';
import { type InteractionRow, NOTE_CHANNEL, presentInteractions } from './interactions.js';

/**
 * Exact queries on the interaction log (5): filters, a time range, the
 * records it links, newest or oldest first, and counts by kind or channel.
 * Interactions are not records (1.3), so this reads the `interactions`
 * table directly instead of going through the records query. Retracted
 * interactions and the notes `remember` creates are left out, as in
 * get_context and search.
 */

const instant = z.iso.datetime({ offset: true });
const oneOrMany = <T extends z.ZodType>(item: T) => z.union([item, z.array(item).min(1).max(50)]);

export const interactionQuerySchema = z.strictObject({
  filter: z
    .strictObject({
      kind: oneOrMany(z.enum(INTERACTION_KINDS)).optional(),
      channel: oneOrMany(z.string().trim().min(1).max(100)).optional(),
      externalId: z.string().min(1).max(500).optional(),
      occurredAt: z
        .strictObject({
          gt: instant.optional(),
          gte: instant.optional(),
          lt: instant.optional(),
          lte: instant.optional(),
        })
        .optional(),
      record: z.uuid().optional(),
      link: z.enum(PARTICIPANT_LINKS).optional(),
    })
    .default({}),
  order: z.enum(['newest', 'oldest']).default('newest'),
  countBy: z.enum(['kind', 'channel']).optional(),
  limit: z.number().int().min(0).max(200).default(50),
  cursor: z.string().optional(),
});
export type InteractionQuery = z.infer<typeof interactionQuerySchema>;

const list = <T>(value: T | T[]): T[] => (Array.isArray(value) ? value : [value]);

export async function queryInteractions(
  tx: Tx,
  workspaceId: string,
  input: InteractionQuery,
): Promise<InteractionQueryResult> {
  const { filter } = input;
  if (filter.link && !filter.record) {
    throw new AppError(422, 'invalid_query', 'filter.link needs filter.record', {
      field: 'link',
    });
  }
  const conditions: Fragment[] = [
    tx`i.workspace_id = ${workspaceId}`,
    tx`i.deleted_at is null`,
    tx`not (i.kind = 'note' and i.channel = ${NOTE_CHANNEL})`,
  ];
  if (filter.kind) conditions.push(tx`i.kind = any(${list(filter.kind)}::text[])`);
  if (filter.channel) conditions.push(tx`i.channel = any(${list(filter.channel)}::text[])`);
  if (filter.externalId) conditions.push(tx`i.external_id = ${filter.externalId}`);
  const range = filter.occurredAt ?? {};
  if (range.gt) conditions.push(tx`i.occurred_at > ${range.gt}::timestamptz`);
  if (range.gte) conditions.push(tx`i.occurred_at >= ${range.gte}::timestamptz`);
  if (range.lt) conditions.push(tx`i.occurred_at < ${range.lt}::timestamptz`);
  if (range.lte) conditions.push(tx`i.occurred_at <= ${range.lte}::timestamptz`);
  if (filter.record) {
    const recordId = await resolveRecordId(tx, workspaceId, filter.record);
    const link = filter.link ? tx`and p.link = ${filter.link}` : tx``;
    conditions.push(tx`exists (
      select 1 from interaction_participants p
      where p.interaction_id = i.id and p.record_id = ${recordId} ${link})`);
  }
  const where = conditions.reduce((a, b) => tx`${a} and ${b}`);

  const newest = input.order === 'newest';
  const direction = tx.unsafe(newest ? 'desc' : 'asc');
  const [rows, [totals], counts] = await Promise.all([
    input.limit === 0
      ? Promise.resolve([])
      : tx<(InteractionRow & { stamp: string })[]>`
          select i.*, i.occurred_at::text as stamp from interactions i
          where ${where} and ${after(tx, tx`i.occurred_at`, tx`i.id`, input.cursor, newest)}
          order by i.occurred_at ${direction}, i.id ${direction}
          limit ${input.limit + 1}`,
    tx<{ total: number }[]>`select count(*)::int as total from interactions i where ${where}`,
    input.countBy
      ? tx<{ key: string; count: number }[]>`
          select ${tx.unsafe(input.countBy === 'kind' ? 'i.kind' : 'i.channel')} as key, count(*)::int as count
          from interactions i where ${where}
          group by 1 order by 2 desc, 1`
      : Promise.resolve(undefined),
  ]);
  const result = page(rows, input.limit);
  return {
    items: await presentInteractions(tx, workspaceId, result.items),
    nextCursor: result.nextCursor,
    total: totals?.total ?? 0,
    ...(counts ? { counts: Object.fromEntries(counts.map((c) => [c.key, c.count])) } : {}),
  };
}
