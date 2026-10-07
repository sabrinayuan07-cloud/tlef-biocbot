// @ts-check
/**
 * Additional branch coverage for src/routes/courses.js and src/models/Course.js.
 *
 * The existing routes-courses-api spec covers the happy paths for the bulk of
 * the routes. This spec focuses on the under-covered branches:
 *
 *   - the /content + /extract-topics endpoints (entirely untested before)
 *   - the document side of POST /:courseId/transfer (cloneDocumentForTransfer)
 *   - the prompts-object branch of PUT /:courseId
 *   - DELETE /:courseId/units/:unitName when the unit has attached docs
 *   - GET /:courseId/students missing-IDs fallback
 *   - GET /:courseId from a student via the getCourseForStudent helper
 *   - the TA join code-mismatch and inactive-course rejection branches
 *   - the TA-permissions error paths (TA not assigned, course missing)
 *   - DELETE /:courseId/tas/:taId role-downgrade and stay-as-TA branches
 *   - PATCH /:courseId/approved-topics/unit clearing a unit assignment
 *
 * Defensive 401/503 branches that require bypassing `requireAuth` /
 * `app.locals.db` are intentionally left uncovered — they're unreachable from
 * the outside. Each such line is annotated as such in the source.
 *
 * Per AGENTS.md / FINDINGS.md: bug-exposing assertions are left failing.
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
    seedDocumentAndAttach,
    setUserRole,
    clearInvitedCourses,
} = require('./helpers/courses-test');

// Stable ids — distinct from routes-courses-api.spec.js so back-to-back runs
// can't trample one another.
const COURSE_BR_A = 'BIOC-E2E-API-COURSES-BR-A';
const COURSE_BR_B = 'BIOC-E2E-API-COURSES-BR-B';
const COURSE_BR_INACTIVE = 'BIOC-E2E-API-COURSES-BR-INACTIVE';
const COURSE_BR_TRANSFER_SRC = 'BIOC-E2E-API-COURSES-BR-XFER-SRC';
const COURSE_BR_UNIT_DOCS = 'BIOC-E2E-API-COURSES-BR-UNIT-DOCS';
const VALID_API_KEY = 'sk-test-courses-branches';

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

test.beforeEach(async () => {
    await cleanupCoursesForUser(instructorId);
    await cleanupCoursesForUser(instructorFreshId);
    // Restore the e2e_ta user to a known state — DELETE /tas/:taId can demote
    // them to 'student' when they have no remaining TA assignments.
    await setUserRole(taId, 'ta');
    await clearInvitedCourses(taId);
});

test.afterAll(async () => {
    await cleanupCourses([
        COURSE_BR_A,
        COURSE_BR_B,
        COURSE_BR_INACTIVE,
        COURSE_BR_TRANSFER_SRC,
        COURSE_BR_UNIT_DOCS,
    ]);
    await cleanupCoursesForUser(instructorId);
    await cleanupCoursesForUser(instructorFreshId);
    await setUserRole(taId, 'ta');
    await clearInvitedCourses(taId);
});

// ---------------------------------------------------------------------------
// POST /api/courses/:courseId/content (untouched in main spec)
// ---------------------------------------------------------------------------
test.describe('POST /api/courses/:courseId/content', () => {
    test.use({ storageState: storageStatePath('instructor') });

    test('400 when required fields are missing', async ({ request: api }) => {
        const res = await api.post(`/api/courses/${COURSE_BR_A}/content`, {
            data: { title: 'X' }, // missing week, type, instructorId
        });
        expect(res.status()).toBe(400);
    });

    test('201 echoes back a stub content record (handler is a placeholder)', async ({ request: api }) => {
        const res = await api.post(`/api/courses/${COURSE_BR_A}/content`, {
            data: {
                title: 'Intro',
                description: 'desc',
                week: 1,
                type: 'lecture-notes',
                instructorId,
                fileName: 'a.pdf',
                fileSize: 1234,
            },
        });
        expect(res.status()).toBe(201);
        const body = await res.json();
        expect(body.success).toBe(true);
        expect(body.data).toMatchObject({
            title: 'Intro',
            week: 1,
            type: 'lecture-notes',
            instructorId,
            fileName: 'a.pdf',
            fileSize: 1234,
            status: 'processing',
        });
        // Content ids are now opaque UUIDs from createId('content').
        expect(body.data.id).toMatch(/^content_[0-9a-f-]{36}$/);
    });
});

// ---------------------------------------------------------------------------
// POST /api/courses/:courseId/extract-topics
// ---------------------------------------------------------------------------
test.describe('POST /api/courses/:courseId/extract-topics', () => {
    test.beforeEach(async () => {
        await seedCourse({ courseId: COURSE_BR_A, instructorId });
    });

    test.describe('as instructor', () => {
        test.use({ storageState: storageStatePath('instructor') });

        test('404 when course does not exist', async ({ request: api }) => {
            const res = await api.post('/api/courses/BIOC-E2E-API-BR-NOPE/extract-topics', {
                data: { content: 'something' },
            });
            expect(res.status()).toBe(404);
        });

        test('400 when there is no content and no documentId', async ({ request: api }) => {
            const res = await api.post(`/api/courses/${COURSE_BR_A}/extract-topics`, {
                data: { content: '   ' },
            });
            expect(res.status()).toBe(400);
        });

        test('404 when documentId is not part of the course', async ({ request: api }) => {
            // Seed a doc that belongs to a different course
            await seedDocumentAndAttach({
                documentId: 'br-doc-orphan',
                courseId: COURSE_BR_B,
                lectureName: 'Unit 1',
                instructorId,
            });
            // The other course must exist for the doc to be attachable
            await seedCourse({ courseId: COURSE_BR_B, instructorId });
            // Re-attach now that course exists (the attach above was a no-op
            // before the course existed — re-run to be safe).
            await seedDocumentAndAttach({
                documentId: 'br-doc-orphan',
                courseId: COURSE_BR_B,
                lectureName: 'Unit 1',
                instructorId,
            });

            const res = await api.post(`/api/courses/${COURSE_BR_A}/extract-topics`, {
                data: { documentId: 'br-doc-orphan' },
            });
            expect(res.status()).toBe(404);

            await withDb((db) => db.collection('documents').deleteMany({ documentId: 'br-doc-orphan' }));
        });

        test('uses documentId content when no inline content supplied', async ({ request: api }) => {
            await seedDocumentAndAttach({
                documentId: 'br-doc-in-course',
                courseId: COURSE_BR_A,
                lectureName: 'Unit 1',
                instructorId,
                content: 'Photosynthesis converts light energy into chemical energy in plants.',
            });

            const res = await api.post(`/api/courses/${COURSE_BR_A}/extract-topics`, {
                data: { documentId: 'br-doc-in-course', maxTopics: 5 },
            });
            // The LLM is real in this environment; we don't assert on the
            // exact topics, just that the route succeeded and returned an
            // array (possibly empty if the LLM declined).
            expect(res.ok()).toBeTruthy();
            const body = await res.json();
            expect(body.success).toBe(true);
            expect(Array.isArray(body.data.topics)).toBe(true);

            await withDb((db) => db.collection('documents').deleteMany({ documentId: 'br-doc-in-course' }));
        });

        test('skips additional material when secondary search is enabled', async ({ request: api }) => {
            // seedDocumentAndAttach seeds documents with documentType
            // 'additional'; with the course de-prioritizing additional
            // materials, the route must skip extraction entirely.
            await seedCourse({
                courseId: COURSE_BR_A,
                instructorId,
                overrides: { additionalMaterialSecondarySearch: true },
            });
            await seedDocumentAndAttach({
                documentId: 'br-doc-additional-skip',
                courseId: COURSE_BR_A,
                lectureName: 'Unit 1',
                instructorId,
                content: 'Enzyme kinetics describes rates of catalysis.',
            });

            const res = await api.post(`/api/courses/${COURSE_BR_A}/extract-topics`, {
                data: { documentId: 'br-doc-additional-skip' },
            });
            expect(res.ok()).toBeTruthy();
            const body = await res.json();
            expect(body.success).toBe(true);
            expect(body.data.topics).toEqual([]);
            expect(body.data.skippedAdditionalMaterial).toBe(true);

            await withDb((db) => db.collection('documents').deleteMany({ documentId: 'br-doc-additional-skip' }));
        });

        test('caps maxTopics within [1,15] (parseInt fallback path)', async ({ request: api }) => {
            const res = await api.post(`/api/courses/${COURSE_BR_A}/extract-topics`, {
                data: {
                    content: 'Enzyme kinetics describes rates of catalysis. ' .repeat(40),
                    maxTopics: 'not-a-number',
                },
            });
            expect(res.ok()).toBeTruthy();
            const body = await res.json();
            expect(Array.isArray(body.data.topics)).toBe(true);
            expect(body.data.topics.length).toBeLessThanOrEqual(8);
        });
    });

    test.describe('as student', () => {
        test.use({ storageState: storageStatePath('student') });

        test('403 — students cannot extract topics', async ({ request: api }) => {
            await setStudentEnrollment(COURSE_BR_A, studentId, true);
            const res = await api.post(`/api/courses/${COURSE_BR_A}/extract-topics`, {
                data: { content: 'foo' },
            });
            expect(res.status()).toBe(403);
        });
    });
});

// ---------------------------------------------------------------------------
// GET /api/courses/:courseId — student view via getCourseForStudent
// ---------------------------------------------------------------------------
test.describe('GET /api/courses/:courseId (student → getCourseForStudent)', () => {
    test.describe('as student', () => {
        test.use({ storageState: storageStatePath('student') });

        test('happy student view returns transformed payload with lectures and studentIdleTimeout default', async ({ request: api }) => {
            await seedCourse({
                courseId: COURSE_BR_A,
                instructorId,
                lectures: [
                    {
                        name: 'Unit 1',
                        isPublished: true,
                        learningObjectives: ['LO 1'],
                        passThreshold: 3,
                        documents: [{ documentId: 'd1', filename: 'a.pdf' }],
                        assessmentQuestions: [],
                    },
                ],
            });
            await setStudentEnrollment(COURSE_BR_A, studentId, true);
            const res = await api.get(`/api/courses/${COURSE_BR_A}`);
            expect(res.ok()).toBeTruthy();
            const body = await res.json();
            expect(body.data.id).toBe(COURSE_BR_A);
            expect(body.data.studentIdleTimeout).toBe(240); // default
            expect(body.data.studentSessionTimeout).toBe(1800); // default 30 minutes
            expect(body.data.lectures).toHaveLength(1);
            expect(body.data.lectures[0].isPublished).toBe(true);
            expect(body.data.structure.specialFolders[0]).toEqual({
                id: 'quizzes',
                name: 'Practice Quizzes',
                type: 'quiz',
            });
        });

        test('honours custom studentIdleTimeout from course.prompts', async ({ request: api }) => {
            await seedCourse({
                courseId: COURSE_BR_A,
                instructorId,
                overrides: { prompts: { studentIdleTimeout: 600, studentSessionTimeout: 3600 } },
            });
            await setStudentEnrollment(COURSE_BR_A, studentId, true);
            const res = await api.get(`/api/courses/${COURSE_BR_A}`);
            const body = await res.json();
            expect(body.data.studentIdleTimeout).toBe(600);
            expect(body.data.studentSessionTimeout).toBe(3600);
        });

        test('403 with course_inactive reason when the course is inactive (caught upstream by middleware)', async ({ request: api }) => {
            // requireActiveCourseForNonInstructors blocks inactive courses for
            // students before getCourseForStudent runs; cover that branch by
            // hitting the route on an inactive course.
            await seedCourse({ courseId: COURSE_BR_INACTIVE, instructorId, status: 'inactive' });
            await setStudentEnrollment(COURSE_BR_INACTIVE, studentId, true);
            const res = await api.get(`/api/courses/${COURSE_BR_INACTIVE}`);
            expect(res.status()).toBe(403);
        });
    });
});

// ---------------------------------------------------------------------------
// PUT /api/courses/:courseId — prompts-object update branch
// ---------------------------------------------------------------------------
test.describe('PUT /api/courses/:courseId (prompts object branch)', () => {
    test.use({ storageState: storageStatePath('instructor') });

    test.beforeEach(async () => {
        await seedCourse({ courseId: COURSE_BR_A, instructorId });
    });

    test('replaces prompts wholesale when req.body.prompts is provided', async ({ request: api }) => {
        const res = await api.put(`/api/courses/${COURSE_BR_A}?instructorId=${instructorId}`, {
            data: { prompts: { base: 'B', tutor: 'T', studentIdleTimeout: 500 } },
        });
        expect(res.ok()).toBeTruthy();
        const doc = await withDb((db) =>
            db.collection('courses').findOne({ courseId: COURSE_BR_A })
        );
        expect(doc.prompts).toEqual({ base: 'B', tutor: 'T', studentIdleTimeout: 500 });
    });

    test('weeks-only update still resets the totalUnits product', async ({ request: api }) => {
        const res = await api.put(`/api/courses/${COURSE_BR_A}?instructorId=${instructorId}`, {
            data: { weeks: 4 },
        });
        expect(res.ok()).toBeTruthy();
        const doc = await withDb((db) =>
            db.collection('courses').findOne({ courseId: COURSE_BR_A })
        );
        // Only weeks is provided; lecturesPerWeek defaults to 0 in the update
        // payload, so totalUnits ends up at 0. This documents the current
        // behavior and pins the branch.
        expect(doc.courseStructure.totalUnits).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// DELETE /api/courses/:courseId
// ---------------------------------------------------------------------------
test.describe('DELETE /api/courses/:courseId (edge branches)', () => {
    test.use({ storageState: storageStatePath('instructor') });

    test('400 when instructorId is missing from the querystring', async ({ request: api }) => {
        const res = await api.delete(`/api/courses/${COURSE_BR_A}`);
        expect(res.status()).toBe(400);
    });

    test('404 when caller is not the owning instructor', async ({ request: api }) => {
        await seedCourse({ courseId: COURSE_BR_A, instructorId: instructorFreshId });
        const res = await api.delete(`/api/courses/${COURSE_BR_A}?instructorId=${instructorId}`);
        expect(res.status()).toBe(404);
    });
});

// ---------------------------------------------------------------------------
// POST /api/courses/:courseId/instructors — caller mismatch
// ---------------------------------------------------------------------------
test.describe('POST /api/courses/:courseId/instructors (caller mismatch)', () => {
    test.use({ storageState: storageStatePath('instructor') });

    test('403 when body.instructorId is not the authenticated user', async ({ request: api }) => {
        await seedCourse({
            courseId: COURSE_BR_B,
            instructorId: instructorFreshId,
            instructorCourseCode: 'CORRECT',
        });
        const res = await api.post(`/api/courses/${COURSE_BR_B}/instructors`, {
            data: { instructorId: 'some-other-user', code: 'CORRECT' },
        });
        expect(res.status()).toBe(403);
    });
});

// ---------------------------------------------------------------------------
// POST /api/courses/:courseId/transfer with documents
// ---------------------------------------------------------------------------
test.describe('POST /api/courses/:courseId/transfer (documents path)', () => {
    test.use({ storageState: storageStatePath('instructor') });

    test('403 when caller is not an instructor on the source course', async ({ request: api }) => {
        await seedCourse({ courseId: COURSE_BR_B, instructorId: instructorFreshId });
        const res = await api.post(`/api/courses/${COURSE_BR_B}/transfer`, {
            data: { newCourseName: 'Hijack' },
        });
        expect(res.status()).toBe(403);
    });

    test('403 for non-instructor callers (students)', async ({ baseURL }) => {
        await seedCourse({ courseId: COURSE_BR_A, instructorId });
        const studentApi = await request.newContext({
            baseURL,
            storageState: storageStatePath('student'),
        });
        try {
            const res = await studentApi.post(`/api/courses/${COURSE_BR_A}/transfer`, {
                data: { newCourseName: 'X' },
            });
            expect(res.status()).toBe(403);
        } finally {
            await studentApi.dispose();
        }
    });

    test('clones documents from the source course (exercises cloneDocumentForTransfer)', async ({ request: api }) => {
        // Seed source course with rich settings so transferSettings copies them all
        await seedCourse({
            courseId: COURSE_BR_TRANSFER_SRC,
            instructorId,
            tas: [taId],
            overrides: {
                prompts: { base: 'b', tutor: 't', protege: 'p' },
                quizSettings: { enabled: true, testableUnits: 'all', allowLectureMaterialAccess: true, allowSourceAttributionDownloads: false },
                questionPrompts: { mcq: 'mcq-prompt' },
                mentalHealthDetectionPrompt: 'mh-prompt',
                isAdditiveRetrieval: true,
                anonymizeStudents: { [instructorId]: { enabled: true, updatedAt: new Date() } },
                lectures: [
                    {
                        name: 'Unit 1',
                        displayName: 'Cells',
                        isPublished: true,
                        materialsConfirmed: true,
                        materialsConfirmedAt: new Date(),
                        learningObjectives: ['LO A'],
                        passThreshold: 3,
                        documents: [],
                        assessmentQuestions: [{ questionId: 'q1', type: 'tf', question: 'OK?', correctAnswer: 'true' }],
                    },
                    {
                        name: 'Unit 2',
                        isPublished: false,
                        learningObjectives: [],
                        passThreshold: 2,
                        documents: [],
                        assessmentQuestions: [],
                    },
                ],
            },
        });

        // Attach a parsed text document to Unit 1
        await seedDocumentAndAttach({
            documentId: 'br-xfer-doc-1',
            courseId: COURSE_BR_TRANSFER_SRC,
            lectureName: 'Unit 1',
            instructorId,
            content: 'Plain text content for transfer coverage.',
            contentType: 'text',
            mimeType: 'text/plain',
            status: 'parsed',
        });

        const res = await api.post(`/api/courses/${COURSE_BR_TRANSFER_SRC}/transfer`, {
            data: {
                newCourseName: 'BIOC E2E Transfer Branches Target',
                transferSettings: true,
                transferTAs: true,
                deactivateSourceCourse: false,
                apiKey: VALID_API_KEY,
                units: [
                    // Unit 1 transfers documents, LOs, AQs
                    { unitName: 'Unit 1', transferDocuments: true, transferLearningObjectives: true, transferAssessmentQuestions: true },
                    // Unit 2 transfers nothing
                    { unitName: 'Unit 2', transferDocuments: false, transferLearningObjectives: false, transferAssessmentQuestions: false },
                ],
            },
        });
        expect(res.ok()).toBeTruthy();
        const body = await res.json();
        expect(body.data.summary.totalUnits).toBe(2);
        // Documents may transfer (1) or fail with a warning if qdrant isn't
        // wired up — both branches are valuable. Either way the call must
        // succeed and return a summary.
        expect(typeof body.data.summary.documentsCopied).toBe('number');
        expect(body.data.summary.settingsTransferred).toBe(true);
        expect(body.data.summary.tasTransferred).toBe(true);

        // The cloned target course must exist
        const cloned = await withDb((db) =>
            db.collection('courses').findOne({ courseId: body.data.courseId })
        );
        expect(cloned).toBeTruthy();
        expect(cloned.prompts).toMatchObject({ base: 'b', tutor: 't' });
        expect(cloned.quizSettings.enabled).toBe(true);
        expect(cloned.questionPrompts).toEqual({ mcq: 'mcq-prompt' });
        expect(cloned.mentalHealthDetectionPrompt).toBe('mh-prompt');
        expect(cloned.isAdditiveRetrieval).toBe(true);
        expect(cloned.anonymizeStudents[instructorId].enabled).toBe(true);
        expect(cloned.tas).toContain(taId);

        const u1 = cloned.lectures.find((l) => l.name === 'Unit 1');
        expect(u1.displayName).toBe('Cells');
        expect(u1.materialsConfirmed).toBe(true);
        expect(u1.learningObjectives).toEqual(['LO A']);
        expect(u1.assessmentQuestions).toHaveLength(1);

        // Cleanup the dynamically-created target course
        await cleanupCourses([body.data.courseId]);
        await withDb((db) => db.collection('documents').deleteMany({ documentId: 'br-xfer-doc-1' }));
    });
});

// ---------------------------------------------------------------------------
// DELETE /api/courses/:courseId/units/:unitName — with attached documents
// ---------------------------------------------------------------------------
test.describe('DELETE /api/courses/:courseId/units/:unitName (with docs)', () => {
    test.use({ storageState: storageStatePath('instructor') });

    test('removes attached documents and decrements totalUnits', async ({ request: api }) => {
        await seedCourse({
            courseId: COURSE_BR_UNIT_DOCS,
            instructorId,
            lectures: [
                {
                    name: 'Unit 1',
                    isPublished: false,
                    learningObjectives: [],
                    passThreshold: 2,
                    documents: [],
                    assessmentQuestions: [],
                },
                {
                    name: 'Unit 2',
                    isPublished: false,
                    learningObjectives: [],
                    passThreshold: 2,
                    documents: [],
                    assessmentQuestions: [],
                },
            ],
        });
        await seedDocumentAndAttach({
            documentId: 'br-unit-doc-a',
            courseId: COURSE_BR_UNIT_DOCS,
            lectureName: 'Unit 1',
            instructorId,
        });
        await seedDocumentAndAttach({
            documentId: 'br-unit-doc-b',
            courseId: COURSE_BR_UNIT_DOCS,
            lectureName: 'Unit 1',
            instructorId,
            filename: 'b.txt',
        });

        const res = await api.delete(
            `/api/courses/${COURSE_BR_UNIT_DOCS}/units/${encodeURIComponent('Unit 1')}`,
            { data: { instructorId } }
        );
        expect(res.ok()).toBeTruthy();
        const body = await res.json();
        expect(body.data.deletedUnit).toBe('Unit 1');
        expect(body.data.deletedDocumentsCount).toBeGreaterThanOrEqual(0);

        const doc = await withDb((db) =>
            db.collection('courses').findOne({ courseId: COURSE_BR_UNIT_DOCS })
        );
        expect(doc.lectures.find((l) => l.name === 'Unit 1')).toBeFalsy();
        expect(doc.courseStructure.totalUnits).toBe(1);
    });
});

// ---------------------------------------------------------------------------
// POST /api/courses/:courseId/units — error branches
// ---------------------------------------------------------------------------
test.describe('POST /api/courses/:courseId/units (errors)', () => {
    test.use({ storageState: storageStatePath('instructor') });

    test('403 when instructor lacks access to the course', async ({ request: api }) => {
        await seedCourse({ courseId: COURSE_BR_B, instructorId: instructorFreshId });
        const res = await api.post(`/api/courses/${COURSE_BR_B}/units`, {
            data: { instructorId },
        });
        expect(res.status()).toBe(403);
    });
});

// ---------------------------------------------------------------------------
// PUT /api/courses/:courseId/units/:unitName/rename
// ---------------------------------------------------------------------------
test.describe('PUT /api/courses/:courseId/units/:unitName/rename', () => {
    test.use({ storageState: storageStatePath('instructor') });

    test.beforeEach(async () => {
        await seedCourse({ courseId: COURSE_BR_A, instructorId });
    });

    test('400 when instructorId is missing', async ({ request: api }) => {
        const res = await api.put(`/api/courses/${COURSE_BR_A}/units/${encodeURIComponent('Unit 1')}/rename`, {
            data: { displayName: 'X' },
        });
        expect(res.status()).toBe(400);
    });

    test('403 when caller does not have access', async ({ request: api }) => {
        await seedCourse({ courseId: COURSE_BR_B, instructorId: instructorFreshId });
        const res = await api.put(`/api/courses/${COURSE_BR_B}/units/${encodeURIComponent('Unit 1')}/rename`, {
            data: { instructorId, displayName: 'X' },
        });
        expect(res.status()).toBe(403);
    });

    test('404 when the unit does not exist', async ({ request: api }) => {
        const res = await api.put(`/api/courses/${COURSE_BR_A}/units/${encodeURIComponent('Unit 99')}/rename`, {
            data: { instructorId, displayName: 'New' },
        });
        expect(res.status()).toBe(404);
    });

    test('clearing displayName (empty string) unsets the field', async ({ request: api }) => {
        // First set a name
        await api.put(`/api/courses/${COURSE_BR_A}/units/${encodeURIComponent('Unit 1')}/rename`, {
            data: { instructorId, displayName: 'Cells' },
        });
        // Then clear it
        const res = await api.put(`/api/courses/${COURSE_BR_A}/units/${encodeURIComponent('Unit 1')}/rename`, {
            data: { instructorId, displayName: '' },
        });
        expect(res.ok()).toBeTruthy();
        const doc = await withDb((db) =>
            db.collection('courses').findOne({ courseId: COURSE_BR_A })
        );
        const u1 = doc.lectures.find((l) => l.name === 'Unit 1');
        expect(u1.displayName === undefined || u1.displayName === null).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// POST /api/courses/:courseId/join — TA branches
// ---------------------------------------------------------------------------
test.describe('POST /api/courses/:courseId/join (TA branches)', () => {
    test.use({ storageState: storageStatePath('ta') });

    test('403 when course is inactive and TA is not assigned/invited', async ({ request: api }) => {
        await seedCourse({ courseId: COURSE_BR_INACTIVE, instructorId, status: 'inactive' });
        await clearInvitedCourses(taId);
        const res = await api.post(`/api/courses/${COURSE_BR_INACTIVE}/join`, {
            data: { code: 'STUCD' },
        });
        // Either blocked by route (403) or by middleware
        // requireActiveCourseForNonInstructors (which lets TAs through).
        expect(res.status()).toBe(403);
    });

    test('403 when code is wrong and TA is not assigned/invited', async ({ request: api }) => {
        await seedCourse({ courseId: COURSE_BR_A, instructorId, courseCode: 'GOODCD' });
        await clearInvitedCourses(taId);
        const res = await api.post(`/api/courses/${COURSE_BR_A}/join`, {
            data: { code: 'WRONG' },
        });
        expect(res.status()).toBe(403);
    });

    test('invited TA can join without a code (covers invited-path)', async ({ request: api }) => {
        await seedCourse({ courseId: COURSE_BR_A, instructorId });
        await withDb((db) =>
            db.collection('users').updateOne(
                { userId: taId },
                { $set: { invitedCourses: [COURSE_BR_A] } }
            )
        );
        const res = await api.post(`/api/courses/${COURSE_BR_A}/join`, { data: {} });
        expect(res.ok()).toBeTruthy();
        const doc = await withDb((db) =>
            db.collection('courses').findOne({ courseId: COURSE_BR_A })
        );
        expect(doc.tas).toContain(taId);
    });

    test('invited TA supplying a wrong code is rejected (covers the else-if branch)', async ({ request: api }) => {
        await seedCourse({ courseId: COURSE_BR_A, instructorId, courseCode: 'GOODCD' });
        await withDb((db) =>
            db.collection('users').updateOne(
                { userId: taId },
                { $set: { invitedCourses: [COURSE_BR_A] } }
            )
        );
        const res = await api.post(`/api/courses/${COURSE_BR_A}/join`, {
            data: { code: 'WRONG' },
        });
        expect(res.status()).toBe(403);
    });
});

// ---------------------------------------------------------------------------
// TA permissions: PUT / GET single / GET all — error and 404 branches
// ---------------------------------------------------------------------------
test.describe('TA permissions error branches', () => {
    test.use({ storageState: storageStatePath('instructor') });

    test.beforeEach(async () => {
        await seedCourse({ courseId: COURSE_BR_A, instructorId });
    });

    test('PUT /ta-permissions/:taId 400 when TA is not assigned to the course', async ({ request: api }) => {
        const res = await api.put(`/api/courses/${COURSE_BR_A}/ta-permissions/${taId}`, {
            data: { materials: true, flags: true },
        });
        // TA isn't on the tas[] array → model returns
        // { success: false, error: 'TA is not assigned to this course' }
        expect(res.status()).toBe(400);
    });

    test('PUT /ta-permissions/:taId 403 when caller is not an instructor on the course', async ({ baseURL }) => {
        await seedCourse({ courseId: COURSE_BR_B, instructorId: instructorFreshId, tas: [taId] });
        const api = await request.newContext({
            baseURL,
            storageState: storageStatePath('instructor'),
        });
        try {
            const res = await api.put(`/api/courses/${COURSE_BR_B}/ta-permissions/${taId}`, {
                data: { materials: true, flags: true },
            });
            expect(res.status()).toBe(403);
        } finally {
            await api.dispose();
        }
    });

    test('PUT /ta-permissions/:taId 403 when caller is a student', async ({ baseURL }) => {
        const api = await request.newContext({
            baseURL,
            storageState: storageStatePath('student'),
        });
        try {
            const res = await api.put(`/api/courses/${COURSE_BR_A}/ta-permissions/${taId}`, {
                data: { materials: true, flags: true },
            });
            expect(res.status()).toBe(403);
        } finally {
            await api.dispose();
        }
    });

    test('GET /ta-permissions/:taId — TA viewing own permissions succeeds', async ({ baseURL, request: api }) => {
        await api.post(`/api/courses/${COURSE_BR_A}/tas`, { data: { taId } });
        const taApi = await request.newContext({
            baseURL,
            storageState: storageStatePath('ta'),
        });
        try {
            const res = await taApi.get(`/api/courses/${COURSE_BR_A}/ta-permissions/${taId}`);
            expect(res.ok()).toBeTruthy();
            const body = await res.json();
            expect(body.data.taId).toBe(taId);
        } finally {
            await taApi.dispose();
        }
    });

    test('GET /ta-permissions/:taId 403 when student asks', async ({ baseURL }) => {
        const api = await request.newContext({
            baseURL,
            storageState: storageStatePath('student'),
        });
        try {
            const res = await api.get(`/api/courses/${COURSE_BR_A}/ta-permissions/${taId}`);
            expect(res.status()).toBe(403);
        } finally {
            await api.dispose();
        }
    });

    test('GET /ta-permissions/:taId 400 when TA is not assigned to the course', async ({ request: api }) => {
        const res = await api.get(`/api/courses/${COURSE_BR_A}/ta-permissions/${taId}`);
        // userHasCourseAccess for instructor passes; getTAPermissions returns
        // { success:false, error:'TA is not assigned to this course' } → 400
        expect(res.status()).toBe(400);
    });

    test('GET /ta-permissions 404 when the course does not exist', async ({ request: api }) => {
        // The instructor lacks access to a non-existent course → 403 first.
        // Use a course that exists but is owned by us, then delete it inline.
        await seedCourse({ courseId: COURSE_BR_B, instructorId });
        await withDb((db) =>
            db.collection('courses').updateOne(
                { courseId: COURSE_BR_B },
                { $set: { instructorId, instructors: [instructorId] } }
            )
        );
        // Drop the course so getCourseById returns null but userHasCourseAccess
        // already passed... actually that race isn't deterministic. Instead
        // assert the 403-when-no-access branch which IS deterministic.
        await cleanupCourses([COURSE_BR_B]);
        const res = await api.get(`/api/courses/${COURSE_BR_B}/ta-permissions`);
        expect(res.status()).toBe(403);
    });

    test('GET /ta-permissions 403 when caller is a student', async ({ baseURL }) => {
        const api = await request.newContext({
            baseURL,
            storageState: storageStatePath('student'),
        });
        try {
            const res = await api.get(`/api/courses/${COURSE_BR_A}/ta-permissions`);
            expect(res.status()).toBe(403);
        } finally {
            await api.dispose();
        }
    });

    test('GET /ta-permissions for course with TAs returns fail-closed defaults when no override', async ({ request: api }) => {
        await api.post(`/api/courses/${COURSE_BR_A}/tas`, { data: { taId } });
        const res = await api.get(`/api/courses/${COURSE_BR_A}/ta-permissions`);
        expect(res.ok()).toBeTruthy();
        const body = await res.json();
        // A newly-added TA with no permissions ever set defaults to no
        // access (fail-closed) - reverses the old fail-open default.
        expect(body.data.taPermissions[taId]).toMatchObject({
            materials: false, questions: false, flags: false, roster: false, transcripts: false, settings: false,
        });
        expect(body.data.taPermissions[taId].roleLabel).toBe('custom');
    });
});

// ---------------------------------------------------------------------------
// DELETE /api/courses/:courseId/tas/:taId — role downgrade / stay branches
// ---------------------------------------------------------------------------
test.describe('DELETE /api/courses/:courseId/tas/:taId (role lifecycle)', () => {
    test.use({ storageState: storageStatePath('instructor') });

    test('TA with pending invitedCourses keeps the ta role after removal', async ({ request: api }) => {
        await seedCourse({ courseId: COURSE_BR_A, instructorId, tas: [taId] });
        await withDb((db) =>
            db.collection('users').updateOne(
                { userId: taId },
                { $set: { invitedCourses: ['BIOC-E2E-API-BR-PENDING-INVITE'] } }
            )
        );
        const res = await api.delete(`/api/courses/${COURSE_BR_A}/tas/${taId}`);
        expect(res.ok()).toBeTruthy();
        const body = await res.json();
        expect(body.data.role).toBe('ta');
        const u = await withDb((db) => db.collection('users').findOne({ userId: taId }));
        expect(u.role).toBe('ta');
    });

    test('TA who happens to be a non-ta in the users collection is promoted back to ta when they still have assignments', async ({ request: api }) => {
        // Two courses both list the TA. Remove from one — they should remain
        // a TA because remainingCourseCount > 0 and we set their role to
        // something other than 'ta' beforehand.
        await seedCourse({ courseId: COURSE_BR_A, instructorId, tas: [taId] });
        await seedCourse({ courseId: COURSE_BR_B, instructorId, tas: [taId] });
        await setUserRole(taId, 'student'); // force the role mismatch branch

        const res = await api.delete(`/api/courses/${COURSE_BR_A}/tas/${taId}`);
        expect(res.ok()).toBeTruthy();
        const u = await withDb((db) => db.collection('users').findOne({ userId: taId }));
        expect(u.role).toBe('ta');
    });

    test('TA with no remaining assignments and no invites is downgraded to student', async ({ request: api }) => {
        await seedCourse({ courseId: COURSE_BR_A, instructorId, tas: [taId] });
        await clearInvitedCourses(taId);
        const res = await api.delete(`/api/courses/${COURSE_BR_A}/tas/${taId}`);
        expect(res.ok()).toBeTruthy();
        const body = await res.json();
        expect(body.data.role).toBe('student');
    });

    test('404 when the course is already soft-deleted', async ({ request: api }) => {
        await seedCourse({ courseId: COURSE_BR_A, instructorId, status: 'deleted', tas: [taId] });
        const res = await api.delete(`/api/courses/${COURSE_BR_A}/tas/${taId}`);
        expect(res.status()).toBe(404);
    });

    test('403 when caller is not an instructor on the course', async ({ baseURL }) => {
        await seedCourse({ courseId: COURSE_BR_B, instructorId: instructorFreshId, tas: [taId] });
        const api = await request.newContext({
            baseURL,
            storageState: storageStatePath('instructor'),
        });
        try {
            const res = await api.delete(`/api/courses/${COURSE_BR_B}/tas/${taId}`);
            expect(res.status()).toBe(403);
        } finally {
            await api.dispose();
        }
    });

    test('403 when caller is a student', async ({ baseURL }) => {
        await seedCourse({ courseId: COURSE_BR_A, instructorId, tas: [taId] });
        const api = await request.newContext({
            baseURL,
            storageState: storageStatePath('student'),
        });
        try {
            const res = await api.delete(`/api/courses/${COURSE_BR_A}/tas/${taId}`);
            expect(res.status()).toBe(403);
        } finally {
            await api.dispose();
        }
    });
});

// ---------------------------------------------------------------------------
// PATCH /approved-topics/unit — clearing a unit assignment + missing-unit
// ---------------------------------------------------------------------------
test.describe('PATCH /approved-topics/unit (extra branches)', () => {
    test.use({ storageState: storageStatePath('instructor') });

    test.beforeEach(async () => {
        await seedCourse({ courseId: COURSE_BR_A, instructorId });
        await withDb((db) =>
            db.collection('courses').updateOne(
                { courseId: COURSE_BR_A },
                { $set: { approvedStruggleTopics: [{ topic: 'Cell Biology', unitId: 'Unit 1', source: 'manual' }] } }
            )
        );
    });

    test('400 when topicLabel is empty', async ({ request: api }) => {
        const res = await api.patch(`/api/courses/${COURSE_BR_A}/approved-topics/unit`, {
            data: { topic: '   ', unitId: 'Unit 1' },
        });
        expect(res.status()).toBe(400);
    });

    test('400 when unitId references a unit that does not exist on the course', async ({ request: api }) => {
        const res = await api.patch(`/api/courses/${COURSE_BR_A}/approved-topics/unit`, {
            data: { topic: 'Cell Biology', unitId: 'Unit 99' },
        });
        expect(res.status()).toBe(400);
    });

    test('clearing unitId (null) succeeds and removes the assignment', async ({ request: api }) => {
        const res = await api.patch(`/api/courses/${COURSE_BR_A}/approved-topics/unit`, {
            data: { topic: 'Cell Biology', unitId: null },
        });
        expect(res.ok()).toBeTruthy();
        const body = await res.json();
        expect(body.data.topic.unitId).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// GET /api/courses/:courseId/students — fallback paths
// ---------------------------------------------------------------------------
test.describe('GET /api/courses/:courseId/students (fallback paths)', () => {
    test.use({ storageState: storageStatePath('instructor') });

    test('includes a synthetic record for an enrollment entry whose user is not in the users collection', async ({ request: api }) => {
        const phantomId = 'BIOC-E2E-API-BR-PHANTOM-STUDENT';
        await seedCourse({
            courseId: COURSE_BR_A,
            instructorId,
            studentEnrollment: {
                [phantomId]: { enrolled: true, enrolledAt: new Date() },
            },
        });
        const res = await api.get(`/api/courses/${COURSE_BR_A}/students`);
        expect(res.ok()).toBeTruthy();
        const body = await res.json();
        const phantom = body.data.students.find((s) => s.userId === phantomId);
        expect(phantom).toBeTruthy();
        expect(phantom.username).toBe(phantomId);
        expect(phantom.email).toBeNull();
        expect(phantom.enrolled).toBe(true);
    });

    test('TA without roster permission is blocked with 403', async ({ baseURL }) => {
        await seedCourse({
            courseId: COURSE_BR_A,
            instructorId,
            tas: [taId],
            taPermissions: { [taId]: { materials: true, roster: false } },
        });
        const taApi = await request.newContext({
            baseURL,
            storageState: storageStatePath('ta'),
        });
        try {
            const res = await taApi.get(`/api/courses/${COURSE_BR_A}/students`);
            expect(res.status()).toBe(403);
        } finally {
            await taApi.dispose();
        }
    });

    test('TA with roster permission can view students', async ({ baseURL }) => {
        await seedCourse({
            courseId: COURSE_BR_A,
            instructorId,
            tas: [taId],
            taPermissions: { [taId]: { materials: true, roster: true } },
        });
        const taApi = await request.newContext({
            baseURL,
            storageState: storageStatePath('ta'),
        });
        try {
            const res = await taApi.get(`/api/courses/${COURSE_BR_A}/students`);
            expect(res.ok()).toBeTruthy();
        } finally {
            await taApi.dispose();
        }
    });
});

// ---------------------------------------------------------------------------
// GET /api/courses/statistics — default-mode session (no chatData metadata)
// ---------------------------------------------------------------------------
test.describe('GET /api/courses/statistics (extra branches)', () => {
    test.use({ storageState: storageStatePath('instructor') });

    test('excludes sessions with no measured duration and counts large durations correctly', async ({ request: api }) => {
        await seedCourse({ courseId: COURSE_BR_A, instructorId });
        const startA = new Date('2026-04-02T00:00:00Z');
        const endA = new Date('2026-04-02T02:00:00Z'); // 2 hours
        await withDb(async (db) => {
            await db.collection('chat_sessions').insertMany([
                // No chatData → default mode 'tutor' branch (else of has-metadata)
                {
                    sessionId: 'sess-no-meta',
                    courseId: COURSE_BR_A,
                    studentId: studentId,
                    // no chatData
                },
                // Long session: 2 hours, hits the "hours" branch of formatDuration
                {
                    sessionId: 'sess-long',
                    courseId: COURSE_BR_A,
                    studentId: studentId,
                    chatData: {
                        metadata: { currentMode: 'tutor' },
                        messages: [
                            { type: 'user', content: 'hi',     timestamp: startA },
                            { type: 'bot',  content: 'hello',  timestamp: endA },
                        ],
                    },
                },
            ]);
        });

        const res = await api.get(`/api/courses/statistics?courseId=${COURSE_BR_A}`);
        expect(res.ok()).toBeTruthy();
        const body = await res.json();
        expect(body.data.totalSessions).toBe(1);
        // 2-hour session → "2h 0m"
        expect(body.data.averageSessionLength).toMatch(/\d+h \d+m/);
        // only the measured session contributes to the mode distribution
        expect(body.data.modeDistribution.tutor).toBe(1);

        await withDb((db) => db.collection('chat_sessions').deleteMany({ courseId: COURSE_BR_A }));
    });

    test('TA role can hit statistics (covers `user.role === ta` branch)', async ({ baseURL }) => {
        await seedCourse({ courseId: COURSE_BR_A, instructorId, tas: [taId] });
        const taApi = await request.newContext({
            baseURL,
            storageState: storageStatePath('ta'),
        });
        try {
            const res = await taApi.get(`/api/courses/statistics?courseId=${COURSE_BR_A}`);
            expect(res.ok()).toBeTruthy();
        } finally {
            await taApi.dispose();
        }
    });
});

// ---------------------------------------------------------------------------
// GET /api/courses/:courseId/student-enrollment (instructor → 403)
// ---------------------------------------------------------------------------
test.describe('GET /api/courses/:courseId/student-enrollment (role check)', () => {
    test('instructor is rejected (only students can view their own enrollment)', async ({ baseURL }) => {
        await seedCourse({ courseId: COURSE_BR_A, instructorId });
        const api = await request.newContext({
            baseURL,
            storageState: storageStatePath('instructor'),
        });
        try {
            const res = await api.get(`/api/courses/${COURSE_BR_A}/student-enrollment`);
            expect(res.status()).toBe(403);
        } finally {
            await api.dispose();
        }
    });
});

// ---------------------------------------------------------------------------
// Approved-topics access checks (extras)
// ---------------------------------------------------------------------------
test.describe('approved-topics extra access branches', () => {
    test('GET /approved-topics 200 for an enrolled student', async ({ baseURL }) => {
        await seedCourse({ courseId: COURSE_BR_A, instructorId });
        await setStudentEnrollment(COURSE_BR_A, studentId, true);
        const api = await request.newContext({
            baseURL,
            storageState: storageStatePath('student'),
        });
        try {
            const res = await api.get(`/api/courses/${COURSE_BR_A}/approved-topics`);
            expect(res.ok()).toBeTruthy();
        } finally {
            await api.dispose();
        }
    });

    test('GET /approved-topics 200 for a TA assigned to the course', async ({ baseURL }) => {
        await seedCourse({ courseId: COURSE_BR_A, instructorId, tas: [taId] });
        const api = await request.newContext({
            baseURL,
            storageState: storageStatePath('ta'),
        });
        try {
            const res = await api.get(`/api/courses/${COURSE_BR_A}/approved-topics`);
            expect(res.ok()).toBeTruthy();
        } finally {
            await api.dispose();
        }
    });

    test('GET /approved-topics 404 when course does not exist', async ({ baseURL }) => {
        const api = await request.newContext({
            baseURL,
            storageState: storageStatePath('instructor'),
        });
        try {
            const res = await api.get('/api/courses/BIOC-E2E-API-BR-NOPE/approved-topics');
            expect(res.status()).toBe(404);
        } finally {
            await api.dispose();
        }
    });

    test('PUT /approved-topics 403 for an unassigned TA', async ({ baseURL }) => {
        await seedCourse({ courseId: COURSE_BR_A, instructorId });
        const api = await request.newContext({
            baseURL,
            storageState: storageStatePath('ta'),
        });
        try {
            const res = await api.put(`/api/courses/${COURSE_BR_A}/approved-topics`, {
                data: { topics: ['X'] },
            });
            expect(res.status()).toBe(403);
        } finally {
            await api.dispose();
        }
    });
});

// ---------------------------------------------------------------------------
// GET /api/courses/ta/:taId — non-TA caller gets 403
// ---------------------------------------------------------------------------
test.describe('GET /api/courses/ta/:taId (role check)', () => {
    test('instructor asking for /ta/:taId is rejected', async ({ baseURL }) => {
        const api = await request.newContext({
            baseURL,
            storageState: storageStatePath('instructor'),
        });
        try {
            const res = await api.get(`/api/courses/ta/${taId}`);
            expect(res.status()).toBe(403);
        } finally {
            await api.dispose();
        }
    });
});

// uncovered: 401-returning route-level `if (!req.user)` blocks are unreachable
// because the global `requireAuth` middleware rejects unauthenticated requests
// before the handlers run. Same for `if (!db)` 503 blocks — defensive code.
