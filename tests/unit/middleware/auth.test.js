/**
 * Unit tests for src/middleware/auth.js (the createAuthMiddleware(db) factory).
 *
 * Strategy: drive each middleware with fake req/res/next and assert the observable
 * outcome — next() vs res.status().json() vs res.redirect(). We populate req.user
 * directly (the Passport path) so we exercise the authz branches without the
 * db/bcrypt session-hydration path. requireTAPermission does hit the Course model,
 * so that group seeds the in-memory db.
 */
const { memoryDb } = require('../helpers/memory-db');
const createAuthMiddleware = require('../../../src/middleware/auth');
const CourseModel = require('../../../src/models/Course');

// Build middleware over a db seeded with active users (so the session-hydration
// fallback `authService.getUserById(req.session.userId)` resolves a real record)
// and optional courses (for the TA-permission / enrollment middleware).
function seeded({ users = [], courses = [] } = {}) {
    return createAuthMiddleware(memoryDb({
        users: users.map((u) => ({ isActive: true, ...u })),
        courses,
    }));
}

function makeRes() {
    return {
        statusCode: undefined,
        body: undefined,
        redirectedTo: undefined,
        status(code) { this.statusCode = code; return this; },
        json(obj) { this.body = obj; return this; },
        redirect(url) { this.redirectedTo = url; return this; },
    };
}

function makeReq(overrides = {}) {
    return { path: '/x', originalUrl: '/x', query: {}, body: {}, params: {}, session: undefined, user: undefined, ...overrides };
}

