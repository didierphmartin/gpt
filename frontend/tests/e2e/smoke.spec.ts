import { test, expect } from '@playwright/test';

test('frontend root responds', async ({ page }) => {
  const response = await page.goto('/');
  expect(response?.status()).toBeLessThan(400);
  await expect(page).toHaveTitle(/.+/);
});
