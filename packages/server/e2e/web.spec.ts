import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures.js';

async function signIn(page: Page, url: string, key: string) {
  await page.goto(`${url}/app/`);
  await page.getByLabel('Personal API key').fill(key);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Review inbox' })).toBeVisible();
}
/** Sign out from the account menu at the foot of the sidebar. */
async function signOut(page: Page) {
  await page.getByRole('button', { name: /^Account: / }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
}
test('sign in, accept and reject values, browse records, and inspect provenance', async ({
  page,
  retainer: r,
}) => {
  const record = (
    await r.request(
      '/objects/person/records',
      { values: { name: 'Dana Levi', jobTitle: 'CTO' } },
      r.keys.user,
    )
  ).record;
  await r.request(`/records/${record.id}`, { values: { jobTitle: 'CEO' } }, r.keys.agent, 'PATCH');
  await signIn(page, r.url, r.keys.user);
  await expect(page.getByText('CEO', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Accept', exact: true }).click();
  await expect(page.getByText("You're all caught up")).toBeVisible();
  await r.request(
    `/records/${record.id}`,
    { values: { jobTitle: 'President' } },
    r.keys.agent,
    'PATCH',
  );
  await page.reload();
  await page.getByRole('button', { name: 'Reject', exact: true }).click();
  await expect(page.getByText("You're all caught up")).toBeVisible();
  await page.getByRole('link', { name: 'People', exact: true }).click();
  await page.getByRole('link', { name: 'Dana Levi' }).click();
  const sheet = page.getByRole('dialog', { name: 'Dana Levi' });
  await expect(sheet.getByRole('heading', { name: 'Dana Levi' })).toBeVisible();
  await expect(sheet.getByText('CEO', { exact: true })).toBeVisible();
  await sheet.getByRole('button', { name: 'History of Job title' }).click();
  const history = page.getByRole('dialog', { name: 'History of Job title' });
  await expect(history.getByText('rejected', { exact: true })).toBeVisible();
  await history.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(history).not.toBeVisible();
  await expect(sheet).toBeVisible();
  await page.screenshot({ path: '/tmp/retainer-web-record.png', fullPage: true });
  expect(
    await page.evaluate(() => Object.values(localStorage).some((v) => v.includes('rtn_'))),
  ).toBe(false);
});
test('preserves a draft after a stale edit and retries only with explicit action', async ({
  page,
  retainer: r,
}) => {
  const record = (
    await r.request(
      '/objects/person/records',
      { values: { name: 'Dana Levi', jobTitle: 'CTO' } },
      r.keys.user,
    )
  ).record;
  await signIn(page, r.url, r.keys.user);
  await page.goto(`${r.url}/app/r/${record.id}`);
  await page.getByRole('button', { name: 'Edit Job title', exact: true }).click();
  await page.getByRole('textbox', { name: 'Job title', exact: true }).fill('My draft');
  await r.request(
    `/records/${record.id}`,
    { values: { jobTitle: 'Changed elsewhere' } },
    r.keys.user,
    'PATCH',
  );
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('This record changed.', { exact: false })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Job title', exact: true })).toHaveValue(
    'My draft',
  );
  await expect(page.getByText('Changed elsewhere', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Retry with latest version' }).click();
  await expect(page.getByRole('textbox', { name: 'Job title', exact: true })).not.toBeVisible();
  await expect(page.getByText('My draft', { exact: true })).toBeVisible();
  expect((await r.request(`/records/${record.id}`)).fields.jobTitle).toBe('My draft');

  // Clicking away from a stale draft leaves it, rather than retrying unasked.
  await page.getByRole('button', { name: 'Edit Job title', exact: true }).click();
  await page.getByRole('textbox', { name: 'Job title', exact: true }).fill('Second draft');
  await r.request(
    `/records/${record.id}`,
    { values: { jobTitle: 'Changed again' } },
    r.keys.user,
    'PATCH',
  );
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('This record changed.', { exact: false })).toBeVisible();
  await page.getByRole('heading', { name: 'Dana Levi' }).click();
  await expect(page.getByRole('textbox', { name: 'Job title', exact: true })).not.toBeVisible();
  expect((await r.request(`/records/${record.id}`)).fields.jobTitle).toBe('Changed again');
});
test('approves a schema proposal and refreshes the schema', async ({ page, retainer: r }) => {
  await r.request('/schema/changes', {
    operations: [{ op: 'update_field', object: 'person', field: 'jobTitle', isUnique: true }],
  });
  await signIn(page, r.url, r.keys.user);
  await page.getByRole('button', { name: /Schema changes/ }).click();
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(page.getByText('No schema changes to review')).toBeVisible();
  await page.getByRole('link', { name: 'Schema', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Schema', exact: true })).toBeVisible();
  // Pick an object, filter its fields and open one in the side sheet.
  await page
    .getByRole('navigation', { name: 'Records' })
    .getByRole('button', { name: /^People/ })
    .click();
  await expect(page.getByRole('heading', { name: 'People', exact: true })).toBeVisible();
  await page.getByRole('searchbox', { name: 'Filter fields' }).fill('job');
  await page.getByRole('button', { name: 'Job title', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Job title' });
  await expect(sheet.getByText('No two records can share a value')).toBeVisible();
  await expect(page).toHaveURL(/object=person&field=jobTitle/);
  // A relation links to the field on its other side.
  await page.keyboard.press('Escape');
  await page.getByRole('searchbox', { name: 'Filter fields' }).fill('company');
  await page.getByRole('button', { name: 'Company', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Company' })
    .getByRole('button', { name: 'Company → People' })
    .click();
  await expect(page.getByRole('heading', { name: 'Companies', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'People' })).toBeVisible();
  // The approved change is in the history, in words.
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /Change history/ }).click();
  const history = page.getByRole('list', { name: 'Schema changes' });
  await expect(history.getByText('Change Person → Job title: unique')).toBeVisible();
  await page.getByRole('button', { name: 'Status All statuses' }).click();
  await page.getByRole('option', { name: 'Rejected' }).click();
  await expect(page.getByText('No rejected changes')).toBeVisible();
  const schema = await r.request('/schema');
  expect(
    schema.objects
      .find((o: any) => o.nameSingular === 'person')
      .fields.find((f: any) => f.name === 'jobTitle').isUnique,
  ).toBe(true);
});
test('shows why a schema approval failed, with the records in the way', async ({
  page,
  retainer: r,
}) => {
  await r.request('/schema/changes', {
    operations: [{ op: 'update_field', object: 'person', field: 'jobTitle', isUnique: true }],
  });
  // Two records now share the value the change would make unique.
  for (const name of ['Twin One', 'Twin Two']) {
    await r.request('/objects/person/records', { values: { name, jobTitle: 'CTO' } });
  }
  await signIn(page, r.url, r.keys.user);
  await page.getByRole('button', { name: /Schema changes/ }).click();
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(page.getByText(/^The schema change could not be applied: .+/)).toBeVisible();
  await expect(page.getByRole('link', { name: 'Twin One' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Twin Two' })).toBeVisible();
});
test('lists facts as a built-in and event types beside objects, and shows what an event is about', async ({
  page,
  retainer: r,
}) => {
  const acme = (await r.request('/objects/company/records', { values: { name: 'Acme Pilot Co' } }))
    .record;
  const meeting = await r.request('/events', {
    type: 'conversation',
    channel: 'calendar',
    fields: { medium: 'meeting' },
    occurredAt: '2026-10-29T12:00:00Z',
    title: 'Pilot review',
    about: [acme.id],
  });
  await signIn(page, r.url, r.keys.user);
  await page.goto(`${r.url}/app/schema`);
  await page
    .getByRole('navigation', { name: 'Built-in' })
    .getByRole('button', { name: /^Facts/ })
    .click();
  await expect(page.getByRole('heading', { name: 'Facts', exact: true })).toBeVisible();
  await expect(page).toHaveURL(/object=fact/);
  // Records and events are explained above the lists, with how each is written.
  await expect(page.getByText('upsert_record', { exact: true })).toBeVisible();
  await expect(page.getByText('log_event', { exact: true })).toBeVisible();
  await page
    .getByRole('navigation', { name: 'Activity' })
    .getByRole('button', { name: /^Conversations/ })
    .click();
  await expect(page.getByRole('heading', { name: 'Conversations', exact: true })).toBeVisible();
  await expect(page.getByText('occurredAt', { exact: true })).toBeVisible();
  await page.goto(`${r.url}/app/e/${meeting.id}`);
  await expect(page.getByRole('heading', { name: 'Pilot review' })).toBeVisible();
  await expect(
    page.getByText('Conversation · Meeting · Source: calendar', { exact: false }),
  ).toBeVisible();
  await expect(page.getByText('Activity · Conversation')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Acme Pilot Co' })).toBeVisible();
});
test('draws the objects and relations and opens them from the diagram', async ({
  page,
  retainer: r,
}) => {
  await r.request('/templates/sales/apply', {});
  await signIn(page, r.url, r.keys.user);
  await page.goto(`${r.url}/app/schema?tab=diagram`);
  const diagram = page.getByRole('figure', { name: 'Objects and their relations' });
  await expect(page.getByText(/^5 relations\./)).toBeVisible();
  // Cards list the label field and the relations, not every field.
  const deals = diagram.locator('.react-flow__node[data-id="deal"]');
  await expect(deals.getByRole('button', { name: /^Point of contact/ })).toBeVisible();
  await expect(deals.getByText('Amount')).toHaveCount(0);
  // A relation row opens its field in the Objects tab.
  await deals.getByRole('button', { name: /^Point of contact/ }).click();
  await expect(page.getByRole('heading', { name: 'Deals', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Point of contact' })).toBeVisible();
  await expect(page).toHaveURL(/object=deal&field=pointOfContact/);
  // A card's header opens the object.
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Diagram', exact: true }).click();
  await diagram.locator('.react-flow__node[data-id="company"]').getByRole('button').first().click();
  await expect(page.getByRole('heading', { name: 'Companies', exact: true })).toBeVisible();
});
test('deletes an event and refreshes the affected memory', async ({ page, retainer: r }) => {
  const record = (await r.request('/objects/person/records', { values: { name: 'Dana Levi' } }))
    .record;
  const event = await r.request('/events', {
    type: 'conversation',
    channel: 'zoom',
    occurredAt: '2026-10-20T10:00:00Z',
    title: 'Renewal call',
    summary: 'Discussed renewal',
    participants: [{ recordId: record.id }],
  });
  await r.request(
    `/records/${record.id}`,
    { values: { jobTitle: 'CTO' }, source: event.id },
    r.keys.agent,
    'PATCH',
  );
  await r.request(`/records/${record.id}/facts`, {
    text: 'Needs a renewal quote',
    source: event.id,
    quote: 'Please send a quote',
  });
  await signIn(page, r.url, r.keys.user);
  await page.goto(`${r.url}/app/r/${record.id}?tab=events`);
  await expect(page.getByText('Participant', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Renewal call' }).click();
  await page.getByRole('button', { name: 'Delete event', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete event', exact: true }).click();
  await expect(
    page.getByText(/1 assertions retracted, 1 records recomputed, 1 facts hidden/),
  ).toBeVisible();
  await page.goto(`${r.url}/app/r/${record.id}`);
  await expect(page.getByText('No facts yet')).toBeVisible();
});
test('hides mutations from agent and read-only keys and isolates a replacement session', async ({
  page,
  retainer: r,
}) => {
  const record = (
    await r.request('/objects/person/records', { values: { name: 'Private Acme person' } })
  ).record;
  await signIn(page, r.url, r.keys.agent);
  await expect(page.getByText('This key represents a agent.', { exact: false })).toBeVisible();
  await page.goto(`${r.url}/app/r/${record.id}`);
  await expect(page.getByRole('button', { name: 'Edit Job title' })).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Record actions' })).not.toBeVisible();
  await page.getByRole('link', { name: 'People', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Private Acme person' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'New person' })).not.toBeVisible();
  await signOut(page);
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  await page.getByLabel('Personal API key').fill(r.keys.other);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('link', { name: 'People', exact: true }).click();
  await expect(page.getByText('No records found')).toBeVisible();
  await expect(page.getByText('Private Acme person')).not.toBeVisible();
});

test('bulk review reports individual failures and keeps only failed items selected', async ({
  page,
  retainer: r,
}) => {
  const holder = (
    await r.request(
      '/objects/person/records',
      { values: { name: 'Claim holder', emails: 'taken@acme.test' } },
      r.keys.user,
    )
  ).record;
  const blocked = (
    await r.request(
      '/objects/person/records',
      { values: { name: 'Blocked person', emails: 'other@acme.test' } },
      r.keys.user,
    )
  ).record;
  const valid = (
    await r.request(
      '/objects/person/records',
      { values: { name: 'Valid person', jobTitle: 'CTO' } },
      r.keys.user,
    )
  ).record;
  await r.request(
    `/records/${blocked.id}`,
    { values: { emails: 'taken@acme.test' } },
    r.keys.agent,
    'PATCH',
  );
  await r.request(`/records/${valid.id}`, { values: { jobTitle: 'CEO' } }, r.keys.agent, 'PATCH');
  await signIn(page, r.url, r.keys.user);
  await page.getByLabel('Select Blocked person emails').check();
  await page.getByLabel('Select Valid person jobTitle').check();
  await page.getByRole('button', { name: 'Accept selected' }).click();
  await expect(page.getByRole('link', { name: 'View conflicting record' })).toHaveAttribute(
    'href',
    `/app/r/${holder.id}`,
  );
  await expect(page.getByText('Value accepted', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Select Blocked person emails')).toBeChecked();
  await expect(page.getByLabel('Select Valid person jobTitle')).not.toBeVisible();
});

test('discards a previous session response that arrives after a replacement login', async ({
  page,
  retainer: r,
}) => {
  await r.request('/objects/person/records', { values: { name: 'Previous session secret' } });
  await signIn(page, r.url, r.keys.user);
  let release: () => void = () => {};
  let arrived: () => void = () => {};
  const delayed = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  let first = true;
  await page.route('**/v1/objects/person/query', async (route) => {
    if (!first) {
      await route.continue();
      return;
    }
    first = false;
    const response = await route.fetch();
    arrived();
    await delayed;
    try {
      await route.fulfill({ response });
    } catch {
      /* An aborted old request can be discarded by the browser itself. */
    }
  });
  await page.getByRole('link', { name: 'People', exact: true }).click();
  await started;
  await signOut(page);
  await page.getByLabel('Personal API key').fill(r.keys.other);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('link', { name: 'People', exact: true }).click();
  await expect(page.getByText('No records found')).toBeVisible();
  release();
  await expect(page.getByText('Previous session secret')).not.toBeVisible();
  await expect(page.getByText('Other workspace', { exact: true })).toBeVisible();
  await page.unrouteAll({ behavior: 'wait' });
});

test('supports keyboard review and system dark mode on a narrow screen', async ({
  page,
  retainer: r,
}) => {
  const record = (
    await r.request(
      '/objects/person/records',
      { values: { name: 'Keyboard person', jobTitle: 'CTO' } },
      r.keys.user,
    )
  ).record;
  await r.request(`/records/${record.id}`, { values: { jobTitle: 'CEO' } }, r.keys.agent, 'PATCH');
  await signIn(page, r.url, r.keys.user);
  await page.locator('body').click({ position: { x: 1000, y: 30 } });
  await page.keyboard.press('x');
  await expect(page.getByLabel('Select Keyboard person jobTitle')).toBeChecked();
  await page.keyboard.press('a');
  await expect(page.getByText("You're all caught up")).toBeVisible();
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('html')).toHaveClass('dark');
  await page.screenshot({ path: '/tmp/retainer-web-dark-mobile.png', fullPage: true });
});

test('searches the workspace with the command palette and keeps list filters in the URL', async ({
  page,
  retainer: r,
}) => {
  await r.request('/objects/person/records', { values: { name: 'Dana Levi', jobTitle: 'CTO' } });
  await r.request('/objects/person/records', { values: { name: 'Other person', jobTitle: 'CEO' } });
  await signIn(page, r.url, r.keys.user);
  await page.getByRole('link', { name: 'People', exact: true }).click();
  await page.getByRole('button', { name: 'Filter', exact: true }).click();
  await page.getByRole('combobox', { name: 'Filter by' }).fill('job');
  await page.getByRole('option', { name: 'Job title' }).click();
  await page.getByLabel('Job title', { exact: true }).fill('CTO');
  await page.getByRole('button', { name: 'Apply filter' }).click();
  await expect(page.getByRole('link', { name: 'Dana Levi' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Other person' })).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Remove filter Job title' })).toBeVisible();
  expect(page.url()).toContain('filter=');
  await page.reload();
  await expect(page.getByRole('link', { name: 'Dana Levi' })).toBeVisible();
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByLabel('Search the workspace').fill('Other');
  await page.getByRole('dialog').getByRole('button', { name: 'Other person', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Other person' })).toBeVisible();
});

test('sorts from column headers, resizes columns, and collapses the sidebar', async ({
  page,
  retainer: r,
}) => {
  for (const [name, jobTitle] of [
    ['Bravo person', 'B title'],
    ['Alpha person', 'C title'],
    ['Charlie person', 'A title'],
  ])
    await r.request('/objects/person/records', { values: { name, jobTitle } });
  await signIn(page, r.url, r.keys.user);
  await page.getByRole('link', { name: 'People', exact: true }).click();
  const grid = page.getByRole('region', { name: 'People' });
  const header = grid.getByRole('columnheader', { name: 'Job title' });
  await header.getByRole('button').click();
  await expect(header).toHaveAttribute('aria-sort', 'ascending');
  await expect(grid.getByRole('link', { name: / person$/ })).toHaveText([
    'Charlie person',
    'Bravo person',
    'Alpha person',
  ]);
  await header.getByRole('button').click();
  await expect(header).toHaveAttribute('aria-sort', 'descending');
  await expect(grid.getByRole('link', { name: / person$/ }).first()).toHaveText('Alpha person');
  await header.getByRole('button').click();
  await expect(header).not.toHaveAttribute('aria-sort', /.+/);
  expect(page.url()).not.toContain('sort=');

  const resize = grid.getByRole('separator', { name: 'Resize Job title' });
  const before = Number(await resize.getAttribute('aria-valuenow'));
  await resize.focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect(resize).toHaveAttribute('aria-valuenow', String(before + 32));
  await page.reload();
  await expect(page.getByRole('separator', { name: 'Resize Job title' })).toHaveAttribute(
    'aria-valuenow',
    String(before + 32),
  );

  await page.getByRole('button', { name: 'Collapse sidebar' }).click();
  await expect(page.getByRole('button', { name: 'Expand sidebar' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Expand sidebar' })).toBeVisible();
  await page.getByRole('link', { name: 'Review inbox' }).click();
  await expect(page.getByRole('heading', { name: 'Review inbox' })).toBeVisible();
});

test('edits schema-driven scalar and composite fields through the real API', async ({
  page,
  retainer: r,
}) => {
  await r.request(
    '/schema/changes',
    {
      operations: [
        {
          op: 'create_field',
          object: 'person',
          field: { name: 'score', label: 'Score', type: 'number' },
        },
        {
          op: 'create_field',
          object: 'person',
          field: { name: 'active', label: 'Active', type: 'boolean' },
        },
        {
          op: 'create_field',
          object: 'person',
          field: { name: 'renewal', label: 'Renewal date', type: 'date' },
        },
        {
          op: 'create_field',
          object: 'person',
          field: { name: 'meetingAt', label: 'Meeting at', type: 'date_time' },
        },
        {
          op: 'create_field',
          object: 'person',
          field: { name: 'budget', label: 'Budget', type: 'money' },
        },
        {
          op: 'create_field',
          object: 'person',
          field: {
            name: 'stage',
            label: 'Stage',
            type: 'select',
            settings: {
              options: [
                { value: 'new', label: 'New' },
                { value: 'ready', label: 'Ready' },
              ],
            },
          },
        },
        {
          op: 'create_field',
          object: 'person',
          field: {
            name: 'topics',
            label: 'Topics',
            type: 'multi_select',
            settings: {
              options: [
                { value: 'security', label: 'Security' },
                { value: 'billing', label: 'Billing' },
              ],
            },
          },
        },
        {
          op: 'create_field',
          object: 'person',
          field: { name: 'sites', label: 'Sites', type: 'links' },
        },
        {
          op: 'create_field',
          object: 'person',
          field: { name: 'metadata', label: 'Metadata', type: 'json' },
        },
      ],
    },
    r.keys.user,
  );
  const company = (
    await r.request('/objects/company/records', { values: { name: 'Acme Company' } })
  ).record;
  const record = (
    await r.request('/objects/person/records', {
      values: { name: 'Dana Levi', metadata: { source: 'test' } },
    })
  ).record;
  await signIn(page, r.url, r.keys.user);
  await page.goto(`${r.url}/app/r/${record.id}`);
  async function edit(label: string, change: () => Promise<unknown>) {
    await page.getByRole('button', { name: `Edit ${label}`, exact: true }).click();
    await change();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    // The button reads "Saving…" while in flight; the editor closes once the write lands.
    await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toHaveCount(0);
  }
  // Fields chosen from a list save on the pick and close; the list goes away.
  async function pick(label: string, option: string) {
    await page.getByRole('button', { name: `Edit ${label}`, exact: true }).click();
    await page.getByRole('option', { name: option, exact: true }).click();
    await expect(page.getByRole('listbox')).toHaveCount(0);
  }
  await edit('Score', () => page.getByLabel('Score', { exact: true }).fill('42.5'));
  await pick('Active', 'Yes');
  await edit('Renewal date', () =>
    page.getByLabel('Renewal date', { exact: true }).fill('2026-12-01'),
  );
  await edit('Meeting at', () =>
    page.getByLabel('Meeting at', { exact: true }).fill('2026-12-01T14:30'),
  );
  await edit('Budget', async () => {
    await page.getByLabel('Amount', { exact: true }).fill('0.000001');
    await page.getByRole('button', { name: 'Currency USD' }).click();
    await page.getByRole('combobox', { name: 'Search currency' }).fill('shekel');
    await page.getByRole('option', { name: 'ILS', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Currency ILS' })).toBeVisible();
  });
  await pick('Stage', 'Ready');
  // Several choices are kept until the list is left: here with ⌘/Ctrl+Enter.
  await page.getByRole('button', { name: 'Edit Topics', exact: true }).click();
  await page.getByRole('option', { name: 'Security', exact: true }).click();
  await expect(page.getByRole('option', { name: 'Security', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await edit('Emails', async () => {
    await page.getByRole('button', { name: 'Add email' }).click();
    await page.getByLabel('Email 1', { exact: true }).fill('Dana@acme.test');
  });
  await edit('Phones', async () => {
    await page.getByRole('button', { name: 'Add phone' }).click();
    await page.getByLabel('Phone 1', { exact: true }).fill('+972501234567');
    await page.getByLabel('Country code 1', { exact: true }).fill('IL');
  });
  await edit('Sites', async () => {
    await page.getByRole('button', { name: 'Add link' }).click();
    await page.getByLabel('URL 1', { exact: true }).fill('https://acme.test');
    await page.getByLabel('Link label 1', { exact: true }).fill('Website');
  });
  await edit('Address', () => page.getByLabel('City', { exact: true }).fill('Tel Aviv'));
  await edit('Name', () => page.getByLabel('First name', { exact: true }).fill('Danielle'));
  await page.getByRole('button', { name: 'Edit Company', exact: true }).click();
  await page.getByRole('combobox', { name: 'Company', exact: true }).fill('Acme');
  await expect(page.getByRole('option', { name: 'Acme Company' })).toHaveCount(1);
  await page.getByRole('option', { name: 'Acme Company' }).click();
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Edit Metadata', exact: true })).not.toBeVisible();
  const updated = await r.request(`/records/${record.id}`);
  expect(updated.fields).toMatchObject({
    name: { first: 'Danielle', last: 'Levi' },
    score: 42.5,
    active: true,
    renewal: '2026-12-01',
    budget: { amountMicros: 1, currency: 'ILS' },
    stage: 'ready',
    topics: ['security'],
    emails: { primary: 'dana@acme.test' },
    phones: { primary: { number: '+972501234567', countryCode: 'IL' } },
    sites: { primary: { url: 'https://acme.test', label: 'Website' } },
    address: { city: 'Tel Aviv' },
    company: company.id,
    metadata: { source: 'test' },
  });
});

test('opens records from the list in a side sheet and edits fields inline', async ({
  page,
  retainer: r,
}) => {
  const dana = (
    await r.request('/objects/person/records', { values: { name: 'Dana Levi', jobTitle: 'CTO' } })
  ).record;
  await r.request('/objects/person/records', { values: { name: 'Noa Cohen', jobTitle: 'CFO' } });
  await signIn(page, r.url, r.keys.user);
  await page.getByRole('link', { name: 'People', exact: true }).click();
  const grid = page.getByRole('region', { name: 'People' });

  // A click anywhere on the row opens the sheet and records it in the URL.
  await grid.getByRole('row').filter({ hasText: 'Dana Levi' }).getByText('CTO').click();
  const sheet = page.getByRole('dialog', { name: 'Dana Levi' });
  await expect(sheet).toBeVisible();
  expect(new URL(page.url()).searchParams.get('record')).toBe(dana.id);

  // Click the value, type, Enter: saved through the API and shown in the grid behind.
  await sheet.getByText('CTO', { exact: true }).click();
  const input = sheet.getByRole('textbox', { name: 'Job title', exact: true });
  await expect(input).toBeFocused();
  await input.fill('Chief Technology Officer');
  await input.press('Enter');
  await expect(input).not.toBeVisible();
  await expect(sheet.getByText('Chief Technology Officer', { exact: true })).toBeVisible();
  await expect(grid.getByText('Chief Technology Officer', { exact: true })).toBeVisible();
  expect((await r.request(`/records/${dana.id}`)).fields.jobTitle).toBe('Chief Technology Officer');

  // Escape cancels an edit without closing the sheet; the next Escape closes it.
  await sheet.getByRole('button', { name: 'Edit Job title', exact: true }).click();
  await input.fill('Discarded draft');
  await page.keyboard.press('Escape');
  await expect(input).not.toBeVisible();
  await expect(sheet).toBeVisible();
  await expect(sheet.getByText('Chief Technology Officer', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(sheet).not.toBeVisible();
  expect(new URL(page.url()).searchParams.get('record')).toBeNull();

  // Back reopens it; clicking another row while open swaps the record.
  await page.goBack();
  await expect(sheet).toBeVisible();
  await grid.getByRole('link', { name: 'Noa Cohen' }).click();
  await expect(page.getByRole('dialog', { name: 'Noa Cohen' })).toBeVisible();
  await expect(sheet).not.toBeVisible();

  // The full page is one click away and edits the same way.
  await page.getByRole('link', { name: 'Open full page' }).click();
  await expect(page.getByRole('heading', { name: 'Noa Cohen', level: 1 })).toBeVisible();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await page.screenshot({ path: '/tmp/retainer-web-sheet.png', fullPage: true });
});

test('creates a record from the list with a schema-driven form', async ({ page, retainer: r }) => {
  await signIn(page, r.url, r.keys.user);
  await page.getByRole('link', { name: 'People', exact: true }).click();
  await page.getByRole('button', { name: 'New person', exact: true }).click();
  const form = page.getByRole('dialog', { name: 'New person' });
  await form.getByLabel('First name').fill('Noa');
  await form.getByLabel('Last name').fill('Peretz');
  await form.getByRole('textbox', { name: 'Job title', exact: true }).fill('Head of Sales');
  await form.getByRole('button', { name: 'Create person', exact: true }).click();
  // The new record opens in the sheet over the list, which already shows it.
  const sheet = page.getByRole('dialog', { name: 'Noa Peretz' });
  await expect(sheet.getByText('Head of Sales', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Noa Peretz' })).toBeVisible();
  const id = new URL(page.url()).searchParams.get('record');
  expect(await r.request(`/records/${id}`)).toMatchObject({
    fields: { name: { first: 'Noa', last: 'Peretz' }, jobTitle: 'Head of Sales' },
    createdBy: { type: 'user', id: 'dana' },
  });
});

test('checks required fields and shows a unique conflict on the field', async ({
  page,
  retainer: r,
}) => {
  const holder = (
    await r.request(
      '/objects/person/records',
      { values: { name: 'Claim holder', emails: 'taken@acme.test', jobTitle: 'CTO' } },
      r.keys.user,
    )
  ).record;
  const change = await r.request('/schema/changes', {
    operations: [{ op: 'update_field', object: 'person', field: 'jobTitle', isNullable: false }],
  });
  await r.request(`/schema/changes/${change.change.id}/approve`, {}, r.keys.user);
  expect(holder.fields.jobTitle).toBe('CTO');
  await signIn(page, r.url, r.keys.user);
  await page.goto(`${r.url}/app/o/person`);
  await page.getByRole('button', { name: 'New person', exact: true }).click();
  const form = page.getByRole('dialog', { name: 'New person' });
  await form.getByLabel('First name').fill('Second');
  await form.getByRole('button', { name: 'Add email' }).click();
  await form.getByRole('textbox', { name: 'Email 1' }).fill('taken@acme.test');
  await form.getByRole('button', { name: 'Create person', exact: true }).click();
  await expect(form.getByText('Job title is required')).toBeVisible();
  await form.getByRole('textbox', { name: 'Job title', exact: true }).fill('CFO');
  await form.getByRole('button', { name: 'Create person', exact: true }).click();
  await expect(form.getByText('Emails already belongs to another record')).toBeVisible();
  await expect(form.getByRole('link', { name: 'View that record' })).toBeVisible();
  expect((await r.request('/objects/person/query', {})).records).toHaveLength(1);
});

test('deletes a record from its sheet and reports it', async ({ page, retainer: r }) => {
  const record = (
    await r.request('/objects/person/records', { values: { name: 'Dana Levi' } }, r.keys.user)
  ).record;
  await signIn(page, r.url, r.keys.user);
  await page.goto(`${r.url}/app/o/person?record=${record.id}`);
  const sheet = page.getByRole('dialog', { name: 'Dana Levi' });
  await sheet.getByRole('button', { name: 'Record actions' }).click();
  await page.getByRole('menuitem', { name: 'Delete…' }).click();
  const confirm = page.getByRole('dialog', { name: 'Delete Dana Levi?' });
  await confirm.getByRole('button', { name: 'Delete record', exact: true }).click();
  await expect(page.getByText('Deleted Dana Levi.')).toBeVisible();
  await expect(sheet).not.toBeVisible();
  await expect(page.getByText('No records found')).toBeVisible();
  await expect(r.request(`/records/${record.id}`)).rejects.toThrow(/record_deleted/);
});

test('warns before a delete that cascades to linked records', async ({ page, retainer: r }) => {
  const change = await r.request('/schema/changes', {
    operations: [
      {
        op: 'create_field',
        object: 'person',
        field: {
          name: 'employer',
          label: 'Employer',
          type: 'relation',
          settings: {
            targetObject: 'company',
            inverseField: 'staff',
            relationCardinality: 'many_to_one',
            onDelete: 'cascade',
          },
        },
      },
    ],
  });
  expect(change.status).toBe('applied');
  const acme = (await r.request('/objects/company/records', { values: { name: 'Acme' } })).record;
  await r.request('/objects/person/records', { values: { name: 'Dana Levi', employer: acme.id } });
  await signIn(page, r.url, r.keys.user);
  await page.goto(`${r.url}/app/r/${acme.id}`);
  await page.getByRole('button', { name: 'Record actions' }).click();
  await page.getByRole('menuitem', { name: 'Delete…' }).click();
  const confirm = page.getByRole('dialog', { name: 'Delete Acme?' });
  await expect(confirm.getByText('Deleting it also deletes 1 person linked to it.')).toBeVisible();
  await confirm.getByRole('button', { name: 'Delete record', exact: true }).click();
  await expect(page.getByText('Deleted Acme and 1 linked record.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Companies', exact: true })).toBeVisible();
});

test('selects rows in a list to delete them together or merge two', async ({
  page,
  retainer: r,
}) => {
  const change = await r.request('/schema/changes', {
    operations: [
      {
        op: 'create_field',
        object: 'person',
        field: {
          name: 'employer',
          label: 'Employer',
          type: 'relation',
          settings: {
            targetObject: 'company',
            inverseField: 'staff',
            relationCardinality: 'many_to_one',
            onDelete: 'cascade',
          },
        },
      },
    ],
  });
  expect(change.status).toBe('applied');
  const company = async (name: string) =>
    (await r.request('/objects/company/records', { values: { name } })).record.id as string;
  const one = await company('One'),
    two = await company('Two');
  await company('Three');
  for (const [name, employer] of [
    ['Dana Levi', one],
    ['Avi Katz', two],
    ['Noa Cohen', two],
  ])
    await r.request('/objects/person/records', { values: { name, employer } });

  await signIn(page, r.url, r.keys.user);
  await page.getByRole('link', { name: 'Companies', exact: true }).click();
  const grid = page.getByRole('region', { name: 'Companies' });
  await grid.getByRole('checkbox', { name: 'Select One' }).check();
  await grid.getByRole('checkbox', { name: 'Select Two' }).check();
  await expect(page.getByText('2 selected')).toBeVisible();
  // Checking a box selects; it does not open the record.
  expect(new URL(page.url()).searchParams.get('record')).toBeNull();
  await expect(
    grid.getByRole('checkbox', { name: 'Select all rows on this page' }),
  ).toHaveJSProperty('indeterminate', true);
  await page.screenshot({ path: '/tmp/retainer-web-list-selection.png' });

  // The warning counts what both deletes cascade to, once each.
  await page.getByRole('button', { name: 'Delete…' }).click();
  const confirm = page.getByRole('dialog', { name: 'Delete 2 companies?' });
  await expect(
    confirm.getByText('Deleting them also deletes 3 people linked to them.'),
  ).toBeVisible();
  await confirm.getByRole('button', { name: 'Delete 2 companies', exact: true }).click();
  await expect(page.getByText('Deleted 2 companies and 3 linked records.')).toBeVisible();
  await expect(grid.getByRole('link', { name: 'Three' })).toBeVisible();
  await expect(grid.getByRole('link', { name: 'One' })).not.toBeVisible();
  await expect(page.getByText('2 selected')).not.toBeVisible();
  expect((await r.request(`/objects/person/query`, {})).records).toHaveLength(0);

  // Exactly two selected offers a merge.
  const older = (await r.request('/objects/person/records', { values: { name: 'Yael Mizrahi' } }))
    .record;
  const newer = (await r.request('/objects/person/records', { values: { name: 'Yael Mizrachi' } }))
    .record;
  await page.getByRole('link', { name: 'People', exact: true }).click();
  const people = page.getByRole('region', { name: 'People' });
  await people.getByRole('checkbox', { name: 'Select all rows on this page' }).check();
  await expect(page.getByText('2 selected')).toBeVisible();
  await page.getByRole('button', { name: 'Merge…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Merge duplicate records' });
  await dialog.getByRole('button', { name: 'Merge into Yael Mizrahi' }).click();
  await expect(page.getByText('Merged Yael Mizrachi into')).toBeVisible();
  await expect(people.getByRole('link', { name: /^Yael/ })).toHaveCount(1);
  expect((await r.request(`/records/${newer.id}`)).id).toBe(older.id);
});

test('totals columns over the whole list and edits a cell from the grid', async ({
  page,
  retainer: r,
}) => {
  await r.request('/objects/person/records', { values: { name: 'Dana Levi', jobTitle: 'CTO' } });
  await r.request('/objects/person/records', { values: { name: 'Noa Cohen', jobTitle: 'CFO' } });
  const avi = (await r.request('/objects/person/records', { values: { name: 'Avi Katz' } })).record;
  await signIn(page, r.url, r.keys.user);
  await page.getByRole('link', { name: 'People', exact: true }).click();
  const grid = page.getByRole('region', { name: 'People' });
  await expect(page.getByText('1–3 of 3')).toBeVisible();

  await grid.getByRole('button', { name: 'Calculate Job title' }).click();
  await page.getByRole('menuitemradio', { name: 'Percent empty' }).click();
  await expect(grid.getByRole('button', { name: 'Calculate Job title' })).toHaveText('Empty 33%');
  await grid.getByRole('button', { name: 'Calculate Name' }).click();
  await page.getByRole('menuitemradio', { name: 'Not empty', exact: true }).click();
  await expect(grid.getByRole('button', { name: 'Calculate Name' })).toHaveText('Not empty 3');

  // The pencil edits in place, without opening the record, and the total follows.
  const row = grid.getByRole('row').filter({ hasText: 'Avi Katz' });
  await row.hover();
  await row.getByRole('button', { name: 'Edit Job title of Avi Katz' }).click();
  const input = page.getByRole('textbox', { name: 'Job title', exact: true });
  await expect(input).toBeFocused();
  await page.screenshot({ path: '/tmp/retainer-web-grid-edit.png' });
  await input.fill('CEO');
  await input.press('Enter');
  await expect(input).not.toBeVisible();
  await expect(row.getByText('CEO', { exact: true })).toBeVisible();
  expect(new URL(page.url()).searchParams.get('record')).toBeNull();
  expect((await r.request(`/records/${avi.id}`)).fields.jobTitle).toBe('CEO');
  await expect(grid.getByRole('button', { name: 'Calculate Job title' })).toHaveText('Empty 0%');

  // Escape drops a draft; the chosen totals are kept for next time.
  await row.hover();
  await row.getByRole('button', { name: 'Edit Job title of Avi Katz' }).click();
  await input.fill('Discarded');
  await page.keyboard.press('Escape');
  await expect(input).not.toBeVisible();
  await expect(row.getByText('CEO', { exact: true })).toBeVisible();
  await page.reload();
  await expect(grid.getByRole('button', { name: 'Calculate Job title' })).toHaveText('Empty 0%');
  await page.screenshot({ path: '/tmp/retainer-web-list-totals.png', fullPage: true });
});

test('merges a suggested duplicate, choosing the value to keep', async ({ page, retainer: r }) => {
  const older = (
    await r.request('/objects/person/records', {
      values: { name: 'Yael Mizrahi', jobTitle: 'CTO', emails: 'yael@acme.test' },
    })
  ).record;
  const newer = (
    await r.request('/objects/person/records', {
      values: { name: 'Yael Mizrachi', jobTitle: 'VP Engineering', emails: 'yael@gmail.test' },
    })
  ).record;
  await r.consolidate();
  await signIn(page, r.url, r.keys.user);
  await page.getByRole('button', { name: /Suggested merges/ }).click();
  await expect(page.getByText('similar names')).toBeVisible();
  await page
    .getByRole('button', { name: /^Compare and merge Yael Mizra.*hi and Yael Mizra.*hi$/ })
    .click();
  const dialog = page.getByRole('dialog', { name: 'Merge duplicate records' });
  // The older record survives by default; emails are combined unless chosen.
  await expect(dialog.getByRole('radio', { name: /Yael Mizrahi/ })).toBeChecked();
  await expect(dialog.getByRole('button', { name: 'Value for Emails' })).toHaveText('Combine both');
  await dialog.getByRole('button', { name: 'Value for Job title' }).click();
  await page.getByRole('option', { name: 'Merged record’s' }).click();
  await expect(dialog.getByRole('button', { name: 'Value for Job title' })).toHaveText(
    'Merged record’s',
  );
  await dialog.getByRole('button', { name: 'Merge into Yael Mizrahi' }).click();
  await expect(page.getByText('Merged Yael Mizrachi into')).toBeVisible();
  await expect(page.getByText('No suggested merges')).toBeVisible();
  expect(await r.request(`/records/${newer.id}`)).toMatchObject({
    id: older.id,
    fields: {
      jobTitle: 'VP Engineering',
      emails: { primary: 'yael@acme.test', additional: ['yael@gmail.test'] },
    },
  });
});

test('dismisses a suggestion, and merges a duplicate found from the record', async ({
  page,
  retainer: r,
}) => {
  await r.request('/objects/person/records', { values: { name: 'Yael Mizrahi' } });
  await r.request('/objects/person/records', { values: { name: 'Yael Mizrachi' } });
  const keep = (await r.request('/objects/person/records', { values: { name: 'Avi Cohen' } }))
    .record;
  const away = (
    await r.request('/objects/person/records', { values: { name: 'Avi Cohen', jobTitle: 'CFO' } })
  ).record;
  await r.consolidate();
  await signIn(page, r.url, r.keys.user);
  await page.goto(`${r.url}/app/?tab=mergeSuggestions`);
  await page
    .getByRole('button', { name: /^Compare and merge Yael Mizra.*hi and Yael Mizra.*hi$/ })
    .click();
  await page.getByRole('button', { name: 'Not duplicates' }).click();
  await expect(page.getByText('Suggestion dismissed.', { exact: false })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Yael Mizrachi' })).not.toBeVisible();

  await page.goto(`${r.url}/app/r/${keep.id}`);
  await page.getByRole('button', { name: 'Record actions' }).click();
  await page.getByRole('menuitem', { name: 'Merge a duplicate…' }).click();
  const picker = page.getByRole('dialog', { name: 'Merge a duplicate into Avi Cohen' });
  // The search starts from the record's own name, and the record itself is not offered.
  await expect(picker.getByRole('button', { name: 'Avi Cohen' })).toHaveCount(1);
  await picker.getByRole('button', { name: 'Avi Cohen' }).click();
  const dialog = page.getByRole('dialog', { name: 'Merge duplicate records' });
  await expect(dialog.getByText('Keeps the only value')).toBeVisible();
  await dialog.getByRole('button', { name: 'Merge into Avi Cohen' }).click();
  await expect(page.getByText('Merged Avi Cohen into')).toBeVisible();
  await expect(page.getByText('CFO', { exact: true })).toBeVisible();
  expect((await r.request(`/records/${away.id}`)).id).toBe(keep.id);
});

test('erases a person for a privacy request after typed confirmation', async ({
  page,
  retainer: r,
}) => {
  const person = (
    await r.request('/objects/person/records', {
      values: { name: 'Avi Erased', emails: 'avi@erased.test' },
    })
  ).record;
  const event = await r.request('/events', {
    type: 'conversation',
    channel: 'zoom',
    occurredAt: '2026-10-20T10:00:00Z',
    title: 'Intro call',
    participants: [{ recordId: person.id }],
  });
  await r.request(`/records/${person.id}/facts`, { text: 'Prefers email', source: event.id });
  await signIn(page, r.url, r.keys.user);
  await page.goto(`${r.url}/app/r/${person.id}`);
  await page.getByRole('button', { name: 'Record actions' }).click();
  await page.getByRole('menuitem', { name: 'Erase for privacy…' }).click();
  const confirm = page.getByRole('dialog', { name: 'Erase Avi Erased permanently?' });
  const erase = confirm.getByRole('button', { name: 'Erase permanently' });
  await expect(erase).toBeDisabled();
  await confirm.getByLabel('Confirmation').fill('Avi');
  await expect(erase).toBeDisabled();
  await confirm.getByLabel('Confirmation').fill('Avi Erased');
  await erase.click();
  await expect(
    page.getByText(/Erased Avi Erased: 1 record, 1 event, 1 fact and \d+ values\./),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: 'People', exact: true })).toBeVisible();
  await expect(r.request(`/records/${person.id}`)).rejects.toThrow(/not_found/);
  await expect(
    r.request('/objects/person/records', { values: { name: 'Avi', emails: 'avi@erased.test' } }),
  ).rejects.toThrow(/suppressed/);
});

test('offers erasing only to admin user keys', async ({ page, retainer: r }) => {
  const person = (await r.request('/objects/person/records', { values: { name: 'Dana Levi' } }))
    .record;
  await signIn(page, r.url, r.keys.writer);
  await page.goto(`${r.url}/app/r/${person.id}`);
  await page.getByRole('button', { name: 'Record actions' }).click();
  await expect(page.getByRole('menuitem', { name: 'Delete…' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Erase for privacy…' })).not.toBeVisible();
});

test('finds records, facts and events across objects with the command palette', async ({
  page,
  retainer: r,
}) => {
  const dana = (await r.request('/objects/person/records', { values: { name: 'Dana Levi' } }))
    .record;
  await r.request('/objects/company/records', { values: { name: 'Levi Logistics' } });
  const event = await r.request('/events', {
    type: 'conversation',
    channel: 'phone',
    fields: { medium: 'call' },
    occurredAt: '2026-10-20T10:00:00Z',
    title: 'Quarterly pricing review',
    participants: [{ recordId: dana.id }],
  });
  await r.request(`/records/${dana.id}/facts`, {
    text: 'Wants quarterly invoices',
    source: event.id,
  });
  await signIn(page, r.url, r.keys.user);
  await page.keyboard.press('ControlOrMeta+k');
  const palette = page.getByRole('dialog', { name: 'Find anything' });
  await palette.getByLabel('Search the workspace').fill('Levi');
  await expect(
    palette.getByRole('region', { name: 'People' }).getByRole('button', { name: 'Dana Levi' }),
  ).toBeVisible();
  await expect(
    palette
      .getByRole('region', { name: 'Companies' })
      .getByRole('button', { name: 'Levi Logistics' }),
  ).toBeVisible();
  await palette.getByLabel('Search the workspace').fill('quarterly');
  await expect(
    palette
      .getByRole('region', { name: 'Events' })
      .getByRole('button', { name: /Quarterly pricing review/ }),
  ).toBeVisible();
  await palette
    .getByRole('region', { name: 'Facts' })
    .getByRole('button', { name: 'Wants quarterly invoices' })
    .click();
  await expect(page.getByRole('heading', { name: 'Dana Levi' })).toBeVisible();
  expect(page.url()).toContain('tab=facts');
  await expect(page.getByText('Wants quarterly invoices')).toBeVisible();
});

const usd = (dollars: number) => ({ currency: 'USD', amountMicros: dollars * 1_000_000 });

/** What a drag announces to screen readers. */
const announced = (page: Page, text: string) => page.getByRole('status').filter({ hasText: text });

/** Space picks an item up, an arrow carries it to the next target that way, Space drops it. */
async function moveByKeyboard(
  page: Page,
  item: Locator,
  arrow: 'ArrowLeft' | 'ArrowRight',
  from: string,
  to: string,
) {
  const name = await item.getAttribute('aria-label');
  await item.focus();
  await page.keyboard.press('Space');
  await expect(announced(page, `${name} is over ${from}.`)).toHaveCount(1);
  // The drag listens for keys from the task after the pick-up; a person
  // can't press that fast, but a test can.
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve)));
  await page.keyboard.press(arrow);
  await expect(announced(page, `${name} is over ${to}.`)).toHaveCount(1);
  await page.keyboard.press('Space');
}

test('saves a board view, totals its columns, and moves a card from the keyboard', async ({
  page,
  retainer: r,
}) => {
  await r.request('/templates/sales/apply', {});
  for (const [name, stage, amount] of [
    ['Acme renewal', 'lead', 10_000],
    ['Globex pilot', 'lead', 5_000],
    ['Hooli platform', 'qualified', 20_000],
  ] as const)
    await r.request('/objects/deal/records', { values: { name, stage, amount: usd(amount) } });
  await r.request('/objects/deal/records', { values: { name: 'Unscoped inbound' } });
  await signIn(page, r.url, r.keys.user);
  // By the plural name, which the address also takes; views are the object's either way.
  await page.goto(`${r.url}/app/o/deals`);

  await page.getByRole('button', { name: 'View: All deals' }).click();
  await page.getByRole('menuitem', { name: 'New view…' }).click();
  const dialog = page.getByRole('dialog', { name: 'New view' });
  await dialog.getByRole('textbox', { name: 'Name' }).fill('Pipeline');
  await dialog.getByRole('button', { name: 'Board', exact: true }).click();
  // The object's only single select is the default.
  await expect(dialog.getByRole('button', { name: /^Group by/ })).toContainText('Stage');
  await dialog.getByRole('button', { name: 'Create view' }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'View: Pipeline' })).toBeVisible();
  const viewId = new URL(page.url()).searchParams.get('view');
  expect(viewId).toBeTruthy();

  await expect(page.getByRole('region', { name: 'Lead, 2' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Qualified, 1' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'No stage, 1' })).toBeVisible();

  // A column total is a view setting, saved for everyone.
  await page.getByRole('button', { name: 'Options' }).click();
  await page.getByRole('button', { name: /^Column total/ }).click();
  await page.getByRole('option', { name: 'Sum of Amount' }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('region', { name: 'Lead, 2' })).toContainText('Sum');
  await expect
    .poll(async () => (await r.request(`/views/${viewId}`)).groupAggregate)
    .toEqual({ field: 'amount', op: 'sum' });

  await moveByKeyboard(
    page,
    page.getByRole('button', { name: 'Globex pilot' }),
    'ArrowRight',
    'the Lead column',
    'the Qualified column',
  );
  await expect(page.getByRole('region', { name: 'Qualified, 2' })).toContainText('Globex pilot');
  await expect(page.getByRole('region', { name: 'Lead, 1' })).toBeVisible();
  // The card moves at once; the write lands just after.
  await expect
    .poll(async () => {
      const found = await r.request('/objects/deal/query', {
        filter: { name: { eq: 'Globex pilot' } },
      });
      return [found.records[0].fields.stage, found.records[0].updatedBy];
    })
    .toEqual(['qualified', { type: 'user', id: 'dana' }]);
  await page.screenshot({ path: '/tmp/retainer-web-board.png' });

  // Coming back to the object opens the view used last.
  await page.getByRole('link', { name: 'People', exact: true }).click();
  await page.getByRole('link', { name: 'Deals', exact: true }).click();
  await expect(page.getByRole('button', { name: 'View: Pipeline' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Qualified, 2' })).toBeVisible();
});

test('places records on a calendar and moves one to another day', async ({ page, retainer: r }) => {
  await r.request('/templates/sales/apply', {});
  await r.request('/objects/deal/records', {
    values: { name: 'Acme renewal', closeDate: '2026-03-11' },
  });
  await r.request('/objects/deal/records', { values: { name: 'Undated deal' } });
  const view = await r.request(
    '/objects/deal/views',
    { name: 'Closing', kind: 'calendar', dateField: 'closeDate' },
    r.keys.user,
  );
  await signIn(page, r.url, r.keys.user);
  await page.goto(`${r.url}/app/o/deal?view=${view.id}&month=2026-03`);
  await expect(page.getByText('March 2026')).toBeVisible();
  await expect(page.getByText('1 without a close date')).toBeVisible();
  const day = (label: string) =>
    page.getByRole('heading', { name: label, exact: true }).locator('..');
  const entry = day('Wednesday, March 11').getByRole('button', { name: 'Acme renewal' });
  await expect(entry).toBeVisible();

  await moveByKeyboard(page, entry, 'ArrowRight', 'Wednesday, March 11', 'Thursday, March 12');
  await expect(
    day('Thursday, March 12').getByRole('button', { name: 'Acme renewal' }),
  ).toBeVisible();
  await expect
    .poll(async () => {
      const found = await r.request('/objects/deal/query', {
        filter: { name: { eq: 'Acme renewal' } },
      });
      return found.records[0].fields.closeDate;
    })
    .toBe('2026-03-12');
  await expect(page.getByRole('dialog')).not.toBeVisible();

  // Clicking an entry opens the record; the month is in the address.
  await page.getByRole('button', { name: 'Acme renewal' }).click();
  await expect(page.getByRole('dialog', { name: 'Acme renewal' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Next month' }).click();
  await expect(page.getByText('April 2026')).toBeVisible();
  expect(new URL(page.url()).searchParams.get('month')).toBe('2026-04');
  await page.screenshot({ path: '/tmp/retainer-web-calendar.png' });
});

test('moves a record from a busy day\'s "more" panel', async ({ page, retainer: r }) => {
  await r.request('/templates/sales/apply', {});
  for (const name of ['Alpha deal', 'Beta deal', 'Gamma deal', 'Delta deal']) {
    await r.request('/objects/deal/records', { values: { name, closeDate: '2026-03-11' } });
  }
  const view = await r.request(
    '/objects/deal/views',
    { name: 'Closing', kind: 'calendar', dateField: 'closeDate' },
    r.keys.user,
  );
  await signIn(page, r.url, r.keys.user);
  await page.goto(`${r.url}/app/o/deal?view=${view.id}&month=2026-03`);
  const day = (label: string) =>
    page.getByRole('heading', { name: label, exact: true }).locator('..');
  // Three fit; the day shows two and "2 more".
  await day('Wednesday, March 11').getByRole('button', { name: '2 more' }).click();
  const panel = page.getByRole('dialog', { name: 'Wednesday, March 11' });
  const last = panel.getByRole('button', { name: 'Delta deal' });
  await expect(last).toBeVisible();

  // From the keyboard it starts over its own day, not the days the panel covers.
  await moveByKeyboard(page, last, 'ArrowRight', 'Wednesday, March 11', 'Thursday, March 12');
  await expect(day('Thursday, March 12').getByRole('button', { name: 'Delta deal' })).toBeVisible();
  await expect
    .poll(async () => {
      const found = await r.request('/objects/deal/query', {
        filter: { name: { eq: 'Delta deal' } },
      });
      return found.records[0].fields.closeDate;
    })
    .toBe('2026-03-12');
});

test('keeps a changed filter as unsaved until the view is saved or reset', async ({
  page,
  retainer: r,
}) => {
  await r.request('/objects/person/records', { values: { name: 'Dana Levi', jobTitle: 'CTO' } });
  await r.request('/objects/person/records', { values: { name: 'Noa Cohen', jobTitle: 'CFO' } });
  const view = await r.request(
    '/objects/person/views',
    { name: 'Executives', kind: 'table', filter: { jobTitle: { eq: 'CTO' } } },
    r.keys.user,
  );
  const grid = page.getByRole('region', { name: 'People' });
  await signIn(page, r.url, r.keys.user);
  await page.goto(`${r.url}/app/o/person?view=${view.id}`);
  await expect(grid.getByText('Dana Levi')).toBeVisible();
  await expect(grid.getByText('Noa Cohen')).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Save view' })).not.toBeVisible();

  // A filter in the address runs over the view's, and can be reset or saved.
  // The router writes a JSON string param as a quoted string.
  const changed = `${r.url}/app/o/person?view=${view.id}&filter=${encodeURIComponent(
    JSON.stringify(JSON.stringify({ jobTitle: { eq: 'CFO' } })),
  )}`;
  await page.goto(changed);
  await expect(grid.getByText('Noa Cohen')).toBeVisible();
  await expect(grid.getByText('Dana Levi')).not.toBeVisible();
  await page.getByRole('button', { name: 'Reset', exact: true }).click();
  await expect(grid.getByText('Dana Levi')).toBeVisible();
  await expect.poll(() => new URL(page.url()).searchParams.get('filter')).toBeNull();

  await page.goto(changed);
  await page.getByRole('button', { name: 'Save view' }).click();
  await expect(page.getByRole('button', { name: 'Save view' })).not.toBeVisible();
  await expect(grid.getByText('Noa Cohen')).toBeVisible();
  await expect.poll(() => new URL(page.url()).searchParams.get('filter')).toBeNull();
  expect((await r.request(`/views/${view.id}`)).filter).toEqual({ jobTitle: { eq: 'CFO' } });

  // A reader runs the view but cannot change or save it.
  await signOut(page);
  await signIn(page, r.url, r.keys.reader);
  await page.goto(changed);
  await expect(grid.getByText('Noa Cohen')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save view' })).not.toBeVisible();
  await page.getByRole('button', { name: 'View: Executives' }).click();
  await expect(page.getByRole('menuitem', { name: 'New view…' })).not.toBeVisible();
});

test('groups the sidebar into Records and Activity, and explains what event lists lack', async ({
  page,
  retainer: r,
}) => {
  const dana = (await r.request('/objects/person/records', { values: { name: 'Dana Levi' } }))
    .record;
  const acme = (await r.request('/objects/company/records', { values: { name: 'Acme' } })).record;
  for (const [title, day] of [
    ['Kickoff', '2026-10-20'],
    ['Pricing review', '2026-10-22'],
  ])
    await r.request('/events', {
      type: 'conversation',
      channel: 'gmail',
      externalId: title,
      occurredAt: `${day}T10:00:00Z`,
      title,
      fields: { medium: 'email' },
      participants: [{ recordId: dana.id }],
      about: [acme.id],
    });
  await signIn(page, r.url, r.keys.user);
  const records = page.getByRole('group', { name: 'Records' });
  const activity = page.getByRole('group', { name: 'Activity' });
  await expect(records.getByRole('link', { name: 'People', exact: true })).toBeVisible();
  await expect(records.getByRole('link', { name: 'Conversations' })).toHaveCount(0);
  await expect(activity.getByRole('link')).toHaveText(['All activity', 'Conversations']);
  // The icon rail keeps both groups.
  await page.getByRole('button', { name: 'Collapse sidebar' }).click();
  await expect(activity.getByRole('link', { name: 'All activity' })).toBeVisible();
  await page.getByRole('button', { name: 'Expand sidebar' }).click();

  await activity.getByRole('link', { name: 'Conversations' }).click();
  const grid = page.getByRole('region', { name: 'Conversations' });
  // Newest first, with when, medium, who, what about and where from.
  await expect(grid.getByRole('link', { name: /^(Kickoff|Pricing review)$/ })).toHaveText([
    'Pricing review',
    'Kickoff',
  ]);
  for (const column of ['Occurred', 'Medium', 'Participants', 'About', 'Source'])
    await expect(grid.getByRole('columnheader', { name: column })).toBeVisible();
  await expect(grid.getByRole('columnheader', { name: 'Summary' })).toHaveCount(0);
  await expect(grid.getByRole('link', { name: 'Dana Levi' }).first()).toBeVisible();
  await expect(grid.getByRole('link', { name: 'Acme' }).first()).toBeVisible();
  await expect(grid.getByText('gmail').first()).toBeVisible();
  // No New button, and a line that says why.
  await expect(page.getByRole('button', { name: /^New / })).toHaveCount(0);
  await page.getByRole('button', { name: 'Logged by agents and integrations.' }).click();
  await expect(page.getByRole('dialog', { name: 'How events are logged' })).toContainText(
    'POST /v1/events',
  );
  await page.keyboard.press('Escape');
  // Two selected: delete, but no merge, and that is said.
  await grid.getByRole('checkbox', { name: 'Select Kickoff' }).check();
  await grid.getByRole('checkbox', { name: 'Select Pricing review' }).check();
  await expect(page.getByText('Events can’t be merged')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Merge…' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Clear selection' }).click();
  // A calendar of when they happened, with nothing to set up.
  await page.getByRole('button', { name: 'Calendar', exact: true }).click();
  await expect(page).toHaveURL(/layout=calendar/);
  await page.goto(`${r.url}/app/o/conversation?layout=calendar&month=2026-10`);
  await expect(page.getByRole('button', { name: /Kickoff/ })).toBeVisible();
  // People write comments now, not notes (C5).
  await expect(page.getByRole('button', { name: 'Write a note' })).toHaveCount(0);
  await page.getByRole('link', { name: 'All activity' }).click();
  await expect(page.getByRole('heading', { name: 'All activity' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Write a note' })).toHaveCount(0);
});

test('filters all activity by type, source, date and linked record, in the address', async ({
  page,
  retainer: r,
}) => {
  const acme = (await r.request('/objects/company/records', { values: { name: 'Acme' } })).record;
  const globex = (await r.request('/objects/company/records', { values: { name: 'Globex' } }))
    .record;
  await r.request('/events', {
    type: 'conversation',
    channel: 'gmail',
    occurredAt: '2026-10-20T10:00:00Z',
    title: 'Acme intro',
    summary: 'First call with the Acme team about the pilot.',
    fields: { medium: 'call' },
    about: [acme.id],
  });
  await r.request('/events', {
    type: 'conversation',
    channel: 'zoom',
    occurredAt: '2026-10-22T10:00:00Z',
    title: 'Globex demo',
    about: [globex.id],
  });
  await r.request(
    '/schema/changes',
    {
      reason: 'A second event type',
      operations: [
        {
          op: 'create_object',
          object: {
            class: 'event',
            nameSingular: 'memo',
            namePlural: 'memos',
            labelSingular: 'Memo',
            labelPlural: 'Memos',
            fields: [],
          },
        },
      ],
    },
    r.keys.user,
  );
  await r.request('/events', {
    type: 'memo',
    channel: 'agent',
    occurredAt: '2026-10-23T10:00:00Z',
    title: 'Acme budget note',
    about: [acme.id],
  });
  await signIn(page, r.url, r.keys.user);
  await page.getByRole('link', { name: 'All activity' }).click();
  await expect(page.getByRole('heading', { name: 'All activity' })).toBeVisible();
  const titles = page.getByRole('button', { name: /^(Acme intro|Globex demo|Acme budget note)$/ });
  await expect(titles).toHaveText(['Acme budget note', 'Globex demo', 'Acme intro']);
  // Grouped by day, with the medium as a chip and the about records linked.
  await expect(page.getByRole('region', { name: /October 20/ })).toContainText('Call');
  await expect(page.getByRole('region', { name: /October 20/ })).toContainText(
    'First call with the Acme team',
  );

  const filter = async (kind: string) => {
    await page.getByRole('button', { name: 'Filter', exact: true }).click();
    await page.getByRole('option', { name: kind, exact: true }).click();
  };
  await filter('Type');
  await page.getByRole('option', { name: 'Memos' }).click();
  await page.keyboard.press('Escape');
  await expect(titles).toHaveText(['Acme budget note']);
  await expect(page).toHaveURL(/eventTypes=memo/);
  await page.getByRole('button', { name: 'Remove filter Type' }).click();
  await expect(titles).toHaveCount(3);

  await filter('Source');
  await page.getByLabel('Source', { exact: true }).fill('zoom');
  await page.getByRole('button', { name: 'Apply filter' }).click();
  await expect(titles).toHaveText(['Globex demo']);
  await page.getByRole('button', { name: 'Remove filter Source' }).click();

  await filter('Date');
  await page.getByRole('textbox', { name: 'From', exact: true }).fill('2026-10-21');
  await page.getByRole('textbox', { name: 'To', exact: true }).fill('2026-10-22');
  await page.getByRole('button', { name: 'Apply filter' }).click();
  await expect(titles).toHaveText(['Globex demo']);
  await page.getByRole('button', { name: 'Remove filter Date' }).click();

  await filter('Linked record');
  await page.getByRole('combobox', { name: 'Linked record' }).fill('Acme');
  // Entities only: an event is not something to be linked to (C4).
  await expect(page.getByRole('option', { name: /^Acme\b.*Company/ })).toBeVisible();
  await expect(page.getByRole('option', { name: /^Acme intro/ })).toHaveCount(0);
  await page.getByRole('option', { name: /^Acme\b.*Company/ }).click();
  await expect(titles).toHaveText(['Acme budget note', 'Acme intro']);
  await expect(page.getByText('Linked to')).toBeVisible();
  // The address reproduces the feed, and a row opens in the side sheet.
  await page.reload();
  await expect(titles).toHaveText(['Acme budget note', 'Acme intro']);
  await titles.first().click();
  const sheet = page.getByRole('dialog', { name: 'Acme budget note' });
  await expect(sheet.getByText('Activity · Memo')).toBeVisible();
  await expect(page).toHaveURL(/record=/);
});

test('comments on a company: posted once despite a lost response, edited, deleted, never evidence', async ({
  page,
  retainer: r,
}) => {
  const acme = (await r.request('/objects/company/records', { values: { name: 'Acme' } })).record;
  await signIn(page, r.url, r.keys.user);
  await page.goto(`${r.url}/app/r/${acme.id}?tab=comments`);
  await expect(page.getByText('No comments yet')).toBeVisible();
  const box = page.getByRole('textbox', { name: 'Add a comment' });
  await box.fill('Their procurement moves slowly.\nLoop in legal early.');
  // The first post reaches the server, but its response is lost.
  let lost = false;
  await page.route('**/v1/records/*/comments', async (route) => {
    if (lost || route.request().method() !== 'POST') return route.continue();
    lost = true;
    await route.fetch();
    await route.abort('failed');
  });
  await page.getByRole('button', { name: 'Post comment' }).click();
  await expect(page.getByText(/Your comment was not posted/)).toBeVisible();
  await expect(box).toHaveValue(/Their procurement/);
  await box.focus();
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(box).toHaveValue('');
  await page.unrouteAll({ behavior: 'wait' });
  const posted = await r.request(`/records/${acme.id}/comments`);
  expect(posted.items).toHaveLength(1);
  expect(posted.items[0].author).toMatchObject({ type: 'user', id: 'dana' });
  const comments = page.getByRole('list', { name: 'Comments' });
  await expect(comments.getByRole('listitem')).toHaveCount(1);
  await expect(comments).toContainText('Their procurement moves slowly.');
  await expect(page.getByRole('button', { name: /^Comments/ })).toContainText('1');

  // A record with comments opens on them, and an edit says so.
  await page.goto(`${r.url}/app/r/${acme.id}`);
  await expect(page.getByRole('button', { name: /^Comments/ })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await comments.getByRole('listitem').hover();
  await page.getByRole('button', { name: 'Edit comment' }).click();
  const editor = page.getByRole('textbox', { name: 'Edit comment' });
  await editor.fill('Procurement is quick after all.');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(comments).toContainText('Procurement is quick after all.');
  await expect(comments.getByText('edited')).toBeVisible();

  // Not evidence: it is on no timeline or activity list, and in no event query.
  await page.goto(`${r.url}/app/r/${acme.id}?tab=timeline`);
  await expect(page.getByText('Name set to')).toBeVisible();
  await expect(page.getByText('Procurement is quick after all.')).toHaveCount(0);
  await page.goto(`${r.url}/app/activity`);
  await expect(page.getByRole('heading', { name: 'All activity' })).toBeVisible();
  await expect(page.getByText('Procurement is quick after all.')).toHaveCount(0);

  await page.goto(`${r.url}/app/r/${acme.id}?tab=comments`);
  await comments.getByRole('listitem').hover();
  await page.getByRole('button', { name: 'Delete comment' }).click();
  await page
    .getByRole('dialog', { name: 'Delete this comment?' })
    .getByRole('button', { name: 'Delete comment' })
    .click();
  await expect(page.getByText('No comments yet')).toBeVisible();
  // Deleting the last one leaves the person where they were.
  await expect(page.getByRole('button', { name: /^Comments/ })).toHaveAttribute(
    'aria-current',
    'page',
  );
  expect((await r.request(`/records/${acme.id}/comments`)).items).toEqual([]);
});

test('comments on a conversation, from its page and its sheet', async ({ page, retainer: r }) => {
  const call = await r.request('/events', {
    type: 'conversation',
    channel: 'zoom',
    occurredAt: '2026-10-20T10:00:00Z',
    title: 'Renewal call',
  });
  await signIn(page, r.url, r.keys.user);
  await page.goto(`${r.url}/app/e/${call.id}`);
  await page.getByRole('textbox', { name: 'Add a comment' }).fill('I was on this. Date is soft.');
  await page.keyboard.press('ControlOrMeta+Enter');
  const comments = page.getByRole('list', { name: 'Comments' });
  await expect(comments).toContainText('I was on this. Date is soft.');
  await page.goto(`${r.url}/app/o/conversation?record=${call.id}`);
  const sheet = page.getByRole('dialog', { name: 'Renewal call' });
  await expect(sheet.getByRole('list', { name: 'Comments' })).toContainText('Date is soft.');
  await sheet.getByRole('textbox', { name: 'Add a comment' }).fill('Second thought.');
  await sheet.getByRole('button', { name: 'Post comment' }).click();
  await expect(sheet.getByRole('list', { name: 'Comments' }).getByRole('listitem')).toHaveCount(2);
  await expect(sheet.getByRole('button', { name: /^Comments/ })).toContainText('2');
});

test('only people comment: an agent reads and is refused; others can only do what they may', async ({
  page,
  retainer: r,
}) => {
  const acme = (await r.request('/objects/company/records', { values: { name: 'Acme' } })).record;
  const written = await r.request(
    `/records/${acme.id}/comments`,
    { body: 'Written by a person.' },
    r.keys.writer,
  );
  await expect(
    r.request(`/records/${acme.id}/comments`, { body: 'From an agent.' }, r.keys.agent),
  ).rejects.toThrow(/comment/i);
  await signIn(page, r.url, r.keys.agent);
  await page.goto(`${r.url}/app/r/${acme.id}?tab=comments`);
  const comments = page.getByRole('list', { name: 'Comments' });
  await expect(comments).toContainText('Written by a person.');
  await expect(page.getByRole('textbox', { name: 'Add a comment' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Edit comment' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Delete comment' })).toHaveCount(0);
  await signOut(page);

  // An admin deletes what someone else wrote, but cannot put words in their mouth.
  await signIn(page, r.url, r.keys.user);
  await page.goto(`${r.url}/app/r/${acme.id}?tab=comments`);
  await comments.getByRole('listitem').hover();
  await expect(page.getByRole('button', { name: 'Edit comment' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Delete comment' })).toBeVisible();
  await expect(
    r.request(`/comments/${written.id}`, { body: 'Rewritten.' }, r.keys.user, 'PATCH'),
  ).rejects.toThrow(/author/i);
});

test('an event page has comments, claims and history, and no memory of its own', async ({
  page,
  retainer: r,
}) => {
  const acme = (await r.request('/objects/company/records', { values: { name: 'Acme' } })).record;
  const call = await r.request('/events', {
    type: 'conversation',
    channel: 'zoom',
    occurredAt: '2026-10-20T10:00:00Z',
    title: 'Renewal call',
    about: [acme.id],
  });
  await r.request(
    `/records/${acme.id}`,
    { values: { name: 'Acme Holdings' }, source: call.id },
    r.keys.agent,
    'PATCH',
  );
  await r.request(`/records/${acme.id}/facts`, {
    text: 'Wants a two-year term',
    source: call.id,
    quote: 'two years works for us',
  });
  await signIn(page, r.url, r.keys.user);
  await page.goto(`${r.url}/app/e/${call.id}`);
  const sections = page.getByRole('navigation', { name: 'Sections' });
  await expect(sections.getByRole('button')).toHaveText([/^Comments/, /^Claims/, /^History/]);
  await expect(page.getByText('No comments yet')).toBeVisible();

  await sections.getByRole('button', { name: /^Claims/ }).click();
  await expect(sections.getByRole('button', { name: /^Claims/ })).toContainText('2');
  const values = page.getByRole('list', { name: 'Values citing this event' });
  await expect(values).toContainText('Name set to');
  await expect(values).toContainText('Acme Holdings');
  // The event's own values cite it too, and are not claims about it.
  await expect(values.getByRole('listitem')).toHaveCount(1);
  const facts = page.getByRole('list', { name: 'Facts citing this event' });
  await expect(facts).toContainText('Wants a two-year term');
  await expect(facts).toContainText('two years works for us');

  await sections.getByRole('button', { name: 'History' }).click();
  await expect(page.getByText('Title set to')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Field changes' })).toHaveCount(0);

  // The same tabs on the record page and the sheet; an entity keeps its own.
  await page.goto(`${r.url}/app/r/${call.id}`);
  await expect(sections.getByRole('button')).toHaveText([/^Comments/, /^Claims/, /^History/]);
  await page.goto(`${r.url}/app/r/${acme.id}`);
  await expect(sections.getByRole('button')).toHaveText([
    /^Comments/,
    /^Facts/,
    'Activity',
    'Timeline',
    'Open tasks',
  ]);
});

test('shows Open tasks only on types a task relation can point at', async ({
  page,
  retainer: r,
}) => {
  await r.request(
    '/schema/changes',
    {
      reason: 'Something tasks cannot point at',
      operations: [
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
      ],
    },
    r.keys.user,
  );
  const site = (await r.request('/objects/site/records', { values: { name: 'Haifa' } })).record;
  await signIn(page, r.url, r.keys.user);
  await page.goto(`${r.url}/app/r/${site.id}?tab=tasks`);
  const sections = page.getByRole('navigation', { name: 'Sections' });
  await expect(sections.getByRole('button')).toHaveText([
    'Comments',
    'Facts',
    'Activity',
    'Timeline',
  ]);
  await expect(page.getByText('No facts yet')).toBeVisible();
});

test('an event is about entities only: another event is refused and not offered', async ({
  page,
  retainer: r,
}) => {
  const acme = (await r.request('/objects/company/records', { values: { name: 'Acme' } })).record;
  const log = (title: string) =>
    r.request('/events', {
      type: 'conversation',
      channel: 'zoom',
      occurredAt: '2026-10-20T10:00:00Z',
      title,
    });
  const kickoff = await log('Acme kickoff');
  const followUp = await log('Follow-up');
  await expect(r.request(`/events/${followUp.id}/links`, { about: [kickoff.id] })).rejects.toThrow(
    /invalid_link/,
  );
  await expect(
    r.request('/events', {
      type: 'conversation',
      channel: 'zoom',
      occurredAt: '2026-10-21T10:00:00Z',
      title: 'Another',
      about: [kickoff.id],
    }),
  ).rejects.toThrow(/invalid_link/);

  await signIn(page, r.url, r.keys.user);
  await page.goto(`${r.url}/app/e/${followUp.id}`);
  await page.getByRole('button', { name: 'Add record…' }).click();
  await page.getByLabel('Find a record').fill('Acme');
  await expect(page.getByRole('button', { name: /^Acme\b/ }).first()).toBeVisible();
  await expect(page.getByText('Acme kickoff')).toHaveCount(0);
  await page
    .getByRole('button', { name: /^Acme\b/ })
    .first()
    .click();
  await expect
    .poll(async () => (await r.request(`/events/${followUp.id}`)).event.about)
    .toEqual([acme.id]);
});

test('the record sheet keeps long text inside it, and its tabs still as they change', async ({
  page,
  retainer: r,
}) => {
  const unbroken = 'Averyveryveryverylongunbrokenword'.repeat(12);
  const acme = (
    await r.request('/objects/company/records', { values: { name: 'Acme' } }, r.keys.user)
  ).record;
  await r.request(`/records/${acme.id}/comments`, { body: unbroken }, r.keys.user);
  await r.request(`/records/${acme.id}/facts`, { text: unbroken });
  for (let i = 0; i < 25; i++) {
    await r.request('/events', {
      type: 'conversation',
      channel: 'zoom',
      externalId: `long-${i}`,
      occurredAt: new Date(Date.UTC(2026, 9, 1 + i, 10)).toISOString(),
      title: `Call ${i}`,
      summary: unbroken,
      about: [acme.id],
    });
  }
  await signIn(page, r.url, r.keys.user);
  for (const viewport of [
    { width: 1280, height: 800 },
    { width: 390, height: 760 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto(`${r.url}/app/o/company?record=${acme.id}`);
    const sheet = page.getByRole('dialog');
    const nav = sheet.getByRole('navigation', { name: 'Sections' });
    const scroller = sheet.locator('.overflow-y-auto').first();
    const place = async () => ({
      top: Math.round((await nav.boundingBox())?.y ?? -1),
      overflow: await scroller.evaluate((el) => el.scrollWidth - el.clientWidth),
    });
    // Scrolled down a long tab, every other tab starts right under the row.
    await nav.getByRole('button', { name: 'Activity' }).click();
    await expect(sheet.getByRole('list', { name: 'Activity' })).toBeVisible();
    await scroller.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    const stuck = (await place()).top;
    for (const tab of [/^Comments/, /^Facts/, 'Timeline', /^Open tasks/, 'Activity']) {
      await nav.getByRole('button', { name: tab }).click();
      await page.waitForLoadState('networkidle');
      const now = await place();
      expect(now.top).toBe(stuck);
      expect(now.overflow).toBe(0);
    }
  }
});

test('shows API names, IDs, write paths and JSON in developer view, remembered per browser', async ({
  page,
  retainer: r,
}) => {
  const dana = (
    await r.request('/objects/person/records', { values: { name: 'Dana Levi', jobTitle: 'CTO' } })
  ).record;
  const event = await r.request('/events', {
    type: 'conversation',
    channel: 'zoom',
    externalId: 'zoom-42',
    occurredAt: '2026-10-20T10:00:00Z',
    title: 'Intro call',
    participants: [{ recordId: dana.id }],
  });
  await signIn(page, r.url, r.keys.user);
  await page.goto(`${r.url}/app/r/${dana.id}`);
  await expect(page.getByText('Record · Person')).toBeVisible();
  await expect(page.getByText('upsert_record')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'JSON' })).toHaveCount(0);

  await page.getByRole('button', { name: /^Account: / }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Developer view' }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByText('upsert_record', { exact: true })).toBeVisible();
  await expect(page.getByText(`PATCH /v1/records/${dana.id}`)).toBeVisible();
  await expect(page.getByText(dana.id, { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Copy ID' })).toBeVisible();
  await expect(page.getByText('jobTitle', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'JSON', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Record JSON' })).toContainText(
    `"id": "${dana.id}"`,
  );
  // Event rows show how they are attached and their raw identity.
  await page.getByRole('button', { name: 'Activity', exact: true }).click();
  await expect(page.getByText('via {"kind":"participant"}')).toBeVisible();
  await expect(page.getByText('externalId "zoom-42"')).toBeVisible();
  // An event names its own write path.
  await page.goto(`${r.url}/app/e/${event.id}`);
  await expect(page.getByText('log_event', { exact: true })).toBeVisible();
  await expect(page.getByText('POST /v1/events', { exact: true })).toBeVisible();
  // Column headers show API names too, and the switch survives a reload.
  await page.reload();
  await page.goto(`${r.url}/app/o/person`);
  await expect(
    page.getByRole('columnheader', { name: /Job title/ }).getByText('jobTitle'),
  ).toBeVisible();

  await page.getByRole('button', { name: /^Account: / }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Developer view' }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByText('jobTitle', { exact: true })).toHaveCount(0);
  await page.goto(`${r.url}/app/r/${dana.id}`);
  await expect(page.getByText('upsert_record')).toHaveCount(0);
});
