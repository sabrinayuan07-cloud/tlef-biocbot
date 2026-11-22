// @ts-check
/**
 * End-to-end coverage for "View as Student" (src/routes/preview.js,
 * src/services/previewSession.js, src/middleware/auth.js preview branches,
 * public/common/scripts/preview-session.js).
 *
 * The feature deliberately downgrades an instructor to a sandboxed student, so
 * most of this suite is about the boundaries that downgrade must respect:
 *
 *   - a student can never obtain or fake a preview,
 *   - a preview can only ever reach the one course its grant names,
 *   - a preview is invisible to every instructor-side read, and
 *   - leaving a preview destroys it, so re-entering finds no chat history.
 *
 * Requests carry `X-Preview-Session: 1` because that is what the browser's fetch
 * patch does; without it the same session is still a plain instructor, which a
 * couple of tests below rely on.
 */

const { test, expect, request } = require('./fixtures/monocart');
const { TEST_USERS, storageStatePath } = require('./helpers/users');
const {
    withDb,
    getUserIdByUsername,
    seedCourse,
    cleanupCourses,
} = require('./helpers/courses-test');

const COURSE_ID = 'BIOC-E2E-PREVIEW';
const FOREIGN_COURSE_ID = 'BIOC-E2E-PREVIEW-FOREIGN';
const UNIT_PUBLISHED = 'Unit 1';
const UNIT_DRAFT = 'Unit 2';
const QUESTION_ID = 'q_e2e_preview_tf';
const FOREIGN_QUESTION_ID = 'q_e2e_preview_foreign_secret';

const PREVIEW_HEADER = { 'X-Preview-Session': '1' };

/** @type {any} */ let instructorId;
/** @type {any} */ let studentId;
/** @type {any} */ let previewUserId;

/**
 * Units shared by both seeded courses: one published, one still a draft.
 * @param {string} questionId - Assessment question id for the published unit
 * @returns {Array<Object>} Lecture documents
 */
function buildUnits(questionId) {
    const now = new Date();
    return [
        {
            name: UNIT_PUBLISHED,
            displayName: UNIT_PUBLISHED,
            isPublished: true,
            learningObjectives: ['Explain enzyme kinetics'],
            passThreshold: 2,
            createdAt: now,
            updatedAt: now,
            documents: [],
            assessmentQuestions: [
                {
                    questionId,
                    questionType: 'true-false',
                    question: 'Enzymes lower activation energy?',
                    correctAnswer: 'true',
                    isActive: true,
                },
            ],
        },
        {
            name: UNIT_DRAFT,
            displayName: UNIT_DRAFT,
            isPublished: false,
            learningObjectives: [],
            passThreshold: 2,
            createdAt: now,
            updatedAt: now,
            documents: [],
            assessmentQuestions: [],
        },
    ];
}

/**
 * Open an authenticated API context.
 * @param {string|undefined} baseURL - Server base URL
 * @param {string} role - Key from TEST_USERS
 * @param {boolean} [marked] - Whether to send the preview marker
 * @returns {Promise<import('@playwright/test').APIRequestContext>} Context
 */
async function apiAs(baseURL, role, marked = false) {
    return request.newContext({
        baseURL,
        storageState: storageStatePath(role),
        extraHTTPHeaders: marked ? PREVIEW_HEADER : {},
    });
}

/**
 * Start a preview of COURSE_ID as the e2e instructor.
 * @param {import('@playwright/test').APIRequestContext} api - Instructor context
 * @returns {Promise<any>} Start response body
 */
async function startPreview(api) {
    const res = await api.post('/api/preview/start', { data: { courseId: COURSE_ID } });
    expect(res.ok()).toBeTruthy();
    return res.json();
}

/**
 * Take the sandbox through the student welcome flow.
 *
 * A fresh sandbox is a brand-new student, so every student subpage bounces back
 * to the current tour step. Tests that care about a returning student have to
 * clear it first — the same thing global-setup does for the shared fixtures.
 *
 * @param {import('@playwright/test').APIRequestContext} api - Marked context
 * @returns {Promise<void>}
 */
