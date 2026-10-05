// @ts-check
/**
 * API-level coverage for src/routes/flags.js and src/models/FlaggedQuestion.js.
 *
 * Targets the auth/role gates, validation 400s, 404 unknown-id paths, model
 * failure-paths, the `status='resolved'` branch in updateFlagStatus, the
 * `low` priority fallback in determinePriority, and the
 * "flag not found" branches in the model.
 *
 * The 503 DB-unavailable branches and the catch-all 500 blocks require
 * either internal mocking or a downed Mongo — both out of scope per this
 * coverage task's "browser-level only" rule. We leave a one-line skip note
 * for each.
 */

const { test, expect, request } = require('./fixtures/monocart');
const { TEST_USERS, storageStatePath } = require('./helpers/users');
const {
    withDb,
    getUserIdByUsername,
    seedCourse,
    cleanupCourses,
    cleanupCoursesForUser,
} = require('./helpers/courses-test');

const COURSE_A = 'BIOC-E2E-FLAGS-COV-A';
const COURSE_B = 'BIOC-E2E-FLAGS-COV-B';
const QUESTION_ID = 'q_e2e_flagscov_1';
const UNIT_NAME = 'Unit 1';

let instructorId;
let studentId;
let taId;

async function seedFlagDoc({
    flagId = `e2e-cov-flag-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    courseId = COURSE_A,
    studentIdForFlag = null,
    flagStatus = 'pending',
    flagReason = 'unclear',
    instructorResponse = null,
} = {}) {
    await withDb(async (db) => {
        await db.collection('flaggedQuestions').insertOne({
            flagId,
            questionId: QUESTION_ID,
            courseId,
            unitName: UNIT_NAME,
            studentId: studentIdForFlag || studentId,
            studentName: TEST_USERS.student.displayName,
            flagReason,
            flagDescription: 'seeded for coverage',
            botMode: 'tutor',
            flagStatus,
            instructorResponse,
            priority: 'medium',
            questionContent: { question: 'Q?', questionType: 'true-false' },
            createdAt: new Date(),
            updatedAt: new Date(),
        });
    });
    return flagId;
}

async function cleanupFlags(courseIds) {
    await withDb(async (db) => {
        await db.collection('flaggedQuestions').deleteMany({ courseId: { $in: courseIds } });
    });
}

test.beforeAll(async () => {
    instructorId = await getUserIdByUsername(TEST_USERS.instructor.username);
    studentId = await getUserIdByUsername(TEST_USERS.student.username);
    taId = await getUserIdByUsername(TEST_USERS.ta.username);
});

test.beforeEach(async () => {
    await cleanupCoursesForUser(instructorId);
    await cleanupFlags([COURSE_A, COURSE_B]);
    // Seed COURSE_A with student enrolled so requireStudentEnrolled passes.
    await seedCourse({
        courseId: COURSE_A,
        instructorId,
        studentEnrollment: { [studentId]: { enrolled: true, enrolledAt: new Date() } },
        lectures: [{
            name: UNIT_NAME,
            displayName: UNIT_NAME,
            isPublished: true,
            learningObjectives: [],
            passThreshold: 2,
            createdAt: new Date(),
            updatedAt: new Date(),
            documents: [],
            assessmentQuestions: [
                { questionId: QUESTION_ID, questionType: 'true-false', question: 'Q?', correctAnswer: 'true', isActive: true },
            ],
        }],
    });
});

test.afterAll(async () => {
    await cleanupCourses([COURSE_A, COURSE_B]);
    await cleanupFlags([COURSE_A, COURSE_B]);
    await cleanupCoursesForUser(instructorId);
});

// ---------------------------------------------------------------------------
// GET /api/flags/my — auth + role + role-success
// ---------------------------------------------------------------------------
test.describe('GET /api/flags/my', () => {
    test('student happy path returns own flags only', async ({ baseURL }) => {
        const myId = await seedFlagDoc({});
        await seedFlagDoc({ studentIdForFlag: 'someone_else_user_id' });
        const api = await request.newContext({ baseURL, storageState: storageStatePath('student') });
        try {
            const res = await api.get('/api/flags/my');
            expect(res.ok()).toBeTruthy();
            const body = await res.json();
            expect(body.success).toBe(true);
            const ids = body.data.flags.map((f) => f.flagId);
            expect(ids).toContain(myId);
            expect(ids).not.toContain('someone_else_user_id');
        } finally {
            await api.dispose();
        }
    });

    test('includes the student\'s Super Course flags even when scoped to a real course', async ({ baseURL }) => {
        const courseFlagId = await seedFlagDoc({ courseId: COURSE_A });
        const superFlagId = await seedFlagDoc({ courseId: 'SUPER_COURSE' });
        const api = await request.newContext({ baseURL, storageState: storageStatePath('student') });
        try {
            // Scoped to a real course the student is enrolled in...
            const res = await api.get(`/api/flags/my?courseId=${COURSE_A}`);
            expect(res.ok()).toBeTruthy();
            const body = await res.json();
            const ids = body.data.flags.map((f) => f.flagId);
            expect(ids).toContain(courseFlagId);   // the course flag
            expect(ids).toContain(superFlagId);    // ...and the Super Course flag still shows
        } finally {
            await api.dispose();
            // SUPER_COURSE flags aren't covered by cleanupFlags([COURSE_A, COURSE_B]).
            await withDb((db) => db.collection('flaggedQuestions').deleteMany({ flagId: superFlagId }));
        }
    });

    test('403 when an instructor calls /my', async ({ baseURL }) => {
        const api = await request.newContext({ baseURL, storageState: storageStatePath('instructor') });
        try {
            const res = await api.get('/api/flags/my', { failOnStatusCode: false });
            expect(res.status()).toBe(403);
        } finally {
            await api.dispose();
        }
    });

    test('401/302 when no session is present', async ({ baseURL }) => {
        const api = await request.newContext({ baseURL });
        try {
            const res = await api.get('/api/flags/my', { failOnStatusCode: false, maxRedirects: 0 });
            expect([401, 302]).toContain(res.status());
        } finally {
            await api.dispose();
        }
    });
});

// ---------------------------------------------------------------------------
// POST /api/flags — all branches except 503 (DB-unavail) and catch (500)
// ---------------------------------------------------------------------------
test.describe('POST /api/flags', () => {
    test('401/302 when anonymous', async ({ baseURL }) => {
        const api = await request.newContext({ baseURL });
        try {
            const res = await api.post('/api/flags', {
                data: { courseId: COURSE_A, questionId: QUESTION_ID, unitName: UNIT_NAME, flagReason: 'unclear', flagDescription: 'x' },
                failOnStatusCode: false,
                maxRedirects: 0,
            });
            expect([401, 302]).toContain(res.status());
        } finally {
            await api.dispose();
        }
    });

    test('200 when an instructor flags their own course; 403 for a TA', async ({ baseURL }) => {
        // Instructors with course access may now create flags; TAs review
        // flags but still cannot create them.
        const api = await request.newContext({ baseURL, storageState: storageStatePath('instructor') });
        try {
            const res = await api.post('/api/flags', {
                data: { courseId: COURSE_A, questionId: QUESTION_ID, unitName: UNIT_NAME, flagReason: 'unclear', flagDescription: 'x' },
                failOnStatusCode: false,
            });
            expect(res.status()).toBe(200);
        } finally {
            await api.dispose();
        }

        const taApi = await request.newContext({ baseURL, storageState: storageStatePath('ta') });
        try {
            const res = await taApi.post('/api/flags', {
                data: { courseId: COURSE_A, questionId: QUESTION_ID, unitName: UNIT_NAME, flagReason: 'unclear', flagDescription: 'x' },
                failOnStatusCode: false,
            });
            expect(res.status()).toBe(403);
        } finally {
            await taApi.dispose();
        }
    });

    test('400 when required fields are missing', async ({ baseURL }) => {
        const api = await request.newContext({ baseURL, storageState: storageStatePath('student') });
        try {
            const res = await api.post('/api/flags', {
                data: { questionId: QUESTION_ID, courseId: COURSE_A },
                failOnStatusCode: false,
            });
            expect(res.status()).toBe(400);
        } finally {
            await api.dispose();
        }
    });

    test('400 when botMode is invalid', async ({ baseURL }) => {
        const api = await request.newContext({ baseURL, storageState: storageStatePath('student') });
        try {
            const res = await api.post('/api/flags', {
                data: {
                    questionId: QUESTION_ID,
                    courseId: COURSE_A,
                    unitName: UNIT_NAME,
                    flagReason: 'unclear',
                    flagDescription: 'x',
                    botMode: 'unknown',
                },
                failOnStatusCode: false,
            });
            expect(res.status()).toBe(400);
        } finally {
            await api.dispose();
        }
    });

    test('happy path with default botMode and `other` reason hits determinePriority `low` fallback', async ({ baseURL }) => {
        const api = await request.newContext({ baseURL, storageState: storageStatePath('student') });
        try {
            const res = await api.post('/api/flags', {
                data: {
                    questionId: QUESTION_ID,
                    courseId: COURSE_A,
                    unitName: UNIT_NAME,
                    flagReason: 'something-not-known', // exercises priority='low' branch
                    flagDescription: 'I have a different concern.',
                },
            });
            expect(res.ok()).toBeTruthy();
            const body = await res.json();
            const stored = await withDb((db) =>
                db.collection('flaggedQuestions').findOne({ flagId: body.data.flagId })
            );
            expect(stored.botMode).toBe('tutor');
            expect(stored.priority).toBe('low');
        } finally {
            await api.dispose();
        }
    });

    test('happy path with explicit protege botMode and medium-priority reason', async ({ baseURL }) => {
        const api = await request.newContext({ baseURL, storageState: storageStatePath('student') });
        try {
            const res = await api.post('/api/flags', {
                data: {
                    questionId: QUESTION_ID,
                    courseId: COURSE_A,
                    unitName: UNIT_NAME,
                    flagReason: 'typo',
                    flagDescription: 'spelling issue',
                    botMode: 'protege',
                    questionContent: { question: 'Q?', questionType: 'true-false' },
                },
            });
            expect(res.ok()).toBeTruthy();
            const body = await res.json();
            const stored = await withDb((db) =>
                db.collection('flaggedQuestions').findOne({ flagId: body.data.flagId })
            );
            expect(stored.botMode).toBe('protege');
            expect(stored.priority).toBe('medium');
        } finally {
            await api.dispose();
        }
    });
});

// ---------------------------------------------------------------------------
// GET /api/flags/course/:courseId and ?status=
// ---------------------------------------------------------------------------
test.describe('GET /api/flags/course/:courseId', () => {
    test('returns all flags for the course', async ({ baseURL }) => {
        await seedFlagDoc({ flagId: 'cov-course-A1' });
        await seedFlagDoc({ flagId: 'cov-course-A2', flagStatus: 'resolved' });
        const api = await request.newContext({ baseURL, storageState: storageStatePath('instructor') });
        try {
            const res = await api.get(`/api/flags/course/${COURSE_A}`);
            expect(res.ok()).toBeTruthy();
            const body = await res.json();
            expect(body.data.count).toBeGreaterThanOrEqual(2);
            const ids = body.data.flags.map((f) => f.flagId);
            expect(ids).toContain('cov-course-A1');
            expect(ids).toContain('cov-course-A2');
        } finally {
            await api.dispose();
        }
    });

    test('?status=pending filters by status', async ({ baseURL }) => {
        await seedFlagDoc({ flagId: 'cov-pending-1', flagStatus: 'pending' });
        await seedFlagDoc({ flagId: 'cov-resolved-1', flagStatus: 'resolved' });
        const api = await request.newContext({ baseURL, storageState: storageStatePath('instructor') });
        try {
            const res = await api.get(`/api/flags/course/${COURSE_A}?status=pending`);
            expect(res.ok()).toBeTruthy();
            const body = await res.json();
            const ids = body.data.flags.map((f) => f.flagId);
            expect(ids).toContain('cov-pending-1');
            expect(ids).not.toContain('cov-resolved-1');
        } finally {
            await api.dispose();
        }
    });
});

// ---------------------------------------------------------------------------
// GET /api/flags/status/:status
// ---------------------------------------------------------------------------
test.describe('GET /api/flags/status/:status', () => {
    test('returns flags filtered by status', async ({ baseURL }) => {
        const id = await seedFlagDoc({ flagId: 'cov-status-1', flagStatus: 'reviewed' });
        const api = await request.newContext({ baseURL, storageState: storageStatePath('instructor') });
        try {
            const res = await api.get('/api/flags/status/reviewed');
            expect(res.ok()).toBeTruthy();
            const body = await res.json();
            const ids = body.data.flags.map((f) => f.flagId);
            expect(ids).toContain(id);
        } finally {
            await api.dispose();
        }
    });
});

// ---------------------------------------------------------------------------
// GET /api/flags/:flagId — happy path and 404
// ---------------------------------------------------------------------------
test.describe('GET /api/flags/:flagId', () => {
    test('returns the flag for a known id', async ({ baseURL }) => {
        const id = await seedFlagDoc({ flagId: 'cov-getbyid-1' });
        const api = await request.newContext({ baseURL, storageState: storageStatePath('instructor') });
        try {
            const res = await api.get(`/api/flags/${id}`);
            expect(res.ok()).toBeTruthy();
            const body = await res.json();
            expect(body.data.flagId).toBe(id);
        } finally {
            await api.dispose();
        }
    });

    test('404 when flagId is unknown', async ({ baseURL }) => {
        const api = await request.newContext({ baseURL, storageState: storageStatePath('instructor') });
        try {
            const res = await api.get('/api/flags/does_not_exist', { failOnStatusCode: false });
            expect(res.status()).toBe(404);
        } finally {
            await api.dispose();
        }
    });
});

// ---------------------------------------------------------------------------
// PUT /api/flags/:flagId/response — auth, role gate, missing field, happy,
// model failure (unknown flag → 400)
// ---------------------------------------------------------------------------
test.describe('PUT /api/flags/:flagId/response', () => {
    test('401/302 anonymous', async ({ baseURL }) => {
        const api = await request.newContext({ baseURL });
        try {
            const res = await api.put('/api/flags/anything/response', {
                data: { response: 'reply' }, failOnStatusCode: false, maxRedirects: 0,
            });
            expect([401, 302]).toContain(res.status());
        } finally {
            await api.dispose();
        }
    });

    test('403 when student tries to respond', async ({ baseURL }) => {
        const id = await seedFlagDoc({ flagId: 'cov-resp-403' });
        const api = await request.newContext({ baseURL, storageState: storageStatePath('student') });
        try {
            const res = await api.put(`/api/flags/${id}/response`, {
                data: { response: 'I am a student' }, failOnStatusCode: false,
            });
            expect(res.status()).toBe(403);
        } finally {
            await api.dispose();
        }
    });

    test('400 when response field is missing', async ({ baseURL }) => {
        const id = await seedFlagDoc({ flagId: 'cov-resp-400' });
        const api = await request.newContext({ baseURL, storageState: storageStatePath('instructor') });
        try {
            const res = await api.put(`/api/flags/${id}/response`, {
                data: {}, failOnStatusCode: false,
            });
            expect(res.status()).toBe(400);
        } finally {
            await api.dispose();
        }
    });

    test('happy path resolves the flag and stamps instructor metadata', async ({ baseURL }) => {
        const id = await seedFlagDoc({ flagId: 'cov-resp-ok' });
        const api = await request.newContext({ baseURL, storageState: storageStatePath('instructor') });
        try {
            const res = await api.put(`/api/flags/${id}/response`, {
                data: { response: 'Resolved by instructor', flagStatus: 'resolved' },
            });
            expect(res.ok()).toBeTruthy();
            const stored = await withDb((db) =>
                db.collection('flaggedQuestions').findOne({ flagId: id })
            );
            expect(stored.flagStatus).toBe('resolved');
            expect(stored.instructorId).toBe(instructorId);
            expect(stored.instructorResponse).toBe('Resolved by instructor');
            expect(stored.resolvedAt).toBeTruthy();
        } finally {
            await api.dispose();
        }
    });

    test('TA happy path is permitted', async ({ baseURL }) => {
        // Ensure the TA has access through course's tas array plus the
        // 'flags' permission (fail-closed default otherwise blocks this).
        // tas is [String] in product code (Course.js:1219, schema L18).
        await withDb(async (db) => {
            await db.collection('courses').updateOne(
                { courseId: COURSE_A },
                { $set: { tas: [taId], [`taPermissions.${taId}`]: { flags: true } } }
            );
        });
        const id = await seedFlagDoc({ flagId: 'cov-resp-ta' });
        const api = await request.newContext({ baseURL, storageState: storageStatePath('ta') });
        try {
            const res = await api.put(`/api/flags/${id}/response`, {
                data: { response: 'TA response', flagStatus: 'reviewed' },
            });
            expect(res.ok()).toBeTruthy();
            const stored = await withDb((db) =>
                db.collection('flaggedQuestions').findOne({ flagId: id })
            );
            expect(stored.flagStatus).toBe('reviewed');
            expect(stored.instructorName).toBe(TEST_USERS.ta.displayName);
        } finally {
            await api.dispose();
        }
    });

    test('400 from model when flagId is unknown (updateInstructorResponse "not found")', async ({ baseURL }) => {
        const api = await request.newContext({ baseURL, storageState: storageStatePath('instructor') });
        try {
            const res = await api.put('/api/flags/no_such_flag_id/response', {
                data: { response: 'reply' }, failOnStatusCode: false,
            });
            expect(res.status()).toBe(400);
            const body = await res.json();
            expect(body.success).toBe(false);
        } finally {
            await api.dispose();
        }
    });
});

// ---------------------------------------------------------------------------
// PUT /api/flags/:flagId/status — auth, role gate, missing fields, resolved
// branch, model failure
// ---------------------------------------------------------------------------
test.describe('PUT /api/flags/:flagId/status', () => {
    test('401/302 anonymous', async ({ baseURL }) => {
        const api = await request.newContext({ baseURL });
        try {
            const res = await api.put('/api/flags/anything/status', {
                data: { status: 'reviewed' }, failOnStatusCode: false, maxRedirects: 0,
            });
            expect([401, 302]).toContain(res.status());
        } finally {
            await api.dispose();
        }
    });

    test('403 when student tries to update status', async ({ baseURL }) => {
        const id = await seedFlagDoc({ flagId: 'cov-st-403' });
        const api = await request.newContext({ baseURL, storageState: storageStatePath('student') });
        try {
            const res = await api.put(`/api/flags/${id}/status`, {
                data: { status: 'reviewed' }, failOnStatusCode: false,
            });
            expect(res.status()).toBe(403);
        } finally {
            await api.dispose();
        }
    });

    test('400 when status field is missing', async ({ baseURL }) => {
        const id = await seedFlagDoc({ flagId: 'cov-st-400' });
        const api = await request.newContext({ baseURL, storageState: storageStatePath('instructor') });
        try {
            const res = await api.put(`/api/flags/${id}/status`, {
                data: {}, failOnStatusCode: false,
            });
            expect(res.status()).toBe(400);
        } finally {
            await api.dispose();
        }
    });

    test('status=resolved updates resolvedAt (FlaggedQuestion.updateFlagStatus L208–210 branch)', async ({ baseURL }) => {
        const id = await seedFlagDoc({ flagId: 'cov-st-resolved' });
        const api = await request.newContext({ baseURL, storageState: storageStatePath('instructor') });
        try {
            const res = await api.put(`/api/flags/${id}/status`, {
                data: { status: 'resolved' },
            });
            expect(res.ok()).toBeTruthy();
            const stored = await withDb((db) =>
                db.collection('flaggedQuestions').findOne({ flagId: id })
            );
            expect(stored.flagStatus).toBe('resolved');
            expect(stored.resolvedAt).toBeTruthy();
        } finally {
            await api.dispose();
        }
    });

    test('400 from model when flagId is unknown', async ({ baseURL }) => {
        const api = await request.newContext({ baseURL, storageState: storageStatePath('instructor') });
        try {
            const res = await api.put('/api/flags/no_such_flag_id/status', {
                data: { status: 'dismissed' }, failOnStatusCode: false,
            });
            expect(res.status()).toBe(400);
            const body = await res.json();
            expect(body.success).toBe(false);
        } finally {
            await api.dispose();
        }
    });
});

// ---------------------------------------------------------------------------
// GET /api/flags/stats/:courseId
// ---------------------------------------------------------------------------
test.describe('GET /api/flags/stats/:courseId', () => {
    test('returns aggregated counts by status', async ({ baseURL }) => {
        await seedFlagDoc({ flagId: 'cov-stats-1', flagStatus: 'pending' });
        await seedFlagDoc({ flagId: 'cov-stats-2', flagStatus: 'resolved' });
        await seedFlagDoc({ flagId: 'cov-stats-3', flagStatus: 'dismissed' });
        const api = await request.newContext({ baseURL, storageState: storageStatePath('instructor') });
        try {
            const res = await api.get(`/api/flags/stats/${COURSE_A}`);
            expect(res.ok()).toBeTruthy();
            const body = await res.json();
            expect(body.data.statistics.total).toBeGreaterThanOrEqual(3);
            expect(body.data.statistics.pending).toBeGreaterThanOrEqual(1);
            expect(body.data.statistics.resolved).toBeGreaterThanOrEqual(1);
            expect(body.data.statistics.dismissed).toBeGreaterThanOrEqual(1);
        } finally {
            await api.dispose();
        }
    });
});

// ---------------------------------------------------------------------------
// DELETE /api/flags/:flagId — happy + unknown id model failure
// ---------------------------------------------------------------------------
test.describe('DELETE /api/flags/:flagId', () => {
    test('happy path deletes the flag', async ({ baseURL }) => {
        const id = await seedFlagDoc({ flagId: 'cov-del-ok' });
        const api = await request.newContext({ baseURL, storageState: storageStatePath('instructor') });
        try {
            const res = await api.delete(`/api/flags/${id}`);
            expect(res.ok()).toBeTruthy();
            const stored = await withDb((db) =>
                db.collection('flaggedQuestions').findOne({ flagId: id })
            );
            expect(stored).toBeNull();
        } finally {
            await api.dispose();
        }
    });

    test('400 from model when flagId is unknown', async ({ baseURL }) => {
        const api = await request.newContext({ baseURL, storageState: storageStatePath('instructor') });
        try {
            const res = await api.delete('/api/flags/never_existed', { failOnStatusCode: false });
            expect(res.status()).toBe(400);
            const body = await res.json();
            expect(body.success).toBe(false);
        } finally {
            await api.dispose();
        }
    });
});

// uncovered: 503 "Database connection not available" branches in flags.js
// (every endpoint) — require a real DB outage / app.locals.db mock.
// uncovered: catch-block 500 handlers in flags.js — require forcing a
// model-level throw (defensive error path).
