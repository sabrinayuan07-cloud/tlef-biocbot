// @ts-check
/**
 * Branch coverage for src/models/Course.js — the largest model in the repo.
 *
 * Existing specs already hit the happy paths for most static methods through
 * routes/courses.js, routes/lectures.js, routes/questions.js, etc. The
 * remaining holes are concentrated in:
 *
 *   - "course not found" / "lecture not found" returns on the mutators that
 *     callers reach without a pre-check (POST /api/questions, DELETE
 *     /api/questions/:id, POST /api/learning-objectives, POST /api/lectures/
 *     pass-threshold, POST /api/courses/:id/join as student),
 *   - empty-array returns on the getters (getPublishedLectures,
 *     getAssessmentQuestions, getLearningObjectives, getPassThreshold,
 *     getApprovedStruggleTopicObjects) when the course is missing the field,
 *   - the student branch of userHasCourseAccess (reached by a student calling
 *     POST /api/lectures/publish — the route trusts user.role and forwards it
 *     into the model),
 *   - getQuizSettings defaults-vs-overridden branches and
 *     updateQuizSettings defaults-vs-overridden branches,
 *   - the legacy-string preservation branch in setApprovedStruggleTopics,
 *   - getTopicLabel falling through on non-string/non-object entries,
 *   - getAnonymizeStudents branches (no course, missing per-instructor entry,
 *     enabled true, enabled false) and updateAnonymizeStudents not-found,
 *   - joinCourse: course-not-found and revoked-enrollment branches,
 *   - joinCourseAsInstructor: backfilling instructorId when missing,
 *   - updatePassThreshold / deleteAssessmentQuestion / updateLearningObjectives
 *     lecture-not-found branches.
 *
 * Unreachable-through-routes branches (and the reason) are listed at the
 * bottom of this file — they are intentionally NOT forced.
 *
 * No production code is modified. Tests that surface a real bug are left
 * failing and recorded in FINDINGS.md.
 */

const { test, expect } = require('./fixtures/monocart');
const { TEST_USERS, storageStatePath } = require('./helpers/users');
const {
    withDb,
    getUserIdByUsername,
    seedCourse,
    cleanupCourses,
    cleanupCoursesForUser,
    setStudentEnrollment,
} = require('./helpers/courses-test');

const PREFIX = 'BIOC-E2E-API-CRSMODEL';
const COURSE_MAIN = `${PREFIX}-MAIN`;
const COURSE_NOLECT = `${PREFIX}-NOLECT`;
const COURSE_BAD_TOPICS = `${PREFIX}-BADTOPICS`;
const COURSE_LEGACY_TOPICS = `${PREFIX}-LEGACY`;
const COURSE_QUIZ_PARTIAL = `${PREFIX}-QPART`;
const COURSE_QUIZ_FULL = `${PREFIX}-QFULL`;
const COURSE_ANON_SET = `${PREFIX}-ANONSET`;
const COURSE_ANON_OTHER = `${PREFIX}-ANONOTH`;
const COURSE_REVOKED = `${PREFIX}-REVOKED`;
const COURSE_NOOWNER = `${PREFIX}-NOOWNER`;
const COURSE_NONEXISTENT = `${PREFIX}-NOPE-DOES-NOT-EXIST`;

const ALL_COURSES = [
    COURSE_MAIN,
    COURSE_NOLECT,
    COURSE_BAD_TOPICS,
    COURSE_LEGACY_TOPICS,
    COURSE_QUIZ_PARTIAL,
    COURSE_QUIZ_FULL,
    COURSE_ANON_SET,
    COURSE_ANON_OTHER,
    COURSE_REVOKED,
    COURSE_NOOWNER,
];

let instructorId;
let instructorFreshId;
let studentId;
let taId;

test.beforeAll(async () => {
    instructorId = await getUserIdByUsername(TEST_USERS.instructor.username);
    instructorFreshId = await getUserIdByUsername(TEST_USERS.instructor_fresh.username);
    studentId = await getUserIdByUsername(TEST_USERS.student.username);
    taId = await getUserIdByUsername(TEST_USERS.ta.username);
});

test.beforeEach(async () => {
    await cleanupCourses(ALL_COURSES);
    await cleanupCoursesForUser(instructorId);
    await cleanupCoursesForUser(instructorFreshId);
});

test.afterAll(async () => {
    await cleanupCourses(ALL_COURSES);
    await cleanupCoursesForUser(instructorId);
    await cleanupCoursesForUser(instructorFreshId);
});

// ---------------------------------------------------------------------------
// Updaters that have no route-level pre-check: course-not-found and
// lecture-not-found return the model's `{ success: false, error: ... }`.
// ---------------------------------------------------------------------------
test.describe('updateAssessmentQuestions (via POST /api/questions)', () => {
    test.use({ storageState: storageStatePath('instructor') });

    test('400 with "Course not found" when courseId does not exist', async ({ request: api }) => {
        const res = await api.post('/api/questions', {
            data: {
                courseId: COURSE_NONEXISTENT,
                lectureName: 'Unit 1',
                instructorId,
                questionType: 'short-answer',
                question: 'What is enzyme catalysis?',
                correctAnswer: 'A rate enhancement.',
            },
        });
        expect(res.status()).toBe(400);
        const body = await res.json();
        expect(body.success).toBe(false);
        expect(body.message).toMatch(/Course not found/i);
    });

    test('400 with "Lecture not found" when course exists but unit does not', async ({ request: api }) => {
        await seedCourse({ courseId: COURSE_MAIN, instructorId });
        const res = await api.post('/api/questions', {
            data: {
                courseId: COURSE_MAIN,
                lectureName: 'Unit Doesnt Exist',
                instructorId,
                questionType: 'short-answer',
                question: 'Q',
                correctAnswer: 'A',
            },
        });
        expect(res.status()).toBe(400);
        const body = await res.json();
        expect(body.message).toMatch(/Lecture not found/i);
    });
});