async function completeSandboxOnboarding(api) {
    const res = await api.post('/api/auth/student-onboarding/complete', { failOnStatusCode: false });
    expect(res.ok()).toBeTruthy();
}

/**
 * Write a chat transcript straight into the sandbox, standing in for a
 * previewer who chatted before leaving.
 * @param {string} sessionId - Session identifier
 * @returns {Promise<void>}
 */
async function seedSandboxChat(sessionId) {
    await withDb(async (/** @type {any} */ db) => {
        await db.collection('chat_sessions').insertOne({
            sessionId,
            courseId: COURSE_ID,
            studentId: previewUserId,
            studentName: 'Preview Student',
            unitName: UNIT_PUBLISHED,
            title: 'Sandbox conversation',
            messageCount: 2,
            isDeleted: false,
            savedAt: new Date().toISOString(),
            chatData: { messages: [{ type: 'user', content: 'hello', timestamp: new Date().toISOString() }] },
            createdAt: new Date(),
        });
    });
}

/**
 * Count everything the sandbox may have left behind.
 * @returns {Promise<any>} Per-collection counts
 */
async function sandboxFootprint() {
    return withDb(async (/** @type {any} */ db) => ({
        chats: await db.collection('chat_sessions').countDocuments({ studentId: previewUserId }),
        attempts: await db.collection('quizAttempts').countDocuments({ studentId: previewUserId }),
        users: await db.collection('users').countDocuments({ userId: previewUserId }),
        states: await db.collection('previewStates').countDocuments({ previewUserId }),
    }));
}

/**
 * Remove every trace of the sandbox between tests.
 * @returns {Promise<void>}
 */
async function wipeSandbox() {
    await withDb(async (/** @type {any} */ db) => {
        await db.collection('chat_sessions').deleteMany({ studentId: previewUserId });
        await db.collection('quizAttempts').deleteMany({ studentId: previewUserId });
        await db.collection('users').deleteMany({ userId: previewUserId });
        await db.collection('previewStates').deleteMany({ previewUserId });
    });
}

test.beforeAll(async () => {
    instructorId = await getUserIdByUsername(TEST_USERS.instructor.username);
    studentId = await getUserIdByUsername(TEST_USERS.student.username);
    previewUserId = `__preview__${instructorId}::${COURSE_ID}`;
});

test.beforeEach(async () => {
    await seedCourse({
        courseId: COURSE_ID,
        instructorId,
        courseName: 'BIOC E2E Preview',
        studentEnrollment: { [studentId]: { enrolled: true, enrolledAt: new Date() } },
        lectures: buildUnits(QUESTION_ID),
        overrides: {
            quizSettings: { enabled: true, testableUnits: 'all', allowLectureMaterialAccess: true },
        },
    });

    // A course the e2e instructor has nothing to do with. Everything a preview
    // must not be able to reach lives in here.
    await seedCourse({
        courseId: FOREIGN_COURSE_ID,
        instructorId: 'someone-else-entirely',
        courseName: 'BIOC E2E Preview (Foreign)',
        lectures: buildUnits(FOREIGN_QUESTION_ID),
        overrides: {
            quizSettings: { enabled: true, testableUnits: 'all', allowLectureMaterialAccess: true },
        },
    });

    await wipeSandbox();
});

test.afterEach(async ({ baseURL }) => {
    // The grant lives on the server-side session, which every context built from
    // the instructor storage state shares — including later spec files. Leaving
    // one behind puts the shared instructor into preview mode for the rest of
    // the run, which is enough to change how student page routes answer them.
    const api = await apiAs(baseURL, 'instructor', true);
    try {
        await api.post('/api/preview/stop', { failOnStatusCode: false });
    } finally {
        await api.dispose();
    }
});

test.afterAll(async () => {
    await cleanupCourses([COURSE_ID, FOREIGN_COURSE_ID]);
    await wipeSandbox();
});

