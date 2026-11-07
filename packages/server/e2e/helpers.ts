import type { Page } from '@playwright/test';
import { expect } from './fixtures.js';

export async function signIn(page: Page, url: string, key: string) {
  await page.goto(`${url}/app/`);
  await page.getByLabel('Personal API key').fill(key);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Review inbox' })).toBeVisible();
}

/** Sign out from the account menu at the foot of the sidebar. */
export async function signOut(page: Page) {
  await page.getByRole('button', { name: /^Account: / }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
}
