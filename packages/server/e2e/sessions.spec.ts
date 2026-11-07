import { expect, test } from './fixtures.js';
import { signIn, signOut } from './helpers.js';

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
