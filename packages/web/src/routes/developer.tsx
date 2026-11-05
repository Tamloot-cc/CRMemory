import type { ObjectView, PresentedRecord } from '@retainer/shared';
import { createContext, useCallback, useContext } from 'react';
import { ApiName, Code, CopyButton, Property, PropertyList, Row, Section } from '../ui/index.js';

/**
 * Developer view (D8): API names, classes, IDs and write paths beside what
 * people read. Remembered per browser, for every actor. It changes what is
 * displayed, never what is sent.
 */
export const DEVELOPER_VIEW_KEY = 'retainer:developer-view:v1';

/** Whether developer view was left on in this browser; off when storage is refused. */
export function readDeveloperView(storage: () => Pick<Storage, 'getItem'>): boolean {
  try {
    return storage().getItem(DEVELOPER_VIEW_KEY) === '1';
  } catch {
    return false;
  }
}

/** Remembers the switch; false when the browser refuses storage (it still works for the visit). */
export function writeDeveloperView(storage: () => Pick<Storage, 'setItem'>, on: boolean): boolean {
  try {
    storage().setItem(DEVELOPER_VIEW_KEY, on ? '1' : '0');
    return true;
  } catch {
    return false;
  }
}

export const DeveloperContext = createContext<{ on: boolean; set: (on: boolean) => void }>({
  on: false,
  set: () => {},
});
/** Whether developer view is on. */
export const useDeveloper = () => useContext(DeveloperContext).on;
/** `name` while developer view is on, for an `apiName` prop; otherwise nothing. */
export function useApiName() {
  const on = useDeveloper();
  // Stable while the switch holds, so memoized columns and options keep it as a dependency.
  return useCallback((name: string | undefined) => (on ? name : undefined), [on]);
}

/** How a record of this class is written: the MCP tool and the REST routes. */
export function writePath(
  object: Pick<ObjectView, 'class' | 'nameSingular'>,
  id: string,
): { tool: string; routes: string[] } {
  return object.class === 'event'
    ? { tool: 'log_event', routes: ['POST /v1/events'] }
    : {
        tool: 'upsert_record',
        routes: [`POST /v1/objects/${object.nameSingular}/upsert`, `PATCH /v1/records/${id}`],
      };
}

/** An API name beside a label, only in developer view. */
export function ApiLabel({ name }: { name: string }) {
  return useDeveloper() ? <ApiName>{name}</ApiName> : null;
}

/**
 * What a developer needs to address a record: its object's API name and
 * class, its ID with a copy button, and how it is written. Developer view only.
 */
export function DeveloperFacts({
  record,
  object,
}: {
  record: Pick<PresentedRecord, 'id' | 'object'>;
  object: ObjectView | undefined;
}) {
  if (!useDeveloper()) return null;
  const path = object ? writePath(object, record.id) : undefined;
  return (
    <Section title="Developer">
      <PropertyList>
        <Property label="Object">
          <Row>
            <Code>{record.object}</Code>
            <Code>{object?.class ?? 'unknown'}</Code>
          </Row>
        </Property>
        <Property label="ID">
          <Row nowrap>
            <Code>{record.id}</Code>
            <CopyButton value={record.id} label="Copy ID" />
          </Row>
        </Property>
        {path ? (
          <Property label="Written with">
            <Row>
              <Code>{path.tool}</Code>
              {path.routes.map((r) => (
                <Code key={r}>{r}</Code>
              ))}
            </Row>
          </Property>
        ) : null}
      </PropertyList>
    </Section>
  );
}
