/**
 * In-process route tests for src/routes/preview.js (supertest).
 *
 * The preview control plane is mounted without a role gate, so every handler
 * has to authorize for itself. These tests are mostly about the refusals: who
 * may open a preview at all, and the rule that a grant only ever works for the
 * user it was issued to.
 *
 * The other half is the teardown contract the feature promises out loud —
 * leaving a preview destroys the sandbox, and opening one never inherits data
 * from a previous visit.
 */
const { memoryDb } = require('../helpers/memory-db');
const { makeRouteApp, request } = require('../helpers/route-app');
const previewSession = require('../../../src/services/previewSession');
const router = require('../../../src/routes/preview');

const COURSE_ID = 'BIOC-302';
const OTHER_COURSE_ID = 'CHEM-101';

const instructor = {
    userId: 'inst-1',
    role: 'instructor',
    isActive: true,
    permissions: { systemAdmin: false }
};

const otherInstructor = {
    userId: 'inst-2',
    role: 'instructor',
    isActive: true,
    permissions: { systemAdmin: false }
};

const ta = {
    userId: 'ta-1',
    role: 'ta',
    isActive: true,
    permissions: { systemAdmin: false }
};

const student = {
    userId: 'stu-1',
    role: 'student',
    isActive: true,
    permissions: { systemAdmin: false }
};

const PREVIEW_ID = previewSession.buildPreviewUserId(instructor.userId, COURSE_ID);

