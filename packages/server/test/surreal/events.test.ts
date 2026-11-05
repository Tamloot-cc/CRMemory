import type { Actor } from '@retainer/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import type { LogEventInput } from '../../src/memory/events.js';
import { logEventFor, readEvent, remember } from '../../src/memory/service.js';
import {
  aggregate,
  type Caller,
  createRecord,
  deleteRecord,
  findRecords,
  patchRecord,
  upsertRecord,
  withRead,
} from '../../src/records/service.js';
import { attachedEventPage } from '../../src/retrieval/history.js';
import { contextFor } from '../../src/retrieval/service.js';
import { runSchemaChange } from '../../src/schema-engine/engine.js';
import type { SchemaOperation } from '../../src/schema-engine/operations.js';
import { describeSchema } from '../../src/schema-engine/service.js';
import { createView } from '../../src/views/service.js';
import { createWorkspace } from '../../src/workspaces/workspaces.js';
import { useTestBackend } from '../helpers/backend.js';

/**
 * Event records (spec 6): attachment through an event type's own relation fields, links to records
 * that are gone, and the internal-note type being absent from every route.
 */

const app = useTestBackend();
let workspaceId: string;
let otherWorkspaceId: string;

const AGENT: Actor = { type: 'agent', id: 'inbox' };
const USER: Actor = { type: 'user', id: 'maya' };
const as = (actor: Actor, ws = workspaceId): Caller => ({
  workspaceId: ws,
  actor,
  scopes: ['read', 'write', 'schema:write', 'admin'],
});

const schemaChange = (operations: SchemaOperation[]) =>
  runSchemaChange(app, {
    workspaceId,
    actor: USER,
    scopes: ['schema:write', 'admin'],
    operations,
  });

let n = 0;
const externalId = () => `evt-${++n}`;
const log = (input: Partial<LogEventInput> = {}, ws = workspaceId) =>
  logEventFor(app, as(AGENT, ws), {
    type: 'call',
    channel: 'zoom',
    occurredAt: '2026-10-29T14:00:00+02:00',
    title: 'Call',
    fields: {},
    participants: [],
    about: [],
    ...input,
  });
const company = (name: string) => createRecord(app, as(AGENT), 'company', { name });

beforeAll(async () => {
  workspaceId = (await createWorkspace(app, { name: 'Acme', template: 'sales' })).id;
  otherWorkspaceId = (await createWorkspace(app, { name: 'Other' })).id;
  await schemaChange([
    {
      op: 'create_field',
      object: 'call',
      field: {
        name: 'account',
        label: 'Account',
        type: 'relation',
        settings: { targetObject: 'company', inverseField: 'calls' },
      },
    },
  ]);
});

describe("attachment through an event type's relation field (6.3)", () => {
  it('follows the current value: reassigning the field moves the event', async () => {
    const acme = await company('Acme Field');
    const globex = await company('Globex Field');
    const call = await log({ externalId: externalId(), fields: { account: acme.id } });

    const linked = (record: string) =>
      findRecords(app, as(AGENT), 'call', { linked: { record, link: 'field' }, limit: 50 }).then(
        (page) => page.records.map((r) => r.id),
      );
    expect(await linked(acme.id)).toEqual([call.id]);
    const page = await withRead(app, as(AGENT), (db, schema) =>
      attachedEventPage(db, schema, workspaceId, acme.id, 10),
    );
    expect(page.items.map((e) => [e.id, e.via])).toEqual([
      [call.id, { kind: 'field', field: 'account' }],
    ]);

    await patchRecord(app, as(USER), call.id, { values: { account: globex.id } });
    expect(await linked(acme.id)).toEqual([]);
    expect(await linked(globex.id)).toEqual([call.id]);
    const context = await contextFor(app, as(AGENT), globex.id, { tokenBudget: 4000 });
    expect(context.recentEvents.map((e) => [e.id, e.via])).toEqual([
      [call.id, { kind: 'field', field: 'account' }],
    ]);
  });

  it('lets a correction to an event keep its initial values for retries', async () => {
    const acme = await company('Retry Field');
    const globex = await company('Retry Field 2');
    const id = externalId();
    const first = await log({ externalId: id, fields: { account: acme.id } });
    await patchRecord(app, as(USER), first.id, { values: { account: globex.id } });
    const retry = await log({ externalId: id, fields: { account: acme.id } });
    expect(retry).toMatchObject({ id: first.id, created: false });
  });
});

