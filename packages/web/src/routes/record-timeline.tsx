import { RetainerApiError } from '@retainer/sdk';
import type { ObjectView, TimelineItem, TimelineItemKind } from '@retainer/shared';
import { isInverseRelation, TIMELINE_ITEM_KINDS } from '@retainer/shared';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import { CalendarClock, Lightbulb, PencilLine } from 'lucide-react';
import { api, useWorkspace } from '../api/client.js';
import { fields as fieldModules } from '../fields/index.js';
import { ActorBadge, FactSources } from '../provenance/index.js';
import {
  Badge,
  Button,
  Code,
  Empty,
  Entry,
  EntryDay,
  EntryList,
  EntryLoading,
  EntryText,
  EventLink,
  LoadMore,
  Muted,
  Notice,
  Row,
  Segmented,
  SelectMenu,
  Stack,
} from '../ui/index.js';
import { ViaLabel } from './event-details.js';
import { byCursor, eventTitle, objectByName, objectLabel, QueryError } from './state.js';
import { clockTime } from './views-state.js';

/** The item-type toggle: everything, or one kind. */
export type TimelineKind = 'all' | TimelineItemKind;
/** Timeline filters as the URL (or the sheet's state) holds them: comma lists. */
export type TimelineSearch = { kind?: string; fields?: string; eventTypes?: string };
export type TimelineFilters = { kind: TimelineKind; fields: string[]; eventTypes: string[] };

/** A comma list from the address, empty parts dropped. */
export const list = (raw: string | undefined) => (raw ? raw.split(',').filter(Boolean) : []);
/** Values as a comma list for the address; none clears the parameter. */
export const joined = (values: string[]) => (values.length ? values.join(',') : undefined);

export function parseTimelineFilters(search: TimelineSearch): TimelineFilters {
  const kind = TIMELINE_ITEM_KINDS.find((k) => k === search.kind) ?? 'all';
  return { kind, fields: list(search.fields), eventTypes: list(search.eventTypes) };
}
export function timelineSearch(filters: TimelineFilters): TimelineSearch {
  return {
    kind: filters.kind === 'all' ? undefined : filters.kind,
    fields: joined(filters.fields),
    eventTypes: joined(filters.eventTypes),
  };
}
const showsFields = (kind: TimelineKind) => kind === 'all' || kind === 'field_change';
const showsEventTypes = (kind: TimelineKind) => kind === 'all' || kind === 'event';

/**
 * The filters as `GET /v1/records/:id/timeline` options. Alone, `fields`
 * narrows the page to field changes and `eventTypes` to events, so any kind
 * but "all" is sent as an explicit `types`; a filter for a kind the toggle
 * leaves out is not sent.
 */
export function timelineParams(filters: TimelineFilters): {
  types?: TimelineItemKind[];
  fields?: string[];
  eventTypes?: string[];
} {
  const { kind } = filters;
  return {
    ...(kind === 'all' ? {} : { types: [kind] }),
    ...(showsFields(kind) && filters.fields.length ? { fields: filters.fields } : {}),
    ...(showsEventTypes(kind) && filters.eventTypes.length
      ? { eventTypes: filters.eventTypes }
      : {}),
  };
}

/**
 * Items in runs of the same local day, in the order given (newest first).
 * Pages are flattened before grouping, so a day split across two pages stays
 * one group.
 */
export function groupByDay(items: TimelineItem[]) {
  const days: { day: string; date: Date; items: TimelineItem[] }[] = [];
  for (const item of items) {
    const date = new Date(item.at);
    const day = format(date, 'yyyy-MM-dd');
    const last = days.at(-1);
    if (last?.day === day) last.items.push(item);
    else days.push({ day, date, items: [item] });
  }
  return days;
}

const KINDS: { value: TimelineKind; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'event', label: 'Events' },
  { value: 'field_change', label: 'Field changes' },
  { value: 'fact', label: 'Facts' },
];

/**
 * What the server narrows "all" to when a field or event-type filter is set
 * on its own, so the missing kinds don't look like an empty history.
 */
function narrowedNote(filters: TimelineFilters) {
  if (filters.kind !== 'all') return null;
  const byField = filters.fields.length > 0,
    byType = filters.eventTypes.length > 0;
  if (byField && byType) return 'Showing field changes and events that match these filters.';
  if (byField) return 'Showing field changes for the chosen fields.';
  if (byType) return 'Showing events of the chosen types.';
  return null;
}

