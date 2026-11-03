import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.js';

async function signIn(page: Page, url: string, key: string) {
  await page.goto(`${url}/app/`);
  await page.getByLabel('Personal API key').fill(key);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Review inbox' })).toBeVisible();
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
    .getByRole('navigation', { name: 'Objects' })
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
  await page.getByRole('combobox', { name: 'Status' }).selectOption('rejected');
  await expect(page.getByText('No rejected changes')).toBeVisible();
  const schema = await r.request('/schema');
  expect(
    schema.objects
      .find((o: any) => o.nameSingular === 'person')
      .fields.find((f: any) => f.name === 'jobTitle').isUnique,
  ).toBe(true);
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
test('retracts an interaction and refreshes the affected memory', async ({ page, retainer: r }) => {
  const record = (await r.request('/objects/person/records', { values: { name: 'Dana Levi' } }))
    .record;
  const interaction = await r.request('/interactions', {
    kind: 'meeting',
    channel: 'zoom',
    occurredAt: '2026-10-20T10:00:00Z',
    title: 'Renewal call',
    summary: 'Discussed renewal',
    participants: [{ recordId: record.id }],
  });
  await r.request(
    `/records/${record.id}`,
    { values: { jobTitle: 'CTO' }, source: interaction.id },
    r.keys.agent,
    'PATCH',
  );
  await r.request(`/records/${record.id}/facts`, {
    text: 'Needs a renewal quote',
    source: interaction.id,
    quote: 'Please send a quote',
  });
  await signIn(page, r.url, r.keys.user);
  await page.goto(`${r.url}/app/i/${interaction.id}`);
  await page.getByRole('button', { name: 'Retract interaction', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Retract interaction', exact: true })
    .click();
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
  await page.getByRole('button', { name: 'Sign out' }).click();
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
  await page.getByRole('button', { name: 'Sign out' }).click();
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
  await page.getByLabel('Filter field').selectOption('jobTitle');
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
  await edit('Score', () => page.getByLabel('Score', { exact: true }).fill('42.5'));
  await edit('Active', () => page.getByRole('switch').check());
  await edit('Renewal date', () =>
    page.getByLabel('Renewal date', { exact: true }).fill('2026-12-01'),
  );
  await edit('Meeting at', () =>
    page.getByLabel('Meeting at', { exact: true }).fill('2026-12-01T14:30'),
  );
  await edit('Budget', async () => {
    await page.getByLabel('Amount', { exact: true }).fill('0.000001');
    await page.getByLabel('Currency', { exact: true }).selectOption('ILS');
  });
  await edit('Stage', () => page.getByLabel('Stage', { exact: true }).selectOption('ready'));
  await edit('Topics', () => page.getByRole('checkbox', { name: 'Security', exact: true }).check());
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
  await edit('Address', () => page.getByLabel('city', { exact: true }).fill('Tel Aviv'));
  await edit('Name', () => page.getByLabel('First name', { exact: true }).fill('Danielle'));
  await edit('Company', async () => {
    await page.getByLabel('Search related records').fill('Acme');
    await expect(page.getByRole('option', { name: 'Acme Company' })).toHaveCount(1);
    await page.getByLabel('Company', { exact: true }).selectOption(company.id);
  });
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
  await page.getByRole('button', { name: 'Delete…' }).click();
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
  await page.getByRole('button', { name: 'Delete…' }).click();
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
  await page.getByRole('button', { name: 'Percent empty' }).click();
  await expect(grid.getByRole('button', { name: 'Calculate Job title' })).toHaveText('Empty 33%');
  await grid.getByRole('button', { name: 'Calculate Name' }).click();
  await page.getByRole('button', { name: 'Not empty', exact: true }).click();
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
  await expect(dialog.getByLabel('Value for Emails')).toHaveValue('auto');
  await dialog.getByLabel('Value for Job title').selectOption('merge');
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
  await page.getByRole('button', { name: 'Merge a duplicate…' }).click();
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
  const interaction = await r.request('/interactions', {
    kind: 'meeting',
    channel: 'zoom',
    occurredAt: '2026-10-20T10:00:00Z',
    title: 'Intro call',
    participants: [{ recordId: person.id }],
  });
  await r.request(`/records/${person.id}/facts`, { text: 'Prefers email', source: interaction.id });
  await signIn(page, r.url, r.keys.user);
  await page.goto(`${r.url}/app/r/${person.id}`);
  await page.getByRole('button', { name: 'Record actions' }).click();
  await page.getByRole('button', { name: 'Erase for privacy…' }).click();
  const confirm = page.getByRole('dialog', { name: 'Erase Avi Erased permanently?' });
  const erase = confirm.getByRole('button', { name: 'Erase permanently' });
  await expect(erase).toBeDisabled();
  await confirm.getByLabel('Confirmation').fill('Avi');
  await expect(erase).toBeDisabled();
  await confirm.getByLabel('Confirmation').fill('Avi Erased');
  await erase.click();
  await expect(
    page.getByText(/Erased Avi Erased: 1 record, 1 interaction, 1 fact and \d+ values\./),
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
  await expect(page.getByRole('button', { name: 'Delete…' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Erase for privacy…' })).not.toBeVisible();
});

test('finds records, facts and interactions across objects with the command palette', async ({
  page,
  retainer: r,
}) => {
  const dana = (await r.request('/objects/person/records', { values: { name: 'Dana Levi' } }))
    .record;
  await r.request('/objects/company/records', { values: { name: 'Levi Logistics' } });
  const interaction = await r.request('/interactions', {
    kind: 'call',
    channel: 'phone',
    occurredAt: '2026-10-20T10:00:00Z',
    title: 'Quarterly pricing review',
    participants: [{ recordId: dana.id }],
  });
  await r.request(`/records/${dana.id}/facts`, {
    text: 'Wants quarterly invoices',
    source: interaction.id,
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
      .getByRole('region', { name: 'Interactions' })
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