beforeAll(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterAll(() => jest.restoreAllMocks());

/**
 * Session double carrying the express-session surface the routes touch.
 * @param {Object} [preview] - Grant to pre-install
 * @returns {Object} Session
 */
function makeSession(preview) {
    const session = { userId: instructor.userId, save: (cb) => cb(null) };
    if (preview) {
        session.preview = preview;
    }
    return session;
}

/**
 * Seed a database with the two courses these tests move between.
 * @param {Object} [extra] - Additional collections
 * @returns {Object} Memory database
 */
function makeDb(extra = {}) {
    return memoryDb({
        courses: [
            { courseId: COURSE_ID, courseName: 'Molecular Biology', status: 'active', instructorId: instructor.userId, instructors: [instructor.userId], tas: [ta.userId] },
            { courseId: OTHER_COURSE_ID, courseName: 'Intro Chem', status: 'active', instructorId: otherInstructor.userId, instructors: [otherInstructor.userId], tas: [] }
        ],
        users: [],
        previewStates: [],
        ...extra
    });
}

const app = (opts) => makeRouteApp(router, opts);

describe('POST /start', () => {
    test('401 when nobody is authenticated', async () => {
        const res = await request(app({ db: makeDb(), session: makeSession() })).post('/start').send({ courseId: COURSE_ID });
        expect(res.status).toBe(401);
    });

    test('400 without a courseId', async () => {
        const res = await request(app({ db: makeDb(), user: instructor, session: makeSession() })).post('/start').send({});
        expect(res.status).toBe(400);
    });

    test('403 for a student — previewing is a staff capability', async () => {
        const res = await request(app({ db: makeDb(), user: student, session: makeSession() }))
            .post('/start').send({ courseId: COURSE_ID });

        expect(res.status).toBe(403);
        expect(res.body.message).toMatch(/instructors, TAs, and system admins/i);
    });

    test('403 for an instructor reaching at a course they do not teach', async () => {
        const res = await request(app({ db: makeDb(), user: instructor, session: makeSession() }))
            .post('/start').send({ courseId: OTHER_COURSE_ID });

        expect(res.status).toBe(403);
        expect(res.body.message).toMatch(/do not have access/i);
    });

    test('403 for an unknown course', async () => {
        const res = await request(app({ db: makeDb(), user: instructor, session: makeSession() }))
            .post('/start').send({ courseId: 'NOPE-000' });

        expect(res.status).toBe(403);
        expect(res.body.message).toMatch(/not found/i);
    });

    test('a TA on the course may preview it', async () => {
        const res = await request(app({ db: makeDb(), user: ta, session: makeSession() }))
            .post('/start').send({ courseId: COURSE_ID });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });

    test('a system admin may preview a course they have no membership in', async () => {
        const admin = { userId: 'admin-1', role: 'instructor', isActive: true, permissions: { systemAdmin: true } };
        const res = await request(app({ db: makeDb(), user: admin, session: makeSession() }))
            .post('/start').send({ courseId: OTHER_COURSE_ID });

        expect(res.status).toBe(200);
    });

    test('issues a grant, creates the sandbox user, and returns a marked entry URL', async () => {
        const db = makeDb();
        const session = makeSession();
        const res = await request(app({ db, user: instructor, session })).post('/start').send({ courseId: COURSE_ID });

        expect(res.status).toBe(200);
        expect(res.body.grant.previewUserId).toBe(PREVIEW_ID);
        expect(res.body.firstRunCompleted).toBe(false);
        // The marker has to ride in the query string: a top-level navigation
        // cannot set the header the rest of the feature relies on.
        expect(res.body.entryUrl).toContain('preview=1');
        expect(res.body.entryUrl).toContain(encodeURIComponent(COURSE_ID));

        const sandboxUser = await db.collection('users').findOne({ userId: PREVIEW_ID });
        expect(sandboxUser.role).toBe('student');
        expect(sandboxUser.isPreview).toBe(true);
        expect(sandboxUser.permissions.systemAdmin).toBe(false);
        // Strictly false, not absent — the welcome flow only runs on false.
        expect(sandboxUser.studentOnboardingComplete).toBe(false);
    });

    test('can skip the tutorial for the disposable preview student only', async () => {
        const db = makeDb({
            users: [{ userId: student.userId, role: 'student', studentOnboardingComplete: false }]
        });

        const res = await request(app({ db, user: instructor, session: makeSession() }))
            .post('/start')
            .send({ courseId: COURSE_ID, skipTutorial: true });

        expect(res.status).toBe(200);
        expect(res.body.firstRunCompleted).toBe(true);

        const sandboxUser = await db.collection('users').findOne({ userId: PREVIEW_ID });
        const previewState = await db.collection('previewStates').findOne({ previewUserId: PREVIEW_ID });
        const realStudent = await db.collection('users').findOne({ userId: student.userId });

        expect(sandboxUser.studentOnboardingComplete).toBe(true);
        expect(previewState.firstRunCompleted).toBe(true);
        expect(realStudent.studentOnboardingComplete).toBe(false);
    });

    test('can skip the terms agreement for the disposable preview student only', async () => {
        const db = makeDb({
            userAgreements: [{ userId: student.userId, userType: 'student', hasAgreed: false }]
        });

        const res = await request(app({ db, user: instructor, session: makeSession() }))
            .post('/start')
            .send({ courseId: COURSE_ID, skipTermsAgreement: true });

        expect(res.status).toBe(200);

        const previewAgreement = await db.collection('userAgreements').findOne({ userId: PREVIEW_ID });
        const realAgreement = await db.collection('userAgreements').findOne({ userId: student.userId });

        expect(previewAgreement.hasAgreed).toBe(true);
        expect(realAgreement.hasAgreed).toBe(false);
    });

    test('does not record a terms agreement when skipTermsAgreement is not set', async () => {
        const db = makeDb();

        const res = await request(app({ db, user: instructor, session: makeSession() }))
            .post('/start')
            .send({ courseId: COURSE_ID });

        expect(res.status).toBe(200);
        expect(await db.collection('userAgreements').findOne({ userId: PREVIEW_ID })).toBeNull();
    });

    test('never inherits data from a previous visit, even if it was never exited', async () => {
        // Closing the tab skips /stop entirely, so opening a preview has to be
        // the second place the sandbox is guaranteed clean.
        const db = makeDb({
            chat_sessions: [{ sessionId: 'old', studentId: PREVIEW_ID, courseId: COURSE_ID }],
            quizAttempts: [{ studentId: PREVIEW_ID, courseId: COURSE_ID }],
            previewStates: [{ previewUserId: PREVIEW_ID, firstRunCompleted: true }]
        });

        const res = await request(app({ db, user: instructor, session: makeSession() }))
            .post('/start').send({ courseId: COURSE_ID });

        expect(res.status).toBe(200);
        expect(await db.collection('chat_sessions').findOne({ studentId: PREVIEW_ID })).toBeNull();
        expect(await db.collection('quizAttempts').findOne({ studentId: PREVIEW_ID })).toBeNull();
        // A wiped sandbox is a new student, so the walkthrough is ahead of it.
        expect(res.body.firstRunCompleted).toBe(false);
    });

    test('leaves a real student\'s chat sessions alone', async () => {
        const db = makeDb({
            chat_sessions: [{ sessionId: 'real', studentId: 'stu-1', courseId: COURSE_ID }]
        });

        await request(app({ db, user: instructor, session: makeSession() })).post('/start').send({ courseId: COURSE_ID });

        expect(await db.collection('chat_sessions').findOne({ studentId: 'stu-1' })).not.toBeNull();
    });
});

describe('POST /stop', () => {
    test('destroys the sandbox so no chat history survives the exit', async () => {
        const grant = previewSession.createGrant(instructor, COURSE_ID);
        const db = makeDb({
            chat_sessions: [
                { sessionId: 'preview-chat', studentId: PREVIEW_ID, courseId: COURSE_ID },
                { sessionId: 'real-chat', studentId: 'stu-1', courseId: COURSE_ID }
            ],
            quizAttempts: [{ studentId: PREVIEW_ID }],
            flashcardProgress: [{ studentId: PREVIEW_ID }],
            userAgreements: [{ userId: PREVIEW_ID }],
            users: [{ userId: PREVIEW_ID, isPreview: true, role: 'student' }],
            previewStates: [{ previewUserId: PREVIEW_ID, firstRunCompleted: true }]
        });
        const session = makeSession(grant);

        const res = await request(app({ db, user: instructor, session })).post('/stop').send({});

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(await db.collection('chat_sessions').findOne({ studentId: PREVIEW_ID })).toBeNull();
        expect(await db.collection('quizAttempts').findOne({ studentId: PREVIEW_ID })).toBeNull();
        expect(await db.collection('flashcardProgress').findOne({ studentId: PREVIEW_ID })).toBeNull();
        expect(await db.collection('userAgreements').findOne({ userId: PREVIEW_ID })).toBeNull();
        expect(await db.collection('users').findOne({ userId: PREVIEW_ID })).toBeNull();
        expect(await db.collection('previewStates').findOne({ previewUserId: PREVIEW_ID })).toBeNull();
        // And the real student's transcript is untouched.
        expect(await db.collection('chat_sessions').findOne({ studentId: 'stu-1' })).not.toBeNull();
    });

    test('revokes the grant so the tab stops being a preview', async () => {
        const grant = previewSession.createGrant(instructor, COURSE_ID);
        const session = makeSession(grant);

        await request(app({ db: makeDb(), user: instructor, session })).post('/stop').send({});

        expect(session.preview).toBeUndefined();
    });

    test('refuses to delete a sandbox belonging to somebody else', async () => {
        const foreignGrant = previewSession.createGrant(otherInstructor, COURSE_ID);
        const foreignId = foreignGrant.previewUserId;
        const db = makeDb({
            chat_sessions: [{ sessionId: 'theirs', studentId: foreignId, courseId: COURSE_ID }]
        });

        const res = await request(app({ db, user: instructor, session: makeSession(foreignGrant) })).post('/stop').send({});

        expect(res.status).toBe(200);
        expect(await db.collection('chat_sessions').findOne({ studentId: foreignId })).not.toBeNull();
    });

    test('succeeds when there is no preview to stop', async () => {
        const res = await request(app({ db: makeDb(), user: instructor, session: makeSession() })).post('/stop').send({});
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });
});

describe('GET /state', () => {
    test('reports inactive when no grant is held', async () => {
        const res = await request(app({ db: makeDb(), user: instructor, session: makeSession() })).get('/state');

        expect(res.status).toBe(200);
        expect(res.body.active).toBe(false);
    });

    test('reports the granted course by name', async () => {
        const grant = previewSession.createGrant(instructor, COURSE_ID);
        const res = await request(app({ db: makeDb(), user: instructor, session: makeSession(grant) })).get('/state');

        expect(res.body.active).toBe(true);
        expect(res.body.courseId).toBe(COURSE_ID);
        expect(res.body.courseName).toBe('Molecular Biology');
        expect(res.body.previewUserId).toBe(PREVIEW_ID);
    });

    test('ignores a grant issued to a different user', async () => {
        // Sessions outlive a logout on a shared machine, so ownership is
        // rechecked rather than trusted.
        const foreignGrant = previewSession.createGrant(otherInstructor, COURSE_ID);
        const res = await request(app({ db: makeDb(), user: instructor, session: makeSession(foreignGrant) })).get('/state');

        expect(res.body.active).toBe(false);
    });

    test('repairs a sandbox whose user record went missing mid-preview', async () => {
        const grant = previewSession.createGrant(instructor, COURSE_ID);
        const db = makeDb();

        await request(app({ db, user: instructor, session: makeSession(grant) })).get('/state');

        expect(await db.collection('users').findOne({ userId: PREVIEW_ID })).not.toBeNull();
    });
});

describe('POST /first-run', () => {
    test('403 without an active preview', async () => {
        const res = await request(app({ db: makeDb(), user: instructor, session: makeSession() }))
            .post('/first-run').send({ completed: true });

        expect(res.status).toBe(403);
    });

    test('marking it complete stops the walkthrough coming back', async () => {
        const grant = previewSession.createGrant(instructor, COURSE_ID);
        const db = makeDb({ users: [{ userId: PREVIEW_ID, isPreview: true, role: 'student' }] });

        const res = await request(app({ db, user: instructor, session: makeSession(grant) }))
            .post('/first-run').send({ completed: true });

        expect(res.body.firstRunCompleted).toBe(true);
        const user = await db.collection('users').findOne({ userId: PREVIEW_ID });
        expect(user.studentOnboardingComplete).toBe(true);
    });

    test('replaying puts the sandbox back to a brand-new student', async () => {
        const grant = previewSession.createGrant(instructor, COURSE_ID);
        const db = makeDb({
            users: [{ userId: PREVIEW_ID, isPreview: true, role: 'student', studentOnboardingComplete: true }],
            userAgreements: [{ userId: PREVIEW_ID, agreed: true }]
        });

        const res = await request(app({ db, user: instructor, session: makeSession(grant) }))
            .post('/first-run').send({ completed: false });

        expect(res.body.firstRunCompleted).toBe(false);
        const user = await db.collection('users').findOne({ userId: PREVIEW_ID });
        // The welcome flow is gated on strictly false, so replay has to write
        // the flag back rather than clear a flag of its own.
        expect(user.studentOnboardingComplete).toBe(false);
        // The agreement modal is part of what a new student sees.
        expect(await db.collection('userAgreements').findOne({ userId: PREVIEW_ID })).toBeNull();
    });
});

describe('POST /reset', () => {
    test('403 without an active preview', async () => {
        const res = await request(app({ db: makeDb(), user: instructor, session: makeSession() })).post('/reset').send({});
        expect(res.status).toBe(403);
    });

    test('clears sandbox data but keeps the user the open tab is about to reload with', async () => {
        const grant = previewSession.createGrant(instructor, COURSE_ID);
        const db = makeDb({
            chat_sessions: [{ sessionId: 'preview-chat', studentId: PREVIEW_ID, courseId: COURSE_ID }],
            users: [{ userId: PREVIEW_ID, isPreview: true, role: 'student', studentOnboardingComplete: true, struggleState: { topics: ['glycolysis'] } }]
        });

        const res = await request(app({ db, user: instructor, session: makeSession(grant) })).post('/reset').send({});

        expect(res.status).toBe(200);
        expect(await db.collection('chat_sessions').findOne({ studentId: PREVIEW_ID })).toBeNull();

        const user = await db.collection('users').findOne({ userId: PREVIEW_ID });
        expect(user).not.toBeNull();
        expect(user.struggleState).toEqual({ topics: [] });
        expect(user.studentOnboardingComplete).toBe(false);
    });

    test('refuses a grant belonging to another user', async () => {
        const foreignGrant = previewSession.createGrant(otherInstructor, COURSE_ID);
        const res = await request(app({ db: makeDb(), user: instructor, session: makeSession(foreignGrant) })).post('/reset').send({});

        expect(res.status).toBe(403);
    });
});
