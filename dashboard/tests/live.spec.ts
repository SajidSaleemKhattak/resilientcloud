import { expect, test } from '@playwright/test';

// Opt-in tests use actual local services. No request interception or synthetic feeds.
const expected = process.env.EXPECT_LIVE_STATE ?? 'healthy';
if (!['healthy', 'stale', 'disconnected'].includes(expected)) throw new Error('Invalid EXPECT_LIVE_STATE');

test(`actual local telemetry: ${expected}`, async ({ page, request }, info) => {
  const response = await request.get('/status');
  const calls: { method: string; path: string }[] = [];
  page.on('request', r => { if (['/status', '/events'].includes(new URL(r.url()).pathname)) calls.push({ method: r.method(), path: new URL(r.url()).pathname }); });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  if (expected === 'disconnected') {
    expect(response.ok()).toBe(false);
    await expect(page.getByText('The status service is disconnected.')).toBeVisible();
  } else {
    expect(response.ok()).toBe(true);
    const status = await response.json();
    await info.attach('actual-status.json', { body: JSON.stringify(status, null, 2), contentType: 'application/json' });
    expect(status.stale).toBe(expected === 'stale');
    if (expected === 'stale') await expect(page.getByText('Telemetry is stale.')).toBeVisible();
    else await expect(page.getByText('Live telemetry', { exact: true })).toBeVisible();
    for (const name of ['backend-a', 'backend-b']) {
      const backend = status.backends[name];
      expect(backend).toBeTruthy();
      const card = page.getByRole('article', { name });
      await expect(card.getByText(backend.containerId.slice(0, 12), { exact: true })).toBeVisible();
      await expect(card.getByText(expected === 'stale' ? 'Stale' : 'Ready', { exact: true })).toBeVisible();
      if (expected === 'healthy') expect(backend.lastProbe.ok).toBe(true);
    }
    const events = await (await request.get('/events')).json();
    await info.attach('actual-events.json', { body: JSON.stringify(events, null, 2), contentType: 'application/json' });
    expect(events.available).toBe(true);
    if (events.events.length) await expect(page.locator('.timeline > li').first()).toBeVisible();
  }
  expect(calls.every(call => call.method === 'GET')).toBe(true);
  expect(errors).toEqual([]);
  await expect(page.getByRole('button', { name: /restart|recover|inject|crash/i })).toHaveCount(0);
  await page.screenshot({ path: info.outputPath(`actual-${expected}-desktop.png`), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath(`actual-${expected}-mobile.png`), fullPage: true });
});

test('saved experiment chart reads the actual saved summary', async ({ page, request }, info) => {
  test.skip(expected !== 'healthy', 'Saved evidence is checked once with healthy services.');
  const response = await request.get('/experiments/summary.json');
  expect(response.ok()).toBe(true);
  const saved = await response.json();
  expect(saved.trials.length).toBeGreaterThanOrEqual(27);
  await page.goto('/#experiments');
  await expect(page.getByText('Saved results', { exact: true })).toBeVisible();
  for (const fault of ['crash', 'unhealthy', 'control']) {
    await page.getByRole('button', { name: fault === 'crash' ? 'Crash' : fault === 'unhealthy' ? 'Unhealthy' : 'Control', exact: true }).click();
    const trials = saved.trials.filter((trial: { fault: string }) => trial.fault === fault);
    await expect(page.locator('tbody tr')).toHaveCount(trials.length);
    for (const trial of trials) {
      const row = page.locator('tbody tr').filter({ hasText: trial.id });
      await expect(row).toContainText(`${trial.whole.successes}/${trial.whole.requests}`);
      if (trial.postFault) await expect(row).toContainText(`${trial.postFault.successes}/${trial.postFault.requests}`);
      if (fault !== 'control' && !trial.recoveryObserved) await expect(row).toContainText('Not observed');
    }
  }
  await page.getByRole('button', { name: 'Crash', exact: true }).click();
  await page.screenshot({ path: info.outputPath('actual-saved-experiments-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('actual-saved-experiments-mobile.png'), fullPage: true });
});
