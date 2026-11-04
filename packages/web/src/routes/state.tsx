import type { ObjectView, SchemaDescription } from '@retainer/shared';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from 'react';
import { Button, Notice, Row } from '../ui/index.js';
export type ViewSearch = {
  tab?: string;
  cursor?: string;
  filter?: string;
  sort?: string;
  assertion?: string;
  /** A record open in the side sheet over an object list. */
  record?: string;
  /** Object list: the saved view shown; absent for all records. */
  view?: string;
  /** Calendar view: the month shown, `yyyy-MM`. */
  month?: string;
  /** Schema page: the selected object (singular API name). */
  object?: string;
  /** Schema page: the field open in the side sheet. */
  field?: string;
  /** Schema page: the change-history status filter. */
  status?: string;
};
/** How a record is named on screen. */
export const recordTitle = (r: { label: string | null }) => r.label || 'Untitled record';
/** How an event is named on screen. */
export const eventTitle = (e: { title: string | null }) => e.title || 'Untitled event';
/** The object (or event type) by its singular API name. */
export const objectByName = (schema: SchemaDescription, name: string): ObjectView | undefined =>
  schema.objects.find((o) => o.nameSingular === name);
/** An object's (or event type's) singular name for people, falling back to its API name. */
export const objectLabel = (schema: SchemaDescription, name: string) =>
  objectByName(schema, name)?.labelSingular ?? name;

/** `value` once it has stopped changing for `ms`, so typing is not a request per key. */
export function useDebounced<T>(value: T, ms = 200): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}
/** Standard (system) objects first, then the rest in schema order: the sidebar and schema page order. */
export function sortObjects(objects: ObjectView[]) {
  return [...objects].sort((a, b) => Number(b.owner === 'system') - Number(a.owner === 'system'));
}
export function useView() {
  const search = useSearch({ strict: false }) as ViewSearch;
  const navigate = useNavigate();
  // Stable, so it can be a dependency of memoized callbacks.
  // `replace` changes the address without a new history entry.
  const setSearch = useCallback(
    (change: Partial<ViewSearch>, options: { replace?: boolean } = {}) =>
      navigate({ search: (prev) => ({ ...prev, ...change }) as never, ...options }),
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

/**
 * Reports the outcome of an action whose screen goes away with it (a
 * deleted, merged or erased record): the shell shows it above the next
 * screen until dismissed.
 */
export const ReportContext = createContext<(report: ReactNode) => void>(() => {});
export const useReport = () => useContext(ReportContext);
