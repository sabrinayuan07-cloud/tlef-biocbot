// @ts-check
/**
 * Instructor-side quiz settings tests. Drives the Quiz Practice Settings
 * section on /instructor/settings (UI) and the /api/settings/quiz endpoint
 * (API) — the two halves of how instructors configure what students see.
 */

const { test, expect } = require('./fixtures/monocart');
const { TEST_USERS, loadCredentials, storageStatePath } = require('./helpers/users');
const {
    QUIZ_COURSE_ID,
    withDb,
    getUserIdByUsername,
    resetQuizCourse,
    cleanupQuizCourse,
} = require('./helpers/quiz');

const instructorUser = TEST_USERS.instructor;
let instructorPassword;
let instructorId;

test.beforeAll(async () => {
    instructorPassword = loadCredentials().instructor;
    instructorId = await getUserIdByUsername(instructorUser.username);
});

test.afterAll(async () => {
    await cleanupQuizCourse();
});

async function readQuizSettings() {
    return withDb(async (db) => {
        const course = await db.collection('courses').findOne(
            { courseId: QUIZ_COURSE_ID },
            { projection: { quizSettings: 1 } }
        );
        return course?.quizSettings ?? null;
    });
}

// ----------------------------------------------------------------------------
// UI: /instructor/settings — Quiz Practice Settings section
// ----------------------------------------------------------------------------
test.describe('Instructor settings UI — Quiz Practice section', () => {
    async function loginAsInstructor(page) {
        await page.goto('/login');
        await page.locator('#auth-form input#username').fill(instructorUser.username);
        await page.locator('#auth-form input#password').fill(instructorPassword);
        await page.locator('#auth-form button#login-btn').click();
        await page.waitForURL((url) => url.pathname !== '/' && url.pathname !== '/login', {
            timeout: 10_000,
        });
    }

    async function gotoSettingsPage(page) {
        await page.goto(`/instructor/settings?courseId=${QUIZ_COURSE_ID}#quiz`);
        await expect(page.locator('#settings-panel-quiz')).toBeVisible({ timeout: 15_000 });
        await expect(page.locator('#quiz-settings-section')).toBeVisible({ timeout: 15_000 });
        // loadQuizSettings() runs async after DOMContentLoaded — it ends by
        // populating the testable-units container. Wait for that to render
        // before any test interacts with toggles; otherwise the load can race
        // ahead and overwrite our changes with the seeded values.
        await expect(page.locator('#testable-units-container .loading-text')).toHaveCount(0, { timeout: 15_000 });
        // The quiz section is far down the long settings page; scroll it into
        // view so subsequent toggle/checkbox clicks aren't off-viewport.
        await page.locator('#quiz-settings-section').scrollIntoViewIfNeeded();
        // Testable units rendering (above) is an early marker inside the
        // broader loadSettings() sequence - wireAutosaveSection() for this
        // section is wired once that whole sequence resolves, slightly
        // later. A toggle flipped before it's attached would fire a 'change'
        // event nobody is listening for yet (autosave #632).
        await page.waitForTimeout(300);
    }

    // The toggle <input> elements are visually hidden behind a styled slider,
    // so Playwright's `.check()` fails on them (display:none, off-viewport).
    // Toggle the state programmatically and fire `change` so the page's save
    // handler sees the new value.
    async function setToggle(page, id, checked) {
        await page.evaluate(
            ({ id, checked }) => {
                const el = /** @type {HTMLInputElement | null} */ (
                    document.getElementById(id)
                );
                if (!el) throw new Error(`#${id} not found`);
                el.checked = checked;
                el.dispatchEvent(new Event('change', { bubbles: true }));
            },
            { id, checked }
        );
    }

    test.beforeEach(async () => {
        await resetQuizCourse({
            instructorId,
            quizSettings: { enabled: false, testableUnits: 'all', allowLectureMaterialAccess: true },
        });
    });

    test('renders quiz settings and reflects the current course state', async ({ page }) => {
        await loginAsInstructor(page);
        await gotoSettingsPage(page);

        // Toggles reflect the seeded state (enabled:false, materialAccess:true)
        await expect(page.locator('#quiz-enabled-toggle')).not.toBeChecked();
        await expect(page.locator('#quiz-material-access-toggle')).toBeChecked();

        // Testable units container lists the published unit (Unit 1 only)
        const container = page.locator('#testable-units-container');
        await expect(container).toContainText('Unit 1');
        // Unit 2 is seeded as unpublished, so it must not appear here
        await expect(container).not.toContainText('Unit 2');
    });

    test('toggling Enable Quiz on autosaves enabled:true', async ({ page }) => {
        await loginAsInstructor(page);
        await gotoSettingsPage(page);

        // Quiz practice autosaves on every toggle/field change - no Save
        // button to click. Assert on DB truth directly since the debounced
        // save round-trips in the background.
        await setToggle(page, 'quiz-enabled-toggle', true);

        await expect.poll(readQuizSettings, { timeout: 10_000 })
            .toMatchObject({ enabled: true });
    });

    test('toggling Allow Lecture Material Access off autosaves the change', async ({ page }) => {
        await loginAsInstructor(page);
        await gotoSettingsPage(page);

        await setToggle(page, 'quiz-material-access-toggle', false);

        await expect.poll(readQuizSettings, { timeout: 10_000 })
            .toMatchObject({ allowLectureMaterialAccess: false });
    });

    test('selecting a subset of testable units saves them as an array', async ({ page }) => {
        // Need at least two published units for a meaningful subset.
        await withDb((db) =>
            db.collection('courses').updateOne(
                { courseId: QUIZ_COURSE_ID, 'lectures.name': 'Unit 2' },
                { $set: { 'lectures.$.isPublished': true } }
            )
        );

        await loginAsInstructor(page);
        await gotoSettingsPage(page);

        const checkboxes = page.locator('.testable-unit-checkbox');
        await expect(checkboxes).toHaveCount(2);

        // Uncheck "Unit 2" — leaves "Unit 1" as the only testable unit
        await page.evaluate(() => {
            const cb = /** @type {HTMLInputElement | null} */ (
                document.querySelector('.testable-unit-checkbox[value="Unit 2"]')
            );
            if (!cb) throw new Error('Unit 2 checkbox not found');
            cb.checked = false;
            cb.dispatchEvent(new Event('change', { bubbles: true }));
        });
        await setToggle(page, 'quiz-enabled-toggle', true);

        await expect.poll(readQuizSettings, { timeout: 10_000 })
            .toMatchObject({ enabled: true, testableUnits: ['Unit 1'] });
    });

    test('leaving all testable units checked saves the sentinel string "all"', async ({ page }) => {
        await withDb((db) =>
            db.collection('courses').updateOne(
                { courseId: QUIZ_COURSE_ID, 'lectures.name': 'Unit 2' },
                { $set: { 'lectures.$.isPublished': true } }
            )
        );

        await loginAsInstructor(page);
        await gotoSettingsPage(page);

        // Both boxes start checked because the seeded testableUnits is "all".
        // Nothing here actually needs to change - flip an unrelated toggle
        // just to trigger the composite autosave, which reads the testable
        // unit checkboxes fresh off the DOM regardless of what fired it.
        await expect(page.locator('.testable-unit-checkbox')).toHaveCount(2);
        await setToggle(page, 'quiz-material-access-toggle', false);

        await expect.poll(readQuizSettings, { timeout: 10_000 })
            .toMatchObject({ testableUnits: 'all' });
    });
});

