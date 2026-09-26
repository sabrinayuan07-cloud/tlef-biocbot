// @ts-check
require('dotenv').config();
const path = require('path');
const { MongoClient } = require('mongodb');
const { test, expect, request } = require('./fixtures/monocart');
const { TEST_USERS, loadCredentials } = require('./helpers/users');

const user = TEST_USERS.ta;
const instructorUser = TEST_USERS.instructor;
const studentUser = TEST_USERS.student;
const COURSE_ID = 'BIOC-E2E-TA';
const COURSE_NAME = 'BIOC E2E TA Test';
const OTHER_COURSE_ID = 'BIOC-E2E-TA-OTHER';
const OTHER_COURSE_NAME = 'BIOC E2E TA Test (Unassigned)';
const TA_JOIN_COURSE_ID = 'BIOC-E2E-TA-JOIN';
const TA_JOIN_COURSE_NAME = 'BIOC E2E TA Join Test';
const TA_JOIN_COURSE_CODE = 'TAJOIN';
const TA_INVITED_COURSE_ID = 'BIOC-E2E-TA-INVITED';
const TA_INVITED_COURSE_NAME = 'BIOC E2E TA Invited Test';
const TA_INVITED_COURSE_CODE = 'TAINVITE';
const TEST_COURSE_IDS = [COURSE_ID, OTHER_COURSE_ID, TA_JOIN_COURSE_ID, TA_INVITED_COURSE_ID];
const LECTURE_FIXTURE = path.join(__dirname, 'fixtures', 'sample-lecture.txt');
const TA_UPDATE_QUESTION_ID = 'e2e-ta-update-question';
const TA_DELETE_QUESTION_ID = 'e2e-ta-delete-question';
const TA_SEEDED_DOCUMENT_ID = 'e2e-ta-seeded-document';

let password;

test.beforeAll(() => {
    password = loadCredentials().ta;
    if (!password) {
        throw new Error('No credentials.ta found. Global-setup should have generated it.');
    }
});

async function withDb(fn) {
    if (!process.env.MONGO_URI) {
        throw new Error('MONGO_URI not set; cannot run ta.spec.js tests.');
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
        const u = await db.collection('users').findOne({ username });
        if (!u) throw new Error(`User ${username} not found in DB.`);
        return u.userId;
    });
}

/**
 * @param {{
 *   courseId: string,
 *   courseName: string,
 *   instructorId: string,
 *   tas?: string[],
 *   taPermissions?: Record<string, { materials?: boolean, questions?: boolean, flags?: boolean, roster?: boolean, transcripts?: boolean, settings?: boolean, updatedAt: Date }> | null,
 *   courseCode?: string,
 *   status?: string,
 *   approvedStruggleTopics?: Array<string|Record<string, any>>,
 *   assessmentQuestions?: Array<Record<string, any>>,
 *   now?: Date,
 * }} args
 */
