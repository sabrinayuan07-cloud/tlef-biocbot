// @ts-check
/**
 * E2E coverage for public/instructor/scripts/student-hub.js and the backing
 * course/user APIs it relies on.
 */

const fs = require('fs/promises');
const { test, expect, request } = require('./fixtures/monocart');
const { TEST_USERS, storageStatePath } = require('./helpers/users');
const { getUserIdByUsername } = require('./helpers/quiz');
const { setSystemAdmin } = require('./helpers/downloads');
const {
    HUB_COURSE_ID,
    HUB_OTHER_COURSE_ID,
    HUB_UNRELATED_COURSE_ID,
    HUB_EMPTY_COURSE_ID,
    HUB_ACTIVE_STUDENT,
    HUB_XSS_STUDENT,
    HUB_OTHER_STUDENT,
    HUB_INACTIVE_STUDENT,
    HUB_PROMOTE_TARGET,
    HUB_PENDING_TA,
    resetStudentHubData,
    cleanupStudentHubData,
    getHubCourse,
    getHubUser,
} = require('./helpers/studentHub');

let instructorId;
let freshInstructorId;
let taId;

test.beforeAll(async () => {
    instructorId = await getUserIdByUsername(TEST_USERS.instructor.username);
    freshInstructorId = await getUserIdByUsername(TEST_USERS.instructor_fresh.username);
    taId = await getUserIdByUsername(TEST_USERS.ta.username);
});

test.afterAll(async () => {
    await cleanupStudentHubData();
});