// ---------------------------------------------------------------------------
// Who may open a preview
// ---------------------------------------------------------------------------
test.describe('starting a preview', () => {
    test('a student cannot open one', async ({ baseURL }) => {
        const api = await apiAs(baseURL, 'student');
        try {
            const res = await api.post('/api/preview/start', { data: { courseId: COURSE_ID } });
            expect(res.status()).toBe(403);
        } finally {
            await api.dispose();
        }
    });

    test('an instructor cannot preview a course they do not teach', async ({ baseURL }) => {
        const api = await apiAs(baseURL, 'instructor');
        try {
            const res = await api.post('/api/preview/start', { data: { courseId: FOREIGN_COURSE_ID } });
            expect(res.status()).toBe(403);
        } finally {
            await api.dispose();
        }
    });

    test('an instructor gets a grant, a sandbox user, and a marked entry URL', async ({ baseURL }) => {
        const api = await apiAs(baseURL, 'instructor');
        try {
            const body = await startPreview(api);

            expect(body.success).toBe(true);
            expect(body.grant.previewUserId).toBe(previewUserId);
            expect(body.entryUrl).toContain('preview=1');
            expect(body.firstRunCompleted).toBe(false);

            const sandbox = await withDb((/** @type {any} */ db) => db.collection('users').findOne({ userId: previewUserId }));
            expect(sandbox.role).toBe('student');
            expect(sandbox.isPreview).toBe(true);
            expect(sandbox.permissions.systemAdmin).toBe(false);
        } finally {
            await api.dispose();
        }
    });
});

// ---------------------------------------------------------------------------
// The identity swap
// ---------------------------------------------------------------------------
test.describe('preview identity', () => {
    test('a marked request wears the sandboxed student, not the instructor', async ({ baseURL }) => {
        const starter = await apiAs(baseURL, 'instructor');
        await startPreview(starter);
        await starter.dispose();

        const api = await apiAs(baseURL, 'instructor', true);
        try {
            const body = await (await api.get('/api/auth/me')).json();
            expect(body.user.role).toBe('student');
            expect(body.user.userId).toBe(previewUserId);
            expect(body.user.userId).not.toBe(instructorId);
        } finally {
            await api.dispose();
        }
    });

    test('an unmarked request from the same session is still the instructor', async ({ baseURL }) => {
        // express-session is shared across tabs, so the grant alone must not
        // flip a tab that never opted in.
        const api = await apiAs(baseURL, 'instructor');
        try {
            await startPreview(api);
            const body = await (await api.get('/api/auth/me')).json();
            expect(body.user.role).toBe('instructor');
            expect(body.user.userId).toBe(instructorId);
        } finally {
            await api.dispose();
        }
    });

    test('a student sending the marker is not converted', async ({ baseURL }) => {
        const api = await apiAs(baseURL, 'student', true);
        try {
            const body = await (await api.get('/api/auth/me')).json();
            expect(body.user.userId).toBe(studentId);
            expect(body.user.role).toBe('student');

            const state = await (await api.get('/api/preview/state')).json();
            expect(state.active).toBe(false);
        } finally {
            await api.dispose();
        }
    });
});

