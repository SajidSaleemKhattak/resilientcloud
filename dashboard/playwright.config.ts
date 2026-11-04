import { defineConfig } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
process.env.PLAYWRIGHT_BROWSERS_PATH ??= path.resolve(directory, '../.cache/playwright');
const live = process.env.LIVE_DASHBOARD_URL;
if (live && !/^http:\/\/127\.0\.0\.1:\d+$/.test(live)) throw new Error('Live UI validation requires a loopback URL.');
const artifacts = process.env.LIVE_ARTIFACT_DIR;
if (artifacts && !path.resolve(artifacts).startsWith(path.resolve(directory, '..') + path.sep)) throw new Error('Browser artifacts must remain inside resilientcloud.');

export default defineConfig({
  testDir: './tests', testMatch: live ? 'live.spec.ts' : 'dashboard.spec.ts',
  fullyParallel: false, workers: 1, retries: 0, timeout: 20_000,
  outputDir: artifacts ?? './test-results',
  reporter: [['list'], ['html', { open: 'never', ...(artifacts ? { outputFolder: `${artifacts}-report` } : {}) }]],
  use: { baseURL: live ?? 'http://127.0.0.1:4173', browserName: 'chromium',
    viewport: { width: 1440, height: 1000 }, screenshot: 'only-on-failure', trace: 'retain-on-failure', locale: 'en-GB' },
  webServer: live ? undefined : { command: 'npm run preview', cwd: directory,
    url: 'http://127.0.0.1:4173', reuseExistingServer: false, timeout: 15_000,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 1000 } },
});
