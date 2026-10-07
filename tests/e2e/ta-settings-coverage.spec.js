// @ts-check
/**
 * Focused browser coverage for public/ta/scripts/ta-settings.js.
 *
 * Drives the TA settings page through every branch of its loaders, UI
 * renderers, notification helper, and click handlers. The page DOM lives in
 * public/ta/settings.html (it has no #course-assignments container, so for the
 * assignments-render branches the test injects one into the page).
 *
 * Mocks /api/courses/ta/:taId and /api/courses/:courseId/ta-permissions/:taId
 * — plus /api/auth/me so currentUser preferences are deterministic — to drive
 * scenarios without touching MongoDB.
 *
 * Important: the sidebar link `#ta-my-courses-link` is naturally visible from
 * CSS (no `display: none` default), so `toBeVisible()` returns immediately —
 * before setupTANavigationHandlers() has actually attached its click handler.
 * Wherever a test clicks a sidebar link, it first waits for the JS-applied
 * inline style (`el.style.display === 'block'` for permitted links or
 * `'none'` for denied links) which only appears at the end of
 * updateTANavigationBasedOnPermissions() — by then setupTANavigationHandlers()
 * has definitively run.
 */

const { test, expect } = require('./fixtures/monocart');
const { storageStatePath, TEST_USERS } = require('./helpers/users');
const { getUserIdByUsername } = require('./helpers/quiz');

const COURSE_A = 'BIOC-E2E-TASET-A';
const COURSE_B = 'BIOC-E2E-TASET-B';

test.use({ storageState: storageStatePath('ta') });

let taId;

test.beforeAll(async () => {
    taId = await getUserIdByUsername(TEST_USERS.ta.username);
});

/**
 * Install API mocks for the TA settings page.
 *
 * @param {import('@playwright/test').Page} page
 * @param {{
 *   courses?: Array<Record<string, any>>,
 *   permissions?: Record<string, { materials?: boolean, questions?: boolean, flags?: boolean, roster?: boolean, transcripts?: boolean, settings?: boolean, roleLabel?: string } | null>,
 *   coursesStatus?: number,
 *   permissionsStatus?: Record<string, number>,
 *   userPreferences?: Record<string, any>,
 * }} [options]
 */