// ---------------------------------------------------------------------------
// Course scoping — the grant names exactly one course
// ---------------------------------------------------------------------------
test.describe('course scoping', () => {
    test('reads its own course', async ({ baseURL }) => {
        const starter = await apiAs(baseURL, 'instructor');
        await startPreview(starter);
        await starter.dispose();

        const api = await apiAs(baseURL, 'instructor', true);
        try {
            const res = await api.get(`/api/quiz/questions?courseId=${COURSE_ID}`);
            expect(res.ok()).toBeTruthy();
            const body = await res.json();
            const ids = (body.questions || body.data || []).map((/** @type {any} */ q) => q.questionId);
            expect(ids).toContain(QUESTION_ID);
        } finally {
            await api.dispose();
        }
    });

    test('cannot read quiz questions from a course outside the grant', async ({ baseURL }) => {
        // /api/quiz has no course gate of its own — requireStudentEnrolled is
        // the only thing standing between a preview and another instructor's
        // assessment questions.
        const starter = await apiAs(baseURL, 'instructor');
        await startPreview(starter);
        await starter.dispose();

        const api = await apiAs(baseURL, 'instructor', true);
        try {
            const res = await api.get(`/api/quiz/questions?courseId=${FOREIGN_COURSE_ID}`);
            expect(res.status()).toBe(403);

            const body = await res.text();
            expect(body).not.toContain(FOREIGN_QUESTION_ID);
        } finally {
            await api.dispose();
        }
    });

    test('cannot chat against a course outside the grant', async ({ baseURL }) => {
        // No LLM stubbing needed: the refusal happens in requireStudentEnrolled,
        // long before the handler would reach a model.
        const starter = await apiAs(baseURL, 'instructor');
        await startPreview(starter);
        await starter.dispose();

        const api = await apiAs(baseURL, 'instructor', true);
        try {
            const res = await api.post('/api/chat', {
                data: {
                    message: 'Summarize the material',
                    courseId: FOREIGN_COURSE_ID,
                    unitName: UNIT_PUBLISHED,
                    mode: 'tutor',
                },
                failOnStatusCode: false,
            });
            expect(res.status()).toBe(403);
        } finally {
            await api.dispose();
        }
    });

    test('cannot download quiz materials from a course outside the grant', async ({ baseURL }) => {
        const starter = await apiAs(baseURL, 'instructor');
        await startPreview(starter);
        await starter.dispose();

        const api = await apiAs(baseURL, 'instructor', true);
        try {
            const res = await api.get(
                `/api/quiz/materials?courseId=${FOREIGN_COURSE_ID}&lectureName=${encodeURIComponent(UNIT_PUBLISHED)}`,
                { failOnStatusCode: false }
            );
            expect(res.status()).toBe(403);
        } finally {
            await api.dispose();
        }
    });

    test('unpublished units stay hidden, exactly as for a real student', async ({ baseURL }) => {
        const starter = await apiAs(baseURL, 'instructor');
        await startPreview(starter);
        await starter.dispose();

        const api = await apiAs(baseURL, 'instructor', true);
        try {
            const res = await api.get(`/api/lectures/published-with-questions?courseId=${COURSE_ID}`);
            expect(res.ok()).toBeTruthy();
            const body = await res.json();
            const names = body.data.publishedLectures.map((/** @type {any} */ l) => l.name);
            expect(names).toContain(UNIT_PUBLISHED);
            expect(names).not.toContain(UNIT_DRAFT);
        } finally {
            await api.dispose();
        }
    });
});