function buildCourseDoc({
    courseId,
    courseName,
    instructorId,
    tas = [],
    taPermissions = null,
    courseCode = `${courseId}-S`,
    status = 'active',
    approvedStruggleTopics = [],
    assessmentQuestions = [],
    now = new Date(),
}) {
    /** @type {Record<string, any>} */
    const doc = {
        courseId,
        courseName,
        courseCode,
        instructorCourseCode: `${courseId}-I`,
        instructorId,
        instructors: [instructorId],
        tas,
        courseDescription: '',
        assessmentCriteria: '',
        courseMaterials: [],
        approvedStruggleTopics,
        courseStructure: { weeks: 1, lecturesPerWeek: 1, totalUnits: 1 },
        isOnboardingComplete: true,
        status,
        lectures: [
            {
                name: 'Unit 1',
                isPublished: false,
                learningObjectives: ['Sample objective'],
                passThreshold: 0,
                createdAt: now,
                updatedAt: now,
                documents: [],
                assessmentQuestions,
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
    await db.collection('courses').updateMany(
        { tas: taId },
        {
            $pull: { tas: taId },
            $unset: { [`taPermissions.${taId}`]: '' },
            $set: { updatedAt: new Date() },
        }
    );

    await db.collection('users').updateOne(
        { userId: taId },
        {
            $set: {
                role: 'ta',
                isActive: true,
                invitedCourses: [],
                updatedAt: new Date(),
            },
            $unset: {
                'preferences.courseId': '',
            },
        }
    );
}

async function seedCourseWithTA(overrides = {}) {
    const instructorId = await getUserIdByUsername(instructorUser.username);
    const taId = await getUserIdByUsername(user.username);
    await withDb(async (db) => {
        await resetTAUserState(db, taId);
        await db.collection('courses').deleteMany({
            courseId: { $in: TEST_COURSE_IDS },
        });
        await db.collection('flaggedQuestions').deleteMany({
            courseId: { $in: TEST_COURSE_IDS },
        });
        await db.collection('documents').deleteMany({
            courseId: { $in: TEST_COURSE_IDS },
        });
        await db.collection('courses').insertOne(
            buildCourseDoc({
                courseId: COURSE_ID,
                courseName: COURSE_NAME,
                instructorId,
                tas: [taId],
                taPermissions: overrides.taPermissions || null,
                status: overrides.status || 'active',
                approvedStruggleTopics: overrides.approvedStruggleTopics || [],
                assessmentQuestions: overrides.assessmentQuestions || [],
            })
        );
    });
}

async function seedNoCoursesForTA() {
    const taId = await getUserIdByUsername(user.username);

    await withDb(async (db) => {
        await resetTAUserState(db, taId);
        await db.collection('courses').deleteMany({
            courseId: { $in: TEST_COURSE_IDS },
        });
        await db.collection('flaggedQuestions').deleteMany({
            courseId: { $in: TEST_COURSE_IDS },
        });
        await db.collection('documents').deleteMany({
            courseId: { $in: TEST_COURSE_IDS },
        });
    });
}

async function seedTwoCourses() {
    const instructorId = await getUserIdByUsername(instructorUser.username);
    const taId = await getUserIdByUsername(user.username);
    await withDb(async (db) => {
        await resetTAUserState(db, taId);
        await db.collection('courses').deleteMany({
            courseId: { $in: TEST_COURSE_IDS },
        });
        await db.collection('flaggedQuestions').deleteMany({
            courseId: { $in: TEST_COURSE_IDS },
        });
        await db.collection('documents').deleteMany({
            courseId: { $in: TEST_COURSE_IDS },
        });
        await db.collection('courses').insertMany([
            buildCourseDoc({
                courseId: COURSE_ID,
                courseName: COURSE_NAME,
                instructorId,
                tas: [taId],
            }),
            buildCourseDoc({
                courseId: OTHER_COURSE_ID,
                courseName: OTHER_COURSE_NAME,
                instructorId,
                tas: [],
            }),
        ]);
    });
}

async function seedTwoAssignedCoursesWithDifferentPermissions() {
    const instructorId = await getUserIdByUsername(instructorUser.username);
    const taId = await getUserIdByUsername(user.username);
    const now = new Date();

    await withDb(async (db) => {
        await resetTAUserState(db, taId);
        await db.collection('courses').deleteMany({
            courseId: { $in: TEST_COURSE_IDS },
        });
        await db.collection('flaggedQuestions').deleteMany({
            courseId: { $in: TEST_COURSE_IDS },
        });
        await db.collection('documents').deleteMany({
            courseId: { $in: TEST_COURSE_IDS },
        });
        await db.collection('courses').insertMany([
            buildCourseDoc({
                courseId: COURSE_ID,
                courseName: COURSE_NAME,
                instructorId,
                tas: [taId],
                taPermissions: {
                    [taId]: {
                        materials: true, questions: true, settings: true, transcripts: true,
                        flags: false, roster: false,
                        updatedAt: now,
                    },
                },
                now,
            }),
            buildCourseDoc({
                courseId: OTHER_COURSE_ID,
                courseName: OTHER_COURSE_NAME,
                instructorId,
                tas: [taId],
                taPermissions: {
                    [taId]: {
                        materials: false, questions: false, settings: false, transcripts: false,
                        flags: true, roster: true,
                        updatedAt: now,
                    },
                },
                now,
            }),
        ]);
    });
}

async function seedJoinableCourseForTA() {
    const instructorId = await getUserIdByUsername(instructorUser.username);
    const taId = await getUserIdByUsername(user.username);

    await withDb(async (db) => {
        await resetTAUserState(db, taId);
        await db.collection('courses').deleteMany({
            courseId: { $in: TEST_COURSE_IDS },
        });
        await db.collection('flaggedQuestions').deleteMany({
            courseId: { $in: TEST_COURSE_IDS },
        });
        await db.collection('documents').deleteMany({
            courseId: { $in: TEST_COURSE_IDS },
        });
        await db.collection('courses').insertOne(
            buildCourseDoc({
                courseId: TA_JOIN_COURSE_ID,
                courseName: TA_JOIN_COURSE_NAME,
                courseCode: TA_JOIN_COURSE_CODE,
                instructorId,
                tas: [],
            })
        );
    });
}

async function seedInvitedCourseForTA() {
    const instructorId = await getUserIdByUsername(instructorUser.username);
    const taId = await getUserIdByUsername(user.username);

    await withDb(async (db) => {
        await resetTAUserState(db, taId);
        await db.collection('courses').deleteMany({
            courseId: { $in: TEST_COURSE_IDS },
        });
        await db.collection('flaggedQuestions').deleteMany({
            courseId: { $in: TEST_COURSE_IDS },
        });
        await db.collection('documents').deleteMany({
            courseId: { $in: TEST_COURSE_IDS },
        });
        await db.collection('users').updateOne(
            { userId: taId },
            {
                $set: {
                    role: 'ta',
                    isActive: true,
                    invitedCourses: [TA_INVITED_COURSE_ID],
                    updatedAt: new Date(),
                },
            }
        );
        await db.collection('courses').insertOne(
            buildCourseDoc({
                courseId: TA_INVITED_COURSE_ID,
                courseName: TA_INVITED_COURSE_NAME,
                courseCode: TA_INVITED_COURSE_CODE,
                instructorId,
                tas: [],
            })
        );
    });
}

async function seedFlaggedQuestion(courseId = COURSE_ID, options = {}) {
    const studentId = await getUserIdByUsername(studentUser.username);
    const flagId = options.flagId || `e2e-ta-flag-${Date.now()}`;

    await withDb(async (db) => {
        if (options.cleanupExisting !== false) {
            await db.collection('flaggedQuestions').deleteMany({
                courseId,
                flagId: /^e2e-ta-flag-/,
            });
        }
        await db.collection('flaggedQuestions').insertOne({
            flagId,
            questionId: 'e2e-ta-question',
            courseId,
            unitName: 'Unit 1',
            studentId,
            studentName: studentUser.displayName,
            flagReason: 'unclear',
            flagDescription: 'TA seeded flag for Playwright review',
            botMode: 'tutor',
            flagStatus: 'pending',
            priority: 'medium',
            questionContent: {
                question: 'What does this enzyme do?',
                questionType: 'short-answer',
                explanation: 'Seeded e2e flag content',
            },
            createdAt: new Date(),
            updatedAt: new Date(),
        });
    });

    return flagId;
}

async function seedDocumentInCourse(courseId = COURSE_ID) {
    const instructorId = await getUserIdByUsername(instructorUser.username);
    const now = new Date();
    const document = {
        documentId: TA_SEEDED_DOCUMENT_ID,
        courseId,
        lectureName: 'Unit 1',
        documentType: 'lecture-notes',
        type: 'lecture_notes',
        instructorId,
        contentType: 'text',
        filename: 'Seeded TA Protected Document.txt',
        originalName: 'Seeded TA Protected Document',
        content: 'Seeded content that a denied TA must not delete.',
        mimeType: 'text/plain',
        size: 47,
        status: 'uploaded',
        metadata: {
            description: 'Seeded document for TA delete authorization coverage',
            tags: [],
            learningObjectives: [],
        },
        uploadDate: now,
        lastModified: now,
    };

    await withDb(async (db) => {
        await db.collection('documents').deleteMany({ documentId: TA_SEEDED_DOCUMENT_ID });
        await db.collection('courses').updateOne(
            { courseId, 'lectures.name': 'Unit 1' },
            {
                $pull: {
                    'lectures.$.documents': { documentId: TA_SEEDED_DOCUMENT_ID },
                },
            }
        );
        await db.collection('documents').insertOne(document);
        await db.collection('courses').updateOne(
            { courseId, 'lectures.name': 'Unit 1' },
            {
                $push: {
                    'lectures.$.documents': {
                        documentId: TA_SEEDED_DOCUMENT_ID,
                        documentType: document.documentType,
                        filename: document.filename,
                        originalName: document.originalName,
                        mimeType: document.mimeType,
                        size: document.size,
                        status: document.status,
                        metadata: document.metadata,
                    },
                },
                $set: { updatedAt: now },
            }
        );
    });

    return TA_SEEDED_DOCUMENT_ID;
}

async function loginViaUI(page) {
    await page.goto('/login');
    await page.locator('#auth-form input#username').fill(user.username);
    await page.locator('#auth-form input#password').fill(password);
    await page.locator('#auth-form button#login-btn').click();
    await page.waitForURL((url) => url.pathname !== '/' && url.pathname !== '/login', {
        timeout: 10_000,
    });
}

async function loginViaAPI(baseURL) {
    const apiCtx = await request.newContext({ baseURL });
    const loginRes = await apiCtx.post('/api/auth/login', {
        data: { username: user.username, password },
    });
    expect(loginRes.ok()).toBeTruthy();
    return apiCtx;
}

test.describe('TA authentication and course access', () => {
    test.beforeEach(async () => {
        // This block tests baseline TA functionality (sign-in, dashboard,
        // document upload), not permission denial - grant full access so a
        // brand-new TA's fail-closed default doesn't block it. Permission
        // *denial* is covered by the dedicated 'TA permission gating' and
        // 'TA direct API authorization' describe blocks below.
        const taId = await getUserIdByUsername(user.username);
        await seedCourseWithTA({
            taPermissions: {
                [taId]: {
                    materials: true, questions: true, flags: true, roster: true,
                    transcripts: true, settings: true,
                    updatedAt: new Date(),
                },
            },
        });
    });

    test('TA can sign in via the UI and lands on /ta', async ({ page }) => {
        await page.goto('/login');
        await page.locator('#auth-form input#username').fill(user.username);
        await page.locator('#auth-form input#password').fill(password);
        await page.locator('#auth-form button#login-btn').click();

        await page.waitForURL((url) => !url.pathname.match(/^\/?$/) && url.pathname !== '/login', {
            timeout: 10_000,
        });

        expect(page.url()).toContain(user.landingPath);
        await expect(page.locator('h1', { hasText: 'TA Dashboard' })).toBeVisible();
    });

    test('TA dashboard renders assigned course in picker and summary', async ({ page }) => {
        await loginViaUI(page);
        await page.goto('/ta');

        // The course picker only appears once courses load
        const pickerSection = page.locator('#ta-course-picker-section');
        await expect(pickerSection).toBeVisible({ timeout: 15_000 });

        // Assigned course appears in dropdown
        const courseSelect = page.locator('#ta-course-select');
        await expect(courseSelect.locator(`option[value="${COURSE_ID}"]`)).toHaveCount(1);

        // Selected-course summary reflects the seeded course
        await expect(page.locator('#selected-course-name')).toHaveText(COURSE_NAME, { timeout: 10_000 });
        await expect(page.locator('#selected-course-id')).toHaveText(COURSE_ID);

        // Course card is rendered in the courses container with assigned permissions
        const card = page.locator(`.course-card[data-course-id="${COURSE_ID}"]`);
        await expect(card).toBeVisible();
        await expect(card).toContainText('Role: Full TA');
    });

    test('TA can upload a course document to an assigned course', async ({ page }) => {
        await loginViaUI(page);

        // Mock the upload + topic extraction to avoid real LLM/vector work
        let uploadCalls = 0;
        await page.route('**/api/documents/upload', async (route) => {
            uploadCalls += 1;
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    success: true,
                    data: { documentId: `e2e-ta-mocked-upload-${uploadCalls}` },
                }),
            });
        });
        await page.route('**/api/courses/*/extract-topics', async (route) => {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    success: true,
                    data: { topics: ['E2E TA Mock Topic'] },
                }),
            });
        });

        await page.goto(`/instructor/documents?courseId=${COURSE_ID}`);
        await expect(page.locator('#course-title')).toHaveText(COURSE_NAME, { timeout: 15_000 });

        const unitContainer = page.locator('#dynamic-units-container');
        await expect(unitContainer).toContainText('Unit 1');

        // The upload buttons live inside collapsed unit sections, so trigger the
        // page's global openUploadModal directly (same handler the buttons use)
        const firstUploadBtn = unitContainer.locator('button.action-button.upload').first();
        await expect(firstUploadBtn).toBeAttached({ timeout: 15_000 });
        await page.evaluate(() => /** @type {any} */ (window).openUploadModal('Unit 1', 'lecture-notes'));

        await expect(page.locator('#upload-modal')).toBeVisible();
        await page.locator('#file-input').setInputFiles(LECTURE_FIXTURE);
        await page.locator('#upload-btn').click();

        // Mocked extraction surfaces the topic review section
        await expect(page.locator('#topic-review-section')).toBeVisible({ timeout: 15_000 });
        expect(uploadCalls).toBeGreaterThanOrEqual(1);
    });
});

