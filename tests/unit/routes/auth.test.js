/**
 * In-process route tests for src/routes/auth.js (supertest).
 *
 * The router reads the DB from app.locals.db, the user from req.user / req.session,
 * and delegates account work to an injected `authService` on app.locals. We inject
 * a fake authService and (where needed) a fake session via the route harness.
 *
 * Passport-driven paths (successful local login, SAML, logout's session.destroy)
 * are intentionally NOT exercised here — they need a real strategy/session store and
 * belong to e2e. We cover the pre-Passport validation branches and the plain
 * DB/authService-backed endpoints.
 */
const { memoryDb } = require('../helpers/memory-db');
const { makeRouteApp, request } = require('../helpers/route-app');
const router = require('../../../src/routes/auth');

const instructor = { userId: 'i1', role: 'instructor', displayName: 'Dr. I' };
const student = { userId: 's1', role: 'student' };

function makeAuthService(over = {}) {
    return {
        registerUser: jest.fn(async () => ({ success: true, userId: 'u9', user: { userId: 'u9', role: 'student' } })),
        createSessionUser: jest.fn((u) => ({ userId: u.userId, role: u.role, displayName: u.displayName })),
        getUserById: jest.fn(async () => null),
        updateUserPreferences: jest.fn(async () => ({ success: true })),
        setCurrentCourseId: jest.fn(async () => ({ success: true })),
        ...over,
    };
}
const app = (opts) => makeRouteApp(router, opts);

beforeAll(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterAll(() => jest.restoreAllMocks());

describe('POST /login (pre-Passport branches only)', () => {
    test('503 when the admin setting cannot be read', async () => {
        const res = await request(app({ db: null })).post('/login').send({ username: 'a', password: 'b' });
        expect(res.status).toBe(503);
        expect(res.body.code).toBe('AUTH_SERVICE_UNAVAILABLE');
    });

    test('403 when an admin has disabled local login', async () => {
        const db = memoryDb({ settings: [{ _id: 'global', allowLocalLogin: false }] });
        const res = await request(app({ db })).post('/login').send({ username: 'a', password: 'b' });
        expect(res.status).toBe(403);
        expect(res.body.error).toMatch(/disabled/i);
    });

    test('400 when username or password is missing', async () => {
        const res = await request(app({ db: memoryDb({}) })).post('/login').send({ username: 'only-user' });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/required/i);
        expect(res.body.message).toBe(res.body.error);
    });
});

describe('POST /register', () => {
    test('403 when local accounts are disabled', async () => {
        const db = memoryDb({ settings: [{ _id: 'global', allowLocalLogin: false }] });
        const res = await request(app({ db, locals: { authService: makeAuthService() } }))
            .post('/register').send({ username: 'a', password: 'b', role: 'student' });
        expect(res.status).toBe(403);
    });

    test('400 when required fields are missing', async () => {
        const res = await request(app({ db: memoryDb({}), locals: { authService: makeAuthService() } }))
            .post('/register').send({ username: 'a' });
        expect(res.status).toBe(400);
    });

    test('400 for an invalid role', async () => {
        const res = await request(app({ db: memoryDb({}), locals: { authService: makeAuthService() } }))
            .post('/register').send({ username: 'a', password: 'b', role: 'wizard' });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/instructor.*student.*ta/i);
    });

    test('500 when the auth service is unavailable', async () => {
        const res = await request(app({ db: memoryDb({}) }))
            .post('/register').send({ username: 'a', password: 'b', role: 'student' });
        expect(res.status).toBe(500);
    });

    test('400 surfacing the auth service error', async () => {
        const authService = makeAuthService({ registerUser: jest.fn(async () => ({ success: false, error: 'Username taken' })) });
        const res = await request(app({ db: memoryDb({}), locals: { authService } }))
            .post('/register').send({ username: 'a', password: 'b', role: 'student' });
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('Username taken');
    });

    test('200 on success, returning the created user', async () => {
        const authService = makeAuthService();
        const res = await request(app({ db: memoryDb({}), locals: { authService } }))
            .post('/register').send({ username: 'newuser', password: 'pw', role: 'student', displayName: 'New' });
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ success: true, user: { userId: 'u9' } });
        expect(authService.registerUser).toHaveBeenCalledWith(expect.objectContaining({ username: 'newuser', role: 'student' }));
    });
});

describe('GET /me', () => {
    test('401 when neither Passport user nor session is present', async () => {
        const res = await request(app({ db: memoryDb({}), locals: { authService: makeAuthService() } })).get('/me');
        expect(res.status).toBe(401);
        expect(res.body.redirect).toBe('/login');
    });

    test('200 returns the shaped session user for a Passport user', async () => {
        const authService = makeAuthService();
        const res = await request(app({ db: memoryDb({}), user: instructor, locals: { authService } })).get('/me');
        expect(res.status).toBe(200);
        expect(res.body.user).toMatchObject({ userId: 'i1', role: 'instructor' });
        expect(authService.createSessionUser).toHaveBeenCalledWith(expect.objectContaining({ userId: 'i1' }));
    });

    test('500 when the auth service is missing but a user is present', async () => {
        const res = await request(app({ db: memoryDb({}), user: instructor })).get('/me');
        expect(res.status).toBe(500);
    });
});

