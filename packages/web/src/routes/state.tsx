import type { ObjectView } from '@retainer/shared';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useCallback } from 'react';
import { Button, Notice, Row } from '../ui/index.js';
export type ViewSearch = {
  tab?: string;
  cursor?: string;
  filter?: string;
  sort?: string;
  assertion?: string;
  /** A record open in the side sheet over an object list. */
  record?: string;
  /** Schema page: the selected object (singular API name). */
  object?: string;
  /** Schema page: the field open in the side sheet. */
  field?: string;
  /** Schema page: the change-history status filter. */
  status?: string;
};
/** Standard (system) objects first, then the rest in schema order: the sidebar and schema page order. */
export function sortObjects(objects: ObjectView[]) {
  return [...objects].sort((a, b) => Number(b.owner === 'system') - Number(a.owner === 'system'));
}
export function useView() {
  const search = useSearch({ strict: false }) as ViewSearch;
  const navigate = useNavigate();
  // Stable, so it can be a dependency of memoized callbacks.
  const setSearch = useCallback(
    (change: Partial<ViewSearch>) =>
      navigate({ search: (prev) => ({ ...prev, ...change }) as never }),
    [navigate],
  );
  return { search, setSearch };
}
export function QueryError({ error, retry }: { error: Error; retry?: () => void }) {
  return (
    <Notice error>
      <Row>
        {error.message}
        {retry ? <Button onClick={retry}>Try again</Button> : null}
      </Row>
    </Notice>
  );
}
