import type { Operation } from '../db/protocol.js';
import type { CompiledObject } from '../schema-engine/compiled.js';

/** Rewrites the search documents of an object's records. Ported in Phase 4. */
export async function refreshObjectSearch(_op: Operation, _object: CompiledObject): Promise<void> {}