test.describe('TA is blocked from student & instructor-only routes', () => {
    test('TA visiting /student is redirected to /ta', async ({ page }) => {
        await loginViaUI(page);

        const response = await page.goto('/student');
        // Either the server 302s to /ta, or the final URL is /ta
        expect(page.url()).toContain('/ta');
        if (response) {
            expect(response.url()).toContain('/ta');
        }
    });

    test('TA visiting /student/quiz is redirected to /ta', async ({ page }) => {
        await loginViaUI(page);

        await page.goto('/student/quiz');
        expect(page.url()).toContain('/ta');
        expect(page.url()).not.toContain('/student');
    });

    test('TA visiting /instructor/onboarding is redirected to /ta', async ({ page }) => {
        await loginViaUI(page);

        await page.goto('/instructor/onboarding');
        expect(page.url()).toContain('/ta');
        expect(page.url()).not.toContain('/instructor/onboarding');
    });
});

test.describe('TA permission gating', () => {
    test('TA with materials=false loads /instructor/documents but the materials sections stay hidden', async ({ page, baseURL }) => {
        // /instructor/documents is no longer gated on a single permission: it
        // now hosts materials, questions, and settings sections that are
        // independently toggleable, so a TA who only has e.g. 'questions'
        // still needs to reach the page. Section-level hiding (verified here)
        // is what keeps the UI from offering actions the server would reject,
        // and the underlying API calls remain permission-scoped regardless.
        const taId = await getUserIdByUsername(user.username);
        await seedCourseWithTA({
            taPermissions: {
                [taId]: {
                    materials: false, questions: true, flags: false, roster: false,
                    transcripts: false, settings: false,
                    updatedAt: new Date(),
                },
            },
        });

        await loginViaUI(page);

        const response = await page.goto(`/instructor/documents?courseId=${COURSE_ID}`);
        if (!response) throw new Error('Expected a navigation response for /instructor/documents');
        expect(response.status()).toBe(200);

        const firstUnit = page.locator('.accordion-item').first();
        await expect(firstUnit).toBeVisible({ timeout: 15_000 });
        await firstUnit.locator('.accordion-header').click();
        await expect(firstUnit.locator('.course-materials-section').first()).toBeHidden();
        await expect(firstUnit.locator('.learning-objectives-section').first()).toBeHidden();
        await expect(firstUnit.locator('.assessment-questions-section').first()).toBeVisible();

        // Independently verify via the permissions API (source of truth for the gate)
        const apiCtx = await request.newContext({ baseURL });
        await apiCtx.post('/api/auth/login', {
            data: { username: user.username, password },
        });
        const permRes = await apiCtx.get(`/api/courses/${COURSE_ID}/ta-permissions/${taId}`);
        expect(permRes.ok()).toBeTruthy();
        const permBody = await permRes.json();
        expect(permBody.success).toBe(true);
        expect(permBody.data.permissions.materials).toBe(false);
        // A materials-gated write is still rejected server-side, even though the section is just hidden client-side.
        const uploadRes = await apiCtx.post(`/api/documents/text`, {
            data: {
                courseId: COURSE_ID, instructorId: taId, lectureName: 'Unit 1',
                documentType: 'lecture-notes', title: 'x', content: 'x',
            },
            failOnStatusCode: false,
        });
        expect(uploadRes.status()).toBe(403);
        await apiCtx.dispose();
    });

    test('TA with flags=false is hidden from and denied flagged-content access', async ({ page, baseURL }) => {
        const taId = await getUserIdByUsername(user.username);
        await seedCourseWithTA({
            taPermissions: {
                [taId]: {
                    materials: true, questions: true, settings: true, transcripts: true,
                    flags: false, roster: false,
                    updatedAt: new Date(),
                },
            },
        });

        await loginViaUI(page);
        await page.goto('/ta');

        await expect(page.locator('#my-courses-link')).toBeVisible({ timeout: 15_000 });
        await expect(page.locator('#student-support-link')).toBeHidden();
        await expect(page.locator('#quick-courses-link')).toBeVisible();
        await expect(page.locator('#quick-support-link')).toBeHidden();

        // Denial on this HTML page route redirects a TA to /ta (a friendly
        // page, not raw JSON in the browser) rather than returning 403 -
        // page.goto()'s response reflects the followed redirect's 200, so
        // assert the final URL instead of the response status.
        await page.goto(`/instructor/flagged?courseId=${COURSE_ID}`);
        await expect(page).toHaveURL(/\/ta\/?$/);

        const apiCtx = await request.newContext({ baseURL });
        await apiCtx.post('/api/auth/login', {
            data: { username: user.username, password },
        });

        const studentsRes = await apiCtx.get(`/api/courses/${COURSE_ID}/students`, {
            failOnStatusCode: false,
        });
        expect(studentsRes.status()).toBe(403);

        // Desired behavior: direct flag APIs should be course/permission scoped too,
        // not just hidden behind the flagged-content page route.
        const flagsRes = await apiCtx.get(`/api/flags/course/${COURSE_ID}`, {
            failOnStatusCode: false,
        });
        expect(flagsRes.status()).toBe(403);

        await apiCtx.dispose();
    });

    test('TA dashboard updates visible actions when switching selected courses', async ({ page }) => {
        await seedTwoAssignedCoursesWithDifferentPermissions();
        await loginViaUI(page);

        await page.goto(`/ta?courseId=${COURSE_ID}`);
        await expect(page.locator('#selected-course-id')).toHaveText(COURSE_ID, { timeout: 15_000 });
        await expect(page.locator('#my-courses-link')).toBeVisible();
        await expect(page.locator('#student-support-link')).toBeHidden();
        await expect(page.locator('#quick-courses-link')).toBeVisible();
        await expect(page.locator('#quick-support-link')).toBeHidden();

        await page.locator('#ta-course-select').selectOption(OTHER_COURSE_ID);
        await expect(page.locator('#selected-course-id')).toHaveText(OTHER_COURSE_ID, { timeout: 10_000 });
        await expect(page.locator('#my-courses-link')).toBeHidden();
        await expect(page.locator('#student-support-link')).toBeVisible();
        await expect(page.locator('#quick-courses-link')).toBeHidden();
        await expect(page.locator('#quick-support-link')).toBeVisible();

        const selectedCourseId = await page.evaluate(() => localStorage.getItem('selectedCourseId'));
        expect(selectedCourseId).toBe(OTHER_COURSE_ID);

        await page.locator('#quick-support-link').click();
        await page.waitForURL((url) =>
            url.pathname === '/instructor/flagged' &&
            url.searchParams.get('courseId') === OTHER_COURSE_ID,
            { timeout: 10_000 }
        );
    });

    test('TA with flag permission can review and dismiss a seeded flag', async ({ page }) => {
        const taId = await getUserIdByUsername(user.username);
        await seedCourseWithTA({
            taPermissions: {
                [taId]: {
                    materials: false, questions: false, settings: false, transcripts: false,
                    flags: true, roster: true,
                    updatedAt: new Date(),
                },
            },
        });
        const flagId = await seedFlaggedQuestion();

        await loginViaUI(page);
        await page.goto(`/instructor/flagged?courseId=${COURSE_ID}`);

        const flagCard = page.locator(`[data-flag-id="${flagId}"]`);
        await expect(flagCard).toBeVisible({ timeout: 15_000 });
        await expect(flagCard).toContainText('TA seeded flag for Playwright review');
        await expect(page.locator('#ta-dashboard-nav')).toBeVisible();
        await expect(page.locator('#instructor-ta-hub-nav')).toBeHidden();

        await flagCard.locator('.dismiss-btn').click();
        await expect(flagCard).toHaveCount(0, { timeout: 10_000 });

        const updatedFlag = await withDb((db) =>
            db.collection('flaggedQuestions').findOne({ flagId })
        );
        expect(updatedFlag.flagStatus).toBe('dismissed');
        // Desired behavior: moderation should leave an audit trail for who acted.
        expect(updatedFlag.instructorId).toBe(taId);
    });
});