/**
 * A record's events, field changes and facts in one list, newest first, by day.
 * With `history`, an event's page: only its field changes, by field.
 */
export function RecordTimeline({
  recordId,
  object,
  history = false,
  search,
  onSearchChange,
}: {
  recordId: string;
  /** The record's object: its fields to filter by and name. */
  object?: ObjectView;
  history?: boolean;
  search: TimelineSearch;
  onSearchChange: (change: TimelineSearch) => void;
}) {
  const { session, schema } = useWorkspace(),
    client = useQueryClient();
  const parsed = parseTimelineFilters(search);
  const filters: TimelineFilters = history
    ? { kind: 'field_change', fields: parsed.fields, eventTypes: [] }
    : parsed;
  const params = timelineParams(filters);
  // The filters are in the key: changing one starts again from the newest page.
  const queryKey = [session.workspace.id, 'timeline', recordId, params];
  const timeline = useInfiniteQuery({
    queryKey,
    queryFn: ({ signal, pageParam }) =>
      api.timeline(recordId, { ...params, cursor: pageParam, signal }),
    ...byCursor,
  });
  const items = timeline.data?.pages.flatMap((p) => p.items) ?? [];
  const update = (change: Partial<TimelineFilters>) =>
    onSearchChange(
      history
        ? { fields: joined(change.fields ?? filters.fields) }
        : timelineSearch({ ...filters, ...change }),
    );
  const fieldOptions = (object?.fields ?? [])
    .filter((f) => !isInverseRelation(f))
    .map((f) => ({ value: f.name, label: f.label, keywords: f.name }));
  const eventTypeOptions = schema.objects
    .filter((o) => o.class === 'event')
    .map((o) => ({ value: o.nameSingular, label: o.labelSingular, keywords: o.nameSingular }));
  const filtered =
    (!history && filters.kind !== 'all') || filters.fields.length || filters.eventTypes.length;
  const staleCursor =
    timeline.error instanceof RetainerApiError && timeline.error.code === 'invalid_cursor';
  const note = narrowedNote(filters);
  return (
    <Stack>
      <Row>
        {history ? null : (
          <Segmented
            label="Show"
            value={filters.kind}
            options={KINDS}
            onChange={(kind) =>
              // A filter for a kind no longer shown is dropped with it.
              update({
                kind,
                fields: showsFields(kind) ? filters.fields : [],
                eventTypes: showsEventTypes(kind) ? filters.eventTypes : [],
              })
            }
          />
        )}
        {showsFields(filters.kind) ? (
          <SelectMenu
            label="Fields"
            size="small"
            multiple
            placeholder="All fields"
            value={filters.fields}
            options={fieldOptions}
            onChange={(next) => update({ fields: next })}
          />
        ) : null}
        {showsEventTypes(filters.kind) ? (
          <SelectMenu
            label="Event types"
            size="small"
            multiple
            placeholder="All event types"
            value={filters.eventTypes}
            options={eventTypeOptions}
            onChange={(next) => update({ eventTypes: next })}
          />
        ) : null}
        {filtered ? (
          <Button
            size="small"
            variant="ghost"
            onClick={() => update({ kind: 'all', fields: [], eventTypes: [] })}
          >
            Clear filters
          </Button>
        ) : null}
      </Row>
      {note ? <Muted small>{note}</Muted> : null}
      {staleCursor ? (
        <Notice error>
          <Row>
            The timeline changed since this page was loaded.
            <Button onClick={() => void client.resetQueries({ queryKey })}>
              Start from the newest
            </Button>
          </Row>
        </Notice>
      ) : timeline.error ? (
        <QueryError error={timeline.error} retry={() => void timeline.refetch()} />
      ) : null}
      {timeline.isPending ? (
        <EntryLoading label={history ? 'Loading history…' : 'Loading timeline…'} />
      ) : null}
      {timeline.data && !items.length ? (
        <Empty
          quiet
          title={
            filtered
              ? 'Nothing matches these filters'
              : history
                ? 'No edits yet'
                : 'Nothing on the timeline yet'
          }
          description={
            history
              ? "Changes to this event's fields appear here, newest first."
              : 'Events, field changes and facts about this record appear here, newest first.'
          }
        />
      ) : null}
      {groupByDay(items).map((group) => (
        <section key={group.day}>
          <EntryDay>
            {group.date.toLocaleDateString(undefined, {
              weekday: 'long',
              year: 'numeric',
              month: 'long',
              day: 'numeric',
            })}
          </EntryDay>
          <EntryList label={`Timeline for ${group.day}`}>
            {group.items.map((item) => (
              <TimelineRow
                key={`${item.kind}:${item.id}`}
                item={item}
                object={object}
                recordId={recordId}
              />
            ))}
          </EntryList>
        </section>
      ))}
      {timeline.hasNextPage ? (
        <LoadMore
          loading={timeline.isFetchingNextPage}
          onClick={() => void timeline.fetchNextPage()}
        />
      ) : null}
    </Stack>
  );
}

