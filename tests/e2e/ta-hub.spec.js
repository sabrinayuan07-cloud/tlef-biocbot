// @ts-check
require('dotenv').config();
const { MongoClient } = require('mongodb');
const { test, expect } = require('./fixtures/monocart');
const { TEST_USERS, loadCredentials } = require('./helpers/users');

const instructorUser = TEST_USERS.instructor;
const taUser = TEST_USERS.ta;

const COURSE_ID = 'BIOC-E2E-TA-HUB';
const COURSE_NAME = 'BIOC E2E TA Hub';
const OTHER_COURSE_ID = 'BIOC-E2E-TA-HUB-OTHER';
const OTHER_COURSE_NAME = 'BIOC E2E TA Hub Other';
const TEST_COURSE_ID_PATTERN = /^BIOC-E2E-TA/;

let credentials;

test.beforeAll(() => {
    credentials = loadCredentials();
    if (!credentials.instructor) {
        throw new Error('No credentials.instructor found. Global-setup should have generated it.');
    }
});

async function withDb(fn) {
    if (!process.env.MONGO_URI) {
        throw new Error('MONGO_URI not set; cannot run ta-hub.spec.js tests.');
    }
    const client = new MongoClient(process.env.MONGO_URI);
    await client.connect();
    try {
        return await fn(client.db());
    } finally {
        await client.close();
    }
}

async function getUserIdByUsername(username) {
    return withDb(async (db) => {
        const user = await db.collection('users').findOne({ username });
        if (!user) throw new Error(`User ${username} not found in DB.`);
        return user.userId;
    });
}

function buildCourseDoc({
    courseId,
    courseName,
    instructorId,
    tas = [],
    taPermissions = null,
}) {
    const now = new Date();
    const doc = {
        courseId,
        courseName,
        courseCode: `${courseId}-S`,
        instructorCourseCode: `${courseId}-I`,
        instructorId,
        instructors: [instructorId],
        tas,
        courseDescription: '',
        assessmentCriteria: '',
        courseMaterials: [],
        approvedStruggleTopics: [],
        courseStructure: { weeks: 1, lecturesPerWeek: 1, totalUnits: 1 },
        isOnboardingComplete: true,
        status: 'active',
        lectures: [
            {
                name: 'Unit 1',
                isPublished: false,
                learningObjectives: ['Sample objective'],
                passThreshold: 0,
                createdAt: now,
                updatedAt: now,
                documents: [],
                assessmentQuestions: [],
            },
        ],
        createdAt: now,
        updatedAt: now,
    };
    if (taPermissions) {
        doc.taPermissions = taPermissions;
    }
    return doc;
}

async function resetTAUserState(db, taId) {
    await db.collection('users').updateOne(
        { userId: taId },
        {
            $set: {
                role: 'ta',
                isActive: true,
                invitedCourses: [],
                updatedAt: new Date(),
            },
        }
    );
}

async function seedTAHubCourses(courses) {
    const instructorId = await getUserIdByUsername(instructorUser.username);
    const taId = await getUserIdByUsername(taUser.username);

    await withDb(async (db) => {
        await resetTAUserState(db, taId);
        await db.collection('courses').deleteMany({
            courseId: TEST_COURSE_ID_PATTERN,
        });
        await db.collection('courses').insertMany(
            courses.map((course) =>
                buildCourseDoc({
                    instructorId,
                    ...course,
                })
            )
        );
    });

    return { instructorId, taId };
}

async function loginAsInstructor(page) {
    await page.goto('/login');
    await page.locator('#auth-form input#username').fill(instructorUser.username);
    await page.locator('#auth-form input#password').fill(credentials.instructor);
    await page.locator('#auth-form button#login-btn').click();
    await page.waitForURL((url) => url.pathname !== '/' && url.pathname !== '/login', {
        timeout: 10_000,
    });
}

