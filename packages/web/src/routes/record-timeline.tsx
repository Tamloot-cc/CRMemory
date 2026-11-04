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
  EventLink,
  Muted,
  Notice,
  Row,
  Section,
  Segmented,
  SelectMenu,
  Stack,
  Timeline,
  TimelineItem as TimelineEntry,
} from '../ui/index.js';
import { ViaLabel } from './event-details.js';
import { eventTitle, objectByName, objectLabel, QueryError } from './state.js';

/** The item-type toggle: everything, or one kind. */
export type TimelineKind = 'all' | TimelineItemKind;
/** Timeline filters as the URL (or the sheet's state) holds them: comma lists. */
export type TimelineSearch = { kind?: string; fields?: string; eventTypes?: string };
export type TimelineFilters = { kind: TimelineKind; fields: string[]; eventTypes: string[] };

const list = (raw: string | undefined) => (raw ? raw.split(',').filter(Boolean) : []);
const joined = (values: string[]) => (values.length ? values.join(',') : undefined);

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

/** A record's events, field changes and facts in one list, newest first, by day. */
export function RecordTimeline({
  recordId,
  object,
  search,
  onSearchChange,
}: {
  recordId: string;
  /** The record's object: its fields to filter by and name. */
  object?: ObjectView;
  search: TimelineSearch;
  onSearchChange: (change: TimelineSearch) => void;
}) {
  const { session, schema } = useWorkspace(),
    client = useQueryClient();
  const filters = parseTimelineFilters(search);
  const params = timelineParams(filters);
  // The filters are in the key: changing one starts again from the newest page.
  const queryKey = [session.workspace.id, 'timeline', recordId, params];
  const timeline = useInfiniteQuery({
    queryKey,
    queryFn: ({ signal, pageParam }) =>
      api.timeline(recordId, { ...params, cursor: pageParam, signal }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const items = timeline.data?.pages.flatMap((p) => p.items) ?? [];
  const update = (change: Partial<TimelineFilters>) =>
    onSearchChange(timelineSearch({ ...filters, ...change }));
  const fieldOptions = (object?.fields ?? [])
    .filter((f) => !isInverseRelation(f))
    .map((f) => ({ value: f.name, label: f.label, keywords: f.name }));
  const eventTypeOptions = schema.objects
    .filter((o) => o.class === 'event')
    .map((o) => ({ value: o.nameSingular, label: o.labelSingular, keywords: o.nameSingular }));
  const filtered = filters.kind !== 'all' || filters.fields.length || filters.eventTypes.length;
  const staleCursor =
    timeline.error instanceof RetainerApiError && timeline.error.code === 'invalid_cursor';
  const note = narrowedNote(filters);
  return (
    <Stack>
      <Row>
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
      {timeline.isPending ? <Notice>Loading timeline…</Notice> : null}
      {timeline.data && !items.length ? (
        <Empty
          title={filtered ? 'Nothing matches these filters' : 'Nothing on the timeline yet'}
          description="Events, field changes and facts about this record appear here, newest first."
        />
      ) : null}
      {groupByDay(items).map((group) => (
        <Section
          key={group.day}
          title={group.date.toLocaleDateString(undefined, {
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric',
          })}
        >
          <Timeline label={`Timeline for ${group.day}`}>
            {group.items.map((item) => (
              <TimelineRow key={`${item.kind}:${item.id}`} item={item} object={object} />
            ))}
          </Timeline>
        </Section>
      ))}
      {timeline.hasNextPage ? (
        <Button
          disabled={timeline.isFetchingNextPage}
          onClick={() => void timeline.fetchNextPage()}
        >
          {timeline.isFetchingNextPage ? 'Loading…' : 'Load more'}
        </Button>
      ) : null}
    </Stack>
  );
}

const time = (at: string) => (
  <Muted small>
    <time dateTime={at}>
      {new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
    </time>
  </Muted>
);

/** One timeline item; `object` is the record's object. */
export function TimelineRow({ item, object }: { item: TimelineItem; object?: ObjectView }) {
  const { schema } = useWorkspace();
  switch (item.kind) {
    case 'event':
      return (
        <TimelineEntry icon={CalendarClock}>
          <Row>
            <Badge>{objectLabel(schema, item.type)}</Badge>
            <EventLink id={item.id}>{eventTitle(item)}</EventLink>
            {time(item.at)}
          </Row>
          {item.summary ? <p>{item.summary}</p> : null}
          <Row>
            <ViaLabel
              via={item.via}
              eventObject={objectByName(schema, item.type)}
              recordObject={object}
            />
          </Row>
        </TimelineEntry>
      );
    case 'field_change':
      return <FieldChange item={item} object={object} />;
    case 'fact':
      return (
        <TimelineEntry icon={Lightbulb}>
          <p>{item.content}</p>
          <Row>
            {item.status === 'superseded' ? <Badge>Superseded</Badge> : null}
            {item.status === 'ended' ? (
              <Badge>
                Ended{item.validTo ? ` ${new Date(item.validTo).toLocaleDateString()}` : ''}
              </Badge>
            ) : null}
            {item.factKind === 'inferred' ? <Badge>Inferred</Badge> : null}
            <ActorBadge actor={item.writtenBy} />
            {time(item.at)}
          </Row>
          <FactSources sources={item.sources} />
        </TimelineEntry>
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
}: {
  item: Extract<TimelineItem, { kind: 'field_change' }>;
  object?: ObjectView;
}) {
  const { schema } = useWorkspace();
  const field = object?.fields.find((f) => f.name === item.field);
  const module = field ? fieldModules[field.type] : null;
  const label = field?.label ?? item.field;
  return (
    <TimelineEntry icon={PencilLine}>
      <Row>
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
      </Row>
      <Row>
        <ActorBadge actor={item.actor} />
        {time(item.at)}
        {item.confidence < 1 ? (
          <Muted small>Confidence {Math.round(item.confidence * 100)}%</Muted>
        ) : null}
        {item.source ? (
          <>
            <Muted small>from</Muted>
            <Badge>{objectLabel(schema, item.source.type)}</Badge>
            <EventLink id={item.source.id}>
              {eventTitle(item.source)} · {new Date(item.source.occurredAt).toLocaleDateString()}
            </EventLink>
          </>
        ) : null}
      </Row>
    </TimelineEntry>
  );
}