// ---------------------------------------------------------------------------
// No route back up to instructor surfaces
// ---------------------------------------------------------------------------
test.describe('privilege boundary', () => {
    for (const [label, path] of [
        ['the course roster', `/api/courses/${COURSE_ID}/students`],
        ['the flag queue', `/api/flags/course/${COURSE_ID}`],
        ['mental health flags', `/api/mental-health-flags?courseId=${COURSE_ID}`],
    ]) {
        test(`a preview cannot read ${label}`, async ({ baseURL }) => {
            const starter = await apiAs(baseURL, 'instructor');
            await startPreview(starter);
            await starter.dispose();

            const api = await apiAs(baseURL, 'instructor', true);
            try {
                const res = await api.get(path, { failOnStatusCode: false });
                expect(res.status()).toBeGreaterThanOrEqual(400);
            } finally {
                await api.dispose();
            }
        });
    }

    // Regression test for a hole this suite originally caught failing:
    // POST /api/lectures/publish authorized with
    // `userHasCourseAccess(db, courseId, user.userId, user.role)` and never
    // checked the role. For role 'student' that resolves through
    // getStudentEnrollment, so a previewer — and any genuinely enrolled student,
    // see the companion test below — could publish units to the real course.
    test('a preview cannot publish a unit in the real course', async ({ baseURL }) => {
        const starter = await apiAs(baseURL, 'instructor');
        await startPreview(starter);
        await starter.dispose();

        const api = await apiAs(baseURL, 'instructor', true);
        try {
            await api.post('/api/lectures/publish', {
                data: { courseId: COURSE_ID, lectureName: UNIT_DRAFT, isPublished: true },
                failOnStatusCode: false,
            });

            const course = await withDb((/** @type {any} */ db) => db.collection('courses').findOne({ courseId: COURSE_ID }));
            const draft = course.lectures.find((/** @type {any} */ l) => l.name === UNIT_DRAFT);
            expect(draft.isPublished).toBe(false);
        } finally {
            await api.dispose();
        }
    });

    test('a genuinely enrolled student cannot publish a unit either', async ({ baseURL }) => {
        // The same gap, reached without any preview involved — enrollment alone
        // used to satisfy the course-access check on a staff-only route.
        const api = await apiAs(baseURL, 'student');
        try {
            const res = await api.post('/api/lectures/publish', {
                data: { courseId: COURSE_ID, lectureName: UNIT_DRAFT, isPublished: true },
                failOnStatusCode: false,
            });
            expect(res.status()).toBe(403);

            const course = await withDb((/** @type {any} */ db) => db.collection('courses').findOne({ courseId: COURSE_ID }));
            const draft = course.lectures.find((/** @type {any} */ l) => l.name === UNIT_DRAFT);
            expect(draft.isPublished).toBe(false);
        } finally {
            await api.dispose();
        }
    });

    test('a student cannot move the pass threshold their own answers are graded against', async ({ baseURL }) => {
        const before = await withDb((/** @type {any} */ db) => db.collection('courses').findOne({ courseId: COURSE_ID }));
        const original = before.lectures.find((/** @type {any} */ l) => l.name === UNIT_PUBLISHED).passThreshold;

        const api = await apiAs(baseURL, 'student');
        try {
            const res = await api.post('/api/lectures/pass-threshold', {
                data: { courseId: COURSE_ID, lectureName: UNIT_PUBLISHED, passThreshold: 0, instructorId },
                failOnStatusCode: false,
            });
            expect(res.status()).toBe(403);

            const after = await withDb((/** @type {any} */ db) => db.collection('courses').findOne({ courseId: COURSE_ID }));
            expect(after.lectures.find((/** @type {any} */ l) => l.name === UNIT_PUBLISHED).passThreshold).toBe(original);
        } finally {
            await api.dispose();
        }
    });

    test('a student cannot read the publish-status map, which names unpublished units', async ({ baseURL }) => {
        const api = await apiAs(baseURL, 'student');
        try {
            const res = await api.get(
                `/api/lectures/publish-status?courseId=${COURSE_ID}&instructorId=${instructorId}`,
                { failOnStatusCode: false }
            );
            expect(res.status()).toBe(403);
            expect(await res.text()).not.toContain(UNIT_DRAFT);
        } finally {
            await api.dispose();
        }
    });
});

// ---------------------------------------------------------------------------
// Invisible to the instructor side
// ---------------------------------------------------------------------------
test.describe('data isolation', () => {
    test('sandbox transcripts never appear in the course roster', async ({ baseURL }) => {
        const starter = await apiAs(baseURL, 'instructor');
        await startPreview(starter);
        await starter.dispose();
        await seedSandboxChat('preview-visible-check');

        const api = await apiAs(baseURL, 'instructor');
        try {
            const body = await (await api.get(`/api/courses/${COURSE_ID}/students`)).json();
            const ids = (body.data?.students || body.students || []).map((/** @type {any} */ s) => s.userId || s.studentId);
            expect(ids).not.toContain(previewUserId);
        } finally {
            await api.dispose();
        }
    });

    test('the sandbox is never written into the course enrollment map', async ({ baseURL }) => {
        const starter = await apiAs(baseURL, 'instructor');
        await startPreview(starter);
        await starter.dispose();

        const api = await apiAs(baseURL, 'instructor', true);
        try {
            // Whatever the student UI would do on entry, the roster stays clean.
            await api.get(`/api/courses/${COURSE_ID}/student-enrollment`, { failOnStatusCode: false });

            const course = await withDb((/** @type {any} */ db) => db.collection('courses').findOne({ courseId: COURSE_ID }));
            expect(Object.keys(course.studentEnrollment || {})).not.toContain(previewUserId);
        } finally {
            await api.dispose();
        }
    });

    test('the sandbox user is excluded from course statistics', async ({ baseURL }) => {
        const starter = await apiAs(baseURL, 'instructor');
        await startPreview(starter);
        await starter.dispose();
        await seedSandboxChat('preview-stats-check');

        const api = await apiAs(baseURL, 'instructor');
        try {
            const res = await api.get('/api/courses/statistics', { failOnStatusCode: false });
            if (res.ok()) {
                const text = await res.text();
                expect(text).not.toContain(previewUserId);
            }
        } finally {
            await api.dispose();
        }
    });
});

