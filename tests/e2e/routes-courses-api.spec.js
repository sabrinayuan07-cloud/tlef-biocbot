// @ts-check
/**
 * API coverage for src/routes/courses.js
 *
 * Goal: drive most of the route handlers, including the TA-management, unit-
 * management, transfer, statistics, approved-topics, and join paths that the
 * existing UI specs miss. Per AGENTS.md, bug-exposing assertions are left
 * failing and recorded in FINDINGS.md.
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
    setCourseStatus,
} = require('./helpers/courses-test');

// Stable ids so we don't leak fixtures across reruns
const COURSE_A = 'BIOC-E2E-API-COURSES-A';
const COURSE_B = 'BIOC-E2E-API-COURSES-B';
const COURSE_INACTIVE = 'BIOC-E2E-API-COURSES-INACTIVE';
const COURSE_DELETED = 'BIOC-E2E-API-COURSES-DELETED';
const COURSE_CREATED_VIA_API = 'bioc-e2e-api-created'; // populated dynamically; we clean by prefix
const VALID_API_KEY = 'sk-test-courses-api';

let instructorId;
let instructorFreshId;
let taId;
let studentId;

test.beforeAll(async () => {
    instructorId = await getUserIdByUsername(TEST_USERS.instructor.username);
    instructorFreshId = await getUserIdByUsername(TEST_USERS.instructor_fresh.username);
    taId = await getUserIdByUsername(TEST_USERS.ta.username);
    studentId = await getUserIdByUsername(TEST_USERS.student.username);
});

// Wipe each instructor's courses up-front so routes that find-by-instructorId
// don't accidentally target stale documents from prior runs. Also restore the
// e2e_ta user's role to 'ta', because the DELETE /tas/:taId route demotes a TA
// to 'student' when their final course assignment is removed.
test.beforeEach(async () => {
    await cleanupCoursesForUser(instructorId);
    await cleanupCoursesForUser(instructorFreshId);
    await withDb((db) =>
        db.collection('users').updateOne(
            { userId: taId },
            { $set: { role: 'ta', isActive: true }, $unset: { invitedCourses: '' } }
        )
    );
});

test.afterAll(async () => {
    await cleanupCourses([COURSE_A, COURSE_B, COURSE_INACTIVE, COURSE_DELETED]);
    await cleanupCoursesForUser(instructorId);
    await cleanupCoursesForUser(instructorFreshId);
});

// ---------------------------------------------------------------------------
// POST /api/courses — create
// ---------------------------------------------------------------------------
test.describe('POST /api/courses (create)', () => {
    test.describe('as instructor', () => {
        test.use({ storageState: storageStatePath('instructor') });

        test('400 when required fields are missing', async ({ request: api }) => {
            const res = await api.post('/api/courses', { data: { course: 'X' } });
            expect(res.status()).toBe(400);
        });

        test('400 when weeks is out of range', async ({ request: api }) => {
            const r1 = await api.post('/api/courses', {
                data: { course: 'X', weeks: 0, lecturesPerWeek: 1 },
            });
            expect(r1.status()).toBe(400);

            const r2 = await api.post('/api/courses', {
                data: { course: 'X', weeks: 25, lecturesPerWeek: 1 },
            });
            expect(r2.status()).toBe(400);
        });

        test('400 when lecturesPerWeek is out of range', async ({ request: api }) => {
            const res = await api.post('/api/courses', {
                data: { course: 'X', weeks: 4, lecturesPerWeek: 9 },
            });
            expect(res.status()).toBe(400);
        });

        test('201 happy path returns course id and structure', async ({ request: api }) => {
            const res = await api.post('/api/courses', {
                data: {
                    course: 'BIOC E2E API New Course',
                    weeks: 3,
                    lecturesPerWeek: 2,
                    contentTypes: ['practice-quizzes', 'lecture-notes'],
                    apiKey: VALID_API_KEY,
                },
            });
            expect(res.status()).toBe(201);
            const body = await res.json();
            expect(body.success).toBe(true);
            // Course ids are now opaque UUIDs from createId('course'), not name-derived slugs.
            expect(body.data.id).toMatch(/^course_[0-9a-f-]{36}$/);
            expect(body.data.weeks).toBe(3);
            expect(body.data.lecturesPerWeek).toBe(2);
            // Practice-quizzes special folder is in the returned structure
            expect(body.data.structure.specialFolders.some((f) => f.type === 'quiz')).toBe(true);

            // The course exists in the DB with 6 units (3 weeks × 2 per week)
            const doc = await withDb((db) =>
                db.collection('courses').findOne({ courseId: body.data.id })
            );
            expect(doc.courseStructure.totalUnits).toBe(6);
            expect(doc.lectures).toHaveLength(6);
            expect(doc.llmApiKey.status).toBe('valid');
        });
    });

    test.describe('as student', () => {
        test.use({ storageState: storageStatePath('student') });

        test('403 because only instructors can create', async ({ request: api }) => {
            const res = await api.post('/api/courses', {
                data: { course: 'NoGo', weeks: 1, lecturesPerWeek: 1 },
            });
            expect(res.status()).toBe(403);
        });
    });
});

test.describe('course LLM API keys', () => {
    test.use({ storageState: storageStatePath('instructor') });

    test('rejects invalid and quota-exhausted keys without replacing the saved key', async ({ request: api }) => {
        await seedCourse({ courseId: COURSE_A, instructorId });
        const before = await withDb((db) => db.collection('courses').findOne({ courseId: COURSE_A }));

        const invalid = await api.put(`/api/courses/${COURSE_A}/llm-key`, {
            data: { apiKey: 'not-a-real-key' },
            failOnStatusCode: false,
        });
        expect(invalid.status()).toBe(400);
        expect(await invalid.json()).toMatchObject({ success: false, code: 'LLM_KEY_INVALID' });

        const quota = await api.put(`/api/courses/${COURSE_A}/llm-key`, {
            data: { apiKey: 'sk-quota-courses-api' },
            failOnStatusCode: false,
        });
        expect(quota.status()).toBe(400);
        expect(await quota.json()).toMatchObject({ success: false, code: 'LLM_KEY_QUOTA' });

        const after = await withDb((db) => db.collection('courses').findOne({ courseId: COURSE_A }));
        expect(after.llmApiKey.ciphertext).toBe(before.llmApiKey.ciphertext);
    });

    test('saves course keys encrypted and can retest the saved key', async ({ request: api }) => {
        await seedCourse({ courseId: COURSE_A, instructorId });
        const apiKey = 'sk-test-courses-api-save-1234';

        const save = await api.put(`/api/courses/${COURSE_A}/llm-key`, {
            data: { apiKey },
        });
        expect(save.status()).toBe(200);
        expect(await save.json()).toMatchObject({
            success: true,
            aiAvailable: true,
            llmKey: { status: 'valid', last4: '1234' },
        });

        const doc = await withDb((db) => db.collection('courses').findOne({ courseId: COURSE_A }));
        expect(doc.llmApiKey.status).toBe('valid');
        expect(doc.llmApiKey.last4).toBe('1234');
        expect(doc.llmApiKey.ciphertext).not.toContain(apiKey);

        const testSaved = await api.post(`/api/courses/${COURSE_A}/llm-key/test`);
        expect(testSaved.status()).toBe(200);
        expect(await testSaved.json()).toMatchObject({
            success: true,
            aiAvailable: true,
            llmKey: { status: 'valid', last4: '1234' },
        });
    });
});

// ---------------------------------------------------------------------------
// GET /api/courses — list, plus the soft-delete bug (FINDINGS #6)
// ---------------------------------------------------------------------------
test.describe('GET /api/courses', () => {
    test.use({ storageState: storageStatePath('instructor') });

    test('403 for students', async ({ baseURL }) => {
        const api = await request.newContext({
            baseURL,
            storageState: storageStatePath('student'),
        });
        try {
            const res = await api.get('/api/courses');
            expect(res.status()).toBe(403);
        } finally {
            await api.dispose();
        }
    });

    test('returns instructor courses with transformed shape', async ({ request: api }) => {
        await seedCourse({ courseId: COURSE_A, instructorId, courseName: 'A' });
        const res = await api.get('/api/courses');
        expect(res.ok()).toBeTruthy();
        const body = await res.json();
        expect(body.success).toBe(true);
        const ours = body.data.find((c) => c.id === COURSE_A);
        expect(ours).toBeTruthy();
        expect(ours).toMatchObject({
            id: COURSE_A,
            name: 'A',
            instructorId,
            status: 'active',
        });
        expect(typeof ours.createdAt).toBe('string');
    });

    test('PRODUCT BUG (FINDINGS #6): soft-deleted courses still appear in GET /api/courses', async ({ request: api }) => {
        await seedCourse({ courseId: COURSE_DELETED, instructorId, courseName: 'Gone' });
        // Soft-delete via DELETE endpoint
        const del = await api.delete(`/api/courses/${COURSE_DELETED}?instructorId=${instructorId}`);
        expect(del.ok()).toBeTruthy();

        const res = await api.get('/api/courses');
        const body = await res.json();
        const ids = body.data.map((c) => c.id);
        // EXPECTED: deleted course should not be listed.
        expect(ids).not.toContain(COURSE_DELETED);
    });
});

// ---------------------------------------------------------------------------
// GET /api/courses/:courseId
// ---------------------------------------------------------------------------
test.describe('GET /api/courses/:courseId', () => {
    test('404 when course does not exist (instructor)', async ({ baseURL }) => {
        const api = await request.newContext({
            baseURL,
            storageState: storageStatePath('instructor'),
        });
        try {
            const res = await api.get('/api/courses/BIOC-E2E-API-NOPE');
            expect(res.status()).toBe(404);
        } finally {
            await api.dispose();
        }
    });

    test('404 when course does not exist (student)', async ({ baseURL }) => {
        const api = await request.newContext({
            baseURL,
            storageState: storageStatePath('student'),
        });
        try {
            const res = await api.get('/api/courses/BIOC-E2E-API-NOPE');
            expect(res.status()).toBe(404);
        } finally {
            await api.dispose();
        }
    });

    test.describe('as instructor', () => {
        test.use({ storageState: storageStatePath('instructor') });

        test('returns transformed course shape including lectures and structure', async ({ request: api }) => {
            await seedCourse({ courseId: COURSE_A, instructorId, courseName: 'A' });
            const res = await api.get(`/api/courses/${COURSE_A}`);
            expect(res.ok()).toBeTruthy();
            const body = await res.json();
            expect(body.data).toMatchObject({
                id: COURSE_A,
                courseId: COURSE_A,
                name: 'A',
                instructorId,
            });
            expect(Array.isArray(body.data.lectures)).toBe(true);
            expect(body.data.lectures.length).toBeGreaterThan(0);
            expect(body.data.structure.specialFolders[0]).toEqual({
                id: 'quizzes',
                name: 'Practice Quizzes',
                type: 'quiz',
            });
        });

        test('404 when caller does not own the course', async ({ baseURL }) => {
            // Course is owned by instructor_fresh; the default instructor isn't in the access list.
            await seedCourse({ courseId: COURSE_B, instructorId: instructorFreshId, courseName: 'B' });
            const api = await request.newContext({
                baseURL,
                storageState: storageStatePath('instructor'),
            });
            try {
                const res = await api.get(`/api/courses/${COURSE_B}`);
                expect(res.status()).toBe(404);
            } finally {
                await api.dispose();
            }
        });
    });

    test.describe('as student', () => {
        test.use({ storageState: storageStatePath('student') });

        test('403 when student is not enrolled', async ({ request: api }) => {
            await seedCourse({ courseId: COURSE_A, instructorId, courseName: 'A' });
            const res = await api.get(`/api/courses/${COURSE_A}`);
            expect(res.status()).toBe(403);
        });

        test('200 when student is enrolled', async ({ request: api }) => {
            await seedCourse({ courseId: COURSE_A, instructorId });
            await setStudentEnrollment(COURSE_A, studentId, true);
            const res = await api.get(`/api/courses/${COURSE_A}`);
            expect(res.ok()).toBeTruthy();
            const body = await res.json();
            expect(body.data.id).toBe(COURSE_A);
        });

        test('403 when course status is inactive (blocked by requireActiveCourseForNonInstructors)', async ({ request: api }) => {
            await seedCourse({ courseId: COURSE_INACTIVE, instructorId, status: 'inactive' });
            await setStudentEnrollment(COURSE_INACTIVE, studentId, true);
            const res = await api.get(`/api/courses/${COURSE_INACTIVE}`);
            expect(res.status()).toBe(403);
        });
    });
});

// ---------------------------------------------------------------------------
// Approved struggle topics
// ---------------------------------------------------------------------------
test.describe('approved-topics endpoints', () => {
    test.describe('as instructor', () => {
        test.use({ storageState: storageStatePath('instructor') });

        test.beforeEach(async () => {
            await seedCourse({ courseId: COURSE_A, instructorId });
        });

        test('GET /approved-topics returns empty list initially', async ({ request: api }) => {
            const res = await api.get(`/api/courses/${COURSE_A}/approved-topics`);
            expect(res.ok()).toBeTruthy();
            const body = await res.json();
            expect(body.data.courseId).toBe(COURSE_A);
            expect(Array.isArray(body.data.topics)).toBe(true);
            expect(body.data.topics).toHaveLength(0);
        });

        test('PUT /approved-topics replaces the list', async ({ request: api }) => {
            const res = await api.put(`/api/courses/${COURSE_A}/approved-topics`, {
                data: { topics: ['Cell Biology', 'Genetics', 'Metabolism'] },
            });
            expect(res.ok()).toBeTruthy();
            const body = await res.json();
            expect(body.data.topicLabels).toEqual(['Cell Biology', 'Genetics', 'Metabolism']);
        });

        test('PUT /approved-topics 400 when topics is not an array', async ({ request: api }) => {
            const res = await api.put(`/api/courses/${COURSE_A}/approved-topics`, {
                data: { topics: 'not-an-array' },
            });
            expect(res.status()).toBe(400);
        });

        test('PUT /approved-topics 404 for unknown course', async ({ request: api }) => {
            const res = await api.put('/api/courses/BIOC-E2E-API-NOPE/approved-topics', {
                data: { topics: [] },
            });
            expect(res.status()).toBe(404);
        });

        test('PATCH /approved-topics/unit assigns a topic to a unit', async ({ request: api }) => {
            await api.put(`/api/courses/${COURSE_A}/approved-topics`, {
                data: { topics: ['Cell Biology'] },
            });
            const res = await api.patch(`/api/courses/${COURSE_A}/approved-topics/unit`, {
                data: { topic: 'Cell Biology', unitId: 'Unit 1' },
            });
            expect(res.ok()).toBeTruthy();
            const body = await res.json();
            // normalizeTopicObject stores the label in the `topic` field
            expect(body.data.topic.topic).toBe('Cell Biology');
            expect(body.data.topic.unitId).toBe('Unit 1');
        });

        test('PATCH /approved-topics/unit 404 when topic does not exist', async ({ request: api }) => {
            const res = await api.patch(`/api/courses/${COURSE_A}/approved-topics/unit`, {
                data: { topic: 'NonExistentTopic', unitId: 'Unit 1' },
            });
            expect([400, 404]).toContain(res.status());
        });
    });

    test.describe('as student', () => {
        test.use({ storageState: storageStatePath('student') });

        test('GET /approved-topics 403 when not enrolled', async ({ request: api }) => {
            await seedCourse({ courseId: COURSE_A, instructorId });
            const res = await api.get(`/api/courses/${COURSE_A}/approved-topics`);
            // Either blocked by the route's access check or by middleware
            expect([403]).toContain(res.status());
        });

        test('PUT /approved-topics 403 — students cannot update', async ({ request: api }) => {
            await seedCourse({ courseId: COURSE_A, instructorId });
            await setStudentEnrollment(COURSE_A, studentId, true);
            const res = await api.put(`/api/courses/${COURSE_A}/approved-topics`, {
                data: { topics: ['Hack'] },
            });
            expect(res.status()).toBe(403);
        });
    });
});

// ---------------------------------------------------------------------------
// PUT /api/courses/:courseId — update
// ---------------------------------------------------------------------------
test.describe('PUT /api/courses/:courseId (update)', () => {
    test.use({ storageState: storageStatePath('instructor') });

    test.beforeEach(async () => {
        await seedCourse({ courseId: COURSE_A, instructorId, courseName: 'Original' });
    });

    test('400 when instructorId is missing', async ({ request: api }) => {
        const res = await api.put(`/api/courses/${COURSE_A}`, { data: { name: 'New' } });
        expect(res.status()).toBe(400);
    });

    test('404 when caller is not in instructors array', async ({ request: api }) => {
        const res = await api.put(`/api/courses/${COURSE_A}?instructorId=${instructorFreshId}`, {
            data: { name: 'Hijack' },
        });
        // userHasCourseAccess returns false, route responds 403 (per code).
        expect([403, 404]).toContain(res.status());
    });

    test('happy path updates name, status, isAdditiveRetrieval, weeks, prompts', async ({ request: api }) => {
        const res = await api.put(`/api/courses/${COURSE_A}?instructorId=${instructorId}`, {
            data: {
                name: 'Renamed',
                status: 'inactive',
                weeks: 5,
                lecturesPerWeek: 2,
                isAdditiveRetrieval: true,
                base: 'Base prompt v1',
                tutor: 'Tutor prompt v1',
                protege: 'Protege prompt v1',
            },
        });
        expect(res.ok()).toBeTruthy();

        const doc = await withDb((db) =>
            db.collection('courses').findOne({ courseId: COURSE_A })
        );
        expect(doc.courseName).toBe('Renamed');
        expect(doc.status).toBe('inactive');
        expect(doc.isAdditiveRetrieval).toBe(true);
        expect(doc.courseStructure.totalUnits).toBe(10);
        expect(doc.prompts.base).toBe('Base prompt v1');
        expect(doc.prompts.tutor).toBe('Tutor prompt v1');
        expect(doc.prompts.protege).toBe('Protege prompt v1');
    });

    test('accepts a full lectures array (document-removal fallback path)', async ({ request: api }) => {
        const res = await api.put(`/api/courses/${COURSE_A}?instructorId=${instructorId}`, {
            data: {
                lectures: [
                    { name: 'Unit 1', isPublished: true, documents: [], learningObjectives: [], assessmentQuestions: [] },
                ],
            },
        });
        expect(res.ok()).toBeTruthy();
        const doc = await withDb((db) =>
            db.collection('courses').findOne({ courseId: COURSE_A })
        );
        expect(doc.lectures).toHaveLength(1);
        expect(doc.lectures[0].isPublished).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// PUT /api/courses/:courseId/retrieval-mode
// ---------------------------------------------------------------------------
test.describe('PUT /api/courses/:courseId/retrieval-mode', () => {
    test.use({ storageState: storageStatePath('instructor') });

    test.beforeEach(async () => {
        await seedCourse({ courseId: COURSE_A, instructorId });
    });

    test('400 when isAdditiveRetrieval is not a boolean', async ({ request: api }) => {
        const res = await api.put(`/api/courses/${COURSE_A}/retrieval-mode`, {
            data: { isAdditiveRetrieval: 'yes-please' },
        });
        expect(res.status()).toBe(400);
    });

    test('happy path flips the flag', async ({ request: api }) => {
        const res = await api.put(`/api/courses/${COURSE_A}/retrieval-mode`, {
            data: { isAdditiveRetrieval: true },
        });
        expect(res.ok()).toBeTruthy();
        const doc = await withDb((db) =>
            db.collection('courses').findOne({ courseId: COURSE_A })
        );
        expect(doc.isAdditiveRetrieval).toBe(true);
    });

    test('403 when caller is not an instructor on the course', async ({ baseURL }) => {
        await seedCourse({ courseId: COURSE_B, instructorId: instructorFreshId });
        const api = await request.newContext({
            baseURL,
            storageState: storageStatePath('instructor'),
        });
        try {
            const res = await api.put(`/api/courses/${COURSE_B}/retrieval-mode`, {
                data: { isAdditiveRetrieval: true },
            });
            expect(res.status()).toBe(403);
        } finally {
            await api.dispose();
        }
    });

    test('404 when course does not exist', async ({ request: api }) => {
        const res = await api.put('/api/courses/BIOC-E2E-API-NOPE/retrieval-mode', {
            data: { isAdditiveRetrieval: true },
        });
        expect(res.status()).toBe(404);
    });
});

// ---------------------------------------------------------------------------
// Available / joinable lists
// ---------------------------------------------------------------------------
test.describe('available + joinable', () => {
    test.describe('GET /available/all', () => {
        test('instructor sees their own courses; not someone else\'s', async ({ baseURL }) => {
            await seedCourse({ courseId: COURSE_A, instructorId });
            await seedCourse({ courseId: COURSE_B, instructorId: instructorFreshId });
            const api = await request.newContext({
                baseURL,
                storageState: storageStatePath('instructor'),
            });
            try {
                const res = await api.get('/api/courses/available/all');
                expect(res.ok()).toBeTruthy();
                const body = await res.json();
                const ids = body.data.map((c) => c.courseId);
                expect(ids).toContain(COURSE_A);
                expect(ids).not.toContain(COURSE_B);
            } finally {
                await api.dispose();
            }
        });

        test('student only sees active courses (inactive ones are filtered out)', async ({ baseURL }) => {
            await seedCourse({ courseId: COURSE_A, instructorId });
            await seedCourse({ courseId: COURSE_INACTIVE, instructorId, status: 'inactive' });
            const api = await request.newContext({
                baseURL,
                storageState: storageStatePath('student'),
            });
            try {
                const res = await api.get('/api/courses/available/all');
                expect(res.ok()).toBeTruthy();
                const body = await res.json();
                const ids = body.data.map((c) => c.courseId);
                expect(ids).toContain(COURSE_A);
                expect(ids).not.toContain(COURSE_INACTIVE);
            } finally {
                await api.dispose();
            }
        });

        test('PRODUCT BUG (FINDINGS #28): TA sees inactive courses through /available/all', async ({ baseURL }) => {
            // The TA filter resets availableCourses from the unfiltered list, so
            // inactive courses can leak through. Expected: TAs only see active or
            // assigned/invited courses.
            await seedCourse({ courseId: COURSE_INACTIVE, instructorId, status: 'inactive' });
            const api = await request.newContext({
                baseURL,
                storageState: storageStatePath('ta'),
            });
            try {
                const res = await api.get('/api/courses/available/all');
                const body = await res.json();
                const ids = body.data.map((c) => c.courseId);
                expect(ids).not.toContain(COURSE_INACTIVE);
            } finally {
                await api.dispose();
            }
        });
    });

    test.describe('GET /available/joinable', () => {
        test.use({ storageState: storageStatePath('instructor') });

        test('lists courses the instructor does NOT already own', async ({ request: api }) => {
            await seedCourse({ courseId: COURSE_A, instructorId });
            await seedCourse({ courseId: COURSE_B, instructorId: instructorFreshId });
            const res = await api.get('/api/courses/available/joinable');
            expect(res.ok()).toBeTruthy();
            const body = await res.json();
            const ids = body.data.map((c) => c.courseId);
            expect(ids).toContain(COURSE_B); // owned by someone else, joinable
            expect(ids).not.toContain(COURSE_A); // already owned
        });

        test('403 for non-instructors', async ({ baseURL }) => {
            const api = await request.newContext({
                baseURL,
                storageState: storageStatePath('student'),
            });
            try {
                const res = await api.get('/api/courses/available/joinable');
                expect(res.status()).toBe(403);
            } finally {
                await api.dispose();
            }
        });
    });
});

// ---------------------------------------------------------------------------
// Joining: student via code, TA, instructor via code
// ---------------------------------------------------------------------------
test.describe('POST /api/courses/:courseId/join', () => {
    test.describe('as student', () => {
        test.use({ storageState: storageStatePath('student') });

        test.beforeEach(async () => {
            await seedCourse({
                courseId: COURSE_A,
                instructorId,
                courseCode: 'STUCD',
            });
        });

        test('400 when course code is missing', async ({ request: api }) => {
            const res = await api.post(`/api/courses/${COURSE_A}/join`, { data: {} });
            expect(res.status()).toBe(400);
        });

        test('403 when course code is wrong', async ({ request: api }) => {
            const res = await api.post(`/api/courses/${COURSE_A}/join`, {
                data: { code: 'WRONG!' },
            });
            expect(res.status()).toBe(403);
        });

        test('happy path enrolls the student', async ({ request: api }) => {
            const res = await api.post(`/api/courses/${COURSE_A}/join`, {
                data: { code: 'STUCD' },
            });
            expect(res.ok()).toBeTruthy();
            const enr = await withDb((db) =>
                db.collection('courses').findOne(
                    { courseId: COURSE_A },
                    { projection: { studentEnrollment: 1 } }
                )
            );
            expect(enr.studentEnrollment[studentId]).toBeTruthy();
        });
    });

    test.describe('as TA', () => {
        test.use({ storageState: storageStatePath('ta') });

        test('404 when course does not exist', async ({ request: api }) => {
            const res = await api.post('/api/courses/BIOC-E2E-API-NOPE/join', {
                data: { code: 'X' },
            });
            expect(res.status()).toBe(404);
        });

        test('happy path TA joins with code', async ({ request: api }) => {
            await seedCourse({ courseId: COURSE_A, instructorId, courseCode: 'STUCD' });
            const res = await api.post(`/api/courses/${COURSE_A}/join`, {
                data: { code: 'STUCD' },
            });
            expect(res.ok()).toBeTruthy();
            const doc = await withDb((db) =>
                db.collection('courses').findOne({ courseId: COURSE_A })
            );
            expect(doc.tas).toContain(taId);
        });

        test('400 when code missing and TA is not invited/assigned', async ({ request: api }) => {
            await seedCourse({ courseId: COURSE_A, instructorId });
            // ensure TA isn't on tas[] nor invitedCourses
            await withDb((db) =>
                db.collection('users').updateOne(
                    { userId: taId },
                    { $set: { invitedCourses: [] } }
                )
            );
            const res = await api.post(`/api/courses/${COURSE_A}/join`, { data: {} });
            expect(res.status()).toBe(400);
        });
    });

    test.describe('as instructor', () => {
        test.use({ storageState: storageStatePath('instructor') });

        test('403 — instructors must use /instructors, not /join', async ({ request: api }) => {
            await seedCourse({ courseId: COURSE_B, instructorId: instructorFreshId });
            const res = await api.post(`/api/courses/${COURSE_B}/join`, { data: {} });
            expect(res.status()).toBe(403);
        });
    });
});

// ---------------------------------------------------------------------------
// POST /api/courses/:courseId/instructors — join as additional instructor
// ---------------------------------------------------------------------------
test.describe('POST /api/courses/:courseId/instructors', () => {
    test.use({ storageState: storageStatePath('instructor') });

    test('400 when instructorId missing', async ({ request: api }) => {
        await seedCourse({ courseId: COURSE_B, instructorId: instructorFreshId });
        const res = await api.post(`/api/courses/${COURSE_B}/instructors`, {
            data: { code: 'X' },
        });
        expect(res.status()).toBe(400);
    });

    test('403 when instructorId does not match caller', async ({ request: api }) => {
        await seedCourse({ courseId: COURSE_B, instructorId: instructorFreshId });
        const res = await api.post(`/api/courses/${COURSE_B}/instructors`, {
            data: { instructorId: instructorFreshId, code: 'INSTCD' },
        });
        expect(res.status()).toBe(403);
    });

    test('404 when course does not exist', async ({ request: api }) => {
        const res = await api.post('/api/courses/BIOC-E2E-API-NOPE/instructors', {
            data: { instructorId, code: 'INSTCD' },
        });
        expect(res.status()).toBe(404);
    });

    test('400 when not already an instructor and no code supplied', async ({ request: api }) => {
        await seedCourse({ courseId: COURSE_B, instructorId: instructorFreshId });
        const res = await api.post(`/api/courses/${COURSE_B}/instructors`, {
            data: { instructorId },
        });
        expect(res.status()).toBe(400);
    });

    test('403 when instructor code is wrong', async ({ request: api }) => {
        await seedCourse({
            courseId: COURSE_B,
            instructorId: instructorFreshId,
            instructorCourseCode: 'CORRECT',
        });
        const res = await api.post(`/api/courses/${COURSE_B}/instructors`, {
            data: { instructorId, code: 'WRONG' },
        });
        expect(res.status()).toBe(403);
    });

    test('happy path joins the instructor', async ({ request: api }) => {
        await seedCourse({
            courseId: COURSE_B,
            instructorId: instructorFreshId,
            instructorCourseCode: 'CORRECT',
        });
        const res = await api.post(`/api/courses/${COURSE_B}/instructors`, {
            data: { instructorId, code: 'CORRECT' },
        });
        expect(res.ok()).toBeTruthy();
        const doc = await withDb((db) =>
            db.collection('courses').findOne({ courseId: COURSE_B })
        );
        expect(doc.instructors).toContain(instructorId);
    });

    test('idempotent: already an instructor returns success with alreadyJoined', async ({ request: api }) => {
        await seedCourse({ courseId: COURSE_A, instructorId });
        const res = await api.post(`/api/courses/${COURSE_A}/instructors`, {
            data: { instructorId, code: 'INSTCD' },
        });
        expect(res.ok()).toBeTruthy();
        const body = await res.json();
        expect(body.data.alreadyJoined).toBe(true);
    });

    test('PRODUCT BUG (FINDINGS #29): joinCourseAsInstructor allows joining a deleted course', async ({ request: api }) => {
        await seedCourse({
            courseId: COURSE_DELETED,
            instructorId: instructorFreshId,
            instructorCourseCode: 'CORRECT',
            status: 'deleted',
        });
        const res = await api.post(`/api/courses/${COURSE_DELETED}/instructors`, {
            data: { instructorId, code: 'CORRECT' },
        });
        // EXPECTED: refuse to attach to a deleted course.
        expect([403, 404]).toContain(res.status());
    });
});

// ---------------------------------------------------------------------------
// TA management: add, remove, permissions
// ---------------------------------------------------------------------------
test.describe('TA management', () => {
    test.use({ storageState: storageStatePath('instructor') });

    test.beforeEach(async () => {
        await seedCourse({ courseId: COURSE_A, instructorId });
    });

    test('POST /tas adds a TA (400 when taId missing)', async ({ request: api }) => {
        const r1 = await api.post(`/api/courses/${COURSE_A}/tas`, { data: {} });
        expect(r1.status()).toBe(400);

        const r2 = await api.post(`/api/courses/${COURSE_A}/tas`, { data: { taId } });
        expect(r2.ok()).toBeTruthy();
        const doc = await withDb((db) =>
            db.collection('courses').findOne({ courseId: COURSE_A })
        );
        expect(doc.tas).toContain(taId);
    });

    test('PUT /ta-permissions/:taId updates and validates', async ({ request: api }) => {
        await api.post(`/api/courses/${COURSE_A}/tas`, { data: { taId } });

        const emptyBody = await api.put(`/api/courses/${COURSE_A}/ta-permissions/${taId}`, {
            data: {},
        });
        expect(emptyBody.status()).toBe(400);

        const badType = await api.put(`/api/courses/${COURSE_A}/ta-permissions/${taId}`, {
            data: { materials: 'yes' },
        });
        expect(badType.status()).toBe(400);

        // Partial patch: only the sent key changes.
        const good = await api.put(`/api/courses/${COURSE_A}/ta-permissions/${taId}`, {
            data: { materials: true, flags: false },
        });
        expect(good.ok()).toBeTruthy();

        const doc = await withDb((db) =>
            db.collection('courses').findOne({ courseId: COURSE_A })
        );
        expect(doc.taPermissions[taId]).toMatchObject({
            materials: true,
            flags: false,
        });
    });

    test('PUT /ta-permissions/:taId accepts a named role preset', async ({ request: api }) => {
        await api.post(`/api/courses/${COURSE_A}/tas`, { data: { taId } });

        const res = await api.put(`/api/courses/${COURSE_A}/ta-permissions/${taId}`, {
            data: { role: 'fullTA' },
        });
        expect(res.ok()).toBeTruthy();
        const body = await res.json();
        expect(body.data.permissions).toEqual({
            materials: true, questions: true, flags: true, roster: true, transcripts: true, settings: true,
        });
        expect(body.data.roleLabel).toBe('fullTA');
    });

    test('GET /ta-permissions returns all TA permissions for course', async ({ request: api }) => {
        await api.post(`/api/courses/${COURSE_A}/tas`, { data: { taId } });
        await api.put(`/api/courses/${COURSE_A}/ta-permissions/${taId}`, {
            data: { materials: true, flags: true },
        });
        const res = await api.get(`/api/courses/${COURSE_A}/ta-permissions`);
        expect(res.ok()).toBeTruthy();
        const body = await res.json();
        expect(body.data.taPermissions[taId]).toBeTruthy();
        expect(body.data.taPermissions[taId].roleLabel).toBeTruthy();
    });

    test('GET /ta-permissions/:taId — instructor can read any TA', async ({ request: api }) => {
        await api.post(`/api/courses/${COURSE_A}/tas`, { data: { taId } });
        const res = await api.get(`/api/courses/${COURSE_A}/ta-permissions/${taId}`);
        expect(res.ok()).toBeTruthy();
        const body = await res.json();
        expect(body.data.taId).toBe(taId);
    });

    test('DELETE /tas/:taId removes the TA', async ({ request: api }) => {
        await api.post(`/api/courses/${COURSE_A}/tas`, { data: { taId } });
        const res = await api.delete(`/api/courses/${COURSE_A}/tas/${taId}`);
        expect(res.ok()).toBeTruthy();
        const doc = await withDb((db) =>
            db.collection('courses').findOne({ courseId: COURSE_A })
        );
        expect(doc.tas).not.toContain(taId);
    });
});

test.describe('TA-side permissions reads', () => {
    test.use({ storageState: storageStatePath('ta') });

    test('GET /ta/:taId returns courses for the TA', async ({ request: api }) => {
        await seedCourse({
            courseId: COURSE_A,
            instructorId,
            tas: [taId],
            taPermissions: { [taId]: { materials: true, questions: true, settings: true, transcripts: true, flags: true, roster: true } },
        });
        const res = await api.get(`/api/courses/ta/${taId}`);
        expect(res.ok()).toBeTruthy();
        const body = await res.json();
        const ids = body.data.map((c) => c.courseId);
        expect(ids).toContain(COURSE_A);
    });

    test('GET /ta/:taId 403 when asking about another TA', async ({ request: api }) => {
        const res = await api.get('/api/courses/ta/somebody-else');
        expect(res.status()).toBe(403);
    });
});

// ---------------------------------------------------------------------------
// Student enrollment endpoints
// ---------------------------------------------------------------------------
test.describe('student-enrollment endpoints', () => {
    test('PUT /student-enrollment/:studentId 400 when enrolled is not boolean', async ({ baseURL }) => {
        await seedCourse({ courseId: COURSE_A, instructorId });
        const api = await request.newContext({
            baseURL,
            storageState: storageStatePath('instructor'),
        });
        try {
            const res = await api.put(`/api/courses/${COURSE_A}/student-enrollment/${studentId}`, {
                data: { enrolled: 'maybe' },
            });
            expect(res.status()).toBe(400);
        } finally {
            await api.dispose();
        }
    });

    test('PUT /student-enrollment/:studentId happy path toggles enrollment', async ({ baseURL }) => {
        await seedCourse({ courseId: COURSE_A, instructorId });
        const api = await request.newContext({
            baseURL,
            storageState: storageStatePath('instructor'),
        });
        try {
            await api.put(`/api/courses/${COURSE_A}/student-enrollment/${studentId}`, {
                data: { enrolled: true },
            });
            const doc = await withDb((db) =>
                db.collection('courses').findOne({ courseId: COURSE_A })
            );
            expect(doc.studentEnrollment[studentId].enrolled).toBe(true);
        } finally {
            await api.dispose();
        }
    });

    test('GET /student-enrollment is reachable for a student even on inactive course', async ({ baseURL }) => {
        // requireActiveCourseForNonInstructors special-cases this path.
        await seedCourse({ courseId: COURSE_INACTIVE, instructorId, status: 'inactive' });
        const api = await request.newContext({
            baseURL,
            storageState: storageStatePath('student'),
        });
        try {
            const res = await api.get(`/api/courses/${COURSE_INACTIVE}/student-enrollment`);
            // Either 200 with course_inactive or 200 with enrolled:false — the
            // route must be reachable (not blocked by middleware).
            expect(res.status()).toBe(200);
            const body = await res.json();
            expect(body.data.enrolled === false).toBe(true);
        } finally {
            await api.dispose();
        }
    });
});

// ---------------------------------------------------------------------------
// Unit management: add, rename, delete
// ---------------------------------------------------------------------------
test.describe('units endpoints', () => {
    test.use({ storageState: storageStatePath('instructor') });

    test.beforeEach(async () => {
        await seedCourse({ courseId: COURSE_A, instructorId });
    });

    test('POST /units 400 when instructorId missing', async ({ request: api }) => {
        const res = await api.post(`/api/courses/${COURSE_A}/units`, { data: {} });
        expect(res.status()).toBe(400);
    });

    test('POST /units adds a unit and increments totalUnits', async ({ request: api }) => {
        const res = await api.post(`/api/courses/${COURSE_A}/units`, {
            data: { instructorId },
        });
        expect(res.ok()).toBeTruthy();
        const body = await res.json();
        expect(body.data.unit.name).toMatch(/^Unit \d+$/);

        const doc = await withDb((db) =>
            db.collection('courses').findOne({ courseId: COURSE_A })
        );
        expect(doc.lectures.length).toBe(3);
        expect(doc.courseStructure.totalUnits).toBe(3);
    });

    test('PUT /units/:unitName/rename updates the displayName', async ({ request: api }) => {
        const res = await api.put(`/api/courses/${COURSE_A}/units/${encodeURIComponent('Unit 1')}/rename`, {
            data: { instructorId, displayName: 'Cell Theory' },
        });
        expect(res.ok()).toBeTruthy();
        const doc = await withDb((db) =>
            db.collection('courses').findOne({ courseId: COURSE_A })
        );
        const u1 = doc.lectures.find((l) => l.name === 'Unit 1');
        expect(u1.displayName).toBe('Cell Theory');
    });

    test('DELETE /units/:unitName removes the unit', async ({ request: api }) => {
        const res = await api.delete(
            `/api/courses/${COURSE_A}/units/${encodeURIComponent('Unit 2')}`,
            { data: { instructorId } }
        );
        expect(res.ok()).toBeTruthy();
        const doc = await withDb((db) =>
            db.collection('courses').findOne({ courseId: COURSE_A })
        );
        expect(doc.lectures.find((l) => l.name === 'Unit 2')).toBeFalsy();
    });

    test('DELETE /units/:unitName 404 when unit does not exist', async ({ request: api }) => {
        const res = await api.delete(
            `/api/courses/${COURSE_A}/units/${encodeURIComponent('Unit 99')}`,
            { data: { instructorId } }
        );
        expect(res.status()).toBe(404);
    });

    test('PRODUCT BUG: DELETE /units/:unitName 500 when no body sent (destructures req.body)', async ({ request: api }) => {
        // src/routes/courses.js:3140 destructures `const { instructorId } = req.body;`
        // Express 5 leaves req.body undefined when the request has no
        // Content-Type, so this route crashes before it can read the
        // querystring fallback. Expected: gracefully read the query param and
        // return 400/200 instead of 500.
        const res = await api.delete(
            `/api/courses/${COURSE_A}/units/${encodeURIComponent('Unit 2')}?instructorId=${instructorId}`
        );
        expect(res.status()).not.toBe(500);
    });
});

// ---------------------------------------------------------------------------
// course-materials/confirm
// ---------------------------------------------------------------------------
test.describe('POST /api/courses/course-materials/confirm', () => {
    test.use({ storageState: storageStatePath('instructor') });

    test('400 when required fields missing', async ({ request: api }) => {
        const res = await api.post('/api/courses/course-materials/confirm', {
            data: { week: 'Unit 1' },
        });
        expect(res.status()).toBe(400);
    });

    test('404 when instructor has no course with that unit', async ({ request: api }) => {
        const res = await api.post('/api/courses/course-materials/confirm', {
            data: { week: 'Unit 999', instructorId },
        });
        expect(res.status()).toBe(404);
    });

    test('happy path marks materials confirmed', async ({ request: api }) => {
        await seedCourse({ courseId: COURSE_A, instructorId });
        const res = await api.post('/api/courses/course-materials/confirm', {
            data: { week: 'Unit 1', instructorId },
        });
        expect(res.ok()).toBeTruthy();
        const doc = await withDb((db) =>
            db.collection('courses').findOne({ courseId: COURSE_A })
        );
        const u1 = doc.lectures.find((l) => l.name === 'Unit 1');
        expect(u1.materialsConfirmed).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------
test.describe('GET /api/courses/statistics', () => {
    test.use({ storageState: storageStatePath('instructor') });

    test('403 when caller is a student', async ({ baseURL }) => {
        const api = await request.newContext({
            baseURL,
            storageState: storageStatePath('student'),
        });
        try {
            const res = await api.get('/api/courses/statistics');
            expect(res.status()).toBe(403);
        } finally {
            await api.dispose();
        }
    });

    test('zero stats when instructor has no chat sessions', async ({ request: api }) => {
        await seedCourse({ courseId: COURSE_A, instructorId });
        const res = await api.get(`/api/courses/statistics?courseId=${COURSE_A}`);
        expect(res.ok()).toBeTruthy();
        const body = await res.json();
        expect(body.data.totalSessions).toBe(0);
        expect(body.data.totalStudents).toBe(0);
    });

    test('aggregates chat sessions correctly (mode mix + duration + length)', async ({ request: api }) => {
        await seedCourse({ courseId: COURSE_A, instructorId });

        const t0 = new Date('2026-04-01T12:00:00Z');
        const t1 = new Date('2026-04-01T12:01:30Z'); // +90s
        const t2 = new Date('2026-04-01T12:03:00Z'); // +90s
        await withDb(async (db) => {
            await db.collection('chat_sessions').insertMany([
                {
                    sessionId: 'sess1',
                    courseId: COURSE_A,
                    studentId: studentId,
                    chatData: {
                        metadata: { currentMode: 'tutor' },
                        messages: [
                            { type: 'user', content: 'Hi there!',  timestamp: t0 },
                            { type: 'bot',  content: 'Hello back.', timestamp: t1 },
                        ],
                    },
                },
                {
                    sessionId: 'sess2',
                    courseId: COURSE_A,
                    studentId: 'OTHER-STUDENT',
                    chatData: {
                        metadata: { currentMode: 'protege' },
                        messages: [
                            { type: 'user', content: 'A',  timestamp: t1 },
                            { type: 'bot',  content: 'BB', timestamp: t2 },
                        ],
                    },
                },
            ]);
        });

        const res = await api.get(`/api/courses/statistics?courseId=${COURSE_A}`);
        const body = await res.json();
        expect(body.data.totalSessions).toBe(2);
        expect(body.data.totalStudents).toBe(2);
        expect(body.data.modeDistribution).toEqual({ tutor: 1, protege: 1 });
        expect(body.data.averageSessionLengthSeconds).toBe(90);
        expect(body.data.averageMessagesPerSession).toBeGreaterThan(0);
        expect(body.data.averageMessageLength).toBeGreaterThan(0);
        expect(body.data.averageSessionLength).toMatch(/^(\d+m \d+s|\d+s|\d+h \d+m)$/);

        await withDb((db) =>
            db.collection('chat_sessions').deleteMany({ courseId: COURSE_A })
        );
    });
});

// ---------------------------------------------------------------------------
// remove-document + transfer (lightweight) — drive happy/sad branches
// ---------------------------------------------------------------------------
test.describe('POST /:courseId/remove-document', () => {
    test.use({ storageState: storageStatePath('instructor') });

    test('400 when missing fields', async ({ request: api }) => {
        const res = await api.post(`/api/courses/${COURSE_A}/remove-document`, {
            data: { documentId: 'x' },
        });
        expect(res.status()).toBe(400);
    });

    test('404 when document is not in any unit', async ({ request: api }) => {
        await seedCourse({ courseId: COURSE_A, instructorId });
        const res = await api.post(`/api/courses/${COURSE_A}/remove-document`, {
            data: { documentId: 'doc-not-here', instructorId },
        });
        expect(res.status()).toBe(404);
    });

    test('happy path removes a doc reference from a unit', async ({ request: api }) => {
        const lectures = [
            {
                name: 'Unit 1',
                isPublished: false,
                learningObjectives: [],
                passThreshold: 2,
                documents: [{ documentId: 'doc-abc', filename: 'a.txt' }],
                assessmentQuestions: [],
            },
        ];
        await seedCourse({ courseId: COURSE_A, instructorId, lectures });
        const res = await api.post(`/api/courses/${COURSE_A}/remove-document`, {
            data: { documentId: 'doc-abc', instructorId },
        });
        expect(res.ok()).toBeTruthy();
        const doc = await withDb((db) =>
            db.collection('courses').findOne({ courseId: COURSE_A })
        );
        const u1 = doc.lectures.find((l) => l.name === 'Unit 1');
        expect(u1.documents.find((d) => d.documentId === 'doc-abc')).toBeFalsy();
    });
});

test.describe('POST /:courseId/transfer', () => {
    test.use({ storageState: storageStatePath('instructor') });

    test('400 when newCourseName missing', async ({ request: api }) => {
        await seedCourse({ courseId: COURSE_A, instructorId });
        const res = await api.post(`/api/courses/${COURSE_A}/transfer`, { data: {} });
        expect(res.status()).toBe(400);
    });

    test('404 when source course does not exist', async ({ request: api }) => {
        const res = await api.post('/api/courses/BIOC-E2E-API-NOPE/transfer', {
            data: { newCourseName: 'X' },
        });
        expect(res.status()).toBe(404);
    });

    test('happy path creates a new course copy without docs', async ({ request: api }) => {
        await seedCourse({ courseId: COURSE_A, instructorId });
        const res = await api.post(`/api/courses/${COURSE_A}/transfer`, {
            data: {
                newCourseName: 'BIOC E2E API Transfer Target',
                transferSettings: true,
                transferTAs: false,
                deactivateSourceCourse: true,
                apiKey: VALID_API_KEY,
                units: [
                    { unitName: 'Unit 1', transferDocuments: false, transferLearningObjectives: true, transferAssessmentQuestions: false },
                ],
            },
        });
        expect(res.ok()).toBeTruthy();
        const body = await res.json();
        expect(body.data.summary.totalUnits).toBe(2);
        expect(body.data.sourceDeactivated).toBe(true);

        // Source course is now inactive
        const src = await withDb((db) =>
            db.collection('courses').findOne({ courseId: COURSE_A })
        );
        expect(src.status).toBe('inactive');
    });
});