const time = (at: string) => <time dateTime={at}>{clockTime(at)}</time>;

/** One timeline item; `object` is the record's object and `recordId` its ID. */
function TimelineRow({
  item,
  object,
  recordId,
}: {
  item: TimelineItem;
  object?: ObjectView;
  recordId: string;
}) {
  const { schema } = useWorkspace();
  switch (item.kind) {
    case 'event':
      return (
        <Entry
          icon={CalendarClock}
          title={
            <>
              <Badge>{objectLabel(schema, item.type)}</Badge>
              <EventLink id={item.id} title>
                {eventTitle(item)}
              </EventLink>
            </>
          }
          time={time(item.at)}
          footer={
            <ViaLabel
              via={item.via}
              eventObject={objectByName(schema, item.type)}
              recordObject={object}
            />
          }
        >
          {item.summary ? <EntryText clamp={3}>{item.summary}</EntryText> : null}
        </Entry>
      );
    case 'field_change':
      return <FieldChange item={item} object={object} recordId={recordId} />;
    case 'fact':
      return (
        <Entry
          icon={Lightbulb}
          title={
            <>
              <ActorBadge actor={item.writtenBy} />
              {item.status === 'superseded' ? <Badge>Superseded</Badge> : null}
              {item.status === 'ended' ? (
                <Badge>
                  Ended{item.validTo ? ` ${new Date(item.validTo).toLocaleDateString()}` : ''}
                </Badge>
              ) : null}
              {item.factKind === 'inferred' ? <Badge>Inferred</Badge> : null}
            </>
          }
          time={time(item.at)}
        >
          <EntryText clamp={4}>{item.content}</EntryText>
          <FactSources sources={item.sources} />
        </Entry>
      );
    default:
      return unknownItem(item);
  }
}
/** Fails to compile when a kind has no case above; shows nothing at run time. */
function unknownItem(item: never): null {
  void item;
  return null;
}

/**
 * "Stage set to Won". The value asserted, not a diff: a claim that is not
 * the current value may never have been the record's value, so it is
 * labelled and nothing says what it changed from.
 */
function FieldChange({
  item,
  object,
  recordId,
}: {
  item: Extract<TimelineItem, { kind: 'field_change' }>;
  object?: ObjectView;
  /** The record whose timeline this is; a value from its own logging needs no "from". */
  recordId: string;
}) {
  const { schema } = useWorkspace();
  const field = object?.fields.find((f) => f.name === item.field);
  const module = field ? fieldModules[field.type] : null;
  const label = field?.label ?? item.field;
  // An event's own values cite the event: saying so on its page says nothing.
  const source = item.source && item.source.id !== recordId ? item.source : null;
  return (
    <Entry
      icon={PencilLine}
      title={
        <>
          {field && module ? (
            module.isEmpty(item.value) ? (
              <span>{label} cleared</span>
            ) : (
              <>
                <span>{label} set to</span>
                <module.Display
                  field={field}
                  value={item.value}
                  references={item.relationReferences}
                />
              </>
            )
          ) : (
            <>
              <span>{label} set to</span>
              <Code>{JSON.stringify(item.value)}</Code>
            </>
          )}
          {item.current ? null : <Badge>Not the current value</Badge>}
        </>
      }
      time={time(item.at)}
      footer={
        <>
          <ActorBadge actor={item.actor} />
          {item.confidence < 1 ? (
            <Muted small>Confidence {Math.round(item.confidence * 100)}%</Muted>
          ) : null}
          {source ? (
            <>
              <Muted small>from</Muted>
              <Badge>{objectLabel(schema, source.type)}</Badge>
              <EventLink id={source.id}>
                {eventTitle(source)} · {new Date(source.occurredAt).toLocaleDateString()}
              </EventLink>
            </>
          ) : null}
        </>
      }
    />
  );
}