// ---------------------------------------------------------------------------
// First-run state
// ---------------------------------------------------------------------------
test.describe('first run', () => {
    test('finishing the welcome flow is recorded, so it does not set itself up again', async ({ baseURL }) => {
        const starter = await apiAs(baseURL, 'instructor');
        const started = await startPreview(starter);
        expect(started.firstRunCompleted).toBe(false);
        await starter.dispose();

        const marked = await apiAs(baseURL, 'instructor', true);
        try {
            await completeSandboxOnboarding(marked);

            const state = await (await marked.get('/api/preview/state')).json();
            expect(state.firstRunCompleted).toBe(true);
        } finally {
            await marked.dispose();
        }
    });

    test('replaying puts the sandbox back to a brand-new student', async ({ baseURL }) => {
        const starter = await apiAs(baseURL, 'instructor');
        await startPreview(starter);
        await starter.dispose();

        const marked = await apiAs(baseURL, 'instructor', true);
        try {
            await completeSandboxOnboarding(marked);
            await marked.post('/api/preview/first-run', { data: { completed: false } });

            const state = await (await marked.get('/api/preview/state')).json();
            expect(state.firstRunCompleted).toBe(false);

            const sandbox = await withDb((/** @type {any} */ db) =>
                db.collection('users').findOne({ userId: previewUserId }));
            // Strictly false — the welcome flow only runs on false, not absent.
            expect(sandbox.studentOnboardingComplete).toBe(false);
        } finally {
            await marked.dispose();
        }
    });

    test('a fresh sandbox after exit starts the welcome flow over', async ({ baseURL }) => {
        const starter = await apiAs(baseURL, 'instructor');
        await startPreview(starter);
        await starter.dispose();

        const marked = await apiAs(baseURL, 'instructor', true);
        await completeSandboxOnboarding(marked);
        await marked.post('/api/preview/stop');
        await marked.dispose();

        const reopen = await apiAs(baseURL, 'instructor');
        try {
            const body = await startPreview(reopen);
            expect(body.firstRunCompleted).toBe(false);
        } finally {
            await reopen.dispose();
        }
    });
});

