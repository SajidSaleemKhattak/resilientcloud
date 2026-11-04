import { expect, test, type Page } from '@playwright/test';

// Synthetic fixtures for UI state tests only. Production contains no demo feed.
function statusFixture() {
  const timestamp = new Date().toISOString();
  return { available: true, stale: false, ageMs: 0, updatedAt: timestamp, recoveryEnabled: true,
    config: { maxAttempts: 2, failureThreshold: 3, intervalMs: 500 },
    backends: Object.fromEntries(['backend-a', 'backend-b'].map((service, i) => [service, {
      state: 'healthy', attempts: 0, failures: 0, containerId: String(i + 1).repeat(64), stale: false, observationAgeMs: 0,
      lastProbe: { ok: true, timestamp, latencyMs: 1, reason: null },
    }])) };
}
function savedFixture() {
  const whole = { requests: 10, successes: 8, failures: 2, successRate: .8, skipped: 0, scheduled: 10, latencyMs: { p50: 3, p95: 1001 } };
  return { schemaVersion: 1, generatedAt: '2026-11-04T00:00:00.000Z', status: 'passed',
    protocol: { baselineSeconds: 15, observationSeconds: 60, rate: 10, concurrency: 8, timeoutMs: 2500, repetitions: 3 },
    trials: ['A', 'B', 'C'].map(configuration => ({ id: `fixture-${configuration}-crash-1`, configuration,
      fault: 'crash', repetition: 1, valid: configuration !== 'B', whole, postFault: { ...whole, successes: 5, failures: 5, successRate: .5 },
      detectionMs: 1200, recoveryMs: configuration === 'C' ? 2400 : null, recoveryObserved: configuration === 'C',
      clockUncertaintyMs: 40, rawWorkload: { dropped: 1 } })) };
}
async function fixtures(page: Page, status: () => unknown = statusFixture) {
  await page.route('**/status', route => route.fulfill({ json: status() }));
  await page.route('**/events', route => route.fulfill({ json: { available: true, events: [], truncated: false } }));
  await page.route('**/experiments/summary.json', route => route.fulfill({ json: savedFixture() }));
}
async function noHorizontalOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

test('loads observed identities and reads telemetry using GET without infrastructure controls', async ({ page }, info) => {
  const calls: { method: string; path: string }[] = [];
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (['/status', '/events'].includes(new URL(request.url()).pathname)) calls.push({ method: request.method(), path: new URL(request.url()).pathname }); });
  await fixtures(page);
  await page.goto('/');
  await expect(page.getByText('Live telemetry', { exact: true })).toBeVisible();
  for (const [name, id] of [['backend-a', '1'.repeat(12)], ['backend-b', '2'.repeat(12)]]) {
    const card = page.getByRole('article', { name });
    await expect(card.getByText('Ready', { exact: true })).toBeVisible();
    await expect(card.getByText(id, { exact: true })).toBeVisible();
    await expect(card.getByText('Healthy', { exact: true })).toBeVisible();
  }
  await expect(page.getByRole('button', { name: /restart|recover|inject|crash/i })).toHaveCount(0);
  await expect(page.getByText('No recorded incidents', { exact: true })).toBeVisible();
  expect(calls.some(call => call.path === '/status')).toBe(true);
  expect(calls.every(call => call.method === 'GET')).toBe(true);
  expect(errors).toEqual([]);
  await noHorizontalOverflow(page);
  await page.screenshot({ path: info.outputPath('fixture-desktop-overview.png'), fullPage: true });
});

test('shows connecting while the first status request is pending', async ({ page }) => {
  await fixtures(page);
  await page.route('**/status', async route => { await new Promise(resolve => setTimeout(resolve, 1500)); await route.fulfill({ json: statusFixture() }); });
  await page.goto('/');
  await expect(page.getByText('Connecting', { exact: true })).toBeVisible();
  await expect(page.getByRole('article', { name: 'backend-a' }).getByText('Unknown', { exact: true })).toHaveCount(2);
  await expect(page.getByText('Live telemetry', { exact: true })).toBeVisible();
});

test('empty and malformed telemetry remains unknown without generated activity', async ({ page }) => {
  await fixtures(page, () => ({ ...statusFixture(), backends: {} }));
  await page.goto('/');
  await expect(page.getByText('No instance observations yet')).toBeVisible();
  await expect(page.getByRole('article', { name: 'backend-a' }).getByText('Not observed', { exact: true })).toHaveCount(2);
  await expect(page.getByText('No recorded incidents', { exact: true })).toBeVisible();
  await page.route('**/status', route => route.fulfill({ json: { unexpected: true } }));
  await expect(page.getByText('The status service is disconnected.')).toBeVisible({ timeout: 7000 });
  await expect(page.getByRole('article', { name: 'backend-a' }).getByText('Ready', { exact: true })).toHaveCount(0);
});

