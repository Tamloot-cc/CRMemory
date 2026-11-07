import { RetainerApiError } from '@retainer/sdk';
import type { FieldView, PresentedRecord } from '@retainer/shared';
import { type Query, useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import { api, useWorkspace } from '../../api/client.js';
import { recordTitle } from '../state.js';

export type MoveNotice = { text: string; error?: boolean };

/**
 * Moving a record on a board or calendar: a normal edit of one field by the
 * person who moved it (ARCHITECTURE.md 1.4, rule 6). The record shows in its
 * new place while the write is saving and until the lists have refreshed;
 * if the server did not apply the value, it goes back and the notice says why.
 */
export function useRecordMoves<T extends { record: PresentedRecord }>() {
  const client = useQueryClient();
  const { session } = useWorkspace();
  // Each record on the move: the value it is moving to, and the item it is
  // shown as (which a column the record was never in can draw).
  const [moving, setMoving] = useState<Record<string, { value: unknown; item: T }>>({});
  const [notice, setNotice] = useState<MoveNotice | null>(null);

  async function move(item: T, field: FieldView, value: unknown, place: string) {
    const { record } = item;
    const title = `“${recordTitle(record)}”`;
    setNotice(null);
    setMoving((m) => ({ ...m, [record.id]: { value, item } }));
    try {
      const result = await api.patchRecord(record.id, {
        values: { [field.name]: value },
        // Moving what you can see: if it changed since, show the change instead.
        expectedUpdatedAt: record.updatedAt,
      });
      const status = result.fields[field.name];
      if (status === 'pending_review')
        setNotice({
          text: `Moving ${title} to ${place} is waiting for review in the inbox, so it stays where it is for now.`,
        });
      else if (status === 'superseded')
        setNotice({
          text: `${title} stays where it is: a newer ${field.label.toLowerCase()} from a person or integration is current.`,
        });
    } catch (e) {
      setNotice({
        error: true,
        text:
          e instanceof RetainerApiError && e.status === 412
            ? `${title} changed since this view loaded, so it was not moved. It now shows its latest ${field.label.toLowerCase()}.`
            : `${title} could not be moved: ${(e as Error).message}`,
      });
    } finally {
      // The moved card stays put until this object's lists and totals are in;
      // the rest of the workspace (the open record, the inbox) refreshes behind.
      const lists = (q: Query) =>
        (q.queryKey[1] === 'records' || q.queryKey[1] === 'aggregate') &&
        q.queryKey[2] === record.object;
      void client.invalidateQueries({
        queryKey: [session.workspace.id],
        predicate: (q) => !lists(q),
      });
      await client.invalidateQueries({ queryKey: [session.workspace.id], predicate: lists });
      setMoving(({ [record.id]: _, ...rest }) => rest);
    }
  }

  /** A field's value as shown: where the record is moving to, while that saves. */
  const shownValue = useCallback(
    (record: PresentedRecord, field: string) => {
      const entry = moving[record.id];
      return entry ? entry.value : record.fields[field];
    },
    [moving],
  );

  return { moving, move, shownValue, notice, dismiss: () => setNotice(null) };
}
