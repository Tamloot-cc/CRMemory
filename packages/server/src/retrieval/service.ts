import type { ContextPack, SearchResult, TimelinePage } from '@retainer/shared';
import type { Sql } from '../db/client.js';
import { type Caller, withRead } from '../records/service.js';
import { type ContextInput, contextPack } from './context.js';
import { type SearchInput, search } from './search.js';
import { type TimelineInput, timelinePage } from './timeline.js';

/** Search and context packs for one caller, shared by REST and MCP (5, 5.1). */

export async function searchFor(
  sql: Sql,
  caller: Caller,
  input: SearchInput,
): Promise<SearchResult> {
  return withRead(sql, caller, (tx, schema) => search(tx, caller.workspaceId, schema, input));
}

export async function contextFor(
  sql: Sql,
  caller: Caller,
  recordId: string,
  input: ContextInput,
): Promise<ContextPack> {
  return withRead(sql, caller, (tx, schema) =>
    contextPack(tx, caller.workspaceId, schema, recordId, input),
  );
}

export async function timelineFor(
  sql: Sql,
  caller: Caller,
  recordId: string,
  input: TimelineInput,
): Promise<TimelinePage> {
  return withRead(sql, caller, (tx, schema) =>
    timelinePage(tx, caller.workspaceId, schema, recordId, input),
  );
}
