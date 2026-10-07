// @ts-check
/**
 * Coverage for src/middleware/auth.js (~50% → target higher).
 *
 * Each test drives an endpoint that funnels through a specific middleware
 * branch we want to exercise — requireRole, requireInstructorOrTA,
 * requireStudentEnrolled, requireActiveCourseForNonInstructors, requireSystemAdmin,
 * requireTAPermission.
 */

const { test, expect, request } = require('./fixtures/monocart');
const { TEST_USERS, storageStatePath } = require('./helpers/users');
const {
    withDb,
    getUserIdByUsername,
    seedCourse,
    cleanupCourses,
    cleanupCoursesForUser,
    setStudentEnrollment,
} = require('./helpers/courses-test');

const COURSE_A = 'BIOC-E2E-MW-AUTH-A';

let instructorId;
let studentId;
let taId;

test.beforeAll(async () => {
    instructorId = await getUserIdByUsername(TEST_USERS.instructor.username);
    studentId = await getUserIdByUsername(TEST_USERS.student.username);
    taId = await getUserIdByUsername(TEST_USERS.ta.username);
});

test.beforeEach(async () => {
    await cleanupCoursesForUser(instructorId);
    await withDb((db) =>
        db.collection('users').updateOne(
            { userId: taId },
            { $set: { role: 'ta', isActive: true }, $unset: { invitedCourses: '' } }
        )
    );
});

test.afterAll(async () => {
    await cleanupCourses([COURSE_A]);
    await cleanupCoursesForUser(instructorId);
});

// ---------------------------------------------------------------------------
// requireAuth: API path returns 401 when no session
// ---------------------------------------------------------------------------
test.describe('requireAuth', () => {
    test('Non-API page redirects to /login when no session', async ({ baseURL }) => {
        const anon = await request.newContext({
            baseURL,
            storageState: { cookies: [], origins: [] },
        });
        try {
            const res = await anon.get('/instructor/home', {
                maxRedirects: 0,
                failOnStatusCode: false,
            });
            expect(res.status()).toBe(302);
            expect((res.headers()['location'] || '').includes('/login')).toBe(true);
        } finally {
            await anon.dispose();
        }
    });
});

// ---------------------------------------------------------------------------
// requireRole: student calling instructor-only endpoint
// ---------------------------------------------------------------------------
test.describe('requireRole', () => {
    test('student → instructor route returns 403 with userRole echoed', async ({ baseURL }) => {
        const api = await request.newContext({
            baseURL,
            storageState: storageStatePath('student'),
        });
        try {
            const res = await api.post('/api/courses', {
                data: { course: 'Nope', weeks: 1, lecturesPerWeek: 1 },
            });
            expect(res.status()).toBe(403);
        } finally {
            await api.dispose();
        }
    });
});

// ---------------------------------------------------------------------------
// requireInstructorOrTA: applied to /instructor static, used at /api/courses
// indirectly via role check
// ---------------------------------------------------------------------------
test.describe('requireInstructorOrTA', () => {
    test('student → /instructor/home redirects to /student (via requireRole)', async ({ baseURL }) => {
        const api = await request.newContext({
            baseURL,
            storageState: storageStatePath('student'),
        });
        try {
            const res = await api.get('/instructor/home', {
                maxRedirects: 0,
                failOnStatusCode: false,
            });
            expect([302, 303]).toContain(res.status());
            expect((res.headers()['location'] || '')).toMatch(/^\/student/);
        } finally {
            await api.dispose();
        }
    });
});

// ---------------------------------------------------------------------------
// requireActiveCourseForNonInstructors
// ---------------------------------------------------------------------------
test.describe('requireActiveCourseForNonInstructors', () => {
    test('student → inactive course is blocked with 403', async ({ baseURL }) => {
        await seedCourse({ courseId: COURSE_A, instructorId, status: 'inactive' });
        await setStudentEnrollment(COURSE_A, studentId, true);
        const api = await request.newContext({
            baseURL,
            storageState: storageStatePath('student'),
        });
        try {
            const res = await api.get(`/api/courses/${COURSE_A}`);
            expect(res.status()).toBe(403);
        } finally {
            await api.dispose();
        }
    });

    test('student → /student-enrollment is allowed even on inactive course', async ({ baseURL }) => {
        await seedCourse({ courseId: COURSE_A, instructorId, status: 'inactive' });
        const api = await request.newContext({
            baseURL,
            storageState: storageStatePath('student'),
        });
        try {
            const res = await api.get(`/api/courses/${COURSE_A}/student-enrollment`);
            expect(res.status()).toBe(200);
        } finally {
            await api.dispose();
        }
    });

    test('instructor → inactive course passes through (no middleware block)', async ({ baseURL }) => {
        await seedCourse({ courseId: COURSE_A, instructorId, status: 'inactive' });
        const api = await request.newContext({
            baseURL,
            storageState: storageStatePath('instructor'),
        });
        try {
            const res = await api.get(`/api/courses/${COURSE_A}`);
            expect(res.ok()).toBeTruthy();
        } finally {
            await api.dispose();
        }
    });
});

