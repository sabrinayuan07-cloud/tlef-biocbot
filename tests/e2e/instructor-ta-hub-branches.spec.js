// @ts-check
const { test, expect } = require('./fixtures/monocart');
const { TEST_USERS, storageStatePath } = require('./helpers/users');
const {
    withDb,
    getUserIdByUsername,
    seedCourse,
    cleanupCourses,
    cleanupCoursesForUser,
} = require('./helpers/courses-test');

const instructorUser = TEST_USERS.instructor;
const taUser = TEST_USERS.ta;

const COURSE_ID = 'BIOC-E2E-TA-HUB-BRANCHES';
const COURSE_NAME = 'BIOC E2E TA Hub Branches';
const EMPTY_COURSE_ID = 'BIOC-E2E-TA-HUB-BRANCHES-EMPTY';
const EMPTY_COURSE_NAME = 'BIOC E2E TA Hub Branches Empty';
const COURSE_IDS = [COURSE_ID, EMPTY_COURSE_ID];

let instructorId;
let taId;

async function resetTAUser() {
    await withDb((db) =>
        db.collection('users').updateOne(
            { userId: taId },
            {
                $set: {
                    role: 'ta',
                    isActive: true,
                    displayName: taUser.displayName,
                    email: taUser.email,
                    updatedAt: new Date(),
                },
                $unset: { invitedCourses: '' },
            }
        )
    );
}

async function seedTAHubCourse({
    courseId = COURSE_ID,
    courseName = COURSE_NAME,
    tas = [taId],
    taPermissions = {},
    overrides = {},
} = {}) {
    return seedCourse({
        courseId,
        courseName,
        instructorId,
        tas,
        taPermissions,
        overrides,
    });
}

async function openTAHub(page, courseId = COURSE_ID) {
    await page.addInitScript(() => window.localStorage.removeItem('selectedCourseId'));
    await page.goto(`/instructor/ta-hub?courseId=${courseId}`);
}

