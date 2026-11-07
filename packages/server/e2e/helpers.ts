import type { Locator, Page } from '@playwright/test';
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

export const usd = (dollars: number) => ({ currency: 'USD', amountMicros: dollars * 1_000_000 });

/** What a drag announces to screen readers. */
export const announced = (page: Page, text: string) =>
  page.getByRole('status').filter({ hasText: text });

/** Space picks an item up, an arrow carries it to the next target that way, Space drops it. */
export async function moveByKeyboard(
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