test.describe('TA course scoping', () => {
    test('GET /api/courses/ta/:taId only returns assigned courses', async ({ baseURL }) => {
        await seedTwoCourses();
        const taId = await getUserIdByUsername(user.username);

        const apiCtx = await request.newContext({ baseURL });
        const loginRes = await apiCtx.post('/api/auth/login', {
            data: { username: user.username, password },
        });
        expect(loginRes.ok()).toBeTruthy();

        const coursesRes = await apiCtx.get(`/api/courses/ta/${taId}`);
        expect(coursesRes.ok()).toBeTruthy();
        const body = await coursesRes.json();
        expect(body.success).toBe(true);

        const returnedIds = body.data.map((c) => c.courseId);
        expect(returnedIds).toContain(COURSE_ID);
        expect(returnedIds).not.toContain(OTHER_COURSE_ID);

        await apiCtx.dispose();
    });

    test('GET /api/courses/ta/:taId for another TA returns 403', async ({ baseURL }) => {
        await seedCourseWithTA();

        const apiCtx = await request.newContext({ baseURL });
        const loginRes = await apiCtx.post('/api/auth/login', {
            data: { username: user.username, password },
        });
        expect(loginRes.ok()).toBeTruthy();

        const res = await apiCtx.get('/api/courses/ta/some-other-ta-id', {
            failOnStatusCode: false,
        });
        expect(res.status()).toBe(403);

        await apiCtx.dispose();
    });
});

test.describe('TA course joining', () => {
    test('TA onboarding requires a valid student course code before joining a course', async ({ page }) => {
        const taId = await getUserIdByUsername(user.username);
        await seedJoinableCourseForTA();
        await loginViaUI(page);

        await page.goto('/ta/onboarding');
        const courseSelect = page.locator('#ta-course-select');
        await expect(courseSelect.locator(`option[value="${TA_JOIN_COURSE_ID}"]`)).toHaveCount(1, {
            timeout: 15_000,
        });

        await courseSelect.selectOption(TA_JOIN_COURSE_ID);
        const courseCodeInput = page.locator('#ta-course-code');
        await expect(courseCodeInput).toHaveAttribute('required', '');

        await page.locator('#ta-course-selection-form button[type="submit"]').click();
        await expect(page.locator('#ta-onboarding-complete')).toBeHidden();
        expect(await courseCodeInput.evaluate((input) => {
            const element = /** @type {HTMLInputElement} */ (input);
            return !element.checkValidity();
        })).toBe(true);

        const notJoinedCourse = await withDb((db) =>
            db.collection('courses').findOne({ courseId: TA_JOIN_COURSE_ID })
        );
        expect(notJoinedCourse.tas || []).not.toContain(taId);

        await courseCodeInput.fill('WRONG1');
        await page.locator('#ta-course-selection-form button[type="submit"]').click();
        await expect(page.locator('.notification.error').last()).toContainText('Invalid course code', {
            timeout: 10_000,
        });

        await courseCodeInput.fill(TA_JOIN_COURSE_CODE);
        await page.locator('#ta-course-selection-form button[type="submit"]').click();
        await expect(page.locator('#ta-onboarding-complete')).toBeVisible({ timeout: 15_000 });

        const joinedCourse = await withDb((db) =>
            db.collection('courses').findOne({ courseId: TA_JOIN_COURSE_ID })
        );
        expect(joinedCourse.tas).toContain(taId);
    });
});