test.describe('deleteAssessmentQuestion (via DELETE /api/questions/:questionId)', () => {
    test.use({ storageState: storageStatePath('instructor') });

    test('400 with "Course not found" when courseId is bogus', async ({ request: api }) => {
        const res = await api.delete('/api/questions/q-nope-doesnt-matter', {
            data: {
                courseId: COURSE_NONEXISTENT,
                lectureName: 'Unit 1',
                instructorId,
            },
        });
        expect(res.status()).toBe(400);
        const body = await res.json();
        expect(body.message).toMatch(/Course not found/i);
    });

    test('400 with "Lecture not found" when lectureName is bogus', async ({ request: api }) => {
        await seedCourse({ courseId: COURSE_MAIN, instructorId });
        const res = await api.delete('/api/questions/q-anything', {
            data: {
                courseId: COURSE_MAIN,
                lectureName: 'No Such Unit',
                instructorId,
            },
        });
        expect(res.status()).toBe(400);
        const body = await res.json();
        expect(body.message).toMatch(/Lecture not found/i);
    });
});

test.describe('updateLearningObjectives (via POST /api/learning-objectives)', () => {
    test.use({ storageState: storageStatePath('instructor') });

    test('404 "Course not found" for bogus courseId', async ({ request: api }) => {
        // The route now pre-checks the course and surfaces model failures
        // instead of always replying 200.
        const res = await api.post('/api/learning-objectives', {
            data: {
                courseId: COURSE_NONEXISTENT,
                lectureName: 'Unit 1',
                objectives: ['LO1'],
                instructorId,
            },
        });
        expect(res.status()).toBe(404);
        const body = await res.json();
        expect(body.message).toMatch(/course not found/i);
    });

    test('404 for lecture-not-found path on existing course', async ({ request: api }) => {
        await seedCourse({ courseId: COURSE_MAIN, instructorId });
        const res = await api.post('/api/learning-objectives', {
            data: {
                courseId: COURSE_MAIN,
                lectureName: 'Unit 99',
                objectives: ['LO1'],
                instructorId,
            },
        });
        // Model failures are surfaced as 404 — verify no objectives were
        // added to a non-existent unit either.
        expect(res.status()).toBe(404);
        const doc = await withDb((db) => db.collection('courses').findOne({ courseId: COURSE_MAIN }));
        const u1 = doc.lectures.find((l) => l.name === 'Unit 1');
        expect(u1.learningObjectives || []).toEqual([]);
    });
});

test.describe('updatePassThreshold (via POST /api/lectures/pass-threshold)', () => {
    test.use({ storageState: storageStatePath('instructor') });

    test('403 for a bogus courseId — no access to a course that does not exist', async ({ request: api }) => {
        const res = await api.post('/api/lectures/pass-threshold', {
            data: {
                courseId: COURSE_NONEXISTENT,
                lectureName: 'Unit 1',
                passThreshold: 3,
                instructorId,
            },
        });
        // This route used to have no authorization at all, so it reached the
        // model and swallowed its "Course not found" into a 200. Now the access
        // check runs first and nothing unknown gets that far. The model branch
        // itself stays covered by tests/unit/models/Course.coverage.test.js.
        expect(res.status()).toBe(403);
    });

    test('404 when the model reports "Lecture not found" for an unknown unit', async ({ request: api }) => {
        await seedCourse({ courseId: COURSE_MAIN, instructorId });
        const res = await api.post('/api/lectures/pass-threshold', {
            data: {
                courseId: COURSE_MAIN,
                lectureName: 'Unit Phantom',
                passThreshold: 4,
                instructorId,
            },
        });
        expect(res.status()).toBe(404);
        const doc = await withDb((db) => db.collection('courses').findOne({ courseId: COURSE_MAIN }));
        const u1 = doc.lectures.find((l) => l.name === 'Unit 1');
        // Default threshold from seedCourse is 2 — unchanged.
        expect(u1.passThreshold).toBe(2);
    });
});

