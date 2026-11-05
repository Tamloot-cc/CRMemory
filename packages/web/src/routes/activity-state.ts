import type { EventQueryInput } from '@retainer/shared';
import { addDays, format, isValid, parse } from 'date-fns';
import { joined, list } from './record-timeline.js';
import type { ViewSearch } from './state.js';
import { DAY } from './views-state.js';

// The activity feed's state (5.2): its filters live in the URL only, and
// its events are read by day.

/** What the feed shows: every filter is optional, and they are ANDed. */
export type FeedFilters = {
  /** Event type API names; none means every type. */
  types: string[];
  /** One source (`channel`). */
  channel?: string;
  /** First day shown, `yyyy-MM-dd`, the viewer's local day. */
  from?: string;
  /** Last day shown, `yyyy-MM-dd`, included. */
  to?: string;
  /** The one record the events are attached to. */
  linked?: string;
};

const validDay = (raw: string | undefined) =>
  raw && /^\d{4}-\d{2}-\d{2}$/.test(raw) && isValid(parse(raw, DAY, new Date())) ? raw : undefined;
const nonEmpty = (raw: string | undefined) => (raw?.trim() ? raw.trim() : undefined);

/** The feed's filters from the address; malformed parts are ignored. */
export function parseFeedSearch(
  search: Pick<ViewSearch, 'eventTypes' | 'channel' | 'from' | 'to' | 'linked'>,
): FeedFilters {
  const types = list(search.eventTypes)
    .map((t) => t.trim())
    .filter((t, i, all) => t && all.indexOf(t) === i);
  const filters: FeedFilters = { types };
  const channel = nonEmpty(search.channel),
    from = validDay(search.from),
    to = validDay(search.to),
    linked = nonEmpty(search.linked);
  if (channel) filters.channel = channel;
  if (from) filters.from = from;
  if (to) filters.to = to;
  if (linked) filters.linked = linked;
  return filters;
}

/** The address parameters for some filters; an absent one clears its parameter. */
export function feedSearch(
  filters: FeedFilters,
): Pick<ViewSearch, 'eventTypes' | 'channel' | 'from' | 'to' | 'linked'> {
  return {
    eventTypes: joined(filters.types),
    channel: filters.channel,
    from: filters.from,
    to: filters.to,
    linked: filters.linked,
  };
}

/** Local midnight at the start of a `yyyy-MM-dd` day, as an instant. */
const startOf = (day: string) => parse(day, DAY, new Date());

/**
 * `POST /v1/events/query` for the filters, newest first. A day range runs
 * from local midnight of `from` to local midnight after `to`.
 */
export function feedQuery(filters: FeedFilters, limit = 30): EventQueryInput {
  const parts: Record<string, unknown>[] = [];
  if (filters.types.length === 1) parts.push({ type: { eq: filters.types[0] } });
  else if (filters.types.length > 1) parts.push({ type: { in: filters.types } });
  if (filters.channel) parts.push({ channel: { eq: filters.channel } });
  if (filters.from) parts.push({ occurredAt: { gte: startOf(filters.from).toISOString() } });
  if (filters.to) parts.push({ occurredAt: { lt: addDays(startOf(filters.to), 1).toISOString() } });
  return {
    limit,
    sort: [{ field: 'occurredAt', direction: 'desc' }],
    include: ['relationReferences'],
    ...(parts.length === 1 ? { filter: parts[0] } : parts.length ? { filter: { and: parts } } : {}),
    ...(filters.linked ? { linked: { record: filters.linked } } : {}),
  };
}

/** How many filters are set; the event type list counts once. */
export const filterCount = (f: FeedFilters) =>
  (f.types.length ? 1 : 0) + (f.channel ? 1 : 0) + (f.from || f.to ? 1 : 0) + (f.linked ? 1 : 0);

/** "Nov 1 – Nov 5", "From Nov 1", "Until Nov 5": a date range in words. */
export function rangeText(from: string | undefined, to: string | undefined): string {
  const day = (d: string) =>
    startOf(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  if (from && to) return from === to ? day(from) : `${day(from)} – ${day(to)}`;
  if (from) return `from ${day(from)}`;
  if (to) return `until ${day(to)}`;
  return '';
}

/** The viewer's local day of an instant, `yyyy-MM-dd`. */
export const localDay = (iso: string) => format(new Date(iso), DAY);

/** "Today", "Yesterday", or the date ("Monday, November 3", with the year when not this one). */
export function dayHeading(day: string, now: Date = new Date()): string {
  const today = format(now, DAY);
  if (day === today) return 'Today';
  if (day === format(addDays(now, -1), DAY)) return 'Yesterday';
  const date = startOf(day);
  return date.toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  });
}

/**
 * Events grouped by the local day they happened, in the order given (the
 * feed is newest first, so days come out newest first too).
 */
export function groupByDay<T extends { event: { occurredAt: string } }>(
  events: T[],
  now: Date = new Date(),
): { day: string; heading: string; events: T[] }[] {
  const groups: { day: string; heading: string; events: T[] }[] = [];
  for (const e of events) {
    const day = localDay(e.event.occurredAt);
    const last = groups[groups.length - 1];
    if (last?.day === day) last.events.push(e);
    else {
      const earlier = groups.find((g) => g.day === day);
      if (earlier) earlier.events.push(e);
      else groups.push({ day, heading: dayHeading(day, now), events: [e] });
    }
  }
  return groups;
}