test.describe('TA dashboard course picker joins', () => {
    test('TA can accept an instructor invite from the dashboard picker without a course code prompt', async ({ page }) => {
        const taId = await getUserIdByUsername(user.username);
        await seedInvitedCourseForTA();
        await loginViaUI(page);

        let promptCount = 0;
        page.on('dialog', async (dialog) => {
            promptCount += 1;
            await dialog.dismiss();
        });

        await page.goto('/ta');
        const courseSelect = page.locator('#ta-course-select');
        await expect(courseSelect.locator(`option[value="${TA_INVITED_COURSE_ID}"]`)).toContainText(
            '(join invite)',
            { timeout: 15_000 }
        );

        await courseSelect.selectOption(TA_INVITED_COURSE_ID);
        await expect(page.locator('#selected-course-id')).toHaveText(TA_INVITED_COURSE_ID, {
            timeout: 15_000,
        });
        await expect(page.locator('.notification.success').last()).toContainText(TA_INVITED_COURSE_NAME);
        expect(promptCount).toBe(0);

        const { joinedCourse, refreshedTA } = await withDb(async (db) => ({
            joinedCourse: await db.collection('courses').findOne({ courseId: TA_INVITED_COURSE_ID }),
            refreshedTA: await db.collection('users').findOne({ userId: taId }),
        }));
        expect(joinedCourse.tas).toContain(taId);
        expect(refreshedTA.invitedCourses || []).not.toContain(TA_INVITED_COURSE_ID);
    });

    test('TA dashboard requires a valid student code before joining an unassigned active course', async ({ page }) => {
        const taId = await getUserIdByUsername(user.username);
        await seedJoinableCourseForTA();
        await loginViaUI(page);

        const promptResponses = ['WRONG1', TA_JOIN_COURSE_CODE];
        page.on('dialog', async (dialog) => {
            await dialog.accept(promptResponses.shift() || '');
        });

        await page.goto('/ta');
        const courseSelect = page.locator('#ta-course-select');
        await expect(courseSelect.locator(`option[value="${TA_JOIN_COURSE_ID}"]`)).toContainText(
            '(enter code to join)',
            { timeout: 15_000 }
        );

        await courseSelect.selectOption(TA_JOIN_COURSE_ID);
        await expect(page.locator('.notification.error').last()).toContainText('Invalid course code', {
            timeout: 10_000,
        });
        const notJoinedCourse = await withDb((db) =>
            db.collection('courses').findOne({ courseId: TA_JOIN_COURSE_ID })
        );
        expect(notJoinedCourse.tas || []).not.toContain(taId);

        await courseSelect.selectOption(TA_JOIN_COURSE_ID);
        await expect(page.locator('#selected-course-id')).toHaveText(TA_JOIN_COURSE_ID, {
            timeout: 15_000,
        });

        const joinedCourse = await withDb((db) =>
            db.collection('courses').findOne({ courseId: TA_JOIN_COURSE_ID })
        );
        expect(joinedCourse.tas).toContain(taId);
    });
});

test.describe('TA settings and inactive course display', () => {
    test('TA dashboard marks an assigned inactive course while preserving permitted actions', async ({ page }) => {
        const taId = await getUserIdByUsername(user.username);
        await seedCourseWithTA({
            status: 'inactive',
            taPermissions: {
                [taId]: {
                    materials: true, questions: true, flags: true, roster: true,
                    transcripts: true, settings: true,
                    updatedAt: new Date(),
                },
            },
        });

        await loginViaUI(page);
        await page.goto('/ta');

        await expect(page.locator('#selected-course-name')).toHaveText(`${COURSE_NAME} (Inactive)`, {
            timeout: 15_000,
        });
        await expect(page.locator('#selected-course-status')).toHaveText('Inactive');
        const card = page.locator(`.course-card[data-course-id="${COURSE_ID}"]`);
        await expect(card).toContainText('Inactive');
        // All six permissions granted matches the "Full TA" preset exactly.
        await expect(card).toContainText('Role: Full TA');
        await expect(page.locator('#my-courses-link')).toBeVisible();
        await expect(page.locator('#student-support-link')).toBeVisible();
    });

    test('TA settings displays account details and permission status', async ({ page }) => {
        const taId = await getUserIdByUsername(user.username);
        await seedCourseWithTA({
            taPermissions: {
                [taId]: {
                    materials: true, questions: false, flags: false, roster: false,
                    transcripts: false, settings: false,
                    updatedAt: new Date(),
                },
            },
        });

        await loginViaUI(page);
        await page.goto(`/ta/settings?courseId=${COURSE_ID}`);

        await expect(page.locator('#ta-id')).toHaveValue(taId, { timeout: 15_000 });
        await expect(page.locator('#ta-email')).toHaveValue(user.email);
        await expect(page.locator('#permissions-status')).toContainText('Role');
        await expect(page.locator('#permissions-status')).toContainText('Custom');
        await expect(page.locator('#permissions-status')).toContainText('Course Materials');
        await expect(page.locator('#permissions-status')).toContainText('Flagged Content');
        await expect(page.locator('#permissions-status')).toContainText('Allowed');
        await expect(page.locator('#permissions-status')).toContainText('Denied');
        await expect(page.locator('#ta-my-courses-link')).toBeVisible();
        await expect(page.locator('#ta-student-support-link')).toBeHidden();
    });
});

