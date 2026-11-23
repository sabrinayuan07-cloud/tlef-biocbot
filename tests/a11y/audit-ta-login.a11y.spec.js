// @ts-check
/**
 * Accessibility audit of the TA pages and the sign-in page: /ta, /ta/settings, /login.
 *
 * An audit, not a gate. Each test drives one page through its states, runs the
 * toolkit rules and axe-core in every state, and writes what it finds to
 * a11y-results/other-pages/raw/. Nothing here fails the build.
 */
const { test } = require('@playwright/test');
const { TEST_USERS, storageStatePath } = require('../e2e/helpers/users');
const { seedCourse, cleanupCourses, getUserIdByUsername, withDb } = require('../e2e/helpers/courses-test');
const { auditTest, toastStates, pageShell } = require('./helpers/audit-recorder');

const COURSE_A = 'BIOC-A11Y-AUD-TA-A';
const COURSE_B = 'BIOC-A11Y-AUD-TA-B';
const COURSE_JOIN = 'BIOC-A11Y-AUD-TA-JOIN';
const ALL = [COURSE_A, COURSE_B, COURSE_JOIN];

test.describe('Audit: TA pages', () => {
    test.use({ storageState: storageStatePath('ta'), viewport: { width: 1440, height: 1000 } });

    test.beforeAll(async () => {
        const [instructorId, taId] = await Promise.all([
            getUserIdByUsername(TEST_USERS.instructor.username),
            getUserIdByUsername(TEST_USERS.ta.username),
        ]);
        await withDb((db) => db.collection('users').updateOne({ userId: taId }, { $set: { role: 'ta', isActive: true, invitedCourses: [] } }));
        const now = new Date();
        // Two assigned courses with different permission sets (so the role pill
        // and the Allowed/Denied rows both vary), one inactive, one joinable.
        await seedCourse({
            courseId: COURSE_A, instructorId, courseName: 'Audit TA Course A', tas: [taId], courseCode: 'AUDTAA',
            taPermissions: { [taId]: { materials: true, questions: true, flags: true, roster: true, transcripts: true, settings: true, updatedAt: now } },
            overrides: { taPermissionsMigrated: true },
        });
        await seedCourse({
            courseId: COURSE_B, instructorId, courseName: 'Audit TA Course B', tas: [taId], courseCode: 'AUDTAB', status: 'inactive',
            taPermissions: { [taId]: { materials: false, questions: false, flags: true, roster: true, transcripts: false, settings: false, updatedAt: now } },
            overrides: { taPermissionsMigrated: true },
        });
        await seedCourse({ courseId: COURSE_JOIN, instructorId, courseName: 'Audit TA Joinable Course', courseCode: 'AUDTAJ' });
    });

    test.afterAll(async () => {
        await cleanupCourses(ALL);
    });

    auditTest(test, '/ta', async ({ page, rec }) => {
        await page.addInitScript((id) => { try { localStorage.setItem('selectedCourseId', id); } catch (_) {} }, COURSE_A);
        await page.goto('/ta');
        await page.locator(`.course-card[data-course-id="${COURSE_A}"]`).waitFor({ timeout: 20_000 });
        await page.locator(`.course-card[data-course-id="${COURSE_B}"]`).waitFor({ timeout: 20_000 });
        await page.waitForTimeout(800);
        await pageShell(page, rec);
        await rec.capture(page, 'loaded-two-courses');

        // Account menu: a show/hide control in the shared header.
        await rec.disclosure('account menu trigger', page.locator('#account-menu-trigger'), { scope: 'header, .header, body' });
        await rec.state(page, 'account-menu-open', async () => {
            await page.locator('#account-menu-trigger').click();
            await page.locator('#account-menu').waitFor({ state: 'visible', timeout: 5000 });
        });
        await rec.step('close account menu', () => page.keyboard.press('Escape'));

        // Selecting a course re-renders every card and shows a toast.
        const other = page.locator(`.course-card[data-course-id="${COURSE_B}"]`);
        await rec.status('select a course card (announcement)', page, () => other.locator('.course-select-button').click(), { watchMs: 6500 });
        await rec.capture(page, 'after-selecting-course-b');
        await rec.focus('"Select Course" button on a card (list re-renders)',
            page.locator(`.course-card[data-course-id="${COURSE_A}"] .course-select-button`), { settleMs: 1500 });
        await rec.focus('course card itself, Enter (role=button container)',
            page.locator(`.course-card[data-course-id="${COURSE_B}"]`), { settleMs: 1500 });

        // The picker announces through #selected-course-summary.
        await rec.status('change the course picker (announcement)', page, async () => {
            const select = page.locator('#ta-course-select');
            const value = await select.locator('option').evaluateAll((opts, id) => {
                const o = /** @type {HTMLOptionElement[]} */ (opts).find((x) => x.value === id);
                return o ? o.value : null;
            }, COURSE_A);
            if (value) await select.selectOption(value);
        }, { watchMs: 6500 });

        await toastStates(page, rec);
    });

    auditTest(test, '/ta', async ({ page, rec }) => {
        // The TA with no courses: the page's empty state.
        await page.route('**/api/courses/ta/*', async (route) => {
            const response = await route.fetch();
            const body = await response.json().catch(() => ({}));
            for (const key of Object.keys(body)) if (Array.isArray(body[key])) body[key] = [];
            if (body.data && typeof body.data === 'object' && !Array.isArray(body.data)) {
                for (const key of Object.keys(body.data)) if (Array.isArray(body.data[key])) body.data[key] = [];
            }
            await route.fulfill({ response, json: body });
        });
        await page.goto('/ta');
        await rec.state(page, 'no-courses', () => page.locator('.no-courses-message').waitFor({ timeout: 15_000 }));
    }, { variant: 'empty' });

    auditTest(test, '/ta/settings', async ({ page, rec }) => {
        await page.goto(`/ta/settings?courseId=${COURSE_B}`);
        await page.locator('#permissions-status .permission-item').first().waitFor({ timeout: 20_000 });
        await page.waitForTimeout(600);
        await pageShell(page, rec);
        await rec.capture(page, 'loaded-with-permissions');
        await rec.disclosure('account menu trigger', page.locator('#account-menu-trigger'), { scope: 'header, .header, body' });
        await rec.state(page, 'account-menu-open', async () => {
            await page.locator('#account-menu-trigger').click();
            await page.locator('#account-menu').waitFor({ state: 'visible', timeout: 5000 });
        });
        await rec.step('close account menu', () => page.keyboard.press('Escape'));
        await toastStates(page, rec);
    });
});