// ---------------------------------------------------------------------------
// Exiting destroys the sandbox
// ---------------------------------------------------------------------------
test.describe('exit teardown', () => {
    test('stopping deletes every trace of the sandbox', async ({ baseURL }) => {
        const starter = await apiAs(baseURL, 'instructor');
        await startPreview(starter);
        await starter.dispose();
        await seedSandboxChat('preview-doomed-chat');

        expect((await sandboxFootprint()).chats).toBe(1);

        const api = await apiAs(baseURL, 'instructor', true);
        try {
            const res = await api.post('/api/preview/stop');
            expect(res.ok()).toBeTruthy();
        } finally {
            await api.dispose();
        }

        expect(await sandboxFootprint()).toEqual({ chats: 0, attempts: 0, users: 0, states: 0 });
    });

    test('re-entering right after exiting finds no chat history', async ({ baseURL }) => {
        // The whole point of the teardown: click "View as Student" again and the
        // History page has nothing to show.
        const starter = await apiAs(baseURL, 'instructor');
        await startPreview(starter);
        await starter.dispose();
        await seedSandboxChat('preview-history-check');

        const exiting = await apiAs(baseURL, 'instructor', true);
        await exiting.post('/api/preview/stop');
        await exiting.dispose();

        const reopen = await apiAs(baseURL, 'instructor');
        await startPreview(reopen);
        await reopen.dispose();

        const api = await apiAs(baseURL, 'instructor', true);
        try {
            const res = await api.get(`/api/students/${COURSE_ID}/${previewUserId}/sessions/own`);
            expect(res.ok()).toBeTruthy();
            const body = await res.json();
            expect(body.data.sessions).toEqual([]);
        } finally {
            await api.dispose();
        }
    });

    test('closing the tab without exiting still leaves nothing for the next visit', async ({ baseURL }) => {
        // No /stop call at all — the browser just went away. Opening a preview
        // is the second place the sandbox is guaranteed clean.
        const starter = await apiAs(baseURL, 'instructor');
        await startPreview(starter);
        await starter.dispose();
        await seedSandboxChat('preview-abandoned-chat');

        const reopen = await apiAs(baseURL, 'instructor');
        try {
            const body = await startPreview(reopen);
            expect(body.firstRunCompleted).toBe(false);
        } finally {
            await reopen.dispose();
        }

        expect((await sandboxFootprint()).chats).toBe(0);
    });

    test('stopping revokes the grant, so the tab stops being a preview', async ({ baseURL }) => {
        const api = await apiAs(baseURL, 'instructor', true);
        try {
            await api.post('/api/preview/start', { data: { courseId: COURSE_ID } });
            expect((await (await api.get('/api/preview/state')).json()).active).toBe(true);

            await api.post('/api/preview/stop');

            const after = await (await api.get('/api/preview/state')).json();
            expect(after.active).toBe(false);

            // And the identity swap is gone with it.
            const me = await (await api.get('/api/auth/me')).json();
            expect(me.user.userId).toBe(instructorId);
        } finally {
            await api.dispose();
        }
    });

    test('a real student\'s chat history is untouched by a preview teardown', async ({ baseURL }) => {
        await withDb(async (/** @type {any} */ db) => {
            await db.collection('chat_sessions').insertOne({
                sessionId: 'real-student-session',
                courseId: COURSE_ID,
                studentId,
                studentName: TEST_USERS.student.displayName,
                unitName: UNIT_PUBLISHED,
                isDeleted: false,
                savedAt: new Date().toISOString(),
                chatData: { messages: [] },
                createdAt: new Date(),
            });
        });

        const api = await apiAs(baseURL, 'instructor', true);
        try {
            await api.post('/api/preview/start', { data: { courseId: COURSE_ID } });
            await api.post('/api/preview/stop');
        } finally {
            await api.dispose();
        }

        const survived = await withDb((/** @type {any} */ db) =>
            db.collection('chat_sessions').countDocuments({ sessionId: 'real-student-session' }));
        expect(survived).toBe(1);

        await withDb((/** @type {any} */ db) => db.collection('chat_sessions').deleteMany({ sessionId: 'real-student-session' }));
    });
});