test.describe('TA empty, revoked, and settings-context flows', () => {
    test('TA with no assigned courses sees an empty dashboard state and no course actions', async ({ page }) => {
        await seedNoCoursesForTA();
        await loginViaUI(page);

        await page.goto('/ta');

        await expect(page.locator('#selected-course-name')).toHaveText('No course selected', {
            timeout: 15_000,
        });
        await expect(page.locator('#selected-course-id')).toHaveText('-');
        await expect(page.locator('#courses-container')).toContainText('No courses joined');
        await expect(page.locator('#courses-container')).toContainText('Join a Course');
        await expect(page.locator('#quick-courses-link')).toBeHidden();
        await expect(page.locator('#quick-support-link')).toBeHidden();
    });

    test('TA assignment revocation blocks stale selected-course access', async ({ page }) => {
        const taId = await getUserIdByUsername(user.username);
        await seedCourseWithTA({
            taPermissions: {
                [taId]: {
                    materials: true, questions: true, flags: true, roster: true,
                    transcripts: true, settings: true,
                    updatedAt: new Date(),
                },
            },
        });
        await loginViaUI(page);

        await page.goto(`/ta?courseId=${COURSE_ID}`);
        await expect(page.locator('#selected-course-id')).toHaveText(COURSE_ID, { timeout: 15_000 });

        await withDb(async (db) => {
            await db.collection('courses').updateOne(
                { courseId: COURSE_ID },
                {
                    $pull: { tas: taId },
                    $unset: { [`taPermissions.${taId}`]: '' },
                    $set: { updatedAt: new Date() },
                }
            );
        });

        // No longer assigned to this course at all: none of
        // materials/questions/settings can be true, so requireAnyPermission
        // redirects (denial on an HTML route) rather than returning 403 JSON.
        await page.goto(`/instructor/documents?courseId=${COURSE_ID}`);
        await expect(page).toHaveURL(/\/ta\/?$/);

        await page.goto('/ta');
        await expect(page.locator('#selected-course-id')).toHaveText('-', { timeout: 15_000 });
        await expect(page.locator('#courses-container')).toContainText('No courses joined');
        await expect(page.locator('#quick-courses-link')).toBeHidden();
        await expect(page.locator('#quick-support-link')).toBeHidden();
    });

    test('TA settings navigation respects the selected course permission context', async ({ page }) => {
        await seedTwoAssignedCoursesWithDifferentPermissions();
        await loginViaUI(page);

        await page.goto(`/ta/settings?courseId=${COURSE_ID}`);
        await expect(page.locator('#ta-id')).not.toHaveValue('', { timeout: 15_000 });
        await expect.soft(page.locator('#ta-my-courses-link')).toBeVisible();
        expect.soft(await page.locator('#ta-my-courses-link').evaluate((node) => getComputedStyle(node).display)).not.toBe('none');
        await expect.soft(page.locator('#ta-student-support-link')).toBeHidden();

        await page.locator('#ta-my-courses-link').click();
        await page.waitForURL((url) =>
            url.pathname === '/instructor/documents' &&
            url.searchParams.get('courseId') === COURSE_ID,
            { timeout: 10_000 }
        );

        await page.goto(`/ta/settings?courseId=${OTHER_COURSE_ID}`);
        await expect(page.locator('#ta-id')).not.toHaveValue('', { timeout: 15_000 });
        await expect.soft(page.locator('#ta-my-courses-link')).toBeHidden();
        await expect.soft(page.locator('#ta-student-support-link')).toBeVisible();
        expect.soft(await page.locator('#ta-student-support-link').evaluate((node) => getComputedStyle(node).display)).not.toBe('none');

        await page.locator('#ta-student-support-link').click();
        await page.waitForURL((url) =>
            url.pathname === '/instructor/flagged' &&
            url.searchParams.get('courseId') === OTHER_COURSE_ID,
            { timeout: 10_000 }
        );
    });
});

test.describe('TA direct API authorization for course content', () => {
    test('TA with materials=false cannot mutate topics or unit structure by direct API', async ({ baseURL }) => {
        const instructorId = await getUserIdByUsername(instructorUser.username);
        const taId = await getUserIdByUsername(user.username);
        await seedCourseWithTA({
            taPermissions: {
                [taId]: {
                    materials: false, questions: false, flags: false, roster: false,
                    transcripts: false, settings: false,
                    updatedAt: new Date(),
                },
            },
            approvedStruggleTopics: ['Original topic'],
        });

        const apiCtx = await loginViaAPI(baseURL);

        const topicUnitRes = await apiCtx.patch(`/api/courses/${COURSE_ID}/approved-topics/unit`, {
            data: { topic: 'Original topic', unitId: 'Unit 1' },
            failOnStatusCode: false,
        });
        expect.soft(topicUnitRes.status()).toBe(403);

        const topicsRes = await apiCtx.put(`/api/courses/${COURSE_ID}/approved-topics`, {
            data: { topics: ['TA injected topic'] },
            failOnStatusCode: false,
        });
        expect.soft(topicsRes.status()).toBe(403);

        const renameUnitRes = await apiCtx.put(
            `/api/courses/${COURSE_ID}/units/${encodeURIComponent('Unit 1')}/rename`,
            {
                data: { displayName: 'TA renamed Unit', instructorId },
                failOnStatusCode: false,
            }
        );
        expect.soft(renameUnitRes.status()).toBe(403);

        const deleteUnitRes = await apiCtx.delete(
            `/api/courses/${COURSE_ID}/units/${encodeURIComponent('Unit 1')}`,
            {
                data: { instructorId },
                failOnStatusCode: false,
            }
        );
        expect.soft(deleteUnitRes.status()).toBe(403);

        const courseAfterAttempts = await withDb((db) =>
            db.collection('courses').findOne({ courseId: COURSE_ID })
        );
        const unitOne = courseAfterAttempts.lectures.find((lecture) => lecture.name === 'Unit 1');
        expect.soft(courseAfterAttempts.approvedStruggleTopics).toEqual(['Original topic']);
        expect.soft(unitOne).toBeTruthy();
        expect.soft(unitOne?.displayName || '').not.toBe('TA renamed Unit');
        expect.soft(courseAfterAttempts.lectures).toHaveLength(1);

        await apiCtx.dispose();
    });

    test('TA with questions=false cannot create, update, or delete assessment questions by direct API', async ({ baseURL }) => {
        const instructorId = await getUserIdByUsername(instructorUser.username);
        const taId = await getUserIdByUsername(user.username);
        await seedCourseWithTA({
            taPermissions: {
                [taId]: {
                    materials: false, questions: false, flags: false, roster: false,
                    transcripts: false, settings: false,
                    updatedAt: new Date(),
                },
            },
            assessmentQuestions: [
                {
                    questionId: TA_UPDATE_QUESTION_ID,
                    questionType: 'short-answer',
                    question: 'Original update-protected question',
                    correctAnswer: 'Original answer',
                    explanation: 'Original explanation',
                    difficulty: 'medium',
                    points: 1,
                },
                {
                    questionId: TA_DELETE_QUESTION_ID,
                    questionType: 'short-answer',
                    question: 'Original delete-protected question',
                    correctAnswer: 'Original answer',
                    explanation: 'Original explanation',
                    difficulty: 'medium',
                    points: 1,
                },
            ],
        });

        const apiCtx = await loginViaAPI(baseURL);

        const createQuestionText = 'TA injected direct question';
        const createRes = await apiCtx.post('/api/questions', {
            data: {
                courseId: COURSE_ID,
                lectureName: 'Unit 1',
                instructorId,
                questionType: 'short-answer',
                question: createQuestionText,
                correctAnswer: 'Injected answer',
            },
            failOnStatusCode: false,
        });
        expect.soft(createRes.status()).toBe(403);

        const updateRes = await apiCtx.put(`/api/questions/${TA_UPDATE_QUESTION_ID}`, {
            data: {
                courseId: COURSE_ID,
                lectureName: 'Unit 1',
                instructorId,
                questionType: 'short-answer',
                question: 'TA edited protected question',
                correctAnswer: 'Edited answer',
            },
            failOnStatusCode: false,
        });
        expect.soft(updateRes.status()).toBe(403);

        const deleteRes = await apiCtx.delete(`/api/questions/${TA_DELETE_QUESTION_ID}`, {
            data: {
                instructorId,
                courseId: COURSE_ID,
                lectureName: 'Unit 1',
            },
            failOnStatusCode: false,
        });
        expect.soft(deleteRes.status()).toBe(403);

        const courseAfterAttempts = await withDb((db) =>
            db.collection('courses').findOne({ courseId: COURSE_ID })
        );
        const questions = courseAfterAttempts.lectures[0].assessmentQuestions || [];
        const updateQuestion = questions.find((question) => question.questionId === TA_UPDATE_QUESTION_ID);
        const deleteQuestion = questions.find((question) => question.questionId === TA_DELETE_QUESTION_ID);

        expect.soft(questions.some((question) => question.question === createQuestionText)).toBe(false);
        expect.soft(updateQuestion?.question).toBe('Original update-protected question');
        expect.soft(deleteQuestion).toBeTruthy();

        await apiCtx.dispose();
    });
});

