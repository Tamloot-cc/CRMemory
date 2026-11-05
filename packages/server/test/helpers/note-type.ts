import type { Sql } from '../../src/db/client.js';
import { inWorkspace } from '../../src/db/tx.js';
import { runSchemaChange, SYSTEM_ACTOR } from '../../src/schema-engine/engine.js';

/**
 * Adds a `note` event type to a workspace, as a template, an agent or a release
 * before C5 did: a second event type for tests about what spans types.
 */
export function addNoteType(owner: Sql, workspaceId: string) {
  return inWorkspace(owner, workspaceId, (tx) =>
    runSchemaChange(tx, {
      workspaceId,
      actor: SYSTEM_ACTOR,
      scopes: [],
      owner: 'system',
      trusted: true,
      reason: 'A note type for this test',
      operations: [
        {
          op: 'create_object',
          object: {
            class: 'event',
            nameSingular: 'note',
            namePlural: 'notes',
            labelSingular: 'Note',
            labelPlural: 'Notes',
            fields: [],
          },
        },
      ],
    }),
  );
}