// ---------------------------------------------------------------------------
// Getters: course-missing / field-missing returns
// ---------------------------------------------------------------------------
test.describe('getters return empty arrays / defaults for missing data', () => {
    test.use({ storageState: storageStatePath('instructor') });

    test('GET /api/lectures/student-visible returns [] when course is missing', async ({ request: api }) => {
        const res = await api.get(`/api/lectures/student-visible?courseId=${COURSE_NONEXISTENT}`);
        expect(res.ok()).toBeTruthy();
        const body = await res.json();
        expect(body.data.publishedLectures).toEqual([]);
        expect(body.data.count).toBe(0);
    });

    test('GET /api/lectures/student-visible returns [] when course has no lectures field', async ({ request: api }) => {
        // Insert a course directly without a lectures field to hit
        // getPublishedLectures's `!course.lectures` branch.
        await withDb(async (db) => {
            await db.collection('courses').deleteMany({ courseId: COURSE_NOLECT });
            await db.collection('courses').insertOne({
                courseId: COURSE_NOLECT,
                courseName: 'No Lectures',
                instructorId,
                courseCode: 'STUNL',
                instructorCourseCode: 'INSNL',
                status: 'active',
                createdAt: new Date(),
                updatedAt: new Date(),
            });
        });
        const res = await api.get(`/api/lectures/student-visible?courseId=${COURSE_NOLECT}`);
        expect(res.ok()).toBeTruthy();
        const body = await res.json();
        expect(body.data.publishedLectures).toEqual([]);
    });

    test('GET /api/lectures/publish-status returns {} when course missing', async ({ request: api }) => {
        const res = await api.get(
            `/api/lectures/publish-status?courseId=${COURSE_NONEXISTENT}&instructorId=${instructorId}`
        );
        expect(res.ok()).toBeTruthy();
        const body = await res.json();
        expect(body.data.publishStatus).toEqual({});
    });

    test('GET /api/lectures/pass-threshold 403s for a course that does not exist', async ({ request: api }) => {
        const res = await api.get(
            `/api/lectures/pass-threshold?courseId=${COURSE_NONEXISTENT}&lectureName=Unit%201`,
            { failOnStatusCode: false }
        );
        // Staff-only since the route gained an access check; the model's
        // "missing course returns 0" branch is covered in
        // tests/unit/models/Course.db.test.js.
        expect(res.status()).toBe(403);
    });

    test('GET /api/lectures/pass-threshold returns 0 when lecture missing on real course', async ({ request: api }) => {
        await seedCourse({ courseId: COURSE_MAIN, instructorId });
        const res = await api.get(
            `/api/lectures/pass-threshold?courseId=${COURSE_MAIN}&lectureName=NO_SUCH_UNIT`
        );
        expect(res.ok()).toBeTruthy();
        const body = await res.json();
        expect(body.data.passThreshold).toBe(0);
    });

    test('GET /api/lectures/pass-threshold returns set value when lecture has explicit threshold', async ({ request: api }) => {
        await seedCourse({ courseId: COURSE_MAIN, instructorId });
        // Drive through POST first so the threshold is materialized.
        await api.post('/api/lectures/pass-threshold', {
            data: {
                courseId: COURSE_MAIN,
                lectureName: 'Unit 1',
                passThreshold: 7,
                instructorId,
            },
        });
        const res = await api.get(
            `/api/lectures/pass-threshold?courseId=${COURSE_MAIN}&lectureName=Unit%201`
        );
        expect(res.ok()).toBeTruthy();
        const body = await res.json();
        expect(body.data.passThreshold).toBe(7);
    });

    test('GET /api/questions/lecture returns [] when course missing', async ({ request: api }) => {
        const res = await api.get(
            `/api/questions/lecture?courseId=${COURSE_NONEXISTENT}&lectureName=Unit%201`
        );
        expect(res.ok()).toBeTruthy();
        const body = await res.json();
        expect(body.data.questions).toEqual([]);
    });

    test('GET /api/questions/lecture returns [] when lecture missing on real course', async ({ request: api }) => {
        await seedCourse({ courseId: COURSE_MAIN, instructorId });
        const res = await api.get(
            `/api/questions/lecture?courseId=${COURSE_MAIN}&lectureName=NO_SUCH_UNIT`
        );
        expect(res.ok()).toBeTruthy();
        const body = await res.json();
        expect(body.data.questions).toEqual([]);
    });

    test('GET /api/learning-objectives returns [] when course missing', async ({ request: api }) => {
        const res = await api.get(
            `/api/learning-objectives?courseId=${COURSE_NONEXISTENT}&lectureName=Unit%201`
        );
        expect(res.ok()).toBeTruthy();
        const body = await res.json();
        expect(body.data.objectives).toEqual([]);
    });

    test('GET /api/learning-objectives returns [] when lecture missing on real course', async ({ request: api }) => {
        await seedCourse({ courseId: COURSE_MAIN, instructorId });
        const res = await api.get(
            `/api/learning-objectives?courseId=${COURSE_MAIN}&lectureName=NO_SUCH_UNIT`
        );
        expect(res.ok()).toBeTruthy();
        const body = await res.json();
        expect(body.data.objectives).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// userHasCourseAccess — the student branch, driven through GET /api/flags/my.
//
// This used to run through POST /api/lectures/publish, which forwarded
// req.user.role straight into the model and so accepted any enrolled student —
// a staff-only route a student could reach. That route is now gated on role
// before course access, so it can no longer reach the student branch at all.
// /api/flags/my is the right vehicle instead: it passes 'student' explicitly
// and is genuinely a student endpoint, so the same model branches are exercised
// without depending on a hole.
// ---------------------------------------------------------------------------
test.describe('userHasCourseAccess (student branch via GET /api/flags/my)', () => {
    test.use({ storageState: storageStatePath('student') });

    test('403 when student is not enrolled — exercises status:active + missing studentEnrollment', async ({ request: api }) => {
        await seedCourse({ courseId: COURSE_MAIN, instructorId });
        const res = await api.get(`/api/flags/my?courseId=${COURSE_MAIN}`);
        // The student branch finds an active course but no enrollment record.
        expect(res.status()).toBe(403);
    });

    test('403 when course is inactive — exercises status:active filter', async ({ request: api }) => {
        await seedCourse({ courseId: COURSE_MAIN, instructorId, status: 'inactive' });
        const res = await api.get(`/api/flags/my?courseId=${COURSE_MAIN}`);
        expect(res.status()).toBe(403);
    });

    test('enrolled student succeeds (exercises enrolled:true branch of userHasCourseAccess)', async ({ request: api }) => {
        test.setTimeout(60_000);
        await seedCourse({ courseId: COURSE_MAIN, instructorId });
        await setStudentEnrollment(COURSE_MAIN, studentId, true);
        const res = await api.get(`/api/flags/my?courseId=${COURSE_MAIN}`, { timeout: 45_000 });
        // userHasCourseAccess returns true on the student branch — the route
        // then proceeds to read the student's own flags.
        expect(res.status()).toBe(200);
    });

    test('enrolled student succeeds when the course has NO status field (regression: strict status:active wrongly 403d)', async ({ request: api }) => {
        test.setTimeout(60_000);
        // Older courses were created without a status field. The chat path treats
        // a missing status as active, but userHasCourseAccess used to require
        // status === 'active' exactly, 403ing the student on questions/flags for a
        // course they were enrolled in. Reproduce a status-less course here.
        await seedCourse({ courseId: COURSE_MAIN, instructorId });
        await withDb((db) => db.collection('courses').updateOne(
            { courseId: COURSE_MAIN },
            { $unset: { status: '' } }
        ));
        await setStudentEnrollment(COURSE_MAIN, studentId, true);
        const res = await api.get(`/api/flags/my?courseId=${COURSE_MAIN}`, { timeout: 45_000 });
        expect(res.status()).toBe(200);
    });
});

// ---------------------------------------------------------------------------
// joinCourse — course-not-found and revoked-enrollment branches.
// ---------------------------------------------------------------------------
test.describe('joinCourse (via POST /api/courses/:courseId/join)', () => {
    test.use({ storageState: storageStatePath('student') });

    test('403 with "Course not found" when joining a bogus courseId', async ({ request: api }) => {
        const res = await api.post(`/api/courses/${COURSE_NONEXISTENT}/join`, {
            data: { code: 'ANY' },
        });
        expect(res.status()).toBe(403);
        const body = await res.json();
        expect(body.message).toMatch(/Course not found/i);
    });

    test('403 when course is inactive', async ({ request: api }) => {
        await seedCourse({ courseId: COURSE_MAIN, instructorId, status: 'inactive', courseCode: 'STUCD' });
        const res = await api.post(`/api/courses/${COURSE_MAIN}/join`, {
            data: { code: 'STUCD' },
        });
        expect(res.status()).toBe(403);
        const body = await res.json();
        expect(body.message).toMatch(/deactivated/i);
    });

    test('403 with "Access revoked" when enrolled:false is on record', async ({ request: api }) => {
        await seedCourse({ courseId: COURSE_REVOKED, instructorId, courseCode: 'STUREV' });
        await setStudentEnrollment(COURSE_REVOKED, studentId, false);
        const res = await api.post(`/api/courses/${COURSE_REVOKED}/join`, {
            data: { code: 'STUREV' },
        });
        expect(res.status()).toBe(403);
        const body = await res.json();
        expect(body.message).toMatch(/revoked/i);
    });

    test('403 with "Invalid course code" when code mismatch', async ({ request: api }) => {
        await seedCourse({ courseId: COURSE_MAIN, instructorId, courseCode: 'STUOK' });
        const res = await api.post(`/api/courses/${COURSE_MAIN}/join`, {
            data: { code: 'WRONG-CODE' },
        });
        expect(res.status()).toBe(403);
        const body = await res.json();
        expect(body.message).toMatch(/Invalid course code/i);
    });
});

// ---------------------------------------------------------------------------
// joinCourseAsInstructor — backfills instructorId when the course has none.
// ---------------------------------------------------------------------------
test.describe('joinCourseAsInstructor (via POST /api/courses/:courseId/instructors)', () => {
    test.use({ storageState: storageStatePath('instructor_fresh') });

    test('backfills course.instructorId when missing on the document', async ({ request: api }) => {
        // Seed a course whose primary instructorId is empty so the model
        // hits the `!course.instructorId` branch (Course.js:1602-1604).
        await seedCourse({
            courseId: COURSE_NOOWNER,
            instructorId: '',           // intentionally blank
            instructors: [],            // not already joined
            courseCode: 'NOOWNS',
            instructorCourseCode: 'NOOWNINS',
            overrides: { instructorId: '' },
        });
        const res = await api.post(`/api/courses/${COURSE_NOOWNER}/instructors`, {
            data: { instructorId: instructorFreshId, code: 'NOOWNINS' },
        });
        expect(res.ok()).toBeTruthy();
        const after = await withDb((db) => db.collection('courses').findOne({ courseId: COURSE_NOOWNER }));
        expect(after.instructorId).toBe(instructorFreshId);
        expect(after.instructors).toContain(instructorFreshId);
    });

    test('alreadyJoined short-circuit when caller is in instructors[]', async ({ request: api }) => {
        await seedCourse({
            courseId: COURSE_MAIN,
            instructorId: instructorFreshId,
            instructors: [instructorFreshId],
        });
        const res = await api.post(`/api/courses/${COURSE_MAIN}/instructors`, {
            data: { instructorId: instructorFreshId, code: 'ANY' },
        });
        expect(res.ok()).toBeTruthy();
        const body = await res.json();
        expect(body.data.alreadyJoined).toBe(true);
    });

    test('403 with "Invalid instructor course code" when caller is new and code is wrong', async ({ request: api }) => {
        await seedCourse({
            courseId: COURSE_MAIN,
            instructorId,
            instructors: [instructorId],
            instructorCourseCode: 'CORRECT',
        });
        const res = await api.post(`/api/courses/${COURSE_MAIN}/instructors`, {
            data: { instructorId: instructorFreshId, code: 'WRONG' },
        });
        expect(res.status()).toBe(403);
    });
});

// ---------------------------------------------------------------------------
// getApprovedStruggleTopicObjects — course has the course but field is missing
// or contains junk entries (hits getTopicLabel's fall-through return '').
// ---------------------------------------------------------------------------
test.describe('approved struggle topic helpers', () => {
    test.use({ storageState: storageStatePath('instructor') });

    test('GET /:courseId/approved-topics returns [] when approvedStruggleTopics field is missing', async ({ request: api }) => {
        // Insert a course WITHOUT the approvedStruggleTopics field — hits the
        // `!Array.isArray(course.approvedStruggleTopics)` branch.
        await withDb(async (db) => {
            await db.collection('courses').deleteMany({ courseId: COURSE_BAD_TOPICS });
            await db.collection('courses').insertOne({
                courseId: COURSE_BAD_TOPICS,
                courseName: 'No Topics',
                instructorId,
                instructors: [instructorId],
                courseCode: 'STUNT',
                instructorCourseCode: 'INSTNT',
                status: 'active',
                lectures: [{ name: 'Unit 1', isPublished: false, documents: [], assessmentQuestions: [] }],
                createdAt: new Date(),
                updatedAt: new Date(),
            });
        });
        const res = await api.get(`/api/courses/${COURSE_BAD_TOPICS}/approved-topics`);
        expect(res.ok()).toBeTruthy();
        const body = await res.json();
        expect(body.data.topics).toEqual([]);
        expect(body.data.topicLabels).toEqual([]);
    });

    test('topics with non-string/non-object entries are dropped (getTopicLabel fall-through)', async ({ request: api }) => {
        // Seed a course where approvedStruggleTopics has mixed garbage —
        // numbers and booleans should be silently dropped (Course.js:116).
        await withDb(async (db) => {
            await db.collection('courses').deleteMany({ courseId: COURSE_BAD_TOPICS });
            await db.collection('courses').insertOne({
                courseId: COURSE_BAD_TOPICS,
                courseName: 'Junk Topics',
                instructorId,
                instructors: [instructorId],
                courseCode: 'STJUNK',
                instructorCourseCode: 'INSJNK',
                status: 'active',
                approvedStruggleTopics: [
                    'Photosynthesis',
                    { topic: 'DNA Replication', unitId: null, source: 'manual', createdAt: new Date() },
                    42,            // junk → dropped
                    true,          // junk → dropped
                    null,          // junk → dropped
                    '   ',         // empty after trim → dropped
                ],
                lectures: [{ name: 'Unit 1', isPublished: false, documents: [], assessmentQuestions: [] }],
                createdAt: new Date(),
                updatedAt: new Date(),
            });
        });
        const res = await api.get(`/api/courses/${COURSE_BAD_TOPICS}/approved-topics`);
        expect(res.ok()).toBeTruthy();
        const body = await res.json();
        const labels = body.data.topicLabels;
        expect(labels).toEqual(expect.arrayContaining(['Photosynthesis', 'DNA Replication']));
        expect(labels).toHaveLength(2);
    });

    test('PUT /approved-topics preserves legacy string entries when no metadata changes', async ({ request: api }) => {
        // Seed a course with legacy string topics. PUT-ing the same labels
        // (no unitId, no explicit source) should preserve them as strings
        // on write — Course.js:1697.
        await withDb(async (db) => {
            await db.collection('courses').deleteMany({ courseId: COURSE_LEGACY_TOPICS });
            await db.collection('courses').insertOne({
                courseId: COURSE_LEGACY_TOPICS,
                courseName: 'Legacy Topics',
                instructorId,
                instructors: [instructorId],
                courseCode: 'STULEG',
                instructorCourseCode: 'INSLEG',
                status: 'active',
                approvedStruggleTopics: ['Mitosis', 'Meiosis'], // legacy strings
                lectures: [{ name: 'Unit 1', isPublished: false, documents: [], assessmentQuestions: [] }],
                createdAt: new Date(),
                updatedAt: new Date(),
            });
        });

        const res = await api.put(`/api/courses/${COURSE_LEGACY_TOPICS}/approved-topics`, {
            data: { topics: ['Mitosis', 'Meiosis'] }, // same labels, no metadata
        });
        expect(res.ok()).toBeTruthy();

        const stored = await withDb((db) =>
            db.collection('courses').findOne({ courseId: COURSE_LEGACY_TOPICS })
        );
        // Should still be plain strings (legacy preserved branch).
        expect(stored.approvedStruggleTopics.every((t) => typeof t === 'string')).toBe(true);
    });

    test('PUT /approved-topics promotes a legacy string to an object once unitId is supplied', async ({ request: api }) => {
        await withDb(async (db) => {
            await db.collection('courses').deleteMany({ courseId: COURSE_LEGACY_TOPICS });
            await db.collection('courses').insertOne({
                courseId: COURSE_LEGACY_TOPICS,
                courseName: 'Legacy Topics 2',
                instructorId,
                instructors: [instructorId],
                courseCode: 'STULG2',
                instructorCourseCode: 'INSLG2',
                status: 'active',
                approvedStruggleTopics: ['Krebs Cycle'],
                lectures: [{ name: 'Unit 1', isPublished: false, documents: [], assessmentQuestions: [] }],
                createdAt: new Date(),
                updatedAt: new Date(),
            });
        });

        const res = await api.put(`/api/courses/${COURSE_LEGACY_TOPICS}/approved-topics`, {
            data: {
                topics: [{ topic: 'Krebs Cycle', unitId: 'Unit 1', source: 'manual' }],
            },
        });
        expect(res.ok()).toBeTruthy();

        const stored = await withDb((db) =>
            db.collection('courses').findOne({ courseId: COURSE_LEGACY_TOPICS })
        );
        // Now stored as an object with unitId.
        expect(typeof stored.approvedStruggleTopics[0]).toBe('object');
        expect(stored.approvedStruggleTopics[0].unitId).toBe('Unit 1');
    });

    test('PATCH /approved-topics/unit returns 404 when topic is unknown', async ({ request: api }) => {
        await seedCourse({ courseId: COURSE_MAIN, instructorId });
        const res = await api.patch(`/api/courses/${COURSE_MAIN}/approved-topics/unit`, {
            data: { topic: 'Topic That Was Never Approved', unitId: 'Unit 1' },
        });
        expect(res.status()).toBe(404);
    });

    test('PATCH /approved-topics/unit returns 400 when topic is empty', async ({ request: api }) => {
        await seedCourse({ courseId: COURSE_MAIN, instructorId });
        const res = await api.patch(`/api/courses/${COURSE_MAIN}/approved-topics/unit`, {
            data: { topic: '   ', unitId: 'Unit 1' },
        });
        expect(res.status()).toBe(400);
    });

    test('PATCH /approved-topics/unit returns 400 when unitId is not a valid unit on the course', async ({ request: api }) => {
        await seedCourse({ courseId: COURSE_MAIN, instructorId });
        await api.put(`/api/courses/${COURSE_MAIN}/approved-topics`, {
            data: { topics: ['Photosynthesis'] },
        });
        const res = await api.patch(`/api/courses/${COURSE_MAIN}/approved-topics/unit`, {
            data: { topic: 'Photosynthesis', unitId: 'Unit Not Real' },
        });
        expect(res.status()).toBe(400);
    });
});

// ---------------------------------------------------------------------------
// getQuizSettings / updateQuizSettings — defaults vs explicit overrides.
// ---------------------------------------------------------------------------
test.describe('quiz settings (via GET/POST /api/settings/quiz)', () => {
    test.use({ storageState: storageStatePath('instructor') });

    test('GET returns full defaults when course does not exist', async ({ request: api }) => {
        const res = await api.get(`/api/settings/quiz?courseId=${COURSE_NONEXISTENT}`);
        expect(res.ok()).toBeTruthy();
        const body = await res.json();
        expect(body.settings).toEqual({
            enabled: false,
            testableUnits: 'all',
            allowLectureMaterialAccess: true,
            allowSourceAttributionDownloads: false,
        });
    });

    test('GET returns defaults when course exists but quizSettings field is missing', async ({ request: api }) => {
        await seedCourse({ courseId: COURSE_QUIZ_PARTIAL, instructorId });
        const res = await api.get(`/api/settings/quiz?courseId=${COURSE_QUIZ_PARTIAL}`);
        expect(res.ok()).toBeTruthy();
        const body = await res.json();
        expect(body.settings.enabled).toBe(false);
        expect(body.settings.testableUnits).toBe('all');
        expect(body.settings.allowLectureMaterialAccess).toBe(true);
        expect(body.settings.allowSourceAttributionDownloads).toBe(false);
    });

    test('GET merges partial quizSettings with defaults', async ({ request: api }) => {
        // Seed with ONLY `enabled` set so the other three defaults branches fire.
        await seedCourse({
            courseId: COURSE_QUIZ_PARTIAL,
            instructorId,
            overrides: { quizSettings: { enabled: true } },
        });
        const res = await api.get(`/api/settings/quiz?courseId=${COURSE_QUIZ_PARTIAL}`);
        expect(res.ok()).toBeTruthy();
        const body = await res.json();
        expect(body.settings.enabled).toBe(true);
        // The other three should fall back to defaults.
        expect(body.settings.testableUnits).toBe('all');
        expect(body.settings.allowLectureMaterialAccess).toBe(true);
        expect(body.settings.allowSourceAttributionDownloads).toBe(false);
    });

    test('GET reflects all-overridden quizSettings', async ({ request: api }) => {
        await seedCourse({
            courseId: COURSE_QUIZ_FULL,
            instructorId,
            overrides: {
                quizSettings: {
                    enabled: true,
                    testableUnits: ['Unit 1'],
                    allowLectureMaterialAccess: false,
                    allowSourceAttributionDownloads: true,
                },
            },
        });
        const res = await api.get(`/api/settings/quiz?courseId=${COURSE_QUIZ_FULL}`);
        expect(res.ok()).toBeTruthy();
        const body = await res.json();
        expect(body.settings).toEqual({
            enabled: true,
            testableUnits: ['Unit 1'],
            allowLectureMaterialAccess: false,
            allowSourceAttributionDownloads: true,
        });
    });

    test('POST with only `enabled` exercises the defaults-fallback branches in updateQuizSettings', async ({ request: api }) => {
        await seedCourse({ courseId: COURSE_QUIZ_PARTIAL, instructorId });
        const res = await api.post('/api/settings/quiz', {
            data: { courseId: COURSE_QUIZ_PARTIAL, enabled: true },
        });
        expect(res.ok()).toBeTruthy();
        const stored = await withDb((db) =>
            db.collection('courses').findOne({ courseId: COURSE_QUIZ_PARTIAL })
        );
        expect(stored.quizSettings).toEqual({
            enabled: true,
            testableUnits: 'all',
            allowLectureMaterialAccess: true,
            allowSourceAttributionDownloads: false,
        });
    });

    test('POST with all fields exercises the explicit-value branches in updateQuizSettings', async ({ request: api }) => {
        await seedCourse({ courseId: COURSE_QUIZ_FULL, instructorId });
        const res = await api.post('/api/settings/quiz', {
            data: {
                courseId: COURSE_QUIZ_FULL,
                enabled: true,
                testableUnits: ['Unit 1', 'Unit 2'],
                allowLectureMaterialAccess: false,
                allowSourceAttributionDownloads: true,
            },
        });
        expect(res.ok()).toBeTruthy();
        const stored = await withDb((db) =>
            db.collection('courses').findOne({ courseId: COURSE_QUIZ_FULL })
        );
        expect(stored.quizSettings).toEqual({
            enabled: true,
            testableUnits: ['Unit 1', 'Unit 2'],
            allowLectureMaterialAccess: false,
            allowSourceAttributionDownloads: true,
        });
    });

    test('POST with bogus courseId returns 400 (model returns "Course not found")', async ({ request: api }) => {
        const res = await api.post('/api/settings/quiz', {
            data: { courseId: COURSE_NONEXISTENT, enabled: true },
        });
        expect(res.status()).toBe(400);
        const body = await res.json();
        expect(body.message).toMatch(/Course not found/i);
    });
});

// ---------------------------------------------------------------------------
// getAnonymizeStudents / updateAnonymizeStudents
// ---------------------------------------------------------------------------
test.describe('anonymize-students settings', () => {
    test.use({ storageState: storageStatePath('instructor') });

    test('GET returns enabled:true default when no entry exists for this instructor', async ({ request: api }) => {
        await seedCourse({ courseId: COURSE_ANON_OTHER, instructorId });
        const res = await api.get(`/api/settings/anonymize-students?courseId=${COURSE_ANON_OTHER}`);
        expect(res.ok()).toBeTruthy();
        const body = await res.json();
        // Default is true when no per-instructor record exists.
        expect(body.enabled).toBe(true);
    });

    test('GET returns enabled:true when stored value is true', async ({ request: api }) => {
        await seedCourse({
            courseId: COURSE_ANON_SET,
            instructorId,
            overrides: { anonymizeStudents: { [instructorId]: { enabled: true, updatedAt: new Date() } } },
        });
        const res = await api.get(`/api/settings/anonymize-students?courseId=${COURSE_ANON_SET}`);
        expect(res.ok()).toBeTruthy();
        const body = await res.json();
        expect(body.enabled).toBe(true);
    });

    test('GET returns enabled:false when stored value is false', async ({ request: api }) => {
        await seedCourse({
            courseId: COURSE_ANON_SET,
            instructorId,
            overrides: { anonymizeStudents: { [instructorId]: { enabled: false, updatedAt: new Date() } } },
        });
        const res = await api.get(`/api/settings/anonymize-students?courseId=${COURSE_ANON_SET}`);
        expect(res.ok()).toBeTruthy();
        const body = await res.json();
        // Route returns `enabled: result.enabled || false` — false stays false.
        expect(body.enabled).toBe(false);
    });

    test('GET on bogus courseId — model returns "Course not found" (route still 200 with enabled:false fallback)', async ({ request: api }) => {
        const res = await api.get(`/api/settings/anonymize-students?courseId=${COURSE_NONEXISTENT}`);
        expect(res.ok()).toBeTruthy();
        const body = await res.json();
        expect(body.success).toBe(true);
        expect(body.enabled).toBe(false);
    });

    test('POST round-trip: setting to false then reading back', async ({ request: api }) => {
        await seedCourse({ courseId: COURSE_ANON_SET, instructorId });
        const post = await api.post('/api/settings/anonymize-students', {
            data: { courseId: COURSE_ANON_SET, enabled: false },
        });
        expect(post.ok()).toBeTruthy();
        const get = await api.get(`/api/settings/anonymize-students?courseId=${COURSE_ANON_SET}`);
        const body = await get.json();
        expect(body.enabled).toBe(false);
    });

    test('POST on bogus courseId returns 400 with "Course not found"', async ({ request: api }) => {
        const res = await api.post('/api/settings/anonymize-students', {
            data: { courseId: COURSE_NONEXISTENT, enabled: true },
        });
        expect(res.status()).toBe(400);
        const body = await res.json();
        expect(body.message).toMatch(/Course not found/i);
    });
});

// ---------------------------------------------------------------------------
// upsertCourse — exercised via POST /api/documents/cleanup-orphans, which
// reloads the course and re-saves it. With a course missing instructorCourseCode
// the model's `!course.instructorCourseCode` branch fires; with matching
// codes the same-code branch fires.
// ---------------------------------------------------------------------------
test.describe('upsertCourse re-save via cleanup-orphans', () => {
    test.use({ storageState: storageStatePath('instructor') });

    test('regenerates instructorCourseCode when it duplicates courseCode', async ({ request: api }) => {
        // Seed a course with documents referring to a non-existent document
        // AND with instructorCourseCode == courseCode so the upsert regenerates it.
        await withDb(async (db) => {
            await db.collection('courses').deleteMany({ courseId: COURSE_MAIN });
            await db.collection('courses').insertOne({
                courseId: COURSE_MAIN,
                courseName: 'Dup Codes',
                instructorId,
                instructors: [instructorId],
                courseCode: 'SAMECD',
                instructorCourseCode: 'SAMECD', // intentionally equal
                status: 'active',
                lectures: [
                    {
                        name: 'Unit 1',
                        isPublished: false,
                        documents: [{ documentId: 'orphan-doc-id', filename: 'orphan.txt' }],
                        assessmentQuestions: [],
                    },
                ],
                createdAt: new Date(),
                updatedAt: new Date(),
            });
        });

        const res = await api.post('/api/documents/cleanup-orphans', {
            data: { courseId: COURSE_MAIN, instructorId },
        });
        expect(res.ok()).toBeTruthy();

        const stored = await withDb((db) =>
            db.collection('courses').findOne({ courseId: COURSE_MAIN })
        );
        // The upsert hits the "instructorCourseCode === courseCode" branch and
        // regenerates a distinct one (or the courseCode hasn't changed but the
        // instructor code is now different).
        expect(stored.courseCode).toBe('SAMECD');
        expect(stored.instructorCourseCode).not.toBe('SAMECD');
        expect(stored.instructorCourseCode).toMatch(/^[A-Z0-9]{6}$/);
    });

    test('regenerates missing courseCode when course-doc lacks one entirely', async ({ request: api }) => {
        await withDb(async (db) => {
            await db.collection('courses').deleteMany({ courseId: COURSE_NOOWNER });
            await db.collection('courses').insertOne({
                courseId: COURSE_NOOWNER,
                courseName: 'No Codes',
                instructorId,
                instructors: [instructorId],
                // courseCode / instructorCourseCode intentionally absent
                status: 'active',
                lectures: [
                    {
                        name: 'Unit 1',
                        isPublished: false,
                        documents: [{ documentId: 'orphan-doc-id-2', filename: 'orphan2.txt' }],
                        assessmentQuestions: [],
                    },
                ],
                createdAt: new Date(),
                updatedAt: new Date(),
            });
        });

        const res = await api.post('/api/documents/cleanup-orphans', {
            data: { courseId: COURSE_NOOWNER, instructorId },
        });
        expect(res.ok()).toBeTruthy();

        const stored = await withDb((db) =>
            db.collection('courses').findOne({ courseId: COURSE_NOOWNER })
        );
        expect(stored.courseCode).toMatch(/^[A-Z0-9]{6}$/);
        expect(stored.instructorCourseCode).toMatch(/^[A-Z0-9]{6}$/);
        expect(stored.courseCode).not.toBe(stored.instructorCourseCode);
    });
});

// ---------------------------------------------------------------------------
// Unreachable branches — documented in the spec rather than forced.
//
// The following uncovered branches are NOT reachable through any HTTP route
// in this codebase and are intentionally left:
//
//   - Course.addInstructorToCourse (entire function): not referenced by any
//     route handler (only exported from the model).
//   - Course.getApprovedStruggleTopics (the labels-only variant): not
//     referenced; routes use `getApprovedStruggleTopicObjects` instead.
//   - Course.getCoursesForUser  role==='instructor' branch: callers in
//     src/middleware/auth.js and src/routes/courses.js only invoke it with
//     role='ta'.
//   - Course.checkTAPermission's invalid-feature whitelist branch: every
//     route hard-codes one of the six TA_PERMISSION_KEYS ('materials',
//     'questions', 'flags', 'roster', 'transcripts', 'settings') as the
//     feature argument, so the `!TA_PERMISSION_KEYS.includes(feature)`
//     early-return is never hit from the public API surface.
//   - Course.ensureCourseCodes migration block: runs only on server boot
//     (src/server.js:536); cannot be triggered at runtime.
//   - Course.removeDocumentFromAnyUnit "Course not found": the
//     POST /api/courses/:id/remove-document route pre-checks
//     userHasCourseAccess, which fails for a missing course.
//   - Course.updateLecturePublishStatus / updateUnitDisplayName / updateTAPermissions /
//     getTAPermissions / updateStudentEnrollment "Course not found": the
//     enclosing routes pre-check via userHasCourseAccess or
//     getCourseById and return 404/403 first.
//   - Course.joinCourseAsInstructor "Course not found": the route pre-checks
//     via collection.findOne and returns 404 before invoking the model.
//   - Course.createCourseFromOnboarding / getCourseWithOnboarding / deleteUnit
//     catch-and-rethrow blocks: only fire on a thrown driver-level error,
//     which is not reachable from the public API surface.
//
// These are reported in the run summary; no contrived test is added to "tag"
// them.
// ---------------------------------------------------------------------------