test.describe('TA direct API authorization for flags', () => {
    test('TA with flags=false cannot respond, status-update, or delete flags by direct API', async ({ baseURL }) => {
        const taId = await getUserIdByUsername(user.username);
        await seedCourseWithTA({
            taPermissions: {
                [taId]: {
                    materials: true, questions: true, settings: true, transcripts: true,
                    flags: false, roster: false,
                    updatedAt: new Date(),
                },
            },
        });
        const responseFlagId = await seedFlaggedQuestion(COURSE_ID, {
            flagId: 'e2e-ta-flag-response',
        });
        const statusFlagId = await seedFlaggedQuestion(COURSE_ID, {
            flagId: 'e2e-ta-flag-status',
            cleanupExisting: false,
        });
        const deleteFlagId = await seedFlaggedQuestion(COURSE_ID, {
            flagId: 'e2e-ta-flag-delete',
            cleanupExisting: false,
        });

        const apiCtx = await loginViaAPI(baseURL);

        const responseRes = await apiCtx.put(`/api/flags/${responseFlagId}/response`, {
            data: {
                response: 'TA should not be able to answer this flag',
                flagStatus: 'resolved',
            },
            failOnStatusCode: false,
        });
        expect.soft(responseRes.status()).toBe(403);

        const statusRes = await apiCtx.put(`/api/flags/${statusFlagId}/status`, {
            data: { status: 'dismissed' },
            failOnStatusCode: false,
        });
        expect.soft(statusRes.status()).toBe(403);

        const deleteRes = await apiCtx.delete(`/api/flags/${deleteFlagId}`, {
            failOnStatusCode: false,
        });
        expect.soft(deleteRes.status()).toBe(403);

        const flagsAfterAttempts = await withDb((db) =>
            db.collection('flaggedQuestions').find({
                flagId: { $in: [responseFlagId, statusFlagId, deleteFlagId] },
            }).toArray()
        );
        const flagById = new Map(flagsAfterAttempts.map((flag) => [flag.flagId, flag]));

        expect.soft(flagById.get(responseFlagId)?.instructorResponse).toBeUndefined();
        expect.soft(flagById.get(responseFlagId)?.flagStatus).toBe('pending');
        expect.soft(flagById.get(statusFlagId)?.flagStatus).toBe('pending');
        expect.soft(flagById.has(deleteFlagId)).toBe(true);

        await apiCtx.dispose();
    });
});

test.describe('TA direct API authorization for documents and settings', () => {
    test('TA with materials=false cannot create, upload, or delete course documents by direct API', async ({ baseURL }) => {
        const instructorId = await getUserIdByUsername(instructorUser.username);
        const taId = await getUserIdByUsername(user.username);
        await seedCourseWithTA({
            taPermissions: {
                [taId]: {
                    materials: false, questions: false, flags: false, roster: false,
                    transcripts: false, settings: false,
                    updatedAt: new Date(),
                },
            },
        });
        const seededDocumentId = await seedDocumentInCourse();

        const apiCtx = await loginViaAPI(baseURL);

        const textTitle = 'TA Direct Text Document';
        const textRes = await apiCtx.post('/api/documents/text', {
            data: {
                courseId: COURSE_ID,
                lectureName: 'Unit 1',
                documentType: 'lecture-notes',
                instructorId,
                content: 'A denied TA should not be able to create this text document.',
                title: textTitle,
            },
            failOnStatusCode: false,
        });
        expect.soft(textRes.status()).toBe(403);

        const uploadRes = await apiCtx.post('/api/documents/upload', {
            multipart: {
                courseId: COURSE_ID,
                lectureName: 'Unit 1',
                documentType: 'lecture-notes',
                instructorId,
                title: 'TA Direct Uploaded Document',
                file: {
                    name: 'ta-direct-upload.txt',
                    mimeType: 'text/plain',
                    buffer: Buffer.from('A denied TA should not upload this file.'),
                },
            },
            failOnStatusCode: false,
        });
        expect.soft(uploadRes.status()).toBe(403);

        const deleteRes = await apiCtx.delete(`/api/documents/${seededDocumentId}`, {
            data: { instructorId },
            failOnStatusCode: false,
        });
        expect.soft(deleteRes.status()).toBe(403);

        const documentState = await withDb(async (db) => {
            const documents = await db.collection('documents').find({
                courseId: COURSE_ID,
                $or: [
                    { documentId: seededDocumentId },
                    { originalName: textTitle },
                    { originalName: 'TA Direct Uploaded Document' },
                    { filename: 'TA Direct Uploaded Document' },
                    { filename: `${textTitle}.txt` },
                ],
            }).toArray();
            const course = await db.collection('courses').findOne({ courseId: COURSE_ID });
            return { documents, course };
        });
        const documentIds = documentState.documents.map((document) => document.documentId);
        const documentNames = documentState.documents.map((document) => document.originalName || document.filename);
        const unitDocuments = documentState.course.lectures[0].documents || [];

        expect.soft(documentIds).toContain(seededDocumentId);
        expect.soft(unitDocuments.some((document) => document.documentId === seededDocumentId)).toBe(true);
        expect.soft(documentNames).not.toContain(textTitle);
        expect.soft(documentNames).not.toContain('TA Direct Uploaded Document');

        await apiCtx.dispose();
    });

    test('TA cannot mutate instructor settings APIs (settings.js) even with every permission granted', async ({ baseURL }) => {
        // src/routes/settings.js (prompts, quiz config, anonymize-students) has
        // no TA branch at all, unrelated to the new 'settings' permission
        // (that one only covers PUT /:courseId - name/status/weeks - and
        // deliberately excludes LLM keys and this file's admin-only config).
        const taId = await getUserIdByUsername(user.username);
        await seedCourseWithTA({
            taPermissions: {
                [taId]: {
                    materials: true, questions: true, flags: true, roster: true,
                    transcripts: true, settings: true,
                    updatedAt: new Date(),
                },
            },
        });

        const apiCtx = await loginViaAPI(baseURL);

        const promptsRes = await apiCtx.post('/api/settings/prompts', {
            data: {
                courseId: COURSE_ID,
                base: 'TA injected base prompt',
                protege: 'TA injected protege prompt',
                tutor: 'TA injected tutor prompt',
                explain: 'TA injected explain prompt',
                directive: 'TA injected directive prompt',
                quizHelp: 'TA injected quiz help prompt',
                additiveRetrieval: false,
                studentIdleTimeout: 60,
            },
            failOnStatusCode: false,
        });
        expect.soft(promptsRes.status()).toBe(403);

        const quizRes = await apiCtx.post('/api/settings/quiz', {
            data: {
                courseId: COURSE_ID,
                enabled: true,
                testableUnits: ['Unit 1'],
                allowLectureMaterialAccess: false,
                allowSourceAttributionDownloads: true,
            },
            failOnStatusCode: false,
        });
        expect.soft(quizRes.status()).toBe(403);

        const anonymizeRes = await apiCtx.post('/api/settings/anonymize-students', {
            data: {
                courseId: COURSE_ID,
                enabled: false,
            },
            failOnStatusCode: false,
        });
        expect.soft(anonymizeRes.status()).toBe(403);

        const adminPromptRes = await apiCtx.post('/api/settings/question-prompts', {
            data: {
                courseId: COURSE_ID,
                systemPrompt: 'TA injected system prompt',
                trueFalse: 'TA injected true false prompt',
                multipleChoice: 'TA injected multiple choice prompt',
                shortAnswer: 'TA injected short answer prompt',
            },
            failOnStatusCode: false,
        });
        expect.soft(adminPromptRes.status()).toBe(403);

        const mentalHealthRes = await apiCtx.post('/api/settings/mental-health-prompt', {
            data: {
                courseId: COURSE_ID,
                prompt: 'TA injected mental health prompt',
            },
            failOnStatusCode: false,
        });
        expect.soft(mentalHealthRes.status()).toBe(403);

        const courseAfterAttempts = await withDb((db) =>
            db.collection('courses').findOne({ courseId: COURSE_ID })
        );
        expect.soft(courseAfterAttempts.prompts).toBeUndefined();
        expect.soft(courseAfterAttempts.quizSettings).toBeUndefined();
        expect.soft(courseAfterAttempts.anonymizeStudents?.[taId]).toBeUndefined();
        expect.soft(courseAfterAttempts.questionPrompts).toBeUndefined();
        expect.soft(courseAfterAttempts.mentalHealthDetectionPrompt).toBeUndefined();

        await apiCtx.dispose();
    });
});

