import type { AggregateInput, ObjectView, SavedView } from '@retainer/shared';
import { useQuery } from '@tanstack/react-query';
import { api, useWorkspace } from '../api/client.js';

/**
 * A board's count and header total per group value, over the view's
 * filter. The board and its options read the same query, so it loads once.
 */
export function useBoardTotals(
  object: ObjectView,
  view: SavedView,
  filter: Record<string, unknown> | undefined,
) {
  const { session } = useWorkspace();
  const field = object.fields.find((f) => f.name === view.groupBy);
  const input: AggregateInput = {
    filter,
    ...(field ? { groupBy: field.name } : {}),
    aggregates: view.groupAggregate ? [view.groupAggregate] : [],
  };
  return useQuery({
    queryKey: [session.workspace.id, 'aggregate', object.nameSingular, input],
    queryFn: ({ signal }) => api.aggregate(object.nameSingular, input, signal),
    enabled: view.kind === 'board' && !!field,
    placeholderData: (previous) => previous,
  });
}