test('stale telemetry and exhausted recovery budget have distinct visible states', async ({ page }) => {
  await fixtures(page, () => {
    const status = statusFixture();
    status.stale = true; status.ageMs = 9000;
    status.backends['backend-a'].state = 'exhausted'; status.backends['backend-a'].attempts = 2;
    return status;
  });
  await page.goto('/');
  await expect(page.getByText('Telemetry is stale.')).toBeVisible();
  const card = page.getByRole('article', { name: 'backend-a' });
  await expect(card.getByText('Stale', { exact: true })).toBeVisible();
  await expect(card.getByText('Exhausted', { exact: true })).toBeVisible();
  await expect(card.getByText('Controller state · last known')).toBeVisible();
  await expect(card.getByText(/Manual intervention is required/)).toBeVisible();
});

test('a failed refresh retains last-known identity but removes current readiness', async ({ page }) => {
  await fixtures(page);
  await page.goto('/');
  const card = page.getByRole('article', { name: 'backend-a' });
  await expect(card.getByText('Ready', { exact: true })).toBeVisible();
  await page.route('**/status', route => route.fulfill({ status: 503, json: { available: false } }));
  await expect(page.getByText('The status service is disconnected.')).toBeVisible({ timeout: 7000 });
  await expect(card.getByText('Unknown', { exact: true })).toBeVisible();
  await expect(card.getByText('1'.repeat(12), { exact: true })).toBeVisible();
  await expect(card.getByText('Controller state · last known')).toBeVisible();
});

test('incident timeline displays recorded failures and verification in journal order', async ({ page }) => {
  await fixtures(page);
  await page.route('**/events', route => route.fulfill({ json: { available: true, truncated: true, events: [
    { type: 'recovery_verified', timestamp: '2026-11-04T00:00:01Z', service: 'backend-a', runId: 'fixture', elapsedMs: 2000 },
    { type: 'restart_accepted', timestamp: '2026-11-04T00:00:05Z', service: 'backend-a', runId: 'fixture', elapsedMs: 1500 },
    { type: 'failure_confirmed', timestamp: '2026-11-04T00:00:00Z', service: 'backend-a', runId: 'fixture', elapsedMs: 1000 },
  ] } }));
  await page.goto('/');
  const entries = page.locator('.timeline > li');
  await expect(entries).toHaveCount(3);
  await expect(entries.nth(0)).toContainText('Readiness verified');
  await expect(entries.nth(1)).toContainText('not yet verified');
  await expect(page.getByText(/Older events remain/)).toBeVisible();
});

test('saved charts distinguish whole/post-fault results and omit invalid trial points', async ({ page }, info) => {
  await fixtures(page);
  await page.goto('/#experiments');
  await expect(page.getByText('Saved results', { exact: true })).toBeVisible();
  await expect(page.getByText('Whole-trial success', { exact: true })).toBeVisible();
  await expect(page.getByText('Post-fault success', { exact: true })).toBeVisible();
  await expect(page.locator('tbody tr')).toHaveCount(3);
  await expect(page.locator('tbody tr').filter({ hasText: 'fixture-A-crash-1' })).toContainText('Not observed');
  await expect(page.locator('tbody tr').filter({ hasText: 'fixture-B-crash-1' })).toContainText('Invalid');
  await expect(page.locator('.trial-mark')).toHaveCount(4); // A and C in both charts; B invalid.
  await expect(page.getByText(/3 were skipped across all raw traffic, including guards/)).toBeVisible();
  await page.getByRole('button', { name: 'Control', exact: true }).click();
  await expect(page.getByText('No trials for this fault', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Crash', exact: true }).click();
  await noHorizontalOverflow(page);
  await page.screenshot({ path: info.outputPath('fixture-desktop-experiments.png'), fullPage: true });
});

test('saved summary missing, empty and malformed cases never substitute samples', async ({ page }) => {
  await fixtures(page);
  await page.route('**/experiments/summary.json', route => route.fulfill({ status: 404, body: '' }));
  await page.goto('/#experiments');
  await expect(page.getByText('No saved results available', { exact: true })).toBeVisible();
  await page.route('**/experiments/summary.json', route => route.fulfill({ json: { ...savedFixture(), trials: [] } }));
  await page.reload();
  await expect(page.getByText('No recorded trials yet', { exact: true })).toBeVisible();
  await page.route('**/experiments/summary.json', route => route.fulfill({ json: { generated: 'activity' } }));
  await page.reload();
  await expect(page.getByText('No saved results available', { exact: true })).toBeVisible();
  await expect(page.locator('tbody tr')).toHaveCount(0);
});

test('mobile layout keeps navigation, telemetry and saved trial table usable at 390px and 320px', async ({ page }, info) => {
  await fixtures(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByRole('article', { name: 'backend-a' }).getByText('Ready', { exact: true })).toBeVisible();
  await noHorizontalOverflow(page);
  await page.screenshot({ path: info.outputPath('fixture-mobile-overview.png'), fullPage: true });
  await page.getByRole('link', { name: 'Saved experiments', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Individual experiment trials' })).toBeVisible();
  await noHorizontalOverflow(page);
  await page.screenshot({ path: info.outputPath('fixture-mobile-experiments.png'), fullPage: true });
  await page.setViewportSize({ width: 320, height: 740 });
  await noHorizontalOverflow(page);
  await page.getByRole('link', { name: 'Live overview', exact: true }).click();
  await noHorizontalOverflow(page);
});