describe('PUT /preferences', () => {
    test('401 without a session', async () => {
        const res = await request(app({ db: memoryDb({}), locals: { authService: makeAuthService() } }))
            .put('/preferences').send({ preferences: { theme: 'dark' } });
        expect(res.status).toBe(401);
    });

    test('400 when preferences is not an object', async () => {
        const res = await request(app({ db: memoryDb({}), session: { userId: 'i1' }, locals: { authService: makeAuthService() } }))
            .put('/preferences').send({ preferences: 'nope' });
        expect(res.status).toBe(400);
    });

    test('200 delegates the update to the auth service', async () => {
        const authService = makeAuthService();
        const res = await request(app({ db: memoryDb({}), session: { userId: 'i1' }, locals: { authService } }))
            .put('/preferences').send({ preferences: { theme: 'dark' } });
        expect(res.status).toBe(200);
        expect(authService.updateUserPreferences).toHaveBeenCalledWith('i1', { theme: 'dark' });
    });
});

describe('POST /set-course', () => {
    test('401 without a session', async () => {
        const res = await request(app({ db: memoryDb({}), locals: { authService: makeAuthService() } }))
            .post('/set-course').send({ courseId: 'C1' });
        expect(res.status).toBe(401);
    });

    test('400 when courseId is missing', async () => {
        const res = await request(app({ db: memoryDb({}), session: { userId: 'i1' }, locals: { authService: makeAuthService() } }))
            .post('/set-course').send({});
        expect(res.status).toBe(400);
    });

    test('200 sets the course context via the auth service', async () => {
        const authService = makeAuthService();
        const res = await request(app({ db: memoryDb({}), session: { userId: 'i1' }, locals: { authService } }))
            .post('/set-course').send({ courseId: 'C1' });
        expect(res.status).toBe(200);
        expect(res.body.courseId).toBe('C1');
        expect(authService.setCurrentCourseId).toHaveBeenCalledWith('i1', 'C1');
    });
});

describe('GET /tas', () => {
    test('401 without a user, 403 for a non-instructor', async () => {
        expect((await request(app({ db: memoryDb({}) })).get('/tas')).status).toBe(401);
        expect((await request(app({ db: memoryDb({}), user: student })).get('/tas')).status).toBe(403);
    });

    test('503 when the db is unavailable', async () => {
        expect((await request(app({ db: null, user: instructor })).get('/tas')).status).toBe(503);
    });

    test('200 lists users with the ta role', async () => {
        const db = memoryDb({ users: [
            { userId: 't1', role: 'ta', username: 'ta-one', createdAt: new Date('2026-01-02') },
            { userId: 's1', role: 'student', username: 'stu' },
        ] });
        const res = await request(app({ db, user: instructor })).get('/tas');
        expect(res.status).toBe(200);
        expect(res.body.data.map(u => u.userId)).toEqual(['t1']);
    });
});

describe('GET /users/:userId', () => {
    test('403 for a non-instructor', async () => {
        expect((await request(app({ db: memoryDb({}), user: student })).get('/users/x')).status).toBe(403);
    });

    test('404 when the user does not exist', async () => {
        const res = await request(app({ db: memoryDb({ users: [] }), user: instructor })).get('/users/ghost');
        expect(res.status).toBe(404);
    });

    test('200 returns the requested user', async () => {
        const db = memoryDb({ users: [{ userId: 'u2', role: 'student', username: 'bob' }] });
        const res = await request(app({ db, user: instructor })).get('/users/u2');
        expect(res.status).toBe(200);
        expect(res.body.data.userId).toBe('u2');
    });
});

