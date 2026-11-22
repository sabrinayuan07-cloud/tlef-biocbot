# Accessibility Scan Guide

Use this folder for Playwright + axe accessibility scans. The infrastructure is
already wired through `playwright.a11y.config.js`, `npm run test:a11y`, and
`tests/a11y/axe-helper.js`.

## Workflow

1. Add scans only. Do not fix app code in the same pass.
2. Run the scans so failures are visible.
3. Report each failure with the page, rule id, impact, selector, and axe details.
4. Fix failures only after the failure list has been reviewed.

## Living Checklist

Keep this section current when routes are added, scans are added, or failures are
fixed.

Status key:

- `todo`: no a11y scan exists yet.
- `scanned-pass`: scan exists and passed in the latest local/CI run.
- `scanned-failing`: scan exists and currently exposes blocking failures.
- `blocked`: route needs a different seeded state, permission, or setup before it
  can be scanned usefully.

When adding a scan, change `[ ]` to `[x]`, wrap the route in `~~route~~`, and
update the status. Do not mark a failing route as pass until `npm run test:a11y`
is green for that route.

### Student Pages

Use `storageStatePath('student')`.

- [x] ~~/student~~ - `scanned-failing`, existing scan in `student.a11y.spec.js`
- [x] ~~/student/history~~ - `scanned-failing`, scan in `student-remaining.a11y.spec.js`
- [x] ~~/student/flagged~~ - `scanned-failing`, scan in `student-remaining.a11y.spec.js`
- [x] ~~/student/quiz~~ - `scanned-pass`, scan in `student-pages.a11y.spec.js`
- [x] ~~/student/super-course~~ - `scanned-failing`, scan in `student-pages.a11y.spec.js`; seeds one visible Super Course bucket plus an enrolled source course and clears stale Super Course localStorage before scanning
- [x] ~~/student/dashboard.html~~ - `scanned-failing`, scan in `student-remaining.a11y.spec.js`

### Instructor Pages

Use `storageStatePath('instructor')` unless noted.

- [x] ~~/instructor~~ - `scanned-failing`, scan in `instructor-remaining.a11y.spec.js`
- [x] ~~/instructor/documents~~ - `scanned-failing`, scan in `instructor-remaining.a11y.spec.js`
- [x] ~~/instructor/home~~ - `scanned-pass`, scan in `instructor.a11y.spec.js`
- [x] ~~/instructor/settings~~ - `scanned-pass`, scan in `instructor.a11y.spec.js`
- [x] ~~/instructor/flagged~~ - `scanned-failing`, scan in `instructor.a11y.spec.js`
- [x] ~~/instructor/onboarding~~ - `scanned-failing`, use `storageStatePath('instructor_fresh')`
- [x] ~~/instructor/chat~~ - `scanned-failing`, scan in `instructor-remaining.a11y.spec.js`
- [x] ~~/instructor/notes~~ - `scanned-failing`, scan in `instructor-remaining.a11y.spec.js`
- [x] ~~/instructor/ta-hub~~ - `scanned-failing`, scan in `instructor-remaining.a11y.spec.js`
- [x] ~~/instructor/student-hub~~ - `scanned-pass`, scan in `instructor-remaining.a11y.spec.js`
- [x] ~~/instructor/downloads~~ - `scanned-failing`, scan in `instructor-downloads.a11y.spec.js`; seeds download data, grants the seeded instructor system-admin access, and opens with a `courseId` query param to avoid stale course state

### TA Pages

Use `storageStatePath('ta')`.

- [x] ~~/ta~~ - `scanned-failing`, scan in `ta.a11y.spec.js`
- [x] ~~/ta/onboarding~~ - `scanned-failing`, scan in `ta.a11y.spec.js`
- [x] ~~/ta/settings~~ - `scanned-failing`, scan in `ta.a11y.spec.js`
- [x] ~~/ta/courses~~ - `scanned-failing`, redirects to `/instructor/documents`
- [x] ~~/ta/students~~ - `scanned-failing`, redirects to `/instructor/flagged`

### Shared / Special Pages