test.describe('Audit: sign-in page', () => {
    // Signed out: an authenticated visitor is redirected away from /login.
    test.use({ storageState: { cookies: [], origins: [] }, viewport: { width: 1440, height: 1000 } });

    auditTest(test, '/login', async ({ page, rec }) => {
        await page.goto('/login');
        await page.locator('#login-form:not(.auth-methods-pending)').waitFor({ timeout: 15_000 }).catch(() => {});
        await page.waitForTimeout(500);
        await pageShell(page, rec);
        const visible = await page.evaluate(() => ({
            localForm: !!document.querySelector('#auth-form') && /** @type {HTMLElement} */ (document.querySelector('#auth-form')).offsetParent !== null,
            cwlButton: !!document.querySelector('#cwl-login-btn') && /** @type {HTMLElement} */ (document.querySelector('#cwl-login-btn')).offsetParent !== null,
        }));
        rec.note('sign-in methods shown in this environment', visible);
        await rec.capture(page, 'sign-in-form');

        if (visible.localForm) {
            // A failed sign-in: the message is the page's only status message.
            await rec.status('failed sign-in (announcement)', page, async () => {
                await page.locator('#username').fill('a11y-audit-no-such-user');
                await page.locator('#password').fill('not-a-real-password');
                await page.locator('#login-btn').click();
                await page.locator('#message.message-error').waitFor({ state: 'visible', timeout: 10_000 });
            }, { watchMs: 5000 });
            await rec.capture(page, 'failed-sign-in-message');
            await rec.focus('Sign In button after a failed sign-in (button is disabled while the request runs)',
                page.locator('#login-btn'), { settleMs: 2500 });

            await rec.focus('"Create one" link (hides sign-in, reveals the register panel)', page.locator('#show-register'), { settleMs: 700 });
            await rec.state(page, 'create-account-form', async () => {
                if (!(await page.locator('#register-form').isVisible())) await page.locator('#show-register').click();
                await page.locator('#register-form').waitFor({ state: 'visible', timeout: 5000 });
            });
            await rec.focus('"Sign in" link (returns from the register panel)', page.locator('#show-login'), { settleMs: 700 });
        } else {
            rec.notCovered('local sign-in form, failed sign-in message and create-account form', 'local login is turned off in this environment');
        }

        await rec.state(page, 'cwl-error-from-url', async () => {
            await page.goto('/login?error=saml_failed');
            await page.locator('#message.message-error').waitFor({ state: 'visible', timeout: 10_000 });
        });
        rec.notCovered('a successful sign-in and a successful account creation', 'not driven: both leave the page, and creating an account would add a real user to the database');
    });
});