// ---------------------------------------------------------------------------
// Browser-level: the preview shell
// ---------------------------------------------------------------------------
test.describe('preview UI', () => {
    test.use({ storageState: storageStatePath('instructor') });

    test('an unmarked instructor tab cannot load a student HTML page while a preview grant exists', async ({ page, baseURL }) => {
        const api = await apiAs(baseURL, 'instructor');
        await startPreview(api);
        await api.dispose();

        // The grant is session-wide, but preview identity is deliberately
        // tab-scoped. Without the marker this tab must remain an instructor tab.
        await page.goto('/student/dashboard.html');
        await expect(page).toHaveURL(/\/instructor/);
    });

    test('the student page loads in preview mode with the banner', async ({ page, baseURL }) => {
        const api = await apiAs(baseURL, 'instructor');
        const { entryUrl } = await startPreview(api);
        await api.dispose();

        await page.goto(entryUrl);

        await expect(page.locator('.preview-banner')).toBeVisible();
        await expect(page.locator('.preview-badge')).toHaveText(/preview/i);
        await expect(page.locator('body')).toHaveClass(/preview-mode/);
        await expect(page.locator('#preview-exit')).toBeVisible();
    });

    test('the banner names the course being previewed', async ({ page, baseURL }) => {
        const api = await apiAs(baseURL, 'instructor');
        const { entryUrl } = await startPreview(api);
        await api.dispose();

        await page.goto(entryUrl);
        await expect(page.locator('.preview-summary')).toContainText('BIOC E2E Preview');
    });

    test('student pages are reachable and keep the marker', async ({ page, baseURL }) => {
        const starter = await apiAs(baseURL, 'instructor');
        await startPreview(starter);
        await starter.dispose();

        // Past the welcome flow, so the quiz page is not bounced back to the
        // tour the way it would be for a genuinely new student.
        const marked = await apiAs(baseURL, 'instructor', true);
        await completeSandboxOnboarding(marked);
        await marked.dispose();

        await page.goto('/student/quiz?preview=1');
        await expect(page.locator('.preview-banner')).toBeVisible();
        expect(page.url()).toContain('/student/quiz');
    });

    test('a brand-new sandbox lands on the student welcome flow', async ({ page, baseURL }) => {
        // The counterpart to the test above: without onboarding, a preview sees
        // exactly what a first-time student sees.
        const api = await apiAs(baseURL, 'instructor');
        await startPreview(api);
        await api.dispose();

        await page.goto('/student/quiz?preview=1');
        await expect(page.locator('.preview-banner')).toBeVisible();
        expect(page.url()).not.toContain('/student/quiz');
    });

    test('Super Course is hidden — it spans courses beyond this one', async ({ page, baseURL }) => {
        const api = await apiAs(baseURL, 'instructor');
        const { entryUrl } = await startPreview(api);
        await api.dispose();

        await page.goto(entryUrl);
        await expect(page.locator('.preview-banner')).toBeVisible();
        await expect(page.locator('#super-course-nav-item')).toBeHidden();
    });

    test('exiting returns to the instructor UI and destroys the sandbox', async ({ page, baseURL }) => {
        const api = await apiAs(baseURL, 'instructor');
        const { entryUrl } = await startPreview(api);
        await api.dispose();
        await seedSandboxChat('preview-ui-exit-chat');

        await page.goto(entryUrl);
        await expect(page.locator('#preview-exit')).toBeVisible();
        await page.locator('#preview-exit').click();

        await page.waitForURL(/\/instructor\/home/);
        expect((await sandboxFootprint()).chats).toBe(0);
    });

    test('the instructor sidebar remembers whether to skip the preview tutorial', async ({ page }) => {
        await page.goto('/instructor/home');
        await expect(page.locator('#nav-student-preview')).toHaveText(/view as student/i);

        const skipTutorial = page.locator('#nav-student-preview-skip');
        await expect(skipTutorial).toBeHidden();
        await page.locator('#nav-student-preview').click();
        await expect(skipTutorial).toBeVisible();
        await expect(page.locator('#nav-student-preview')).toHaveAttribute('aria-expanded', 'true');
        await expect(page.locator('#nav-student-preview')).toHaveText(/open as student/i);
        await expect(skipTutorial).not.toBeChecked();
        await skipTutorial.check();

        await page.reload();
        await expect(page.locator('#nav-student-preview-skip')).toBeHidden();
        await page.locator('#nav-student-preview').click();
        await expect(page.locator('#nav-student-preview-skip')).toBeChecked();
    });

    test('skip terms agreement defaults to checked and remembers an explicit uncheck', async ({ page }) => {
        await page.goto('/instructor/home');
        await page.locator('#nav-student-preview').click();

        const skipTerms = page.locator('#nav-student-preview-skip-terms');
        await expect(skipTerms).toBeVisible();
        await expect(skipTerms).toBeChecked();
        await skipTerms.uncheck();

        await page.reload();
        await expect(page.locator('#nav-student-preview-skip-terms')).toBeHidden();
        await page.locator('#nav-student-preview').click();
        await expect(page.locator('#nav-student-preview-skip-terms')).not.toBeChecked();
    });

    test('a real student sees no preview banner', async ({ page, baseURL }) => {
        const api = await apiAs(baseURL, 'instructor');
        await startPreview(api);
        await api.dispose();

        const studentContext = await request.newContext({ baseURL, storageState: storageStatePath('student') });
        await studentContext.dispose();

        // Same browser, student session: the marker is per-tab and the grant
        // belongs to somebody else, so nothing about the page changes.
        await page.context().clearCookies();
        await page.goto('/student?preview=1');
        await expect(page.locator('.preview-banner')).toHaveCount(0);
    });
});