describe('links to records that are gone', () => {
  it('drops a deleted record out of participants and about, and out of its history', async () => {
    const acme = await company('Gone Inc');
    const dana = await createRecord(app, as(AGENT), 'person', { emails: 'dana@gone.test' });
    const call = await log({
      externalId: externalId(),
      participants: [{ recordId: dana.id }],
      about: [acme.id],
    });
    await deleteRecord(app, as(USER), acme.id);
    await deleteRecord(app, as(USER), dana.id);
    const read = await readEvent(app, as(AGENT), call.id);
    expect(read.event?.about).toEqual([]);
    expect(read.event?.participants.matched).toEqual([]);
  });

  it('drops records of a deleted object out of reads', async () => {
    await schemaChange([
      {
        op: 'create_object',
        object: {
          nameSingular: 'site',
          namePlural: 'sites',
          labelSingular: 'Site',
          labelPlural: 'Sites',
          labelField: 'name',
          fields: [{ name: 'name', label: 'Name', type: 'text' }],
        },
      },
    ]);
    const site = await createRecord(app, as(AGENT), 'site', { name: 'HQ' });
    const call = await log({ externalId: externalId(), about: [site.id] });
    expect((await readEvent(app, as(AGENT), call.id)).event?.about).toEqual([site.id]);
    await schemaChange([{ op: 'delete_object', object: 'site' }]);
    expect((await readEvent(app, as(AGENT), call.id)).event?.about).toEqual([]);
  });
});

describe('sources', () => {
  it("refuses another workspace's event as a source", async () => {
    const foreign = await log({ externalId: externalId() }, otherWorkspaceId);
    await expect(
      createRecord(app, as(AGENT), 'company', { name: 'Cited' }, { source: foreign.id }),
    ).rejects.toMatchObject({ status: 422 });
  });
});

describe('the internal-note type (6.4)', () => {
  it('is absent from describe, queries, views, aggregates and writes', async () => {
    const acme = await company('Noted Inc');
    await remember(app, as(AGENT), acme.id, { text: 'Prefers email' });

    const described = await describeSchema(app, as(AGENT));
    expect(JSON.stringify(described)).not.toMatch(/internalNote/);

    const notFound = { status: 404 };
    await expect(findRecords(app, as(AGENT), 'internalNote', { limit: 50 })).rejects.toMatchObject(
      notFound,
    );
    await expect(findRecords(app, as(AGENT), 'internalNotes', { limit: 50 })).rejects.toMatchObject(
      notFound,
    );
    await expect(
      aggregate(app, as(AGENT), 'internalNote', { aggregates: [] }),
    ).rejects.toMatchObject(notFound);
    await expect(
      createView(app, as(USER), 'internalNote', {
        name: 'Notes',
        kind: 'table',
        visibility: 'workspace',
      }),
    ).rejects.toMatchObject(notFound);
    await expect(
      upsertRecord(app, as(AGENT), 'internalNote', {
        values: { summary: 'x' },
        ifMissing: 'create',
      }),
    ).rejects.toMatchObject(notFound);

    // Neither the record's event history nor the user-visible note type shows it.
    const history = await withRead(app, as(AGENT), (db, schema) =>
      attachedEventPage(db, schema, workspaceId, acme.id, 10),
    );
    expect(history.items).toEqual([]);
    const notes = await findRecords(app, as(AGENT), 'note', { limit: 50 });
    expect(notes.records).toEqual([]);
  });

  it('leaves notes a person logs as ordinary, visible events', async () => {
    const acme = await company('Logged Note Inc');
    const note = await log({
      type: 'note',
      channel: 'web',
      title: 'Spoke at the conference',
      about: [acme.id],
    });
    const notes = await findRecords(app, as(AGENT), 'note', {
      linked: { record: acme.id },
      limit: 50,
    });
    expect(notes.records.map((r) => r.id)).toEqual([note.id]);
  });

  it('lists no events linked to a deleted record', async () => {
    const gone = await company('Deleted Links Inc');
    await log({ externalId: externalId(), about: [gone.id] });
    const linked = () =>
      findRecords(app, as(AGENT), 'call', { linked: { record: gone.id }, limit: 50 });
    expect((await linked()).records).toHaveLength(1);
    await deleteRecord(app, as(USER), gone.id);
    expect((await linked()).records).toEqual([]);
  });
});

describe('calendar views (7.1)', () => {
  it('can place event types by occurredAt, entities cannot', async () => {
    const view = await createView(app, as(USER), 'call', {
      name: 'Calls by day',
      kind: 'calendar',
      visibility: 'workspace',
      dateField: 'occurredAt',
    });
    expect(view).toMatchObject({ kind: 'calendar', dateField: 'occurredAt' });
    await expect(
      createView(app, as(USER), 'company', {
        name: 'Companies',
        kind: 'calendar',
        visibility: 'workspace',
        dateField: 'occurredAt',
      }),
    ).rejects.toMatchObject({ status: 422 });
  });
});
