// @ts-check
/// <reference types="node" />
// Accessibility scans run as their own Playwright check, separate from the e2e
// suite in playwright.config.js. This config reuses the base webServer and
// global-setup (which seeds users and saves per-role auth storage states), but
// scopes test discovery to tests/a11y and writes to its own report directory so
// nothing collides with the e2e run.
const base = require('./playwright.config');

// The audit-*.a11y.spec.js files record findings instead of asserting, and a
// full run takes about 13 minutes, so they stay out of the default run (and
// CI). `npm run test:a11y:audit` sets A11Y_AUDIT=1 to run them.
const runAudit = !!process.env.A11Y_AUDIT;

/** @type {import('@playwright/test').PlaywrightTestConfig} */
module.exports = {
    ...base,
    testDir: './tests/a11y',
    testIgnore: runAudit ? [] : ['**/audit-*.a11y.spec.js'],
    reporter: [
        ['html', { open: 'never', outputFolder: 'playwright-report-a11y' }],
        ['list'],
        ['./tests/a11y/a11y-json-reporter.js'],
    ],
};
