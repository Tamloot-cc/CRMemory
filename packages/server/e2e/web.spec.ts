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
  await expect(page.getByRole('heading', { name: 'Dana Levi' })).toBeVisible();
  await expect(page.getByText('CEO', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'History of Job title' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByText('rejected', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
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
  await expect(
    page.getByRole('dialog').getByText('Changed elsewhere', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Retry with latest version' }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
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
  const schema = await r.request('/schema');
  expect(
    schema.objects
      .find((o: any) => o.nameSingular === 'person')
      .fields.find((f: any) => f.name === 'jobTitle').isUnique,
  ).toBe(true);
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

test('searches the current object with the command palette and keeps list filters in the URL', async ({
  page,
  retainer: r,
}) => {
  await r.request('/objects/person/records', { values: { name: 'Dana Levi', jobTitle: 'CTO' } });
  await r.request('/objects/person/records', { values: { name: 'Other person', jobTitle: 'CEO' } });
  await signIn(page, r.url, r.keys.user);
  await page.getByRole('link', { name: 'People', exact: true }).click();
  await page.getByLabel('Filter field').selectOption('jobTitle');
  await page.getByLabel('Job title', { exact: true }).fill('CTO');
  await page.getByRole('button', { name: 'Apply filter' }).click();
  await expect(page.getByRole('link', { name: 'Dana Levi' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Other person' })).not.toBeVisible();
  expect(page.url()).toContain('filter=');
  await page.reload();
  await expect(page.getByRole('link', { name: 'Dana Levi' })).toBeVisible();
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByLabel('Find objects or records').fill('Other');
  await page.getByRole('dialog').getByRole('button', { name: 'Other person', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Other person' })).toBeVisible();
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
    await expect(page.getByRole('dialog')).not.toBeVisible();
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