// ----------------------------------------------------------------------------
// API: /api/settings/quiz
// ----------------------------------------------------------------------------
test.describe('Quiz settings API', () => {
    test.use({ storageState: storageStatePath('instructor') });

    test.beforeEach(async () => {
        await resetQuizCourse({
            instructorId,
            quizSettings: { enabled: false, testableUnits: 'all', allowLectureMaterialAccess: true },
        });
    });

    test('GET /api/settings/quiz returns the current settings', async ({ request: api }) => {
        const res = await api.get(`/api/settings/quiz?courseId=${QUIZ_COURSE_ID}`);
        expect(res.ok()).toBeTruthy();
        const body = await res.json();
        expect(body.success).toBe(true);
        expect(body.settings).toMatchObject({
            enabled: false,
            testableUnits: 'all',
            allowLectureMaterialAccess: true,
        });
    });

    test('POST /api/settings/quiz persists each setting verbatim', async ({ request: api }) => {
        const res = await api.post('/api/settings/quiz', {
            data: {
                courseId: QUIZ_COURSE_ID,
                enabled: true,
                testableUnits: ['Unit 1'],
                allowLectureMaterialAccess: false,
                allowSourceAttributionDownloads: true,
            },
        });
        expect(res.ok()).toBeTruthy();
        const body = await res.json();
        expect(body.success).toBe(true);

        const stored = await readQuizSettings();
        expect(stored).toMatchObject({
            enabled: true,
            testableUnits: ['Unit 1'],
            allowLectureMaterialAccess: false,
            allowSourceAttributionDownloads: true,
        });
    });

    test('POST /api/settings/quiz returns 400 when courseId is missing', async ({ request: api }) => {
        const res = await api.post('/api/settings/quiz', {
            data: { enabled: true },
        });
        expect(res.status()).toBe(400);
    });
});