async function mockTASettingsAPI(page, options = {}) {
    const courses = options.courses ?? [];
    const permissions = options.permissions ?? {};
    const permissionsStatus = options.permissionsStatus ?? {};

    /** @type {{ navigations: string[] }} */
    const captured = { navigations: [] };

    await page.route('**/api/**', async (route) => {
        const url = new URL(route.request().url());
        const pathname = url.pathname;

        if (pathname === '/api/auth/me') {
            await route.fulfill({
                json: {
                    success: true,
                    user: {
                        userId: taId,
                        username: TEST_USERS.ta.username,
                        email: TEST_USERS.ta.email,
                        role: 'ta',
                        displayName: TEST_USERS.ta.displayName,
                        preferences: options.userPreferences ?? {},
                    },
                },
            });
            return;
        }

        if (pathname === `/api/courses/ta/${taId}`) {
            if (options.coursesStatus && options.coursesStatus !== 200) {
                await route.fulfill({ status: options.coursesStatus, json: { success: false, message: 'forced error' } });
                return;
            }
            await route.fulfill({ json: { success: true, data: courses } });
            return;
        }

        const permMatch = pathname.match(/^\/api\/courses\/([^/]+)\/ta-permissions\//);
        if (permMatch) {
            const courseId = permMatch[1];
            const status = permissionsStatus[courseId];
            if (status && status !== 200) {
                await route.fulfill({ status, json: { success: false, message: 'forced perm error' } });
                return;
            }
            const perms = permissions[courseId];
            if (perms === null) {
                await route.fulfill({ json: { success: false, message: 'no permissions' } });
                return;
            }
            await route.fulfill({
                json: {
                    success: true,
                    data: {
                        permissions: perms ?? { materials: true, questions: true, settings: true, transcripts: true, flags: true, roster: true },
                        roleLabel: (options.roleLabels && options.roleLabels[courseId]) ?? 'fullTA',
                    },
                },
            });
            return;
        }

        await route.fallback();
    });

    // Intercept navigations the page tries to perform via window.location.href.
    await page.route('**/instructor/documents*', async (route) => {
        captured.navigations.push(route.request().url());
        await route.fulfill({ contentType: 'text/html', body: '<html><body>stub-documents</body></html>' });
    });
    await page.route('**/instructor/flagged*', async (route) => {
        captured.navigations.push(route.request().url());
        await route.fulfill({ contentType: 'text/html', body: '<html><body>stub-flagged</body></html>' });
    });

    return captured;
}

/**
 * Wait until ta-settings.js has finished its DOMContentLoaded handler — proven
 * by either nav link's `style.display` being set to its JS-driven value.
 *
 * @param {import('@playwright/test').Page} page
 */
async function waitForTASettingsReady(page) {
    await page.waitForFunction(() => {
        const links = ['ta-my-courses-link', 'ta-student-support-link'];
        return links.some((id) => {
            const el = document.getElementById(id);
            return el && (el.style.display === 'block' || el.style.display === 'none');
        });
    }, null, { timeout: 15_000 });
}

test.describe('ta-settings.js focused coverage', () => {
    test('renders account, permission status, and respects per-feature link visibility', async ({ page }) => {
        await mockTASettingsAPI(page, {
            courses: [{ courseId: COURSE_A, courseName: 'TA Coverage Course A', status: 'active' }],
            permissions: { [COURSE_A]: { materials: true, questions: true, settings: true, transcripts: true, flags: false, roster: false } },
        });

        await page.goto('/ta/settings');
        await waitForTASettingsReady(page);

        await expect(page.locator('#ta-id')).toHaveValue(taId, { timeout: 15_000 });
        await expect(page.locator('#ta-email')).toHaveValue(TEST_USERS.ta.email);

        const status = page.locator('#permissions-status');
        await expect(status).toContainText('Course Materials');
        await expect(status.locator('.permission-status.allowed').filter({ hasText: /^\s*Allowed\s*$/ }).first()).toBeVisible();
        await expect(status.locator('.permission-status.denied').filter({ hasText: /^\s*Denied\s*$/ }).first()).toBeVisible();

        // updateTANavigationBasedOnPermissions sets inline style — assert that
        // rather than visibility, because the link is CSS-visible by default.
        await expect(page.locator('#ta-my-courses-link')).toHaveCSS('display', /(?:block|flex|inline|inline-block)/);
        expect(await page.locator('#ta-my-courses-link').evaluate((el) => el.style.display)).toBe('block');
        expect(await page.locator('#ta-student-support-link').evaluate((el) => el.style.display)).toBe('none');
    });

    test('renders course-assignments markup for active and inactive courses when the container is present', async ({ page }) => {
        await page.addInitScript(() => {
            document.addEventListener('DOMContentLoaded', () => {
                if (!document.getElementById('course-assignments')) {
                    const div = document.createElement('div');
                    div.id = 'course-assignments';
                    document.body.appendChild(div);
                }
            }, { once: true, capture: true });
        });

        await mockTASettingsAPI(page, {
            courses: [
                { courseId: COURSE_A, courseName: 'Active TA Course', status: 'active' },
                { courseId: COURSE_B, courseName: 'Inactive TA Course', status: 'inactive' },
            ],
            permissions: {
                [COURSE_A]: { materials: true, questions: true, settings: true, transcripts: true, flags: true, roster: true },
                [COURSE_B]: { materials: true, questions: true, settings: true, transcripts: true, flags: true, roster: true },
            },
        });

        await page.goto('/ta/settings');
        await waitForTASettingsReady(page);
        await expect(page.locator('#ta-id')).toHaveValue(taId, { timeout: 15_000 });

        const assignments = page.locator('#course-assignments');
        await expect(assignments).toContainText('Active TA Course');
        await expect(assignments).toContainText(COURSE_A);
        await expect(assignments.locator('.course-status.active').first()).toHaveText('Active');

        await expect(assignments).toContainText('Inactive TA Course (Inactive)');
        await expect(assignments.locator('.course-status.inactive').first()).toHaveText('Inactive');
    });

    test('renders the "No Course Assignments" empty state when the TA has no courses', async ({ page }) => {
        await page.addInitScript(() => {
            document.addEventListener('DOMContentLoaded', () => {
                if (!document.getElementById('course-assignments')) {
                    const div = document.createElement('div');
                    div.id = 'course-assignments';
                    document.body.appendChild(div);
                }
            }, { once: true, capture: true });
        });

        await mockTASettingsAPI(page, { courses: [] });
        await page.goto('/ta/settings');
        await waitForTASettingsReady(page);
        await expect(page.locator('#ta-id')).toHaveValue(taId, { timeout: 15_000 });

        await expect(page.locator('#course-assignments .empty-state h3')).toHaveText('No Course Assignments');
        await expect(page.locator('#permissions-status')).toContainText('No Permission Data');

        // Both nav links should be hidden when no permissions are loaded.
        expect(await page.locator('#ta-my-courses-link').evaluate((el) => el.style.display)).toBe('none');
        expect(await page.locator('#ta-student-support-link').evaluate((el) => el.style.display)).toBe('none');
    });

    test('clicking a permitted nav link navigates to /instructor/* with the selected courseId from localStorage', async ({ page, context }) => {
        const captured = await mockTASettingsAPI(page, {
            courses: [
                { courseId: COURSE_A, courseName: 'A', status: 'active' },
                { courseId: COURSE_B, courseName: 'B', status: 'active' },
            ],
            permissions: {
                [COURSE_A]: { materials: true, questions: true, settings: true, transcripts: true, flags: true, roster: true },
                [COURSE_B]: { materials: true, questions: true, settings: true, transcripts: true, flags: true, roster: true },
            },
        });

        // Pre-seed localStorage so navigateToTACourse picks the second course.
        await context.addInitScript((courseId) => {
            try { localStorage.setItem('selectedCourseId', courseId); } catch (e) { /* noop */ }
        }, COURSE_B);

        await page.goto('/ta/settings');
        await waitForTASettingsReady(page);

        await Promise.all([
            page.waitForURL(/\/instructor\/documents\?courseId=/, { timeout: 10_000 }),
            page.locator('#ta-my-courses-link').click(),
        ]);
        expect(page.url()).toContain(`courseId=${COURSE_B}`);

        // Back to settings to exercise the support link too.
        await page.goto('/ta/settings');
        await waitForTASettingsReady(page);
        await Promise.all([
            page.waitForURL(/\/instructor\/flagged\?courseId=/, { timeout: 10_000 }),
            page.locator('#ta-student-support-link').click(),
        ]);
        expect(page.url()).toContain(`courseId=${COURSE_B}`);

        expect(captured.navigations.length).toBeGreaterThanOrEqual(2);
    });

    test('clicking navigation when no courses are available shows the warning notification instead of navigating', async ({ page }) => {
        await mockTASettingsAPI(page, { courses: [] });

        await page.goto('/ta/settings');
        await waitForTASettingsReady(page);
        await expect(page.locator('#ta-id')).toHaveValue(taId, { timeout: 15_000 });

        const url = await page.evaluate(() => window.location.href);

        // Both nav links are hidden — call the handler directly to exercise
        // the "no courses available" branch of navigateToTACourse.
        await page.evaluate(() => {
            /** @type {any} */ (window).navigateToTACourse('/instructor/documents');
        });

        await expect(page.locator('.notification.notification-warning')).toContainText('No courses available', {
            timeout: 5_000,
        });
        expect(page.url()).toBe(url);
    });

    test('falls back to URL courseId when localStorage is empty', async ({ page, context }) => {
        await mockTASettingsAPI(page, {
            courses: [
                { courseId: COURSE_A, courseName: 'A', status: 'active' },
                { courseId: COURSE_B, courseName: 'B', status: 'active' },
            ],
            permissions: {
                [COURSE_A]: { materials: true, questions: true, settings: true, transcripts: true, flags: false, roster: false },
                [COURSE_B]: { materials: false, questions: false, settings: false, transcripts: false, flags: true, roster: true },
            },
        });

        await context.addInitScript(() => {
            try { localStorage.removeItem('selectedCourseId'); } catch (e) { /* noop */ }
        });

        // URL param wins over localStorage / user prefs.
        await page.goto(`/ta/settings?courseId=${COURSE_B}`);
        await waitForTASettingsReady(page);

        await Promise.all([
            page.waitForURL(/\/instructor\/flagged\?courseId=/, { timeout: 10_000 }),
            page.locator('#ta-student-support-link').click(),
        ]);
        expect(page.url()).toContain(`courseId=${COURSE_B}`);
    });

    test('falls back to user preferences.courseId when URL & localStorage do not match an assigned course', async ({ page, context }) => {
        await mockTASettingsAPI(page, {
            courses: [
                { courseId: COURSE_A, courseName: 'A', status: 'active' },
                { courseId: COURSE_B, courseName: 'B', status: 'active' },
            ],
            permissions: {
                [COURSE_A]: { materials: true, questions: true, settings: true, transcripts: true, flags: true, roster: true },
                [COURSE_B]: { materials: true, questions: true, settings: true, transcripts: true, flags: true, roster: true },
            },
            userPreferences: { courseId: COURSE_B },
        });

        // localStorage points at a non-existent course; URL has no courseId.
        await context.addInitScript(() => {
            try { localStorage.setItem('selectedCourseId', 'COURSE-DOES-NOT-EXIST'); } catch (e) { /* noop */ }
        });

        await page.goto('/ta/settings');
        await waitForTASettingsReady(page);

        await Promise.all([
            page.waitForURL(/\/instructor\/documents\?courseId=/, { timeout: 10_000 }),
            page.locator('#ta-my-courses-link').click(),
        ]);
        expect(page.url()).toContain(`courseId=${COURSE_B}`);
    });

    test('falls back to the first course when no candidate matches', async ({ page, context }) => {
        await mockTASettingsAPI(page, {
            courses: [
                { courseId: COURSE_A, courseName: 'A', status: 'active' },
                { courseId: COURSE_B, courseName: 'B', status: 'active' },
            ],
            permissions: {
                [COURSE_A]: { materials: true, questions: true, settings: true, transcripts: true, flags: false, roster: false },
                [COURSE_B]: { materials: true, questions: true, settings: true, transcripts: true, flags: false, roster: false },
            },
            userPreferences: {},
        });

        await context.addInitScript(() => {
            try { localStorage.setItem('selectedCourseId', 'COURSE-DOES-NOT-EXIST'); } catch (e) { /* noop */ }
        });

        await page.goto('/ta/settings');
        await waitForTASettingsReady(page);

        await Promise.all([
            page.waitForURL(/\/instructor\/documents\?courseId=/, { timeout: 10_000 }),
            page.locator('#ta-my-courses-link').click(),
        ]);
        expect(page.url()).toContain(`courseId=${COURSE_A}`);
    });

    test('survives API errors: failed courses fetch leaves arrays empty and surfaces the error notification', async ({ page }) => {
        await mockTASettingsAPI(page, { coursesStatus: 500 });

        await page.goto('/ta/settings');
        await waitForTASettingsReady(page);

        await expect(page.locator('#ta-id')).toHaveValue(taId, { timeout: 15_000 });

        expect(await page.locator('#ta-my-courses-link').evaluate((el) => el.style.display)).toBe('none');
        expect(await page.locator('#ta-student-support-link').evaluate((el) => el.style.display)).toBe('none');
        await expect(page.locator('#permissions-status')).toContainText('No Permission Data');
    });

    test('survives a non-OK permissions fetch — those courses contribute no permissions but page still loads', async ({ page }) => {
        await mockTASettingsAPI(page, {
            courses: [{ courseId: COURSE_A, courseName: 'A', status: 'active' }],
            permissionsStatus: { [COURSE_A]: 500 },
        });

        await page.goto('/ta/settings');
        await waitForTASettingsReady(page);
        await expect(page.locator('#ta-id')).toHaveValue(taId, { timeout: 15_000 });
        await expect(page.locator('#permissions-status')).toContainText('No Permission Data');
    });

    test('showNotification renders each visual variant (info, success, warning, error)', async ({ page }) => {
        await mockTASettingsAPI(page, { courses: [] });
        await page.goto('/ta/settings');
        await waitForTASettingsReady(page);
        await expect(page.locator('#ta-id')).toHaveValue(taId, { timeout: 15_000 });

        const types = /** @type {const} */ (['info', 'success', 'warning', 'error']);
        for (const type of types) {
            await page.evaluate((t) => {
                /** @type {any} */ (window).showNotification(`hello-${t}`, t);
            }, type);
            await expect(page.locator(`.notification.notification-${type}`).filter({ hasText: `hello-${type}` })).toBeVisible({
                timeout: 5_000,
            });
        }

        // Default branch — type omitted falls back to 'info'.
        await page.evaluate(() => {
            /** @type {any} */ (window).showNotification('default-notif');
        });
        await expect(page.locator('.notification.notification-info').filter({ hasText: 'default-notif' })).toBeVisible();
    });

    test('contactInstructor and viewHelp emit info notifications via showNotification', async ({ page }) => {
        await mockTASettingsAPI(page, { courses: [] });
        await page.goto('/ta/settings');
        await waitForTASettingsReady(page);
        await expect(page.locator('#ta-id')).toHaveValue(taId, { timeout: 15_000 });

        await page.evaluate(() => {
            /** @type {any} */ (window).contactInstructor();
        });
        await expect(page.locator('.notification.notification-info').filter({ hasText: 'Contact instructor functionality coming soon' })).toBeVisible();

        await page.evaluate(() => {
            /** @type {any} */ (window).viewHelp();
        });
        await expect(page.locator('.notification.notification-info').filter({ hasText: 'Help guide coming soon' })).toBeVisible();
    });
});

test.describe('ta-settings.js auth-not-ready guard', () => {
    test('logs the warning when getCurrentInstructorId never returns a userId', async ({ page }) => {
        // /api/auth/me returns success but with an empty userId so that
        // currentUser is set but `getCurrentInstructorId()` evaluates to ''.
        // waitForAuth() will loop until its 5-second cap and then emit the
        // warning that proves the timeout branch ran.
        await page.route('**/api/auth/me', async (route) => {
            await route.fulfill({
                json: {
                    success: true,
                    user: {
                        userId: '',
                        username: TEST_USERS.ta.username,
                        email: TEST_USERS.ta.email,
                        role: 'ta',
                        displayName: TEST_USERS.ta.displayName,
                    },
                },
            });
        });

        const warningSeen = page.waitForEvent('console', {
            predicate: (msg) => msg.text().includes('TA Authentication not ready'),
            timeout: 10_000,
        });

        await page.goto('/ta/settings');
        await warningSeen;
    });
});

// The end-to-end "real DB" round-trip is left to tests/e2e/ta.spec.js, which
// already covers it with a clean TA fixture. Here we focus on JS branches via
// the mocks above so the suite stays isolated from cross-test DB residue.

