/**
 * In-process route tests for src/routes/mentalHealthFlags.js (supertest).
 *
 * No heavy deps: the router reads the MentalHealthFlag model over the in-memory
 * Mongo double and the pure `authorization` service for the admin check. Covers
 * anonymization for non-admins, the admin-only status transitions, and the db guard.
 */
const { memoryDb } = require('../helpers/memory-db');
const { makeRouteApp, request } = require('../helpers/route-app');
const router = require('../../../src/routes/mentalHealthFlags');

const instructor = { userId: 'i1', role: 'instructor' };
const admin = { userId: 'a1', role: 'instructor', permissions: { systemAdmin: true } };
const app = (opts) => makeRouteApp(router, opts);
const course = { courseId: 'C1', instructorId: 'i1', tas: ['t1'] };
const mentalDb = (data = {}) => memoryDb({ courses: [course], ...data });

const flag = (over = {}) => ({
    flagId: 'mhf_1', studentId: 's1', studentName: 'Jane Student', courseId: 'C1',
    unitName: 'Unit 1', message: 'I feel hopeless', concernLevel: 'high concern',
    status: 'pending', createdAt: new Date('2026-06-20T10:00:00Z'), ...over,
});

beforeAll(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterAll(() => jest.restoreAllMocks());

describe('GET /course/:courseId', () => {
    test('503 when the db is unavailable', async () => {
        const res = await request(app({ db: null, user: instructor })).get('/course/C1');
        expect(res.status).toBe(503);
    });

    test('requires authentication and membership on the requested course', async () => {
        const db = mentalDb({ mentalHealthFlags: [flag()] });
        expect((await request(app({ db })).get('/course/C1')).status).toBe(401);
        expect((await request(app({ db, user: { userId: 'i2', role: 'instructor' } })).get('/course/C1')).status).toBe(403);
    });

    test('non-admin gets anonymized flags (no studentId, generic name) and isAdmin:false', async () => {
        const db = mentalDb({ mentalHealthFlags: [flag()] });
        const res = await request(app({ db, user: instructor })).get('/course/C1');
        expect(res.status).toBe(200);
        expect(res.body.isAdmin).toBe(false);
        expect(res.body.flags[0].studentName).toBe('Anonymous Student');
        expect(res.body.flags[0].studentId).toBeUndefined();
        expect(res.body.stats).toMatchObject({ total: 1, pending: 1 });
    });

    test('admin sees real student identity and isAdmin:true', async () => {
        const db = mentalDb({ mentalHealthFlags: [flag()] });
        const res = await request(app({ db, user: admin })).get('/course/C1');
        expect(res.status).toBe(200);
        expect(res.body.isAdmin).toBe(true);
        expect(res.body.flags[0]).toMatchObject({ studentId: 's1', studentName: 'Jane Student' });
    });

    test('status query param filters the returned flags', async () => {
        const db = mentalDb({ mentalHealthFlags: [
            flag({ flagId: 'a', status: 'pending' }),
            flag({ flagId: 'b', status: 'escalated' }),
        ] });
        const res = await request(app({ db, user: admin })).get('/course/C1?status=escalated');
        expect(res.status).toBe(200);
        expect(res.body.flags.map(f => f.flagId)).toEqual(['b']);
    });
});

describe('PUT /:flagId/escalate', () => {
    test('escalates a flag and records the escalating instructor', async () => {
        const db = mentalDb({ mentalHealthFlags: [flag()] });
        const res = await request(app({ db, user: instructor })).put('/mhf_1/escalate');
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        const saved = await db.collection('mentalHealthFlags').findOne({ flagId: 'mhf_1' });
        expect(saved).toMatchObject({ status: 'escalated', escalatedBy: 'i1' });
    });

    test('reports failure (success:false) when the flag does not exist', async () => {
        const db = mentalDb({ mentalHealthFlags: [] });
        const res = await request(app({ db, user: instructor })).put('/missing/escalate');
        expect(res.status).toBe(404);
        expect(res.body.success).toBe(false);
    });

    test('rejects anonymous and non-owning instructors', async () => {
        const db = mentalDb({ mentalHealthFlags: [flag()] });
        expect((await request(app({ db })).put('/mhf_1/escalate')).status).toBe(401);
        expect((await request(app({ db, user: { userId: 'i2', role: 'instructor' } })).put('/mhf_1/escalate')).status).toBe(403);
    });
});

describe('PUT /:flagId/dismiss', () => {
    test('marks a flag dismissed', async () => {
        const db = mentalDb({ mentalHealthFlags: [flag()] });
        const res = await request(app({ db, user: instructor })).put('/mhf_1/dismiss');
        expect(res.status).toBe(200);
        expect((await db.collection('mentalHealthFlags').findOne({ flagId: 'mhf_1' })).status).toBe('dismissed');
    });
});

describe('PUT /:flagId/resolve — admin only', () => {
    test('403 for a non-admin instructor', async () => {
        const db = memoryDb({ mentalHealthFlags: [flag({ status: 'escalated' })] });
        const res = await request(app({ db, user: instructor })).put('/mhf_1/resolve');
        expect(res.status).toBe(403);
        // Unchanged.
        expect((await db.collection('mentalHealthFlags').findOne({ flagId: 'mhf_1' })).status).toBe('escalated');
    });

    test('admin resolves and is recorded as resolvedBy', async () => {
        const db = memoryDb({ mentalHealthFlags: [flag({ status: 'escalated' })] });
        const res = await request(app({ db, user: admin })).put('/mhf_1/resolve');
        expect(res.status).toBe(200);
        const saved = await db.collection('mentalHealthFlags').findOne({ flagId: 'mhf_1' });
        expect(saved).toMatchObject({ status: 'resolved', resolvedBy: 'a1' });
    });
});

describe('PUT /:flagId/disregard — admin only', () => {
    test('403 for a non-admin instructor', async () => {
        const res = await request(app({ db: memoryDb({ mentalHealthFlags: [flag()] }), user: instructor })).put('/mhf_1/disregard');
        expect(res.status).toBe(403);
    });

    test('admin disregards and is recorded as resolvedBy', async () => {
        const db = memoryDb({ mentalHealthFlags: [flag({ status: 'escalated' })] });
        const res = await request(app({ db, user: admin })).put('/mhf_1/disregard');
        expect(res.status).toBe(200);
        expect((await db.collection('mentalHealthFlags').findOne({ flagId: 'mhf_1' })).resolvedBy).toBe('a1');
    });
});

describe('model failure paths (500)', () => {
    const MentalHealthFlag = require('../../../src/models/MentalHealthFlag');

    test('GET /course/:courseId 500 when the model throws', async () => {
        const spy = jest.spyOn(MentalHealthFlag, 'getMentalHealthFlagsForCourse').mockRejectedValueOnce(new Error('mongo down'));
        const res = await request(app({ db: mentalDb(), user: instructor })).get('/course/C1');
        expect(res.status).toBe(500);
        expect(res.body.message).toMatch(/Failed to fetch/i);
        spy.mockRestore();
    });

    test.each([
        ['escalate', instructor, /Failed to escalate/i],
        ['dismiss', instructor, /Failed to dismiss/i],
        ['resolve', { userId: 'a1', role: 'instructor', permissions: { systemAdmin: true } }, /Failed to resolve/i],
        ['disregard', { userId: 'a1', role: 'instructor', permissions: { systemAdmin: true } }, /Failed to disregard/i],
    ])('PUT /:flagId/%s 500 when the model throws', async (action, user, message) => {
        const spy = jest.spyOn(MentalHealthFlag, 'updateFlagStatus').mockRejectedValueOnce(new Error('mongo down'));
        const res = await request(app({ db: mentalDb({ mentalHealthFlags: [flag()] }), user })).put(`/mhf_1/${action}`);
        expect(res.status).toBe(500);
        expect(res.body.message).toMatch(message);
        spy.mockRestore();
    });
});

describe('TA access gated on the transcripts permission', () => {
    // Gated on 'transcripts', not 'flags'/'roster' - requireCourseStaff in
    // mentalHealthFlags.js deliberately keeps raw flagged-conversation
    // content separate from the student-support/roster permissions.
    const taCourse = (permissions) => ({
        courseId: 'C1', instructorId: 'i1', tas: ['t1'],
        taPermissions: { t1: permissions }, taPermissionsMigrated: true,
    });
    const ta = { userId: 't1', role: 'ta' };

    test('GET /course/:courseId: 200 for a TA with transcripts, 403 without it', async () => {
        const allowed = mentalDb({
            courses: [taCourse({ materials: false, questions: false, settings: false, transcripts: true, flags: false, roster: false })],
            mentalHealthFlags: [flag()],
        });
        const resAllowed = await request(app({ db: allowed, user: ta })).get('/course/C1');
        expect(resAllowed.status).toBe(200);
        expect(resAllowed.body.flags[0].studentName).toBe('Anonymous Student');

        const denied = mentalDb({
            courses: [taCourse({ materials: false, questions: false, settings: false, transcripts: false, flags: true, roster: true })],
            mentalHealthFlags: [flag()],
        });
        const resDenied = await request(app({ db: denied, user: ta })).get('/course/C1');
        expect(resDenied.status).toBe(403);
    });

    test('PUT /:flagId/escalate and /:flagId/dismiss: a TA with flags/roster but not transcripts is still denied', async () => {
        const db = mentalDb({
            courses: [taCourse({ materials: false, questions: false, settings: false, transcripts: false, flags: true, roster: true })],
            mentalHealthFlags: [flag()],
        });
        expect((await request(app({ db, user: ta })).put('/mhf_1/escalate')).status).toBe(403);
        expect((await request(app({ db, user: ta })).put('/mhf_1/dismiss')).status).toBe(403);
        expect((await db.collection('mentalHealthFlags').findOne({ flagId: 'mhf_1' })).status).toBe('pending');
    });

    test('PUT /:flagId/escalate: a TA with transcripts succeeds', async () => {
        const db = mentalDb({
            courses: [taCourse({ materials: false, questions: false, settings: false, transcripts: true, flags: false, roster: false })],
            mentalHealthFlags: [flag()],
        });
        const res = await request(app({ db, user: ta })).put('/mhf_1/escalate');
        expect(res.status).toBe(200);
        expect((await db.collection('mentalHealthFlags').findOne({ flagId: 'mhf_1' })).status).toBe('escalated');
    });
});

describe('db guards on the status transitions', () => {
    test('escalate/dismiss/resolve/disregard each return 503 without a db', async () => {
        const admin2 = { userId: 'a1', role: 'instructor', permissions: { systemAdmin: true } };
        for (const action of ['escalate', 'dismiss', 'resolve', 'disregard']) {
            const res = await request(app({ db: null, user: admin2 })).put(`/mhf_1/${action}`);
            expect(res.status).toBe(503);
        }
    });
});
