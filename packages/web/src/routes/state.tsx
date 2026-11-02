import { useNavigate, useSearch } from '@tanstack/react-router';
import { Button, Notice, Row } from '../ui/index.js';
export type ViewSearch = {
  tab?: string;
  cursor?: string;
  filter?: string;
  sort?: string;
  assertion?: string;
  /** A record open in the side sheet over an object list. */
  record?: string;
};
export function useView() {
  const search = useSearch({ strict: false }) as ViewSearch;
  const navigate = useNavigate();
  return {
    search,
    setSearch: (change: Partial<ViewSearch>) =>
      navigate({ search: (prev) => ({ ...prev, ...change }) as never }),
  };
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