test.describe('TA cross-course API scoping', () => {
    test('TA permissions are scoped to the requested course, not any course with that permission', async ({ baseURL }) => {
        await seedTwoAssignedCoursesWithDifferentPermissions();
        await seedFlaggedQuestion(COURSE_ID);
        await withDb(async (db) => {
            await db.collection('courses').updateOne(
                { courseId: OTHER_COURSE_ID },
                { $set: { approvedStruggleTopics: ['Other original topic'] } }
            );
        });

        const apiCtx = await loginViaAPI(baseURL);

        const flagsRes = await apiCtx.get(`/api/flags/course/${COURSE_ID}`, {
            failOnStatusCode: false,
        });
        expect.soft(flagsRes.status()).toBe(403);

        const statsRes = await apiCtx.get(`/api/flags/stats/${COURSE_ID}`, {
            failOnStatusCode: false,
        });
        expect.soft(statsRes.status()).toBe(403);

        const updateOtherTopicsRes = await apiCtx.put(`/api/courses/${OTHER_COURSE_ID}/approved-topics`, {
            data: { topics: ['TA cross-course injected topic'] },
            failOnStatusCode: false,
        });
        expect.soft(updateOtherTopicsRes.status()).toBe(403);

        const otherCourseAfterAttempts = await withDb((db) =>
            db.collection('courses').findOne({ courseId: OTHER_COURSE_ID })
        );
        expect.soft(otherCourseAfterAttempts.approvedStruggleTopics).toEqual(['Other original topic']);

        await apiCtx.dispose();
    });

    test('TA with flags=false cannot use non-course-scoped flag APIs', async ({ baseURL }) => {
        const taId = await getUserIdByUsername(user.username);
        await seedCourseWithTA({
            taPermissions: {
                [taId]: {
                    materials: true, questions: true, settings: true, transcripts: true,
                    flags: false, roster: false,
                    updatedAt: new Date(),
                },
            },
        });
        await seedFlaggedQuestion(COURSE_ID);

        const apiCtx = await loginViaAPI(baseURL);

        const byStatusRes = await apiCtx.get('/api/flags/status/pending', {
            failOnStatusCode: false,
        });
        expect.soft(byStatusRes.status()).toBe(403);

        const statsRes = await apiCtx.get(`/api/flags/stats/${COURSE_ID}`, {
            failOnStatusCode: false,
        });
        expect.soft(statsRes.status()).toBe(403);

        await apiCtx.dispose();
    });
});

test.describe('TA instructor-only guardrails', () => {
    test('TA cannot access instructor home, settings, downloads, or student hub pages', async ({ page }) => {
        await seedCourseWithTA();
        await loginViaUI(page);

        const instructorOnlyPaths = [
            '/instructor/home',
            '/instructor/settings',
            '/instructor/downloads',
            '/instructor/student-hub',
        ];

        for (const path of instructorOnlyPaths) {
            await page.goto(path);
            await page.waitForLoadState('domcontentloaded');

            const finalPath = new URL(page.url()).pathname;
            expect.soft(finalPath, `${path} should route a TA to TA-specific pages`).toMatch(/^\/ta(?:\/settings)?\/?$/);
        }
    });

    test('authorized TA visiting instructor TA management hub is routed to shared course upload page', async ({ page }) => {
        const taId = await getUserIdByUsername(user.username);
        // Needs at least one of materials/questions/settings to land on
        // /instructor/documents rather than being bounced onward to /ta -
        // an unpermissioned new TA (this helper's default) has none.
        await seedCourseWithTA({ taPermissions: { [taId]: { materials: true, updatedAt: new Date() } } });
        await loginViaUI(page);

        await page.goto('/instructor/ta-hub');
        await page.waitForLoadState('domcontentloaded');

        await expect(page).toHaveURL(/\/instructor\/documents/);
    });

    test('TA without settings/materials permissions cannot spoof an instructorId to mutate course settings or units', async ({ baseURL }) => {
        const instructorId = await getUserIdByUsername(instructorUser.username);
        const taId = await getUserIdByUsername(user.username);
        await seedCourseWithTA({
            taPermissions: {
                [taId]: {
                    materials: false, questions: false, flags: false, roster: false,
                    transcripts: false, settings: false,
                    updatedAt: new Date(),
                },
            },
        });

        const apiCtx = await request.newContext({ baseURL });
        await apiCtx.post('/api/auth/login', {
            data: { username: user.username, password },
        });

        const updateRes = await apiCtx.put(`/api/courses/${COURSE_ID}`, {
            data: {
                instructorId,
                name: 'TA Spoofed Course Name',
                status: 'inactive',
            },
            failOnStatusCode: false,
        });
        expect.soft(updateRes.status()).toBe(403);

        const addUnitRes = await apiCtx.post(`/api/courses/${COURSE_ID}/units`, {
            data: { instructorId },
            failOnStatusCode: false,
        });
        expect.soft(addUnitRes.status()).toBe(403);

        const courseAfterAttempts = await withDb((db) =>
            db.collection('courses').findOne({ courseId: COURSE_ID })
        );
        expect.soft(courseAfterAttempts.courseName).toBe(COURSE_NAME);
        expect.soft(courseAfterAttempts.status).toBe('active');
        expect.soft(courseAfterAttempts.lectures).toHaveLength(1);

        await apiCtx.dispose();
    });
});