let mw;
let next;
beforeAll(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterAll(() => jest.restoreAllMocks());
beforeEach(() => {
    mw = createAuthMiddleware(memoryDb({}));
    next = jest.fn();
});

describe('requireAuth', () => {
    test('calls next() when req.user is present (Passport path)', async () => {
        const res = makeRes();
        await mw.requireAuth(makeReq({ user: { userId: 'u1' } }), res, next);
        expect(next).toHaveBeenCalledTimes(1);
        expect(res.statusCode).toBeUndefined();
    });

    test('API request with no auth returns 401 JSON', async () => {
        const res = makeRes();
        await mw.requireAuth(makeReq({ originalUrl: '/api/thing' }), res, next);
        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(401);
        expect(res.body).toMatchObject({ success: false, error: 'Authentication required', redirect: '/login' });
    });

    test('page request with no auth redirects to /login', async () => {
        const res = makeRes();
        await mw.requireAuth(makeReq({ originalUrl: '/dashboard' }), res, next);
        expect(res.redirectedTo).toBe('/login');
        expect(next).not.toHaveBeenCalled();
    });
});

describe('requireRole', () => {
    test('calls next() when the role matches', async () => {
        const res = makeRes();
        await mw.requireRole('instructor')(makeReq({ user: { role: 'instructor' } }), res, next);
        expect(next).toHaveBeenCalledTimes(1);
    });

    test('API request with wrong role returns 403 JSON including the actual role', async () => {
        const res = makeRes();
        await mw.requireRole('instructor')(makeReq({ originalUrl: '/api/x', user: { role: 'student' } }), res, next);
        expect(res.statusCode).toBe(403);
        expect(res.body).toMatchObject({ success: false, error: 'Access denied. instructor role required.', userRole: 'student' });
        expect(next).not.toHaveBeenCalled();
    });

    test('page request with wrong role redirects to the user’s own dashboard', async () => {
        const res = makeRes();
        await mw.requireRole('instructor')(makeReq({ originalUrl: '/page', user: { role: 'student' } }), res, next);
        expect(res.redirectedTo).toBe('/student');
    });

    test('no auth at all on an API request returns 401', async () => {
        const res = makeRes();
        await mw.requireRole('instructor')(makeReq({ originalUrl: '/api/x' }), res, next);
        expect(res.statusCode).toBe(401);
    });
});

describe('requireInstructorOrTA', () => {
    test.each(['instructor', 'ta'])('allows %s through', async (role) => {
        const res = makeRes();
        await mw.requireInstructorOrTA(makeReq({ user: { role } }), res, next);
        expect(next).toHaveBeenCalledTimes(1);
    });

    test('denies a student on an API request with 403', async () => {
        const res = makeRes();
        await mw.requireInstructorOrTA(makeReq({ originalUrl: '/api/x', user: { role: 'student' } }), res, next);
        expect(res.statusCode).toBe(403);
        expect(res.body).toMatchObject({ error: 'Access denied. Instructor or TA role required.', userRole: 'student' });
    });

    test('no auth on a page request redirects to /login', async () => {
        const res = makeRes();
        await mw.requireInstructorOrTA(makeReq({ originalUrl: '/page' }), res, next);
        expect(res.redirectedTo).toBe('/login');
    });
});

describe('requireSystemAdmin', () => {
    test('allows a system admin through', async () => {
        const res = makeRes();
        await mw.requireSystemAdmin(makeReq({ user: { permissions: { systemAdmin: true } } }), res, next);
        expect(next).toHaveBeenCalledTimes(1);
    });

    test('denies a non-admin API request with 403', async () => {
        const res = makeRes();
        await mw.requireSystemAdmin(makeReq({ originalUrl: '/api/x', user: { permissions: {} } }), res, next);
        expect(res.statusCode).toBe(403);
        expect(res.body).toMatchObject({ error: 'Access denied. System admin access required.' });
    });

    test('redirects a non-admin page request to /instructor/home', async () => {
        const res = makeRes();
        await mw.requireSystemAdmin(makeReq({ originalUrl: '/page', user: { permissions: {} } }), res, next);
        expect(res.redirectedTo).toBe('/instructor/home');
    });

    test('no auth on an API request returns 401', async () => {
        const res = makeRes();
        await mw.requireSystemAdmin(makeReq({ originalUrl: '/api/x' }), res, next);
        expect(res.statusCode).toBe(401);
    });
});

describe('redirectIfAuthenticated', () => {
    test('redirects an authenticated instructor session to /instructor', () => {
        const res = makeRes();
        mw.redirectIfAuthenticated(makeReq({ session: { userId: 'u1', userRole: 'instructor' } }), res, next);
        expect(res.redirectedTo).toBe('/instructor');
        expect(next).not.toHaveBeenCalled();
    });

    test('passes through when there is no session', () => {
        const res = makeRes();
        mw.redirectIfAuthenticated(makeReq({}), res, next);
        expect(next).toHaveBeenCalledTimes(1);
        expect(res.redirectedTo).toBeUndefined();
    });
});

describe('requireCourseContext', () => {
    test('redirects to /login when there is no user', async () => {
        const res = makeRes();
        await mw.requireCourseContext(makeReq({}), res, next);
        expect(res.redirectedTo).toBe('/login');
    });

    test('instructor with a course context continues and gets req.courseId', async () => {
        const res = makeRes();
        const req = makeReq({ user: { role: 'instructor', preferences: { courseId: 'C1' } } });
        await mw.requireCourseContext(req, res, next);
        expect(next).toHaveBeenCalledTimes(1);
        expect(req.courseId).toBe('C1');
    });

    test('instructor with no course context is sent to onboarding', async () => {
        const res = makeRes();
        await mw.requireCourseContext(makeReq({ user: { role: 'instructor', preferences: {} } }), res, next);
        expect(res.redirectedTo).toBe('/instructor/onboarding');
    });

    test('non-instructors pass through untouched', async () => {
        const res = makeRes();
        const req = makeReq({ user: { role: 'student' } });
        await mw.requireCourseContext(req, res, next);
        expect(next).toHaveBeenCalledTimes(1);
        expect(req.courseId).toBeUndefined();
    });
});

describe('requirePermission', () => {
    function taMiddleware() {
        const db = memoryDb({
            courses: [{
                courseId: 'C1',
                instructorId: 'i1',
                tas: ['t1'],
                taPermissions: { t1: { materials: true, questions: false, flags: false, roster: false, transcripts: false, settings: false } },
            }],
        });
        return createAuthMiddleware(db);
    }

    // Only TAs are actively checked - matching the original requireTAPermission
    // this replaces. Instructors reaching this middleware already passed
    // requireInstructorOrTA, and the actual course data on these pages is
    // fetched through separately-gated API calls that check instructor
    // course ownership on their own; widening this specific page-shell gate
    // to instructors too broke test setups (and, more importantly, any real
    // flow) that don't expect a Mongo-level ownership check on a page load
    // that returns no course data itself.
    test('denies an unauthenticated caller', async () => {
        const res = makeRes();
        await taMiddleware().requirePermission('materials')(makeReq({ originalUrl: '/api/x' }), res, next);
        expect(res.statusCode).toBe(401);
        expect(next).not.toHaveBeenCalled();
    });

    test('is a no-op for a student', async () => {
        const res = makeRes();
        const req = makeReq({ originalUrl: '/api/x', user: { role: 'student', userId: 's1' }, query: { courseId: 'C1' } });
        await taMiddleware().requirePermission('materials')(req, res, next);
        expect(next).toHaveBeenCalledTimes(1);
    });

    test('is a no-op for an instructor, even for a course they do not own', async () => {
        const res = makeRes();
        const req = makeReq({ originalUrl: '/api/x', user: { role: 'instructor', userId: 'someone-else' }, query: { courseId: 'C1' } });
        await taMiddleware().requirePermission('materials')(req, res, next);
        expect(next).toHaveBeenCalledTimes(1);
    });

    test('allows a TA who has the requested permission', async () => {
        const res = makeRes();
        const req = makeReq({ user: { role: 'ta', userId: 't1' }, query: { courseId: 'C1' } });
        await taMiddleware().requirePermission('materials')(req, res, next);
        expect(next).toHaveBeenCalledTimes(1);
    });

    test('denies a TA who lacks the requested permission with 403', async () => {
        const res = makeRes();
        const req = makeReq({ originalUrl: '/api/x', user: { role: 'ta', userId: 't1' }, query: { courseId: 'C1' } });
        await taMiddleware().requirePermission('flags')(req, res, next);
        expect(res.statusCode).toBe(403);
        expect(res.body.message).toMatch(/do not have the 'flags' permission/);
        expect(next).not.toHaveBeenCalled();
    });

    test('API request with no resolvable course returns 400 for a TA', async () => {
        const res = makeRes();
        // TA belongs to no course, and no courseId in query/body/params/preferences.
        const req = makeReq({ originalUrl: '/api/x', user: { role: 'ta', userId: 'orphan' } });
        await taMiddleware().requirePermission('materials')(req, res, next);
        expect(res.statusCode).toBe(400);
        expect(res.body).toMatchObject({ success: false, message: 'Course ID is required to check permissions' });
    });

    test('resolves courseId from the TA preferences when none is in the request', async () => {
        const res = makeRes();
        const req = makeReq({ user: { role: 'ta', userId: 't1', preferences: { courseId: 'C1' } } });
        await taMiddleware().requirePermission('materials')(req, res, next);
        expect(next).toHaveBeenCalledTimes(1);
    });

    test('falls back to the TAs single course when exactly one is found', async () => {
        const res = makeRes();
        // No courseId anywhere; getCoursesForUser returns exactly C1, so it is used.
        const req = makeReq({ user: { role: 'ta', userId: 't1' } });
        await taMiddleware().requirePermission('materials')(req, res, next);
        expect(next).toHaveBeenCalledTimes(1);
    });

    test('page request with no resolvable course redirects a TA to /ta', async () => {
        const res = makeRes();
        const req = makeReq({ originalUrl: '/page', user: { role: 'ta', userId: 'orphan' } });
        await taMiddleware().requirePermission('materials')(req, res, next);
        expect(res.redirectedTo).toBe('/ta');
    });

    test('page request denied by permission redirects rather than returning JSON', async () => {
        const res = makeRes();
        const req = makeReq({ originalUrl: '/page', user: { role: 'ta', userId: 't1' }, query: { courseId: 'C1' } });
        await taMiddleware().requirePermission('flags')(req, res, next);
        expect(res.redirectedTo).toBe('/ta');
        expect(res.body).toBeUndefined();
    });

    test('returns 500 when the permission lookup throws', async () => {
        jest.spyOn(CourseModel, 'checkTAPermission').mockRejectedValueOnce(new Error('boom'));
        const res = makeRes();
        const req = makeReq({ user: { role: 'ta', userId: 't1' }, query: { courseId: 'C1' } });
        await taMiddleware().requirePermission('materials')(req, res, next);
        expect(res.statusCode).toBe(500);
        expect(res.body).toMatchObject({ success: false, message: 'Error checking permissions' });
    });
});

describe('requireAnyPermission', () => {
    function taMiddleware() {
        const db = memoryDb({
            courses: [{
                courseId: 'C1',
                instructorId: 'i1',
                tas: ['t1'],
                taPermissions: { t1: { materials: false, questions: true, flags: false, roster: false, transcripts: false, settings: false } },
            }],
        });
        return createAuthMiddleware(db);
    }

    test('is a no-op for non-TA roles, same as requirePermission', async () => {
        const res = makeRes();
        const req = makeReq({ user: { role: 'instructor', userId: 'someone-else' }, query: { courseId: 'C1' } });
        await taMiddleware().requireAnyPermission(['materials', 'questions', 'settings'])(req, res, next);
        expect(next).toHaveBeenCalledTimes(1);
    });

    test('allows a TA who has just one of the listed permissions', async () => {
        const res = makeRes();
        const req = makeReq({ user: { role: 'ta', userId: 't1' }, query: { courseId: 'C1' } });
        await taMiddleware().requireAnyPermission(['materials', 'questions', 'settings'])(req, res, next);
        expect(next).toHaveBeenCalledTimes(1);
    });

    test('denies a TA who has none of the listed permissions', async () => {
        const res = makeRes();
        const req = makeReq({ originalUrl: '/api/x', user: { role: 'ta', userId: 't1' }, query: { courseId: 'C1' } });
        await taMiddleware().requireAnyPermission(['materials', 'flags', 'roster'])(req, res, next);
        expect(res.statusCode).toBe(403);
        expect(next).not.toHaveBeenCalled();
    });

    test('denies an unauthenticated caller', async () => {
        const res = makeRes();
        await taMiddleware().requireAnyPermission(['materials'])(makeReq({ originalUrl: '/api/x' }), res, next);
        expect(res.statusCode).toBe(401);
        expect(next).not.toHaveBeenCalled();
    });
});

describe('requireAuth — session fallback', () => {
    test('hydrates req.user from session and calls next()', async () => {
        const m = seeded({ users: [{ userId: 'u1', role: 'student' }] });
        const res = makeRes();
        const req = makeReq({ session: { userId: 'u1' } });
        await m.requireAuth(req, res, next);
        expect(next).toHaveBeenCalledTimes(1);
        expect(req.user).toMatchObject({ userId: 'u1', role: 'student' });
    });

    test('unknown session user destroys the session and returns 401 on an API request', async () => {
        const m = seeded({ users: [] });
        const res = makeRes();
        const destroy = jest.fn((cb) => cb && cb());
        const req = makeReq({ originalUrl: '/api/x', session: { userId: 'ghost', destroy } });
        await m.requireAuth(req, res, next);
        expect(destroy).toHaveBeenCalled();
        expect(res.statusCode).toBe(401);
        expect(res.body).toMatchObject({ error: 'User not found', redirect: '/login' });
    });

    test('unknown session user on a page request redirects to /login', async () => {
        const m = seeded({ users: [] });
        const res = makeRes();
        const req = makeReq({ originalUrl: '/page', session: { userId: 'ghost', destroy: jest.fn() } });
        await m.requireAuth(req, res, next);
        expect(res.redirectedTo).toBe('/login');
    });

    test('a hydration error returns 500 on an API request', async () => {
        const m = seeded({ users: [] });
        jest.spyOn(m.authService, 'getUserById').mockRejectedValueOnce(new Error('db down'));
        const res = makeRes();
        const req = makeReq({ originalUrl: '/api/x', session: { userId: 'u1' } });
        await m.requireAuth(req, res, next);
        expect(res.statusCode).toBe(500);
        expect(res.body).toMatchObject({ error: 'Authentication error' });
    });

    test('a hydration error on a page request redirects to /login', async () => {
        const m = seeded({ users: [] });
        jest.spyOn(m.authService, 'getUserById').mockRejectedValueOnce(new Error('db down'));
        const res = makeRes();
        const req = makeReq({ originalUrl: '/page', session: { userId: 'u1' } });
        await m.requireAuth(req, res, next);
        expect(res.redirectedTo).toBe('/login');
    });
});

describe('requireRole — session fallback & error paths', () => {
    test('hydrates the user from session and allows a matching role', async () => {
        const m = seeded({ users: [{ userId: 'i1', role: 'instructor' }] });
        const res = makeRes();
        const req = makeReq({ session: { userId: 'i1' } });
        await m.requireRole('instructor')(req, res, next);
        expect(next).toHaveBeenCalledTimes(1);
        expect(req.user).toMatchObject({ userId: 'i1' });
    });

    test('no session on a page request redirects to /login', async () => {
        const res = makeRes();
        await mw.requireRole('instructor')(makeReq({ originalUrl: '/page' }), res, next);
        expect(res.redirectedTo).toBe('/login');
    });

    test('unknown session user clears the session and returns 401 on an API request', async () => {
        const m = seeded({ users: [] });
        const res = makeRes();
        const destroy = jest.fn();
        await m.requireRole('instructor')(makeReq({ originalUrl: '/api/x', session: { userId: 'ghost', destroy } }), res, next);
        expect(destroy).toHaveBeenCalled();
        expect(res.statusCode).toBe(401);
        expect(res.body).toMatchObject({ error: 'User not found' });
    });

    test('unknown session user on a page request redirects to /login', async () => {
        const m = seeded({ users: [] });
        const res = makeRes();
        await m.requireRole('instructor')(makeReq({ originalUrl: '/page', session: { userId: 'ghost', destroy: jest.fn() } }), res, next);
        expect(res.redirectedTo).toBe('/login');
    });

    test('redirects a TA with the wrong role to /ta', async () => {
        const res = makeRes();
        await mw.requireRole('instructor')(makeReq({ originalUrl: '/page', user: { role: 'ta' } }), res, next);
        expect(res.redirectedTo).toBe('/ta');
    });

    test('redirects a denied instructor (wrong required role) to /instructor', async () => {
        const res = makeRes();
        await mw.requireRole('student')(makeReq({ originalUrl: '/page', user: { role: 'instructor' } }), res, next);
        expect(res.redirectedTo).toBe('/instructor');
    });

    test('redirects an unknown role to /login', async () => {
        const res = makeRes();
        await mw.requireRole('instructor')(makeReq({ originalUrl: '/page', user: { role: 'guest' } }), res, next);
        expect(res.redirectedTo).toBe('/login');
    });

    test('returns 500 on an API request when hydration throws', async () => {
        const m = seeded({ users: [] });
        jest.spyOn(m.authService, 'getUserById').mockRejectedValueOnce(new Error('boom'));
        const res = makeRes();
        await m.requireRole('instructor')(makeReq({ originalUrl: '/api/x', session: { userId: 'u1' } }), res, next);
        expect(res.statusCode).toBe(500);
        expect(res.body).toMatchObject({ error: 'Authentication error' });
    });

    test('redirects to /login on a page request when hydration throws', async () => {
        const m = seeded({ users: [] });
        jest.spyOn(m.authService, 'getUserById').mockRejectedValueOnce(new Error('boom'));
        const res = makeRes();
        await m.requireRole('instructor')(makeReq({ originalUrl: '/page', session: { userId: 'u1' } }), res, next);
        expect(res.redirectedTo).toBe('/login');
    });
});

describe('role-specific wrappers (requireInstructor/Student/TA)', () => {
    test('requireInstructor allows an instructor and denies others', async () => {
        const ok = makeRes();
        await mw.requireInstructor(makeReq({ user: { role: 'instructor' } }), ok, next);
        expect(next).toHaveBeenCalledTimes(1);

        const denied = makeRes();
        await mw.requireInstructor(makeReq({ originalUrl: '/api/x', user: { role: 'student' } }), denied, jest.fn());
        expect(denied.statusCode).toBe(403);
    });

    test('requireStudent allows a student', async () => {
        const res = makeRes();
        await mw.requireStudent(makeReq({ user: { role: 'student' } }), res, next);
        expect(next).toHaveBeenCalledTimes(1);
    });

    test('requireTA allows a TA', async () => {
        const res = makeRes();
        await mw.requireTA(makeReq({ user: { role: 'ta' } }), res, next);
        expect(next).toHaveBeenCalledTimes(1);
    });
});

describe('requireInstructorOrTA — session fallback & error paths', () => {
    test('hydrates an instructor from session and continues', async () => {
        const m = seeded({ users: [{ userId: 'i1', role: 'instructor' }] });
        const res = makeRes();
        const req = makeReq({ session: { userId: 'i1' } });
        await m.requireInstructorOrTA(req, res, next);
        expect(next).toHaveBeenCalledTimes(1);
    });

    test('no session on an API request returns 401', async () => {
        const res = makeRes();
        await mw.requireInstructorOrTA(makeReq({ originalUrl: '/api/x' }), res, next);
        expect(res.statusCode).toBe(401);
    });

    test('unknown session user returns 401 on an API request', async () => {
        const m = seeded({ users: [] });
        const res = makeRes();
        await m.requireInstructorOrTA(makeReq({ originalUrl: '/api/x', session: { userId: 'ghost', destroy: jest.fn() } }), res, next);
        expect(res.statusCode).toBe(401);
        expect(res.body).toMatchObject({ error: 'User not found' });
    });

    test('unknown session user on a page request redirects to /login', async () => {
        const m = seeded({ users: [] });
        const res = makeRes();
        await m.requireInstructorOrTA(makeReq({ originalUrl: '/page', session: { userId: 'ghost', destroy: jest.fn() } }), res, next);
        expect(res.redirectedTo).toBe('/login');
    });

    test('redirects a denied student page request to /student', async () => {
        const res = makeRes();
        await mw.requireInstructorOrTA(makeReq({ originalUrl: '/page', user: { role: 'student' } }), res, next);
        expect(res.redirectedTo).toBe('/student');
    });

    test('redirects a denied user with an unknown role to /login', async () => {
        const res = makeRes();
        await mw.requireInstructorOrTA(makeReq({ originalUrl: '/page', user: { role: 'guest' } }), res, next);
        expect(res.redirectedTo).toBe('/login');
    });

    test('returns 500 on an API request when hydration throws', async () => {
        const m = seeded({ users: [] });
        jest.spyOn(m.authService, 'getUserById').mockRejectedValueOnce(new Error('boom'));
        const res = makeRes();
        await m.requireInstructorOrTA(makeReq({ originalUrl: '/api/x', session: { userId: 'u1' } }), res, next);
        expect(res.statusCode).toBe(500);
    });

    test('redirects to /login on a page request when hydration throws', async () => {
        const m = seeded({ users: [] });
        jest.spyOn(m.authService, 'getUserById').mockRejectedValueOnce(new Error('boom'));
        const res = makeRes();
        await m.requireInstructorOrTA(makeReq({ originalUrl: '/page', session: { userId: 'u1' } }), res, next);
        expect(res.redirectedTo).toBe('/login');
    });
});

describe('requireSystemAdmin — session fallback & error paths', () => {
    test('hydrates a system admin from session and continues', async () => {
        const m = seeded({ users: [{ userId: 'a1', role: 'instructor', permissions: { systemAdmin: true } }] });
        const res = makeRes();
        await m.requireSystemAdmin(makeReq({ session: { userId: 'a1' } }), res, next);
        expect(next).toHaveBeenCalledTimes(1);
    });

    test('no session on a page request redirects to /login', async () => {
        const res = makeRes();
        await mw.requireSystemAdmin(makeReq({ originalUrl: '/page' }), res, next);
        expect(res.redirectedTo).toBe('/login');
    });

    test('unknown session user returns 401 on an API request', async () => {
        const m = seeded({ users: [] });
        const res = makeRes();
        await m.requireSystemAdmin(makeReq({ originalUrl: '/api/x', session: { userId: 'ghost', destroy: jest.fn() } }), res, next);
        expect(res.statusCode).toBe(401);
        expect(res.body).toMatchObject({ error: 'User not found' });
    });

    test('unknown session user on a page request redirects to /login', async () => {
        const m = seeded({ users: [] });
        const res = makeRes();
        await m.requireSystemAdmin(makeReq({ originalUrl: '/page', session: { userId: 'ghost', destroy: jest.fn() } }), res, next);
        expect(res.redirectedTo).toBe('/login');
    });

    test('returns 500 on an API request when hydration throws', async () => {
        const m = seeded({ users: [] });
        jest.spyOn(m.authService, 'getUserById').mockRejectedValueOnce(new Error('boom'));
        const res = makeRes();
        await m.requireSystemAdmin(makeReq({ originalUrl: '/api/x', session: { userId: 'u1' } }), res, next);
        expect(res.statusCode).toBe(500);
    });

    test('redirects to /login on a page request when hydration throws', async () => {
        const m = seeded({ users: [] });
        jest.spyOn(m.authService, 'getUserById').mockRejectedValueOnce(new Error('boom'));
        const res = makeRes();
        await m.requireSystemAdmin(makeReq({ originalUrl: '/page', session: { userId: 'u1' } }), res, next);
        expect(res.redirectedTo).toBe('/login');
    });
});

describe('populateUser', () => {
    test('passes through immediately when req.user already set', async () => {
        const res = makeRes();
        const req = makeReq({ user: { userId: 'u1' } });
        await mw.populateUser(req, res, next);
        expect(next).toHaveBeenCalledTimes(1);
    });

    test('populates req.user from session when available', async () => {
        const m = seeded({ users: [{ userId: 'u1', role: 'student' }] });
        const res = makeRes();
        const req = makeReq({ session: { userId: 'u1' } });
        await m.populateUser(req, res, next);
        expect(req.user).toMatchObject({ userId: 'u1' });
        expect(next).toHaveBeenCalledTimes(1);
    });

    test('destroys the session and still calls next() for an unknown session user', async () => {
        const m = seeded({ users: [] });
        const res = makeRes();
        const destroy = jest.fn();
        const req = makeReq({ session: { userId: 'ghost', destroy } });
        await m.populateUser(req, res, next);
        expect(destroy).toHaveBeenCalled();
        expect(req.user).toBeUndefined();
        expect(next).toHaveBeenCalledTimes(1);
    });

    test('swallows hydration errors and calls next()', async () => {
        const m = seeded({ users: [] });
        jest.spyOn(m.authService, 'getUserById').mockRejectedValueOnce(new Error('boom'));
        const res = makeRes();
        await m.populateUser(makeReq({ session: { userId: 'u1' } }), res, next);
        expect(next).toHaveBeenCalledTimes(1);
    });

    test('calls next() when there is no session', async () => {
        const res = makeRes();
        await mw.populateUser(makeReq({}), res, next);
        expect(next).toHaveBeenCalledTimes(1);
    });
});

describe('redirectIfAuthenticated — remaining role branches', () => {
    test('redirects an authenticated student to /student', () => {
        const res = makeRes();
        mw.redirectIfAuthenticated(makeReq({ session: { userId: 'u1', userRole: 'student' } }), res, next);
        expect(res.redirectedTo).toBe('/student');
    });

    test('redirects an authenticated TA to /ta', () => {
        const res = makeRes();
        mw.redirectIfAuthenticated(makeReq({ session: { userId: 'u1', userRole: 'ta' } }), res, next);
        expect(res.redirectedTo).toBe('/ta');
    });

    test('an unknown role with a session still passes through', () => {
        const res = makeRes();
        mw.redirectIfAuthenticated(makeReq({ session: { userId: 'u1', userRole: 'admin' } }), res, next);
        expect(next).toHaveBeenCalledTimes(1);
        expect(res.redirectedTo).toBeUndefined();
    });
});

describe('requireStudentEnrolled', () => {
    function m() {
        return seeded({
            courses: [
                { courseId: 'C1', status: 'active', studentEnrollment: { s1: { enrolled: true }, banned: { enrolled: false } } },
                { courseId: 'CINACT', status: 'inactive' },
            ],
        });
    }

    test('is a no-op for non-students', async () => {
        const res = makeRes();
        await m().requireStudentEnrolled(makeReq({ user: { role: 'instructor', userId: 'i1' }, body: { courseId: 'C1' } }), res, next);
        expect(next).toHaveBeenCalledTimes(1);
    });

    test('passes through when no courseId can be inferred', async () => {
        const res = makeRes();
        await m().requireStudentEnrolled(makeReq({ user: { role: 'student', userId: 's1' } }), res, next);
        expect(next).toHaveBeenCalledTimes(1);
    });

    test('allows an enrolled student', async () => {
        const res = makeRes();
        await m().requireStudentEnrolled(makeReq({ user: { role: 'student', userId: 's1' }, body: { courseId: 'C1' } }), res, next);
        expect(next).toHaveBeenCalledTimes(1);
    });

    test('returns 404 when the course does not exist', async () => {
        const res = makeRes();
        await m().requireStudentEnrolled(makeReq({ user: { role: 'student', userId: 's1' }, query: { courseId: 'NOPE' } }), res, next);
        expect(res.statusCode).toBe(404);
        expect(res.body).toMatchObject({ message: 'Course not found' });
    });

    test('returns 403 with the disabled-access message for a banned student', async () => {
        const res = makeRes();
        await m().requireStudentEnrolled(makeReq({ user: { role: 'student', userId: 'banned' }, params: { courseId: 'C1' } }), res, next);
        expect(res.statusCode).toBe(403);
        expect(res.body.message).toMatch(/access to this course is disabled/);
    });

    test('returns 403 with the deactivated message when the course is inactive', async () => {
        const res = makeRes();
        await m().requireStudentEnrolled(makeReq({ user: { role: 'student', userId: 's1' }, body: { courseId: 'CINACT' } }), res, next);
        expect(res.statusCode).toBe(403);
        expect(res.body.message).toMatch(/currently deactivated by the instructor/);
    });

    test('returns 500 when the enrollment lookup throws', async () => {
        jest.spyOn(CourseModel, 'getStudentEnrollment').mockRejectedValueOnce(new Error('boom'));
        const res = makeRes();
        await m().requireStudentEnrolled(makeReq({ user: { role: 'student', userId: 's1' }, body: { courseId: 'C1' } }), res, next);
        expect(res.statusCode).toBe(500);
        expect(res.body).toMatchObject({ message: 'Enrollment check failed' });
    });
});

describe('requireActiveCourseForNonInstructors', () => {
    function m() {
        return seeded({
            courses: [
                { courseId: 'C1', status: 'active' },
                { courseId: 'CINACT', status: 'inactive' },
                { courseId: 'CDEL', status: 'deleted' },
            ],
        });
    }

    test.each(['instructor', 'ta'])('is a no-op for %s', async (role) => {
        const res = makeRes();
        await m().requireActiveCourseForNonInstructors(makeReq({ user: { role }, body: { courseId: 'CINACT' } }), res, next);
        expect(next).toHaveBeenCalledTimes(1);
    });

    test('is a no-op when there is no user', async () => {
        const res = makeRes();
        await m().requireActiveCourseForNonInstructors(makeReq({}), res, next);
        expect(next).toHaveBeenCalledTimes(1);
    });

    test('lets a student inspect enrollment status of a stale course via the GET passthrough', async () => {
        const res = makeRes();
        const req = makeReq({ user: { role: 'student' }, method: 'GET', path: '/api/courses/CINACT/student-enrollment' });
        await m().requireActiveCourseForNonInstructors(req, res, next);
        expect(next).toHaveBeenCalledTimes(1);
    });

    test('passes through when no courseId is present', async () => {
        const res = makeRes();
        await m().requireActiveCourseForNonInstructors(makeReq({ user: { role: 'student' } }), res, next);
        expect(next).toHaveBeenCalledTimes(1);
    });

    test('passes through when the course is not found', async () => {
        const res = makeRes();
        await m().requireActiveCourseForNonInstructors(makeReq({ user: { role: 'student' }, query: { courseId: 'NOPE' } }), res, next);
        expect(next).toHaveBeenCalledTimes(1);
    });

    test('allows an active course', async () => {
        const res = makeRes();
        await m().requireActiveCourseForNonInstructors(makeReq({ user: { role: 'student' }, body: { courseId: 'C1' } }), res, next);
        expect(next).toHaveBeenCalledTimes(1);
    });

    test.each(['CINACT', 'CDEL'])('blocks a student from a %s course with 403', async (courseId) => {
        const res = makeRes();
        await m().requireActiveCourseForNonInstructors(makeReq({ user: { role: 'student' }, params: { courseId } }), res, next);
        expect(res.statusCode).toBe(403);
        expect(res.body.message).toMatch(/currently deactivated by the instructor/);
    });

    test('returns 500 when the course lookup throws', async () => {
        jest.spyOn(CourseModel, 'getCourseByIdIncludingDeleted').mockRejectedValueOnce(new Error('boom'));
        const res = makeRes();
        await m().requireActiveCourseForNonInstructors(makeReq({ user: { role: 'student' }, body: { courseId: 'C1' } }), res, next);
        expect(res.statusCode).toBe(500);
        expect(res.body).toMatchObject({ message: 'Course access check failed' });
    });
});

describe('requireCourseContext — error path', () => {
    test('swallows an error from getCurrentCourseId and calls next()', async () => {
        const res = makeRes();
        jest.spyOn(mw.authService, 'getCurrentCourseId').mockImplementationOnce(() => { throw new Error('boom'); });
        await mw.requireCourseContext(makeReq({ user: { role: 'instructor', preferences: {} } }), res, next);
        expect(next).toHaveBeenCalledTimes(1);
    });
});
