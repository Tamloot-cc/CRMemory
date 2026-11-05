import type { ContextPack, SearchResult, TimelinePage } from '@retainer/shared';
import type { Backend } from '../db/backend.js';
import { type Caller, withRead } from '../records/service.js';
import { type ContextInput, contextPack } from './context.js';
import { type SearchInput, search } from './search.js';
import { type TimelineInput, timelinePage } from './timeline.js';

/** Search and context packs for one caller, shared by REST and MCP (5, 5.1). */

export async function searchFor(
  backend: Backend,
  caller: Caller,
  input: SearchInput,
): Promise<SearchResult> {
  return withRead(backend, caller, (db, schema) => search(db, caller.workspaceId, schema, input));
}

export async function contextFor(
  backend: Backend,
  caller: Caller,
  recordId: string,
  input: ContextInput,
): Promise<ContextPack> {
  return withRead(backend, caller, (db, schema) =>
    contextPack(db, caller.workspaceId, schema, recordId, input),
  );
}

export async function timelineFor(
  backend: Backend,
  caller: Caller,
  recordId: string,
  input: TimelineInput,
): Promise<TimelinePage> {
  return withRead(backend, caller, (db, schema) =>
    timelinePage(db, caller.workspaceId, schema, recordId, input),
  );
}