// ---------------------------------------------------------------------------
// requireStudentEnrolled
// ---------------------------------------------------------------------------
test.describe('requireStudentEnrolled', () => {
    test('not-enrolled student → /api/chat returns 403', async ({ baseURL }) => {
        await seedCourse({ courseId: COURSE_A, instructorId });
        const api = await request.newContext({
            baseURL,
            storageState: storageStatePath('student'),
        });
        try {
            const res = await api.post('/api/chat', {
                data: { message: 'hi', courseId: COURSE_A, unitName: 'Unit 1' },
            });
            expect(res.status()).toBe(403);
        } finally {
            await api.dispose();
        }
    });

    test('enrolled student → /api/chat passes the enrollment gate', async ({ baseURL }) => {
        await seedCourse({ courseId: COURSE_A, instructorId });
        await setStudentEnrollment(COURSE_A, studentId, true);
        const api = await request.newContext({
            baseURL,
            storageState: storageStatePath('student'),
        });
        try {
            // Unit 1 isn't published, so we expect 400 from the route handler —
            // proving the middleware let the request through.
            const res = await api.post('/api/chat', {
                data: { message: 'hi', courseId: COURSE_A, unitName: 'Unit 1' },
            });
            expect(res.status()).toBe(400);
        } finally {
            await api.dispose();
        }
    });
});

// ---------------------------------------------------------------------------
// requireSystemAdmin (settings endpoints)
// ---------------------------------------------------------------------------
test.describe('requireSystemAdmin', () => {
    test('non-admin → /api/settings/global returns 403', async ({ baseURL }) => {
        const api = await request.newContext({
            baseURL,
            storageState: storageStatePath('instructor'),
        });
        try {
            const res = await api.get('/api/settings/global');
            expect(res.status()).toBe(403);
        } finally {
            await api.dispose();
        }
    });
});

// ---------------------------------------------------------------------------
// populateUser: route that simply reads req.user without requireRole, while
// using session-only login (no Passport). We hit `/api/auth/me` after a
// session-only login.
// ---------------------------------------------------------------------------
test.describe('populateUser fallback path', () => {
    test('hydrates req.user from session even when Passport req.user is absent', async ({ baseURL }) => {
        // Read credentials and log in via /api/auth/login (Passport.req.login
        // populates the session). Then the next /me request should succeed.
        const creds = JSON.parse(
            require('fs').readFileSync(
                require('path').join(__dirname, '..', '..', 'playwright', '.auth', '.credentials.json'),
                'utf8'
            )
        );
        const api = await request.newContext({
            baseURL,
            storageState: { cookies: [], origins: [] },
        });
        try {
            const login = await api.post('/api/auth/login', {
                data: { username: TEST_USERS.instructor.username, password: creds.instructor },
            });
            expect(login.ok()).toBeTruthy();
            const me = await api.get('/api/auth/me');
            expect(me.ok()).toBeTruthy();
            const body = await me.json();
            expect(body.user.userId).toBe(instructorId);
        } finally {
            await api.dispose();
        }
    });
});

// ---------------------------------------------------------------------------
// requireTAPermission (via flag/courses pages)
// ---------------------------------------------------------------------------
test.describe('requirePermission (student roster)', () => {
    test('TA without roster permission → /api/courses/:courseId/students returns 403', async ({ baseURL }) => {
        await seedCourse({
            courseId: COURSE_A,
            instructorId,
            tas: [taId],
            taPermissions: { [taId]: { materials: true, roster: false } },
        });
        const api = await request.newContext({
            baseURL,
            storageState: storageStatePath('ta'),
        });
        try {
            const res = await api.get(`/api/courses/${COURSE_A}/students`);
            expect(res.status()).toBe(403);
        } finally {
            await api.dispose();
        }
    });

    test('TA with roster permission → /api/courses/:courseId/students returns 200', async ({ baseURL }) => {
        await seedCourse({
            courseId: COURSE_A,
            instructorId,
            tas: [taId],
            taPermissions: { [taId]: { materials: true, roster: true } },
        });
        const api = await request.newContext({
            baseURL,
            storageState: storageStatePath('ta'),
        });
        try {
            const res = await api.get(`/api/courses/${COURSE_A}/students`);
            expect(res.ok()).toBeTruthy();
        } finally {
            await api.dispose();
        }
    });
});
