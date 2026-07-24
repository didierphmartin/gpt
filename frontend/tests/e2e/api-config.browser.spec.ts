import { test, expect } from '@playwright/test';

// baseURL is http://localhost/gpt/frontend/ (see playwright.config.ts),
// so navigation targets are relative to that.

test('globals are set on index.html', async ({ page }) => {
  await page.goto('index.html');
  const base = await page.evaluate(() => (window as any).APP_CONFIG?.API_BASE_URL);
  expect(base).toBe('/gpt/backend/api/v1');           // localhost default
  const joined = await page.evaluate(() => (window as any).apiUrl('/chat'));
  expect(joined).toBe('/gpt/backend/api/v1/chat');
});

test('localStorage override repoints apiUrl', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('API_BASE_URL', 'http://alt.test/v1'));
  await page.goto('index.html');
  const joined = await page.evaluate(() => (window as any).apiUrl('/chat'));
  expect(joined).toBe('http://alt.test/v1/chat');
});