describe('DELETE /tas/:taId', () => {
    test('401 without a user, 403 for a non-instructor', async () => {
        expect((await request(app({ db: memoryDb({}) })).delete('/tas/t1')).status).toBe(401);
        expect((await request(app({ db: memoryDb({}), user: student })).delete('/tas/t1')).status).toBe(403);
    });

    test('demotes the TA to student and pulls them from every course', async () => {
        const db = memoryDb({
            users: [{ userId: 't1', role: 'ta' }],
            courses: [
                { courseId: 'C1', tas: ['t1', 't2'] },
                { courseId: 'C2', tas: ['t1'] },
            ],
        });
        const res = await request(app({ db, user: instructor })).delete('/tas/t1');
        expect(res.status).toBe(200);
        expect(res.body.data.modifiedCount).toBe(2);
        expect((await db.collection('users').findOne({ userId: 't1' })).role).toBe('student');
        expect((await db.collection('courses').findOne({ courseId: 'C1' })).tas).toEqual(['t2']);
        expect((await db.collection('courses').findOne({ courseId: 'C2' })).tas).toEqual([]);
    });

    test('clears the taPermissions record on every course, not just the tas array', async () => {
        // Otherwise a re-added TA inherits whatever permissions were left
        // over from before they were removed, instead of starting fresh.
        const db = memoryDb({
            users: [{ userId: 't1', role: 'ta' }],
            courses: [{
                courseId: 'C1', tas: ['t1'],
                taPermissions: { t1: { materials: true, questions: true, settings: true, transcripts: true, flags: true, roster: true } },
            }],
        });
        const res = await request(app({ db, user: instructor })).delete('/tas/t1');
        expect(res.status).toBe(200);
        expect((await db.collection('courses').findOne({ courseId: 'C1' })).taPermissions.t1).toBeUndefined();
    });
});

describe('POST /promote-to-ta', () => {
    test('401 without a user, 403 for a non-instructor', async () => {
        expect((await request(app({ db: memoryDb({}) })).post('/promote-to-ta').send({ userId: 's9' })).status).toBe(401);
        expect((await request(app({ db: memoryDb({}), user: student })).post('/promote-to-ta').send({ userId: 's9' })).status).toBe(403);
    });

    test('400 when userId is missing', async () => {
        const res = await request(app({ db: memoryDb({}), user: instructor })).post('/promote-to-ta').send({});
        expect(res.status).toBe(400);
    });

    test('404 when the named course does not exist', async () => {
        const db = memoryDb({ users: [{ userId: 's9', role: 'student' }], courses: [] });
        const res = await request(app({ db, user: instructor })).post('/promote-to-ta').send({ userId: 's9', courseId: 'C-missing' });
        expect(res.status).toBe(404);
    });

    test('403 when promoting into a course the instructor does not own', async () => {
        const db = memoryDb({
            users: [{ userId: 's9', role: 'student' }],
            courses: [{ courseId: 'C1', instructorId: 'other-instr', status: 'active' }],
        });
        const res = await request(app({ db, user: instructor })).post('/promote-to-ta').send({ userId: 's9', courseId: 'C1' });
        expect(res.status).toBe(403);
        expect(res.body.message).toMatch(/courses you own/i);
    });

    test('404 when the target user does not exist (no row matched)', async () => {
        const res = await request(app({ db: memoryDb({ users: [] }), user: instructor })).post('/promote-to-ta').send({ userId: 'ghost' });
        expect(res.status).toBe(404);
    });

    test('promotes a student into an owned course and records the invite', async () => {
        const db = memoryDb({
            users: [{ userId: 's9', role: 'student' }],
            courses: [{ courseId: 'C1', instructorId: 'i1', status: 'active' }],
        });
        const res = await request(app({ db, user: instructor })).post('/promote-to-ta').send({ userId: 's9', courseId: 'C1' });
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({ userId: 's9', role: 'ta', invitedToCourse: 'C1' });
        const saved = await db.collection('users').findOne({ userId: 's9' });
        expect(saved.role).toBe('ta');
        expect(saved.invitedCourses).toEqual(['C1']);
    });
});

describe('GET /methods', () => {
    const OLD_ENV = process.env;
    beforeEach(() => { process.env = { ...OLD_ENV }; delete process.env.SAML_ENTRY_POINT; delete process.env.SAML_ISSUER; delete process.env.SAML_CALLBACK_URL; delete process.env.SAML_CERT; });
    afterAll(() => { process.env = OLD_ENV; });

    test('defaults: local on, saml/ubcshib off, when nothing is configured', async () => {
        const res = await request(app({ db: memoryDb({}) })).get('/methods');
        expect(res.status).toBe(200);
        expect(res.body.methods).toMatchObject({ local: true, saml: false, ubcshib: false, allowLocalLogin: true });
    });

    test('reflects the admin "local login disabled" setting', async () => {
        const db = memoryDb({ settings: [{ _id: 'global', allowLocalLogin: false }] });
        const res = await request(app({ db })).get('/methods');
        expect(res.body.methods).toMatchObject({ local: false, allowLocalLogin: false });
    });

    test('marks SAML + ubcshib available once the env vars are present', async () => {
        process.env.SAML_ENTRY_POINT = 'https://idp/entry';
        process.env.SAML_ISSUER = 'biocbot';
        process.env.SAML_CALLBACK_URL = 'https://app/callback';
        process.env.SAML_CERT = 'CERT';
        const res = await request(app({ db: memoryDb({}) })).get('/methods');
        expect(res.body.methods).toMatchObject({ saml: true, ubcshib: true });
    });
});
