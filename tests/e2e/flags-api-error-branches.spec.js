// @ts-check
/**
 * Edge-branch + bug-surface coverage for src/routes/flags.js.
 *
 * Targets branches that the existing flags-api-coverage.spec.js does not
 * reach:
 *
 *   - Per-field 400 disjuncts in POST /api/flags (L75 — questionId, courseId,
 *     unitName, flagReason, flagDescription each missing).
 *   - The truthy side of `courseId || null` in GET /api/flags/my (L33).
 *   - The `user.username` fallback when `user.displayName` is absent on
 *     POST /api/flags (L105) and PUT /api/flags/:flagId/response (L334).
 *   - A `?status=resolved` filter on GET /api/flags/course/:courseId so the
 *     opposite filter branch from the existing `?status=pending` case is hit.
 *   - TA happy-path on GET /api/flags/course/:courseId — the route has no
 *     explicit role gate, and this exercises the read path under a TA session
 *     (the existing spec only covers instructor and student callers).
 *   - GET /api/flags/status/:status for `pending` and `dismissed` (existing
 *     spec only exercises `reviewed`).
 *   - PUT /api/flags/:flagId/status with `dismissed` and `reviewed` — the
 *     non-`resolved` branch in `updateFlagStatus` (model L208 false-side) and
 *     a different success message path through the route.
 *   - PUT /api/flags/:flagId/response without `flagStatus` in the body — the
 *     model's `flagStatus || 'resolved'` default branch (L169) and the
 *     resolvedAt stamping path through the route.
 *
 * Failing tests (FINDINGS):
 *   - DELETE /api/flags/:flagId has no role check and no ownership check, so
 *     a student can delete any flag (theirs or someone else's) in any course.
 *   - PUT /api/flags/:flagId/response and /:flagId/status accept any
 *     instructor/TA, even one who isn't on the course this flag belongs to.
 *
 * The 503 DB-unavailable, 500 catch, and 401-from-route-handler branches
 * remain out of reach (require mocking app.locals.db or bypassing auth
 * middleware), consistent with the existing coverage spec's policy.
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

const COURSE_A = 'BIOC-E2E-FLAGS-EB-A';
const COURSE_B = 'BIOC-E2E-FLAGS-EB-B';
const QUESTION_ID = 'q_e2e_flagseb_1';
const UNIT_NAME = 'Unit 1';

let instructorId;
let instructorFreshId;
let studentId;
let taId;

async function seedFlagDoc({
    flagId = `e2e-eb-flag-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
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
            flagDescription: 'seeded for error-branch coverage',
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

async function unsetUserDisplayName(userId) {
    await withDb((db) =>
        db.collection('users').updateOne(
            { userId },
            { $unset: { displayName: '' } }
        )
    );
}

async function restoreUserDisplayName(userId, displayName) {
    await withDb((db) =>
        db.collection('users').updateOne(
            { userId },
            { $set: { displayName } }
        )
    );
}

test.beforeAll(async () => {
    instructorId = await getUserIdByUsername(TEST_USERS.instructor.username);
    instructorFreshId = await getUserIdByUsername(TEST_USERS.instructor_fresh.username);
    studentId = await getUserIdByUsername(TEST_USERS.student.username);
    taId = await getUserIdByUsername(TEST_USERS.ta.username);
});

test.beforeEach(async () => {
    await cleanupCoursesForUser(instructorId);
    await cleanupCoursesForUser(instructorFreshId);
    await cleanupFlags([COURSE_A, COURSE_B]);
    // Seed COURSE_A with student enrolled so requireStudentEnrolled passes
    // for any student-driven POST / GET against this course.
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
    await cleanupCoursesForUser(instructorId);
    await cleanupCoursesForUser(instructorFreshId);
    await cleanupFlags([COURSE_A, COURSE_B]);
    // Make sure we restore displayNames in case a test bailed mid-flight.
    await restoreUserDisplayName(studentId, TEST_USERS.student.displayName);
    await restoreUserDisplayName(instructorId, TEST_USERS.instructor.displayName);
});

// ---------------------------------------------------------------------------
// POST /api/flags — per-field 400 disjuncts (L75).
// The existing coverage spec only exercises the "two-field body" path; this
// fans out the OR-chain so each missing field hits the short-circuit
// individually.
// ---------------------------------------------------------------------------
test.describe('POST /api/flags per-field validation', () => {
    test.use({ storageState: storageStatePath('student') });

    const baseBody = () => ({
        questionId: QUESTION_ID,
        courseId: COURSE_A,
        unitName: UNIT_NAME,
        flagReason: 'unclear',
        flagDescription: 'detailed description',
    });

    for (const field of ['questionId', 'courseId', 'unitName', 'flagReason', 'flagDescription']) {
        test(`400 when ${field} is missing`, async ({ request: api }) => {
            const data = baseBody();
            delete data[field];
            const res = await api.post('/api/flags', { data, failOnStatusCode: false });
            expect(res.status()).toBe(400);
            const body = await res.json();
            expect(body.success).toBe(false);
            expect(String(body.message)).toContain('Missing required fields');
        });
    }

    test('400 with completely empty body', async ({ request: api }) => {
        const res = await api.post('/api/flags', { data: {}, failOnStatusCode: false });
        expect(res.status()).toBe(400);
        const body = await res.json();
        expect(String(body.message)).toContain('Missing required fields');
    });
});

// ---------------------------------------------------------------------------
// GET /api/flags/my — exercise the `courseId || null` truthy branch (L33).
// ---------------------------------------------------------------------------
test.describe('GET /api/flags/my with course filter', () => {
    test('?courseId=A filters to that course only', async ({ baseURL }) => {
        // Two flags by this student, in different courses. The `?courseId=`
        // filter on /my should drop the COURSE_B one.
        const inA = await seedFlagDoc({ flagId: 'eb-my-a-1', courseId: COURSE_A });
        const inB = await seedFlagDoc({ flagId: 'eb-my-b-1', courseId: COURSE_B });
        const api = await request.newContext({ baseURL, storageState: storageStatePath('student') });
        try {
            const res = await api.get(`/api/flags/my?courseId=${encodeURIComponent(COURSE_A)}`);
            expect(res.ok()).toBeTruthy();
            const body = await res.json();
            const ids = body.data.flags.map((f) => f.flagId);
            expect(ids).toContain(inA);
            expect(ids).not.toContain(inB);
        } finally {
            await api.dispose();
        }
    });
});

// ---------------------------------------------------------------------------
// POST /api/flags — `user.displayName || user.username` fallback (L105).
// The fixture student has a displayName by default; temporarily unset it on
// the user document so the route picks up the `|| user.username` arm.
// ---------------------------------------------------------------------------
test.describe('POST /api/flags displayName fallback', () => {
    test.afterEach(async () => {
        await restoreUserDisplayName(studentId, TEST_USERS.student.displayName);
    });

    test('falls back to user.username when displayName is unset', async ({ baseURL }) => {
        await unsetUserDisplayName(studentId);
        const api = await request.newContext({ baseURL, storageState: storageStatePath('student') });
        try {
            const res = await api.post('/api/flags', {
                data: {
                    questionId: QUESTION_ID,
                    courseId: COURSE_A,
                    unitName: UNIT_NAME,
                    flagReason: 'incorrect',
                    flagDescription: 'wrong answer key',
                    botMode: 'tutor',
                    questionContent: { question: 'Q?', questionType: 'true-false' },
                },
            });
            expect(res.ok()).toBeTruthy();
            const body = await res.json();
            const stored = await withDb((db) =>
                db.collection('flaggedQuestions').findOne({ flagId: body.data.flagId })
            );
            expect(stored.studentName).toBe(TEST_USERS.student.username);
            // `incorrect` is in the high-priority list, so we also exercise
            // determinePriority's `high` branch (model L272).
            expect(stored.priority).toBe('high');
        } finally {
            await api.dispose();
        }
    });
});

// ---------------------------------------------------------------------------
// GET /api/flags/course/:courseId — additional status filter + TA access.
// ---------------------------------------------------------------------------
test.describe('GET /api/flags/course/:courseId additional branches', () => {
    test('?status=resolved filters down to resolved flags only', async ({ baseURL }) => {
        await seedFlagDoc({ flagId: 'eb-cstat-pend', flagStatus: 'pending' });
        await seedFlagDoc({ flagId: 'eb-cstat-resolved', flagStatus: 'resolved' });
        const api = await request.newContext({ baseURL, storageState: storageStatePath('instructor') });
        try {
            const res = await api.get(`/api/flags/course/${COURSE_A}?status=resolved`);
            expect(res.ok()).toBeTruthy();
            const body = await res.json();
            const ids = body.data.flags.map((f) => f.flagId);
            expect(ids).toContain('eb-cstat-resolved');
            expect(ids).not.toContain('eb-cstat-pend');
        } finally {
            await api.dispose();
        }
    });

    test('TA can read flags for the course (no role gate on this route)', async ({ baseURL }) => {
        // Add TA to course so userHasCourseAccess (role=ta) finds them, and
        // grant the 'flags' permission (fail-closed default otherwise blocks this).
        // Canonical shape for the `tas` array is a list of user-id strings —
        // the model's access query is `{ tas: userId }`, which only matches
        // when the array contains the bare ID.
        await withDb((db) =>
            db.collection('courses').updateOne(
                { courseId: COURSE_A },
                { $set: { tas: [taId], [`taPermissions.${taId}`]: { flags: true } } }
            )
        );
        await seedFlagDoc({ flagId: 'eb-ta-read-1' });
        const api = await request.newContext({ baseURL, storageState: storageStatePath('ta') });
        try {
            const res = await api.get(`/api/flags/course/${COURSE_A}`);
            expect(res.ok()).toBeTruthy();
            const body = await res.json();
            const ids = body.data.flags.map((f) => f.flagId);
            expect(ids).toContain('eb-ta-read-1');
        } finally {
            await api.dispose();
        }
    });
});

// ---------------------------------------------------------------------------
// GET /api/flags/status/:status — additional status values.
// ---------------------------------------------------------------------------
test.describe('GET /api/flags/status/:status additional values', () => {
    test('status=pending returns only pending flags', async ({ baseURL }) => {
        const pending = await seedFlagDoc({ flagId: 'eb-stat-pending', flagStatus: 'pending' });
        await seedFlagDoc({ flagId: 'eb-stat-resolved-x', flagStatus: 'resolved' });
        const api = await request.newContext({ baseURL, storageState: storageStatePath('instructor') });
        try {
            const res = await api.get('/api/flags/status/pending');
            expect(res.ok()).toBeTruthy();
            const body = await res.json();
            const ids = body.data.flags.map((f) => f.flagId);
            expect(ids).toContain(pending);
            expect(body.data.status).toBe('pending');
        } finally {
            await api.dispose();
        }
    });

    test('status=dismissed returns only dismissed flags', async ({ baseURL }) => {
        const dismissed = await seedFlagDoc({ flagId: 'eb-stat-dismissed', flagStatus: 'dismissed' });
        const api = await request.newContext({ baseURL, storageState: storageStatePath('instructor') });
        try {
            const res = await api.get('/api/flags/status/dismissed');
            expect(res.ok()).toBeTruthy();
            const body = await res.json();
            const ids = body.data.flags.map((f) => f.flagId);
            expect(ids).toContain(dismissed);
        } finally {
            await api.dispose();
        }
    });
});

// ---------------------------------------------------------------------------
// PUT /api/flags/:flagId/response — displayName fallback and "no flagStatus
// in body" default path.
// ---------------------------------------------------------------------------
test.describe('PUT /api/flags/:flagId/response additional branches', () => {
    test.afterEach(async () => {
        await restoreUserDisplayName(instructorId, TEST_USERS.instructor.displayName);
    });

    test('instructorName falls back to username when displayName is unset (L334)', async ({ baseURL }) => {
        const id = await seedFlagDoc({ flagId: 'eb-resp-fallback' });
        await unsetUserDisplayName(instructorId);
        const api = await request.newContext({ baseURL, storageState: storageStatePath('instructor') });
        try {
            const res = await api.put(`/api/flags/${id}/response`, {
                data: { response: 'Reply without displayName', flagStatus: 'reviewed' },
            });
            expect(res.ok()).toBeTruthy();
            const stored = await withDb((db) =>
                db.collection('flaggedQuestions').findOne({ flagId: id })
            );
            expect(stored.instructorName).toBe(TEST_USERS.instructor.username);
            expect(stored.flagStatus).toBe('reviewed');
        } finally {
            await api.dispose();
        }
    });

    test('no flagStatus in body defaults to "resolved" (model L169)', async ({ baseURL }) => {
        const id = await seedFlagDoc({ flagId: 'eb-resp-default-status' });
        const api = await request.newContext({ baseURL, storageState: storageStatePath('instructor') });
        try {
            const res = await api.put(`/api/flags/${id}/response`, {
                data: { response: 'Resolving without explicit status' },
            });
            expect(res.ok()).toBeTruthy();
            const stored = await withDb((db) =>
                db.collection('flaggedQuestions').findOne({ flagId: id })
            );
            // The `responseData.flagStatus || 'resolved'` default lands here.
            expect(stored.flagStatus).toBe('resolved');
            // The matching `resolvedAt` stamp is asserted in the FAILING
            // section below — the model only stamps it when the INPUT was
            // literally 'resolved', not when the default kicks in.
        } finally {
            await api.dispose();
        }
    });
});

// ---------------------------------------------------------------------------
// PUT /api/flags/:flagId/status — non-resolved branch in model.
// ---------------------------------------------------------------------------
test.describe('PUT /api/flags/:flagId/status non-resolved branches', () => {
    test('status=dismissed does NOT stamp resolvedAt (model L208 false side)', async ({ baseURL }) => {
        const id = await seedFlagDoc({ flagId: 'eb-st-dismissed' });
        const api = await request.newContext({ baseURL, storageState: storageStatePath('instructor') });
        try {
            const res = await api.put(`/api/flags/${id}/status`, {
                data: { status: 'dismissed' },
            });
            expect(res.ok()).toBeTruthy();
            const body = await res.json();
            expect(body.data.status).toBe('dismissed');
            const stored = await withDb((db) =>
                db.collection('flaggedQuestions').findOne({ flagId: id })
            );
            expect(stored.flagStatus).toBe('dismissed');
            // resolvedAt should be absent because the new status is not
            // 'resolved'.
            expect(stored.resolvedAt).toBeUndefined();
        } finally {
            await api.dispose();
        }
    });

    test('status=reviewed by TA also takes the non-resolved branch', async ({ baseURL }) => {
        await withDb((db) =>
            db.collection('courses').updateOne(
                { courseId: COURSE_A },
                // tas is [String] in product code (Course.js:1219, schema L18);
                // userHasCourseAccess queries `tas: userId` against bare strings.
                // Also grant 'flags' permission (fail-closed default otherwise blocks this).
                { $set: { tas: [taId], [`taPermissions.${taId}`]: { flags: true } } }
            )
        );
        const id = await seedFlagDoc({ flagId: 'eb-st-reviewed-ta' });
        const api = await request.newContext({ baseURL, storageState: storageStatePath('ta') });
        try {
            const res = await api.put(`/api/flags/${id}/status`, {
                data: { status: 'reviewed' },
            });
            expect(res.ok()).toBeTruthy();
            const stored = await withDb((db) =>
                db.collection('flaggedQuestions').findOne({ flagId: id })
            );
            expect(stored.flagStatus).toBe('reviewed');
            expect(stored.resolvedAt).toBeUndefined();
        } finally {
            await api.dispose();
        }
    });
});

// ---------------------------------------------------------------------------
// GET /api/flags/stats/:courseId — call with no flags for the course.
// Exercises the "empty stats" path through getFlagStatistics (model L255 loop
// over empty stats array).
// ---------------------------------------------------------------------------
test.describe('GET /api/flags/stats/:courseId edge cases', () => {
    test('returns all-zero counts when the course has no flags', async ({ baseURL }) => {
        // beforeEach cleans up flags for COURSE_A; do nothing more.
        const api = await request.newContext({ baseURL, storageState: storageStatePath('instructor') });
        try {
            const res = await api.get(`/api/flags/stats/${COURSE_A}`);
            expect(res.ok()).toBeTruthy();
            const body = await res.json();
            expect(body.data.statistics.total).toBe(0);
            expect(body.data.statistics.pending).toBe(0);
            expect(body.data.statistics.resolved).toBe(0);
            expect(body.data.statistics.dismissed).toBe(0);
            expect(body.data.statistics.reviewed).toBe(0);
        } finally {
            await api.dispose();
        }
    });
});

// ---------------------------------------------------------------------------
// FAILING TESTS — surface bugs in the flags route's authorization model.
// See FINDINGS.md for full write-ups. These assert the *expected* behavior
// (the route SHOULD deny these requests) and will fail until the route is
// hardened. AGENTS.md policy: leave the tests failing, log in FINDINGS.md.
// ---------------------------------------------------------------------------
test.describe('FAILING: updateInstructorResponse default-resolved skips resolvedAt', () => {
    test('PRODUCT BUG: stored.flagStatus="resolved" without a matching resolvedAt', async ({ baseURL }) => {
        // The model writes `flagStatus: responseData.flagStatus || 'resolved'`
        // but stamps `resolvedAt` only if `responseData.flagStatus ===
        // 'resolved'` — a strict check on the INPUT, not the resolved value.
        // Result: a record can end up in flagStatus='resolved' with no
        // resolvedAt timestamp, violating the implicit invariant that every
        // resolved flag has a resolution time.
        const id = await seedFlagDoc({ flagId: 'eb-bug-default-resolved-stamp' });
        const api = await request.newContext({ baseURL, storageState: storageStatePath('instructor') });
        try {
            const res = await api.put(`/api/flags/${id}/response`, {
                data: { response: 'No explicit flagStatus' },
            });
            expect(res.ok()).toBeTruthy();
            const stored = await withDb((db) =>
                db.collection('flaggedQuestions').findOne({ flagId: id })
            );
            expect(stored.flagStatus).toBe('resolved');
            // EXPECTED: every resolved flag should carry a resolvedAt.
            expect(stored.resolvedAt).toBeTruthy();
        } finally {
            await api.dispose();
        }
    });
});

test.describe('FAILING: DELETE /api/flags/:flagId is missing role + ownership checks', () => {
    test('PRODUCT BUG: a student can delete any flag (no role gate)', async ({ baseURL }) => {
        // Seed a flag attributed to a DIFFERENT student (not the caller).
        const id = await seedFlagDoc({
            flagId: 'eb-del-other-student',
            studentIdForFlag: 'someone_else_user_id',
        });
        const api = await request.newContext({ baseURL, storageState: storageStatePath('student') });
        try {
            const res = await api.delete(`/api/flags/${id}`, { failOnStatusCode: false });
            // EXPECTED: the route should deny non-instructor/non-TA deletions
            // (and additionally enforce ownership for student-initiated
            // deletes). It currently returns 200 and deletes the doc.
            expect([401, 403]).toContain(res.status());
            const stillThere = await withDb((db) =>
                db.collection('flaggedQuestions').findOne({ flagId: id })
            );
            expect(stillThere).not.toBeNull();
        } finally {
            await api.dispose();
        }
    });
});

test.describe('FAILING: instructor/TA flag-response endpoints accept callers from any course', () => {
    test('PRODUCT BUG: an instructor not on the flag\'s course can still update the response', async ({ baseURL }) => {
        // Flag belongs to a course owned by instructor_fresh (COURSE_B). The
        // caller is e2e_instructor — they have NO relationship to COURSE_B.
        await seedCourse({ courseId: COURSE_B, instructorId: instructorFreshId });
        const id = await seedFlagDoc({
            flagId: 'eb-cross-instructor-resp',
            courseId: COURSE_B,
        });
        const api = await request.newContext({ baseURL, storageState: storageStatePath('instructor') });
        try {
            const res = await api.put(`/api/flags/${id}/response`, {
                data: { response: 'I do not belong to this course', flagStatus: 'reviewed' },
                failOnStatusCode: false,
            });
            // EXPECTED: 403 because the caller is not on COURSE_B. Today the
            // route allows any user with role === 'instructor'.
            expect(res.status()).toBe(403);
        } finally {
            await api.dispose();
        }
    });

    test('PRODUCT BUG: a TA not on the flag\'s course can still update the status', async ({ baseURL }) => {
        // Flag belongs to COURSE_B, but TA is NOT added to that course's tas
        // array. The TA role alone shouldn't grant cross-course access.
        await seedCourse({ courseId: COURSE_B, instructorId: instructorFreshId });
        const id = await seedFlagDoc({
            flagId: 'eb-cross-ta-status',
            courseId: COURSE_B,
        });
        const api = await request.newContext({ baseURL, storageState: storageStatePath('ta') });
        try {
            const res = await api.put(`/api/flags/${id}/status`, {
                data: { status: 'dismissed' },
                failOnStatusCode: false,
            });
            expect(res.status()).toBe(403);
        } finally {
            await api.dispose();
        }
    });
});