- [x] ~~/login~~ - `scanned-pass`, unauthenticated scan in `shared.a11y.spec.js`

`/qdrant-test` is intentionally absent from this inventory. The server route points
to a removed `public/qdrant-test.html`, so scanning it would audit an Express error
page rather than an application page.

### Modals & Pop-ups

Modals are `display:none` until opened, so the page-level scans above never see
them. `modals.a11y.spec.js` force-reveals each one (static markup gets a `.show`
class / inline-display flip; dynamically-built popups are constructed by calling
the app's own global builder) and scopes axe to the dialog subtree. This audits
structure/naming/contrast but not focus-trapping — that stays in e2e.

Status: `scanned-failing` overall; passing/failing noted per modal.

Instructor (`storageStatePath('instructor')`):

- [x] ~~#upload-modal~~, ~~#question-modal~~, ~~#delete-unit-modal~~, ~~#regenerate-modal~~, ~~#auto-link-confirmation-modal~~, ~~#question-learning-objective-modal~~ on `/instructor/documents` - `scanned-pass`
- [x] ~~#calibration-modal~~ on `/instructor/documents` - `scanned-failing`, missing slider label
- [x] ~~#transfer-course-modal~~ on `/instructor/settings` - `scanned-pass`
- [x] ~~#remove-ta-modal~~ on `/instructor/ta-hub` - `scanned-pass`
- [x] ~~#download-modal~~ on `/instructor/downloads` - `scanned-pass`; needs system-admin
- [x] ~~#student-modal~~ on `/instructor/downloads` - `scanned-failing`, secondary-button contrast
- [x] ~~topic-review modal~~ on `/instructor/documents` - `scanned-pass`; built via `ensureTopicReviewModal()`
- [x] ~~topic-unit assignment modal~~ on `/instructor/home` - `scanned-failing`, button contrast; built via `ensureTopicUnitAssignmentModal()`
- [x] ~~notification toasts~~ on `/instructor/documents` - `scanned-failing`, success/info contrast; injected via `window.showNotification`

Instructor onboarding (`storageStatePath('instructor_fresh')`):

- [x] ~~#upload-modal~~, ~~#question-modal~~, ~~#regenerate-modal~~, ~~#auto-link-confirmation-modal~~, ~~#question-learning-objective-modal~~ on `/instructor/onboarding` - `scanned-failing`, primary-button contrast

Student (`storageStatePath('student')`):

- [x] ~~#confirm-modal~~ on `/student/dashboard.html` - `scanned-failing`, cancel-button contrast
- [x] ~~#idle-timeout-modal~~ on `/student` - `scanned-pass`
- [x] ~~agreement modal~~ (consent + read-only) on `/student` - `scanned-pass`; revealed via `window.agreementModal.show()`
- [x] ~~chat-limit info modal~~ on `/student` - `scanned-failing`, muted-text contrast; built via `window.showChatLimitModal()`
- [ ] chat-survey popup - `blocked`; IIFE-private behind `maybeShowChatSurvey`, needs seeded survey settings + message threshold (e2e candidate)

### Stateful checks (beyond axe)

Page-level scans only see a page as it first loads. `issue-724-course-upload.a11y.spec.js`
drives `/instructor/documents` into each of its states (units expanded, dialogs
open, toasts showing, a control just activated) and checks them with the generic
rules in `tests/a11y/toolkit/` as well as axe. It has one test per finding in
ubc/tlef-biocbot#724, plus a sweep that fails on any `fail`-tier toolkit finding
or blocking axe violation in any state.

- [x] ~~/instructor/documents (9 states)~~ - `scanned-pass`

See `tests/a11y/toolkit/README.md` for how to run it against a nodemon dev server.

### Route Aliases / Redirects

These are viewable or navigable URLs, but they should usually be covered through
the canonical route listed above unless there is alias-specific behavior.

- `/` redirects to `/login`
- `/settings` redirects to `/student`
- `/instructor/` serves the same page as `/instructor`
- `/instructor/chat.html` serves the same page as `/instructor/chat`
- `/instructor/downloads.html` serves the same page as `/instructor/downloads`
- `/instructor/student-hub.html` serves the same page as `/instructor/student-hub`
- `/ta/courses` redirects to `/instructor/documents`
- `/ta/students` redirects to `/instructor/flagged`

Not an HTML page:

- `/test-qdrant` returns JSON connection-test data, not a view.

## Current Fix Backlog

These are blocking issues from the latest Phase 1 run. Update or remove each
item after the fix pass and rerun.

- [ ] `/student` - `select-name` critical on `#course-select`; select has no accessible name.
- [ ] `/student/super-course` - `color-contrast` serious on `#super-course-scope` and `label[for="answer-level"]`; captured ratios include fg `#888888`, bg `#f5f7fa`, ratio `3.3`, and fg `#888888`, bg `#ffffff`, ratio `3.54`, expected `4.5`.
- [ ] `/student/history` - `color-contrast` serious on `.no-history-content > p` and `.no-selection-content > p`; fg `#777777`, bg `#ffffff`, ratio `4.47`, expected `4.5`.
- [ ] `/student/flagged` - `color-contrast` serious on `.flagged-subtitle > p` and `#refresh-flags`; one captured ratio is fg `#ffffff`, bg `#3b82f6`, ratio `3.67`, expected `4.5`.
- [ ] `/student/dashboard.html` - `color-contrast` serious on `#directive-mode-status` and `#reset-all-btn`; one captured ratio is fg `#ffffff`, bg `#e74c3c`, ratio `3.82`, expected `4.5`.
- [ ] `/instructor` - `color-contrast` serious on `#published-units-summary`; fg `#6c757d`, bg `#f5f7fa`, ratio `4.36`, expected `4.5`.
- [ ] `/instructor/documents` - `color-contrast` serious on `#published-units-summary > strong`; fg `#d9534f`, bg `#f5f7fa`, ratio `3.69`, expected `4.5`.
- [ ] `/instructor/downloads` - `color-contrast` serious on 9 nodes: `#scope-subtitle`, `.students-stats`, `#download-all-label`, `.student-id`, `.student-stats`, and `.student-actions > .btn-primary`; captured ratios include fg `#7f8c8d`, bg `#f5f7fa`, ratio `3.24`; fg `#7f8c8d`, bg `#f8fafc`, ratio `3.32`; fg `#ffffff`, bg `#3498db`, ratio `3.15`; and fg `#7f8c8d`, bg `#ffffff`, ratio `3.47`, expected `4.5`.
- [ ] `/instructor/chat` - `color-contrast` serious on `label[for="answer-level"]`; fg `#888888`, bg `#ffffff`, ratio `3.54`, expected `4.5`.
- [ ] `/instructor/notes` - `color-contrast` serious on `.notes-section-heading`, `.note-meta`, and `.note-usage`; captured ratios include fg `#888888` or `#7a8a9a`, bg `#ffffff`, ratio `3.54`, expected `4.5`.
- [ ] `/instructor/ta-hub` - `color-contrast` serious on `.section-description > p`.
- [ ] `/instructor/flagged` - `select-name` critical on `#mh-status-filter`; select has no accessible name.
- [ ] `/instructor/flagged` - `color-contrast` serious on `.flagged-subtitle > p`; fg `#64748b`, bg `#f5f7fa`, ratio `4.43`, expected `4.5`.
- [ ] `/instructor/flagged` - `color-contrast` serious on `#refresh-mh-flags`; fg `#ffffff`, bg `#3b82f6`, ratio `3.67`, expected `4.5`.
- [ ] `/instructor/flagged` - `color-contrast` serious on `#refresh-flags`; fg `#ffffff`, bg `#3b82f6`, ratio `3.67`, expected `4.5`.
- [ ] `/instructor/flagged` - `color-contrast` serious on `.notification > span`; fg `#fbe7e9`, bg `#f2dde2`, ratio `1.09`, expected `4.5`.
- [ ] `/instructor/onboarding` - `color-contrast` serious on `span[data-step="1"]`; fg `#ffffff`, bg `#4caf50`, ratio `2.77`, expected `4.5`.
- [ ] `/ta` - `color-contrast` serious on `.content-header > p`, `#quick-courses-link > p`, `#quick-support-link > p`, and `.action-card[href$="settings"] > p`; captured ratios include fg `#7f8c8d`, bg `#f5f7fa`, ratio `3.24`, and fg `#6c757d`, bg `#f8f9fa`, ratio `4.44`, expected `4.5`.
- [ ] `/ta/onboarding` - `color-contrast` serious on welcome header, feature-card headings/body text, form heading, and labels; captured ratios include fg `#d3d8e0`, bg `#f5f7fa`, ratio `1.33`, and fg `#c1c5cc`, bg `#f8f9fb`, ratio `1.64`.
- [ ] `/ta/settings` - `color-contrast` serious on `header > p`; fg `#7f8c8d`, bg `#f5f7fa`, ratio `3.24`, expected `4.5`.
- [ ] `/ta/courses` - redirects to the TA dashboard and exposes the same contrast failures as `/ta`.
- [ ] `/ta/students` - redirects to the TA dashboard and exposes the same contrast failures as `/ta`.

## Commands

Use Node.js 22 or later (`engines.node` in `package.json` is `>=22`).

List discovered a11y tests without needing the app services to pass:

```sh
npx playwright test --config=playwright.a11y.config.js --list
```

Run the full accessibility suite:

```sh
npm run test:a11y
```

Every run initializes `a11y-results/a11y-results.json` with a non-passing `running`
state, then replaces it atomically with the final result. The report includes test
pass/fail/flaky/skip counts, scan status, WCAG tags, and one record per affected
target for critical, serious, moderate, and minor axe violations. Each violation
record includes its route/page, rule ID, impact, selector/target, failure summary,
help text, HTML, and axe help URL.

Run one file:

```sh
npx playwright test --config=playwright.a11y.config.js tests/a11y/student-pages.a11y.spec.js
```

Run one route/test by title:

```sh
npx playwright test --config=playwright.a11y.config.js -g "/student/quiz"
```

## Spec Pattern

Use existing storage states from global setup. Do not add new login code.

```js
// @ts-check
const { test } = require('@playwright/test');
const { storageStatePath } = require('../e2e/helpers/users');
const { expectNoA11yViolations } = require('./axe-helper');

test.describe('Accessibility: audience pages', () => {
    test.use({ storageState: storageStatePath('student') });

    for (const path of ['/student/quiz']) {
        test(`${path} has no critical/serious a11y violations`, async ({ page }) => {
            await page.goto(path);
            await page.waitForLoadState('load');
            await expectNoA11yViolations(page);
        });
    }
});
```

Available storage states:

- `student`
- `instructor`
- `ta`
- `instructor_fresh`

Use `instructor_fresh` for onboarding flows that would redirect a completed
instructor away from `/instructor/onboarding`.

## Route Verification

Before adding scans, verify exact route URLs from the app routes or public page
links. For this app, protected page routes are defined in `src/server.js`, and
many links are visible in `public/<audience>/*.html`.

Useful route search:

```sh
rg -n "app\\.get\\('/(student|instructor|ta)|/instructor/settings|/student/quiz" src public
```

## Reporting Failures

For each blocking failure, report:

- Page URL
- Axe rule id
- Impact
- Element HTML or selector
- Failure summary
- For contrast: foreground color, background color, actual ratio, expected ratio

The Playwright failure output usually includes the selector and axe data. Error
context files are written under `test-results/**/error-context.md`.

For contrast failures, copy the values axe reports, for example:

```text
fg #ffffff, bg #3b82f6, ratio 3.67, expected 4.5
```

## Guardrails

- Do not edit production code during the scan/report phase.
- Do not touch `tests/e2e` harness specs for a11y scan expansion.
- Do not change the `test` script in `package.json`.
- Keep `expectNoA11yViolations` blocking on critical/serious violations.
- Prefer fixing accessibility issues later over suppressing them.
- Use `disableRules` only for a pre-existing issue that cannot be fixed in the
  current pass, and call out the suppression clearly.