test.describe('Instructor TA Hub branch coverage', () => {
    test.use({ storageState: storageStatePath('instructor') });

    test.beforeAll(async () => {
        instructorId = await getUserIdByUsername(instructorUser.username);
        taId = await getUserIdByUsername(taUser.username);
    });

    test.beforeEach(async () => {
        await cleanupCoursesForUser(instructorId);
        await resetTAUser();
    });

    test.afterAll(async () => {
        await cleanupCourses(COURSE_IDS);
        await resetTAUser();
    });

    test('updates TA permission toggles independently and persists each as a partial patch', async ({ page }) => {
        await seedTAHubCourse({
            taPermissions: {
                [taId]: {
                    materials: false,
                    questions: false,
                    flags: true,
                    roster: false,
                    transcripts: false,
                    settings: false,
                    updatedAt: new Date(),
                },
            },
        });

        await openTAHub(page);

        const card = page.locator('.ta-card', { hasText: taUser.displayName });
        await expect(card).toBeVisible({ timeout: 15_000 });

        const materialsPermission = card.locator(`#materials-permission-${taId}`);
        const flagsPermission = card.locator(`#flags-permission-${taId}`);
        await expect(materialsPermission).not.toBeChecked();
        await expect(flagsPermission).toBeChecked();

        await materialsPermission.click();
        await expect(materialsPermission).toBeChecked();
        const materialsSuccess = `Course Materials access enabled for ${taId}`;
        await expect(page.locator('.notification.success').filter({ hasText: materialsSuccess }))
            .toBeVisible();

        await flagsPermission.click();
        await expect(flagsPermission).not.toBeChecked();
        const flagsSuccess = `Flagged Content access disabled for ${taId}`;
        await expect(page.locator('.notification.success').filter({ hasText: flagsSuccess }))
            .toBeVisible();

        // Each toggle is written as a single-key partial patch (no read-merge-write),
        // but both changes still land on the stored document.
        const doc = await withDb((db) =>
            db.collection('courses').findOne({ courseId: COURSE_ID })
        );
        expect(doc.taPermissions[taId]).toMatchObject({
            materials: true,
            flags: false,
        });
    });

    test('shows the no-TA empty state for an instructor course without assistants', async ({ page }) => {
        await seedTAHubCourse({
            courseId: EMPTY_COURSE_ID,
            courseName: EMPTY_COURSE_NAME,
            tas: [],
        });

        await openTAHub(page, EMPTY_COURSE_ID);

        await expect(page.locator('.no-tas-message')).toContainText('No Teaching Assistants', {
            timeout: 15_000,
        });
        await expect(page.locator('.course-ta-item')).toContainText(EMPTY_COURSE_NAME);
        await expect(page.locator('.ta-card')).toHaveCount(0);
    });

    test('reverts the checkbox and reports the 400 permission update path', async ({ page }) => {
        await seedTAHubCourse({
            taPermissions: {
                [taId]: {
                    materials: true,
                    questions: true,
                    flags: true,
                    roster: true,
                    transcripts: true,
                    settings: true,
                    updatedAt: new Date(),
                },
            },
        });

        /** @type {unknown} */
        let putPayload;
        await page.route(`**/api/courses/${COURSE_ID}/ta-permissions/${taId}`, async (route) => {
            putPayload = route.request().postDataJSON();
            await route.fulfill({
                status: 400,
                contentType: 'application/json',
                body: JSON.stringify({
                    success: false,
                    message: "'flags' must be a boolean value",
                }),
            });
        });

        await openTAHub(page);

        const flagsPermission = page.locator(`#flags-permission-${taId}`);
        await expect(flagsPermission).toBeChecked({ timeout: 15_000 });

        await flagsPermission.click();

        // Partial patch: only the toggled key is sent, not the other five.
        expect(putPayload).toEqual({ flags: false });
        await expect(page.locator('.notification.error')).toContainText(
            'Error updating permission: HTTP error! status: 400'
        );
        await expect(flagsPermission).toBeChecked();
    });

    test('opens, dismisses, and confirms the TA-removal flow', async ({ page }) => {
        await seedTAHubCourse({ tas: [taId] });

        let deleteRequested = false;
        await page.route(`**/api/auth/tas/${taId}`, async (route) => {
            deleteRequested = true;
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    success: true,
                    message: 'TA removed from all courses successfully',
                    data: { taId, modifiedCount: 1 },
                }),
            });
        });

        await openTAHub(page);

        const card = page.locator('.ta-card', { hasText: taUser.displayName });
        await expect(card).toBeVisible({ timeout: 15_000 });

        await card.getByRole('button', { name: 'Remove' }).click();
        const modal = page.locator('#remove-ta-modal');
        await expect(modal).toHaveClass(/show/);
        await expect(modal.locator('.modal-body')).toContainText(
            `Are you sure you want to remove ${taUser.displayName} from all courses?`
        );

        await page.locator('#remove-ta-modal').evaluate((element) => {
            element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
        await expect(modal).not.toHaveClass(/show/);

        await card.getByRole('button', { name: 'Remove' }).click();
        await page.locator('#confirm-remove-ta').click();

        expect(deleteRequested).toBe(true);
        await expect(page.locator('.notification.success')).toContainText(
            'TA removed successfully!'
        );
        await expect(modal).not.toHaveClass(/show/);
    });

    test('falls back to the TA username when displayName is missing', async ({ page }) => {
        await withDb((db) =>
            db.collection('users').updateOne(
                { userId: taId },
                {
                    $unset: { displayName: '' },
                    $set: { role: 'ta', isActive: true, updatedAt: new Date() },
                }
            )
        );
        await seedTAHubCourse({ tas: [taId] });

        await openTAHub(page);

        const card = page.locator('.ta-card', { hasText: taUser.username });
        await expect(card).toBeVisible({ timeout: 15_000 });
        await expect(card.locator('.ta-name')).toHaveText(taUser.username);
    });
});