test.describe('Instructor TA Hub UI', () => {
    test('renders assigned TAs, course assignments, and stored permissions from seeded courses', async ({ page }) => {
        const taId = await getUserIdByUsername(taUser.username);
        await seedTAHubCourses([
            {
                courseId: COURSE_ID,
                courseName: COURSE_NAME,
                tas: [taId],
                taPermissions: {
                    [taId]: {
                        materials: true,
                        questions: false,
                        flags: false,
                        roster: false,
                        transcripts: false,
                        settings: false,
                        updatedAt: new Date(),
                    },
                },
            },
            {
                courseId: OTHER_COURSE_ID,
                courseName: OTHER_COURSE_NAME,
                tas: [],
            },
        ]);

        await loginAsInstructor(page);
        await page.goto('/instructor/ta-hub');

        const card = page.locator('.ta-card', { hasText: taUser.displayName });
        await expect(card).toBeVisible({ timeout: 15_000 });
        await expect(card).toContainText(`Username: ${taUser.username}`);
        await expect(card).toContainText(`Email: ${taUser.email}`);
        await expect(card).toContainText(`Course: ${COURSE_NAME}`);
        await expect(card.locator(`#materials-permission-${taId}`)).toBeChecked();
        await expect(card.locator(`#flags-permission-${taId}`)).not.toBeChecked();
        // 6 checkboxes, one per permission.
        await expect(card.locator('.permission-toggle input[type="checkbox"]')).toHaveCount(6);

        const assignedCourse = page.locator('.course-ta-item', { hasText: new RegExp(`Course ID:\\s*${COURSE_ID}\\s*$`) });
        await expect(assignedCourse).toContainText(COURSE_NAME);
        const unassignedCourse = page.locator('.course-ta-item', { hasText: new RegExp(`Course ID:\\s*${OTHER_COURSE_ID}\\s*$`) });
        await expect(unassignedCourse).toContainText(OTHER_COURSE_NAME);
    });

    test('scopes the TA list by saved course and lets the URL-selected course take precedence', async ({ page }) => {
        const taId = await getUserIdByUsername(taUser.username);
        await seedTAHubCourses([
            {
                courseId: COURSE_ID,
                courseName: COURSE_NAME,
                tas: [taId],
                taPermissions: {
                    [taId]: {
                        materials: true,
                        questions: false,
                        flags: false,
                        roster: false,
                        transcripts: false,
                        settings: false,
                        updatedAt: new Date(),
                    },
                },
            },
            {
                courseId: OTHER_COURSE_ID,
                courseName: OTHER_COURSE_NAME,
                tas: [taId],
                taPermissions: {
                    [taId]: {
                        materials: false,
                        questions: false,
                        flags: true,
                        roster: true,
                        transcripts: false,
                        settings: false,
                        updatedAt: new Date(),
                    },
                },
            },
        ]);

        await loginAsInstructor(page);
        await page.evaluate((courseId) => localStorage.setItem('selectedCourseId', courseId), OTHER_COURSE_ID);
        await page.goto('/instructor/ta-hub');

        const savedCourseCard = page.locator('.ta-card', { hasText: taUser.displayName });
        await expect(savedCourseCard).toContainText(`Course: ${OTHER_COURSE_NAME}`, { timeout: 15_000 });
        await expect(savedCourseCard.locator(`#materials-permission-${taId}`)).not.toBeChecked();
        await expect(savedCourseCard.locator(`#flags-permission-${taId}`)).toBeChecked();

        await page.goto(`/instructor/ta-hub?courseId=${COURSE_ID}`);
        const urlCourseCard = page.locator('.ta-card', { hasText: taUser.displayName });
        await expect(urlCourseCard).toContainText(`Course: ${COURSE_NAME}`, { timeout: 15_000 });
        await expect(urlCourseCard.locator(`#materials-permission-${taId}`)).toBeChecked();
        await expect(urlCourseCard.locator(`#flags-permission-${taId}`)).not.toBeChecked();
    });

    test('ignores stale selected course storage and still shows assigned TAs', async ({ page }) => {
        const taId = await getUserIdByUsername(taUser.username);
        await seedTAHubCourses([
            {
                courseId: COURSE_ID,
                courseName: COURSE_NAME,
                tas: [taId],
            },
        ]);

        await loginAsInstructor(page);
        await page.evaluate(() => localStorage.setItem('selectedCourseId', 'not-a-real-course'));
        await page.goto('/instructor/ta-hub');

        const card = page.locator('.ta-card', { hasText: taUser.displayName });
        await expect(card).toContainText(`Course: ${COURSE_NAME}`, { timeout: 15_000 });
        await expect(page.locator('.no-tas-message')).toHaveCount(0);
    });

    test('shows a visible error when TA loading fails', async ({ page }) => {
        const taId = await getUserIdByUsername(taUser.username);
        await seedTAHubCourses([
            {
                courseId: COURSE_ID,
                courseName: COURSE_NAME,
                tas: [taId],
            },
        ]);

        await loginAsInstructor(page);
        await page.route('**/api/auth/tas', async (route) => {
            await route.fulfill({
                status: 500,
                contentType: 'application/json',
                body: JSON.stringify({ success: false, message: 'TA lookup failed' }),
            });
        });
        await page.goto('/instructor/ta-hub');

        await expect(page.locator('.notification.error')).toContainText('Error loading TAs. Please try again.', {
            timeout: 15_000,
        });
    });

    test('reverts a permission checkbox and reports an error when the permission update fails', async ({ page }) => {
        const taId = await getUserIdByUsername(taUser.username);
        await seedTAHubCourses([
            {
                courseId: COURSE_ID,
                courseName: COURSE_NAME,
                tas: [taId],
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
            },
        ]);

        await loginAsInstructor(page);
        await page.route(`**/api/courses/${COURSE_ID}/ta-permissions/${taId}`, async (route) => {
            await route.fulfill({
                status: 500,
                contentType: 'application/json',
                body: JSON.stringify({ success: false, message: 'Permission update failed' }),
            });
        });
        await page.goto('/instructor/ta-hub');

        const materialsPermission = page.locator(`#materials-permission-${taId}`);
        await expect(materialsPermission).toBeChecked({ timeout: 15_000 });
        await materialsPermission.click();

        await expect(page.locator('.notification.error')).toContainText('Error updating permission: HTTP error! status: 500');
        await expect(materialsPermission).toBeChecked();
    });

    test('toggling checkboxes grants permissions independently and names the TA in the notification', async ({ page }) => {
        const taId = await getUserIdByUsername(taUser.username);
        await seedTAHubCourses([
            {
                courseId: COURSE_ID,
                courseName: COURSE_NAME,
                tas: [taId],
                // No explicit permissions - starts fail-closed/all-denied.
            },
        ]);

        await loginAsInstructor(page);
        await page.goto('/instructor/ta-hub');

        const card = page.locator('.ta-card', { hasText: taUser.displayName });
        await expect(card).toBeVisible({ timeout: 15_000 });
        await expect(card.locator(`#materials-permission-${taId}`)).not.toBeChecked();
        await expect(card.locator(`#flags-permission-${taId}`)).not.toBeChecked();

        await card.locator(`#materials-permission-${taId}`).check();
        await expect(page.locator('.notification.success')).toContainText(
            `Course Materials access enabled for TA: ${taUser.displayName}`,
            { timeout: 15_000 }
        );
        await expect(card.locator(`#materials-permission-${taId}`)).toBeChecked();

        await card.locator(`#flags-permission-${taId}`).check();
        await expect(page.locator('.notification.success').last()).toContainText(
            `Flagged Content access enabled for TA: ${taUser.displayName}`,
            { timeout: 15_000 }
        );
        await expect(card.locator(`#flags-permission-${taId}`)).toBeChecked();

        await card.locator(`#materials-permission-${taId}`).uncheck();
        await expect(page.locator('.notification.success').last()).toContainText(
            `Course Materials access disabled for TA: ${taUser.displayName}`,
            { timeout: 15_000 }
        );
        await expect(card.locator(`#materials-permission-${taId}`)).not.toBeChecked();
    });
});