async function seedStudentHub(options = {}) {
    await resetStudentHubData({
        instructorId,
        freshInstructorId,
        taId,
        options,
    });
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {{ courseId?: string, storedCourseId?: string | null }} [options]
 */
async function openStudentHub(page, { courseId = HUB_COURSE_ID, storedCourseId = HUB_OTHER_COURSE_ID } = {}) {
    await page.addInitScript((courseIdToStore) => {
        try {
            if (courseIdToStore) {
                localStorage.setItem('selectedCourseId', courseIdToStore);
            } else {
                localStorage.removeItem('selectedCourseId');
            }
        } catch (_) {}
    }, storedCourseId);

    await page.goto(`/instructor/student-hub?courseId=${courseId}`);
    await expect(page.locator('#students-container')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('.student-card').first()).toBeVisible({ timeout: 15_000 });
}

function studentCard(page, text) {
    return page.locator('.student-card', { hasText: text });
}

test.describe('Student Hub UI', () => {
    test.use({ storageState: storageStatePath('instructor'), acceptDownloads: true });

    test.beforeEach(async () => {
        await seedStudentHub();
    });

    test('loads the URL-selected course, hides the legacy selector, and renders students and struggle topics (not TAs)', async ({ page }) => {
        await openStudentHub(page, {
            courseId: HUB_COURSE_ID,
            storedCourseId: HUB_OTHER_COURSE_ID,
        });

        await expect(page.locator('.controls-row')).toBeHidden();

        const activeCard = studentCard(page, HUB_ACTIVE_STUDENT.displayName);
        await expect(activeCard).toBeVisible();
        await expect(activeCard).toContainText(HUB_ACTIVE_STUDENT.email);
        await expect(activeCard).toContainText('Struggle Topics');
        await expect(activeCard).toContainText('Oxidative phosphorylation');
        await expect(activeCard).toContainText('Count: 3');
        await expect(activeCard.getByRole('button', { name: 'Download Report' })).toBeVisible();

        // Student Hub shows students only - TA management lives in TA Hub.
        await expect(studentCard(page, TEST_USERS.ta.displayName)).toHaveCount(0);

        await expect(studentCard(page, HUB_OTHER_STUDENT.displayName)).toHaveCount(0);
    });

    test('opening an unlinked Student Hub does not contact Canvas or start Canvas login', async ({ page }) => {
        /** @type {string[]} */
        const canvasRequests = [];
        page.on('request', (request) => {
            const url = request.url();
            if (url.includes('/available-courses?provider=canvas') || url.includes('/api/lms/canvas/auth/')) {
                canvasRequests.push(url);
            }
        });

        // CI intentionally has no Canvas environment configuration. Model only
        // the app's provider metadata so this exercises "configured but
        // unlinked" everywhere, without seeding or mocking Canvas login/token.
        await page.route(
            new RegExp(`/api/lms/grades/courses/${HUB_COURSE_ID}(?:\\?.*)?$`),
            (route) => route.fulfill({
                status: 200,
                json: {
                    success: true,
                    data: {
                        provider: 'canvas',
                        source: null,
                        sources: [
                            { provider: 'canvas', configured: true, linked: false },
                            { provider: 'moodle', configured: false, linked: false },
                        ],
                        students: [],
                        gradeItems: [],
                        importedAt: null,
                    },
                },
            })
        );

        // resetStudentHubData creates the course without any LMS link. The page
        // still uses only the normal BiocBot instructor storage state.
        await openStudentHub(page);

        await expect(page).toHaveURL(new RegExp(`/instructor/student-hub\\?courseId=${HUB_COURSE_ID}$`));
        await expect(page.getByRole('button', { name: 'Connect Canvas' })).toBeVisible();
        await expect(page.locator('#lms-grades-status')).toContainText('Not linked');
        expect(canvasRequests).toEqual([]);
    });

    test('falls back to the selected course in localStorage when no courseId is in the URL', async ({ page }) => {
        await page.addInitScript((courseIdToStore) => {
            try {
                localStorage.setItem('selectedCourseId', courseIdToStore);
            } catch (_) {}
        }, HUB_OTHER_COURSE_ID);

        await page.goto('/instructor/student-hub');
        await expect(page.locator('.student-card').first()).toBeVisible({ timeout: 15_000 });

        await expect(studentCard(page, HUB_OTHER_STUDENT.displayName)).toBeVisible();
        await expect(studentCard(page, HUB_ACTIVE_STUDENT.displayName)).toHaveCount(0);
    });

    test('renders an empty state for a course with no students or TAs', async ({ page }) => {
        await page.goto(`/instructor/student-hub?courseId=${HUB_EMPTY_COURSE_ID}`);

        await expect(page.locator('#students-container')).toContainText(
            'No students found for this course yet.',
            { timeout: 15_000 }
        );
        await expect(page.locator('.student-card')).toHaveCount(0);
    });

    test('shows a pending TA invite instead of another promote action', async ({ page }) => {
        await seedStudentHub({ includePendingTA: true });

        await openStudentHub(page);

        const pendingCard = studentCard(page, HUB_PENDING_TA.displayName);
        await expect(pendingCard).toBeVisible();
        await expect(pendingCard.getByRole('button', { name: 'Pending TA joining course' })).toBeDisabled();
        await expect(pendingCard.getByRole('button', { name: 'Promote to TA' })).toHaveCount(0);
        await expect(pendingCard.getByRole('button', { name: 'Demote from TA' })).toHaveCount(0);
    });

    test('anonymize-students hides struggle topics but leaves the student card and actions visible', async ({ page }) => {
        await seedStudentHub({ anonymizeStudents: true });

        await openStudentHub(page);

        const activeCard = studentCard(page, HUB_ACTIVE_STUDENT.displayName);
        await expect(activeCard).toBeVisible();
        // The real checkbox is visually hidden behind the .toggle-switch/
        // .toggle-slider pill, so check the visible toggle control instead.
        await expect(activeCard.locator('.enroll-toggle .toggle-switch')).toBeVisible();
        await expect(activeCard).not.toContainText('Struggle Topics');
        await expect(activeCard).not.toContainText('Oxidative phosphorylation');
        await expect(activeCard.locator('.download-struggle-btn')).toHaveCount(0);
    });

    test('hides the anonymization-ID button from a non-admin instructor, and shows it for a system admin', async ({ page }) => {
        await setSystemAdmin(instructorId, false);

        await openStudentHub(page);
        await expect(page.locator('#open-pseudonym-manager')).toBeHidden();

        try {
            await setSystemAdmin(instructorId, true);
            await openStudentHub(page);
            await expect(page.locator('#open-pseudonym-manager')).toBeVisible();

            await page.locator('#open-pseudonym-manager').click();
            await expect(page.locator('#pseudonym-manager')).toBeVisible();
        } finally {
            await setSystemAdmin(instructorId, false);
        }
    });

    test('downloads a markdown struggle report for the selected student', async ({ page }) => {
        await openStudentHub(page);

        const activeCard = studentCard(page, HUB_ACTIVE_STUDENT.displayName);
        const [download] = await Promise.all([
            page.waitForEvent('download'),
            activeCard.getByRole('button', { name: 'Download Report' }).click(),
        ]);

        expect(download.suggestedFilename()).toMatch(/^Struggle_Report_Student_Hub_Ada_\d{4}-\d{2}-\d{2}\.md$/);
        const downloadPath = await download.path();
        expect(downloadPath).toBeTruthy();
        const report = await fs.readFile(downloadPath, 'utf8');
        expect(report).toContain('# Struggle Report: Student Hub Ada');
        expect(report).toContain('| Oxidative phosphorylation | 3 |');
        expect(report).toContain('| Enzyme kinetics | 1 |');
    });

    test('promoting a student to TA persists the invite and renders pending state after reload', async ({ page }) => {
        await openStudentHub(page, {
            courseId: HUB_COURSE_ID,
            storedCourseId: HUB_COURSE_ID,
        });

        page.on('dialog', (dialog) => dialog.accept().catch(() => {}));

        const activeCard = studentCard(page, HUB_ACTIVE_STUDENT.displayName);
        await activeCard.getByRole('button', { name: 'Promote to TA' }).click();

        await expect(page.locator('.notification.success')).toContainText(
            `Successfully promoted ${HUB_ACTIVE_STUDENT.displayName} to TA`,
            { timeout: 10_000 }
        );

        const user = await getHubUser(HUB_ACTIVE_STUDENT.userId);
        expect(user.role).toBe('ta');
        expect(user.invitedCourses || []).toContain(HUB_COURSE_ID);

        const reloadedCard = studentCard(page, HUB_ACTIVE_STUDENT.displayName);
        await expect(reloadedCard.getByRole('button', { name: 'Pending TA joining course' })).toBeDisabled({
            timeout: 10_000,
        });
    });

    test('enrollment toggle enables Save and persists the new enrollment state', async ({ page }) => {
        await openStudentHub(page);

        const activeCard = studentCard(page, HUB_ACTIVE_STUDENT.displayName);
        const checkbox = activeCard.locator('input[type="checkbox"]');
        const saveButton = activeCard.locator(`#save-${HUB_ACTIVE_STUDENT.userId}`);

        await expect(checkbox).toBeChecked();
        await expect(saveButton).toBeDisabled();

        // The real checkbox is zero-size and visually hidden behind the
        // .toggle-switch/.toggle-slider pill (same pattern used for every
        // other toggle in the app) - click the visible slider instead, same
        // as a real user would. The outer <label> wraps the single checkbox,
        // so the click still toggles it via native label/input association.
        await activeCard.locator('.enroll-toggle .toggle-slider').click();
        await expect(checkbox).not.toBeChecked();
        await expect(saveButton).toBeEnabled();
        await saveButton.click();

        await expect(page.locator('.notification.success')).toContainText(
            `Enrollment disabled for ${HUB_ACTIVE_STUDENT.userId}`,
            { timeout: 10_000 }
        );
        await expect(saveButton).toBeDisabled();

        const course = await getHubCourse();
        expect(course.studentEnrollment[HUB_ACTIVE_STUDENT.userId].enrolled).toBe(false);
    });

    test('escapes student display names instead of injecting markup', async ({ page }) => {
        await page.addInitScript(() => {
            (/** @type {Window & typeof globalThis & { __studentHubXss?: boolean }} */ (window)).__studentHubXss = false;
        });

        await openStudentHub(page);

        const xssCard = studentCard(page, HUB_XSS_STUDENT.displayName);
        await expect(xssCard).toBeVisible();
        await expect(page.locator('.student-card img[src="x"]')).toHaveCount(0);

        const injected = await page.evaluate(() =>
            (/** @type {Window & typeof globalThis & { __studentHubXss?: boolean }} */ (window)).__studentHubXss === true
        );
        expect(injected).toBe(false);
    });

    test('TAs assigned to the course are not shown in the Student Hub roster', async ({ page }) => {
        await openStudentHub(page, {
            courseId: HUB_COURSE_ID,
            storedCourseId: null,
        });

        // Student Hub shows students only - TA management lives in TA Hub.
        await expect(studentCard(page, HUB_ACTIVE_STUDENT.displayName)).toBeVisible();
        await expect(studentCard(page, TEST_USERS.ta.displayName)).toHaveCount(0);

        const course = await getHubCourse();
        expect(course.tas || []).toContain(taId);
    });
});

test.describe('Student Hub authorization for non-instructors', () => {
    test.beforeEach(async () => {
        await seedStudentHub();
    });

    test('student sessions cannot reach the page or call Student Hub APIs directly', async ({ browser, baseURL }) => {
        const context = await browser.newContext({ storageState: storageStatePath('student') });
        const page = await context.newPage();
        await page.goto(`/instructor/student-hub?courseId=${HUB_COURSE_ID}`);
        await page.waitForLoadState('domcontentloaded');
        expect(new URL(page.url()).pathname).toMatch(/^\/student\/?$/);
        await context.close();

        const api = await request.newContext({ baseURL, storageState: storageStatePath('student') });
        try {
            const listRes = await api.get(`/api/courses/${HUB_COURSE_ID}/students`, {
                failOnStatusCode: false,
            });
            expect(listRes.status()).toBe(403);

            const enrollmentRes = await api.put(
                `/api/courses/${HUB_COURSE_ID}/student-enrollment/${HUB_ACTIVE_STUDENT.userId}`,
                {
                    data: { enrolled: false },
                    failOnStatusCode: false,
                }
            );
            expect(enrollmentRes.status()).toBe(403);

            const promoteRes = await api.post('/api/auth/promote-to-ta', {
                data: { userId: HUB_ACTIVE_STUDENT.userId, courseId: HUB_COURSE_ID },
                failOnStatusCode: false,
            });
            expect(promoteRes.status()).toBe(403);
        } finally {
            await api.dispose();
        }
    });

    test('TA sessions cannot reach Student Hub routes or perform instructor-only mutations', async ({ browser, baseURL }) => {
        const taContext = await browser.newContext({ storageState: storageStatePath('ta') });
        const taPage = await taContext.newPage();
        await taPage.goto(`/instructor/student-hub?courseId=${HUB_COURSE_ID}`);
        await taPage.waitForLoadState('domcontentloaded');
        expect(new URL(taPage.url()).pathname).toMatch(/^\/ta\/?$/);

        await taPage.goto(`/instructor/student-hub.html?courseId=${HUB_COURSE_ID}`);
        await taPage.waitForLoadState('domcontentloaded');
        expect.soft(new URL(taPage.url()).pathname).toMatch(/^\/ta\/?$/);
        await taContext.close();

        const api = await request.newContext({ baseURL, storageState: storageStatePath('ta') });
        try {
            const enrollmentRes = await api.put(
                `/api/courses/${HUB_COURSE_ID}/student-enrollment/${HUB_ACTIVE_STUDENT.userId}`,
                {
                    data: { enrolled: false },
                    failOnStatusCode: false,
                }
            );
            expect(enrollmentRes.status()).toBe(403);

            const promoteRes = await api.post('/api/auth/promote-to-ta', {
                data: { userId: HUB_ACTIVE_STUDENT.userId, courseId: HUB_COURSE_ID },
                failOnStatusCode: false,
            });
            expect(promoteRes.status()).toBe(403);

            const demoteRes = await api.delete(`/api/courses/${HUB_COURSE_ID}/tas/${taId}`, {
                failOnStatusCode: false,
            });
            expect(demoteRes.status()).toBe(403);
        } finally {
            await api.dispose();
        }
    });
});

test.describe('Student Hub instructor API authorization and data isolation', () => {
    test.use({ storageState: storageStatePath('instructor') });

    test.beforeEach(async () => {
        await seedStudentHub();
    });

    test('instructor cannot list or update another instructor course through Student Hub APIs', async ({ request: api }) => {
        const listRes = await api.get(`/api/courses/${HUB_UNRELATED_COURSE_ID}/students`, {
            failOnStatusCode: false,
        });
        expect(listRes.status()).toBe(403);

        const enrollmentRes = await api.put(
            `/api/courses/${HUB_UNRELATED_COURSE_ID}/student-enrollment/${HUB_PROMOTE_TARGET.userId}`,
            {
                data: { enrolled: false },
                failOnStatusCode: false,
            }
        );
        expect(enrollmentRes.status()).toBe(403);

        const unrelatedCourse = await getHubCourse(HUB_UNRELATED_COURSE_ID);
        expect(unrelatedCourse.studentEnrollment[HUB_PROMOTE_TARGET.userId].enrolled).toBe(true);
    });

    test('student list API is scoped to the requested course', async ({ request: api }) => {
        const listRes = await api.get(`/api/courses/${HUB_COURSE_ID}/students`);
        expect(listRes.ok()).toBeTruthy();
        const body = await listRes.json();
        const listedIds = body.data.students.map((student) => student.userId);

        expect(listedIds).toContain(HUB_ACTIVE_STUDENT.userId);
        expect(listedIds).toContain(HUB_XSS_STUDENT.userId);
        expect(listedIds).not.toContain(HUB_OTHER_STUDENT.userId);
    });

    test('enrollment update rejects non-boolean values and leaves state unchanged', async ({ request: api }) => {
        const updateRes = await api.put(
            `/api/courses/${HUB_COURSE_ID}/student-enrollment/${HUB_ACTIVE_STUDENT.userId}`,
            {
                data: { enrolled: 'false' },
                failOnStatusCode: false,
            }
        );
        expect(updateRes.status()).toBe(400);

        const course = await getHubCourse();
        expect(course.studentEnrollment[HUB_ACTIVE_STUDENT.userId].enrolled).toBe(true);
    });

    test('promote-to-TA rejects course IDs the instructor does not own', async ({ request: api }) => {
        const promoteRes = await api.post('/api/auth/promote-to-ta', {
            data: {
                userId: HUB_PROMOTE_TARGET.userId,
                courseId: HUB_UNRELATED_COURSE_ID,
            },
            failOnStatusCode: false,
        });

        expect.soft(promoteRes.status()).toBe(403);

        const user = await getHubUser(HUB_PROMOTE_TARGET.userId);
        expect.soft(user.role).toBe('student');
        expect.soft(user.invitedCourses || []).not.toContain(HUB_UNRELATED_COURSE_ID);
    });

    test('student listing does not expose inactive user accounts enrolled in the course', async ({ request: api }) => {
        await seedStudentHub({ includeInactiveStudent: true });

        const listRes = await api.get(`/api/courses/${HUB_COURSE_ID}/students`);
        expect(listRes.ok()).toBeTruthy();
        const body = await listRes.json();
        const listedIds = body.data.students.map((student) => student.userId);

        expect(listedIds).toContain(HUB_ACTIVE_STUDENT.userId);
        expect(listedIds).not.toContain(HUB_INACTIVE_STUDENT.userId);
    });
});
