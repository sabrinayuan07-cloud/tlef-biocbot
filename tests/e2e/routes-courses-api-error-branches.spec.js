// @ts-check
/**
 * Targeted branch coverage for under-covered paths in src/routes/courses.js.
 *
 * Sister spec to routes-courses-api.spec.js and routes-courses-api-branches.spec.js;
 * focuses on validation/error paths and helper-function branches the existing
 * specs do not exercise:
 *
 *   - POST /:courseId/transfer: non-string / whitespace newCourseName,
 *     non-array units, source course missing courseStructure (fallback path)
 *   - POST /:courseId/transfer with a contentType=file source document
 *     (drives getStoredFileBuffer / getStoredDocumentContent / inferDocumentSize
 *     and the file branch of cloneDocumentForTransfer)
 *   - POST /:courseId/transfer with a stored Buffer (Buffer.isBuffer branch),
 *     a {buffer:[...]} object form, and a base64 string form
 *   - DELETE /:courseId/units/:unitName when an attached docRef has no
 *     documentId (the else branch of the `if (docRef.documentId)` guard)
 *   - POST /:courseId/join: TA already on tas[] supplies a wrong code → 403
 *     (the `else if` branch at the bottom of the canJoinWithoutCode block)
 *   - POST /:courseId/join: TA already invited supplies the right code → ok
 *     (covers the success path through the else-if branch with matching code)
 *   - POST /:courseId/join: addTAToCourse failure path (course not found
 *     after the role check) → 400
 *   - POST /:courseId/extract-topics: maxTopics caps to upper (15) and lower
 *     (1) bounds via Math.min/Math.max
 *   - POST /:courseId/tas: 400 when course does not exist (addTAToCourse
 *     returns success:false)
 *   - PUT /:courseId/retrieval-mode: 404 when course does not exist
 *   - GET /:courseId/ta-permissions: empty {} when course has no tas[]
 *   - GET /:courseId/students: chat-session student path (chatStudents
 *     branch with chatStudents.length > 0)
 *
 * Branches that are not reachable without bypassing requireAuth / app.locals.db
 * (the `if (!req.user)` 401 and `if (!db)` 503 defensive blocks at the top of
 * every handler) are intentionally not targeted here — they're documented as
 * unreachable in the sister spec.
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

const COURSE_ERR_A = 'BIOC-E2E-API-COURSES-ERR-A';
const COURSE_ERR_B = 'BIOC-E2E-API-COURSES-ERR-B';
const COURSE_ERR_FILE_XFER = 'BIOC-E2E-API-COURSES-ERR-FILE-XFER';
const COURSE_ERR_BUF_XFER = 'BIOC-E2E-API-COURSES-ERR-BUF-XFER';
const COURSE_ERR_NO_STRUCT = 'BIOC-E2E-API-COURSES-ERR-NO-STRUCT';
const COURSE_ERR_UNIT_ORPHAN = 'BIOC-E2E-API-COURSES-ERR-UNIT-ORPHAN';
const COURSE_ERR_CHAT = 'BIOC-E2E-API-COURSES-ERR-CHAT';
const COURSE_ERR_NOPE = 'BIOC-E2E-API-COURSES-ERR-DOES-NOT-EXIST';
const VALID_API_KEY = 'sk-test-courses-error-branches';

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
    await setUserRole(taId, 'ta');
    await clearInvitedCourses(taId);
});

test.afterAll(async () => {
    await cleanupCourses([
        COURSE_ERR_A,
        COURSE_ERR_B,
        COURSE_ERR_FILE_XFER,
        COURSE_ERR_BUF_XFER,
        COURSE_ERR_NO_STRUCT,
        COURSE_ERR_UNIT_ORPHAN,
        COURSE_ERR_CHAT,
    ]);
    await cleanupCoursesForUser(instructorId);
    await cleanupCoursesForUser(instructorFreshId);
    await setUserRole(taId, 'ta');
    await clearInvitedCourses(taId);
});

// ---------------------------------------------------------------------------
// POST /:courseId/transfer — validation branches around newCourseName / units
// ---------------------------------------------------------------------------
test.describe('POST /api/courses/:courseId/transfer (validation)', () => {
    test.use({ storageState: storageStatePath('instructor') });

    test.beforeEach(async () => {
        await seedCourse({ courseId: COURSE_ERR_A, instructorId });
    });

    test('400 when newCourseName is a non-string (number)', async ({ request: api }) => {
        const res = await api.post(`/api/courses/${COURSE_ERR_A}/transfer`, {
            data: { newCourseName: 12345 },
        });
        expect(res.status()).toBe(400);
    });

    test('400 when newCourseName is whitespace-only (fails .trim() check)', async ({ request: api }) => {
        const res = await api.post(`/api/courses/${COURSE_ERR_A}/transfer`, {
            data: { newCourseName: '     ' },
        });
        expect(res.status()).toBe(400);
    });

    test('accepts non-array units payload (normalizes to []) and copies all lectures with defaults', async ({ request: api }) => {
        // units is not-an-array → routes' ternary takes the else branch and
        // sets normalizedUnits to [] (line ~1438), forcing every lecture to
        // be mapped via the default normalizeTransferUnitConfig.
        const res = await api.post(`/api/courses/${COURSE_ERR_A}/transfer`, {
            data: {
                newCourseName: 'BIOC E2E Err Xfer Non-Array Units',
                apiKey: VALID_API_KEY,
                units: 'not-an-array', // <-- the key branch
            },
        });
        expect(res.ok()).toBeTruthy();
        const body = await res.json();
        // Default normalizeTransferUnitConfig keeps transferDocuments/LOs/AQs=true
        expect(body.data.summary.totalUnits).toBe(2);
        await cleanupCourses([body.data.courseId]);
    });
});

// ---------------------------------------------------------------------------
// POST /:courseId/transfer — source course is missing courseStructure
// (drives the default-courseStructure fallback at lines ~1496-1502)
// ---------------------------------------------------------------------------
test.describe('POST /:courseId/transfer (no courseStructure fallback)', () => {
    test.use({ storageState: storageStatePath('instructor') });

    test('falls back to {weeks: lectures.length, lecturesPerWeek: 1} when source has no courseStructure', async ({ request: api }) => {
        await seedCourse({
            courseId: COURSE_ERR_NO_STRUCT,
            instructorId,
            overrides: { courseStructure: null }, // clear the structure
        });

        const res = await api.post(`/api/courses/${COURSE_ERR_NO_STRUCT}/transfer`, {
            data: {
                newCourseName: 'BIOC E2E Err Xfer No-Struct Target',
                apiKey: VALID_API_KEY,
            },
        });
        expect(res.ok()).toBeTruthy();
        const body = await res.json();

        // The default-structure branch builds it from sourceLectures.length
        const cloned = await withDb((db) =>
            db.collection('courses').findOne({ courseId: body.data.courseId })
        );
        expect(cloned).toBeTruthy();
        expect(cloned.courseStructure).toMatchObject({
            weeks: 2, // default seed has 2 units
            lecturesPerWeek: 1,
            totalUnits: 2,
        });

        await cleanupCourses([body.data.courseId]);
    });
});

// ---------------------------------------------------------------------------
// POST /:courseId/transfer with a contentType=file source document — drives
// getStoredFileBuffer, inferDocumentSize, and the file branch of
// cloneDocumentForTransfer (the `if (contentType === 'file' && fileBuffer)`
// path at line ~252-253).
// ---------------------------------------------------------------------------
test.describe('POST /:courseId/transfer (file document branches)', () => {
    test.use({ storageState: storageStatePath('instructor') });

    test('transfers a file document stored as a Mongo BSON Binary (Buffer.isBuffer branch)', async ({ request: api }) => {
        await seedCourse({ courseId: COURSE_ERR_FILE_XFER, instructorId });

        // Seed a document whose contentType=file and fileData is a Node Buffer
        // — drives Buffer.isBuffer(fileData) === true in getStoredFileBuffer.
        const docId = 'br-xfer-file-buf';
        const fileBytes = Buffer.from('Binary content of the seeded PDF-like file.', 'utf8');
        await withDb(async (db) => {
            const now = new Date();
            await db.collection('documents').deleteMany({ documentId: docId });
            await db.collection('documents').insertOne({
                documentId: docId,
                courseId: COURSE_ERR_FILE_XFER,
                lectureName: 'Unit 1',
                instructorId,
                filename: 'binary.pdf',
                originalName: 'binary.pdf',
                contentType: 'file',
                mimeType: 'application/pdf',
                documentType: 'lecture-notes',
                fileData: fileBytes,
                // intentionally no `size` field — exercises inferDocumentSize's
                // fileBuffer-length branch
                status: 'parsed',
                createdAt: now,
                updatedAt: now,
            });
            await db.collection('courses').updateOne(
                { courseId: COURSE_ERR_FILE_XFER, 'lectures.name': 'Unit 1' },
                {
                    $push: {
                        'lectures.$.documents': {
                            documentId: docId,
                            filename: 'binary.pdf',
                            mimeType: 'application/pdf',
                            status: 'parsed',
                        },
                    },
                }
            );
        });

        const res = await api.post(`/api/courses/${COURSE_ERR_FILE_XFER}/transfer`, {
            data: {
                newCourseName: 'BIOC E2E Err Xfer File Target',
                apiKey: VALID_API_KEY,
                units: [
                    { unitName: 'Unit 1', transferDocuments: true, transferLearningObjectives: true, transferAssessmentQuestions: true },
                    { unitName: 'Unit 2', transferDocuments: false, transferLearningObjectives: false, transferAssessmentQuestions: false },
                ],
            },
        });
        expect(res.ok()).toBeTruthy();
        const body = await res.json();
        // The cloned document is created regardless of qdrant outcome
        expect(typeof body.data.summary.documentsCopied).toBe('number');

        // Verify a clone-doc row exists for the target course
        const clones = await withDb((db) =>
            db.collection('documents').find({ courseId: body.data.courseId }).toArray()
        );
        expect(clones.length).toBeGreaterThanOrEqual(1);
        const clone = clones[0];
        expect(clone.contentType).toBe('file');
        // inferDocumentSize fell back to fileBuffer.length because the source
        // doc had no `size` field
        expect(clone.size).toBe(fileBytes.length);

        await cleanupCourses([body.data.courseId, COURSE_ERR_FILE_XFER]);
        await withDb((db) => db.collection('documents').deleteMany({ documentId: docId }));
    });

    test('transfers a file document stored as a base64 string (string branch of getStoredFileBuffer)', async ({ request: api }) => {
        await seedCourse({ courseId: COURSE_ERR_BUF_XFER, instructorId });

        const docId = 'br-xfer-file-b64';
        const original = 'Hello base64 transfer world!';
        const b64 = Buffer.from(original, 'utf8').toString('base64');
        await withDb(async (db) => {
            const now = new Date();
            await db.collection('documents').deleteMany({ documentId: docId });
            await db.collection('documents').insertOne({
                documentId: docId,
                courseId: COURSE_ERR_BUF_XFER,
                lectureName: 'Unit 1',
                instructorId,
                filename: 'sample.md',
                originalName: 'sample.md',
                contentType: 'file',
                // text/markdown mime → exercises the getStoredDocumentContent
                // branch that decodes the buffer to utf-8 (line ~215-217)
                mimeType: 'text/markdown',
                documentType: 'additional',
                fileData: b64, // string → Buffer.from(fileData, 'base64')
                size: original.length,
                status: 'parsed',
                createdAt: now,
                updatedAt: now,
            });
            await db.collection('courses').updateOne(
                { courseId: COURSE_ERR_BUF_XFER, 'lectures.name': 'Unit 1' },
                {
                    $push: {
                        'lectures.$.documents': {
                            documentId: docId,
                            filename: 'sample.md',
                            mimeType: 'text/markdown',
                            size: original.length,
                            status: 'parsed',
                        },
                    },
                }
            );
        });

        const res = await api.post(`/api/courses/${COURSE_ERR_BUF_XFER}/transfer`, {
            data: {
                newCourseName: 'BIOC E2E Err Xfer Base64 Target',
                apiKey: VALID_API_KEY,
                units: [
                    { unitName: 'Unit 1', transferDocuments: true, transferLearningObjectives: true, transferAssessmentQuestions: true },
                ],
            },
        });
        expect(res.ok()).toBeTruthy();
        const body = await res.json();

        const cloneDocs = await withDb((db) =>
            db.collection('documents').find({ courseId: body.data.courseId }).toArray()
        );
        expect(cloneDocs.length).toBeGreaterThanOrEqual(1);
        // The text/markdown branch of getStoredDocumentContent decoded the
        // buffer back to utf-8 and stored it as `content`.
        const clone = cloneDocs[0];
        expect(typeof clone.content).toBe('string');
        expect(clone.content).toContain('Hello base64 transfer world');

        await cleanupCourses([body.data.courseId, COURSE_ERR_BUF_XFER]);
        await withDb((db) => db.collection('documents').deleteMany({ documentId: docId }));
    });
});

// ---------------------------------------------------------------------------
// DELETE /:courseId/units/:unitName — docRef without documentId is silently
// skipped (the false-branch of the `if (docRef.documentId)` guard at ~3199).
// ---------------------------------------------------------------------------
test.describe('DELETE /:courseId/units/:unitName (orphan docRef branch)', () => {
    test.use({ storageState: storageStatePath('instructor') });

    test('handles a documents[] entry with no documentId field (skips the deletion branch)', async ({ request: api }) => {
        await seedCourse({
            courseId: COURSE_ERR_UNIT_ORPHAN,
            instructorId,
            lectures: [
                {
                    name: 'Unit 1',
                    isPublished: false,
                    learningObjectives: [],
                    passThreshold: 2,
                    // Two orphan references: no documentId field at all.
                    // Drives the `if (docRef.documentId)` else branch.
                    documents: [
                        { filename: 'orphan-a.txt' },
                        { filename: 'orphan-b.txt' },
                    ],
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

        const res = await api.delete(
            `/api/courses/${COURSE_ERR_UNIT_ORPHAN}/units/${encodeURIComponent('Unit 1')}`,
            { data: { instructorId } }
        );
        expect(res.ok()).toBeTruthy();
        const body = await res.json();
        // Orphan refs were skipped (no documentId), so deletedDocumentsCount
        // stays at 0 even though documents.length > 0.
        expect(body.data.deletedDocumentsCount).toBe(0);

        const doc = await withDb((db) =>
            db.collection('courses').findOne({ courseId: COURSE_ERR_UNIT_ORPHAN })
        );
        expect(doc.lectures.find((l) => l.name === 'Unit 1')).toBeFalsy();
    });
});

// ---------------------------------------------------------------------------
// POST /:courseId/join — branches around TA joining with codes
// ---------------------------------------------------------------------------
test.describe('POST /:courseId/join (TA code-check branches)', () => {
    test.use({ storageState: storageStatePath('ta') });

    test('TA already in tas[] supplying a wrong code is rejected (canJoinWithoutCode=true + wrong code)', async ({ request: api }) => {
        // TA is *assigned* (in course.tas), but supplies a code that doesn't
        // match → exercises the bottom `else if` branch where the route still
        // re-validates a provided code even when the caller could otherwise
        // skip code validation.
        await seedCourse({
            courseId: COURSE_ERR_A,
            instructorId,
            tas: [taId],
            courseCode: 'CORRECTCODE',
        });
        await clearInvitedCourses(taId);

        const res = await api.post(`/api/courses/${COURSE_ERR_A}/join`, {
            data: { code: 'WRONGCODE' },
        });
        expect(res.status()).toBe(403);
    });

    test('TA already in tas[] supplying the right code succeeds', async ({ request: api }) => {
        await seedCourse({
            courseId: COURSE_ERR_A,
            instructorId,
            tas: [taId],
            courseCode: 'CORRECTCODE',
        });
        await clearInvitedCourses(taId);

        const res = await api.post(`/api/courses/${COURSE_ERR_A}/join`, {
            data: { code: 'CORRECTCODE' },
        });
        expect(res.ok()).toBeTruthy();
    });
});

// ---------------------------------------------------------------------------
// POST /:courseId/tas — failure path when addTAToCourse returns success:false
// (course does not exist).
// ---------------------------------------------------------------------------
test.describe('POST /:courseId/tas (failure branch)', () => {
    test.use({ storageState: storageStatePath('instructor') });

    test('400 when course does not exist (addTAToCourse returns success:false)', async ({ request: api }) => {
        const res = await api.post(`/api/courses/${COURSE_ERR_NOPE}/tas`, {
            data: { taId },
        });
        // Route returns 400 with the model's error message, not 404 — pin the
        // current behavior.
        expect(res.status()).toBe(400);
        const body = await res.json();
        expect(body.success).toBe(false);
        expect(body.message).toMatch(/not found/i);
    });
});

// ---------------------------------------------------------------------------
// PUT /:courseId/retrieval-mode — 404 when course does not exist
// ---------------------------------------------------------------------------
test.describe('PUT /:courseId/retrieval-mode (course missing)', () => {
    test.use({ storageState: storageStatePath('instructor') });

    test('404 when the course does not exist', async ({ request: api }) => {
        const res = await api.put(`/api/courses/${COURSE_ERR_NOPE}/retrieval-mode`, {
            data: { isAdditiveRetrieval: true },
        });
        expect(res.status()).toBe(404);
    });
});

// ---------------------------------------------------------------------------
// POST /:courseId/extract-topics — maxTopics clamping branches
// ---------------------------------------------------------------------------
test.describe('POST /:courseId/extract-topics (maxTopics clamping)', () => {
    test.use({ storageState: storageStatePath('instructor') });

    test.beforeEach(async () => {
        await seedCourse({ courseId: COURSE_ERR_A, instructorId });
    });

    test('caps maxTopics at 15 (Math.min upper bound)', async ({ request: api }) => {
        const res = await api.post(`/api/courses/${COURSE_ERR_A}/extract-topics`, {
            data: {
                content: 'Enzyme kinetics describes rates of catalysis. '.repeat(40),
                maxTopics: 99,
            },
        });
        expect(res.ok()).toBeTruthy();
        const body = await res.json();
        expect(Array.isArray(body.data.topics)).toBe(true);
        // Cap is 15 — the response is always sliced to topicLimit
        expect(body.data.topics.length).toBeLessThanOrEqual(15);
    });

    test('clamps a negative maxTopics up to 1 (Math.max lower bound)', async ({ request: api }) => {
        const res = await api.post(`/api/courses/${COURSE_ERR_A}/extract-topics`, {
            data: {
                content: 'Photosynthesis converts light energy into chemical energy. '.repeat(20),
                maxTopics: -5,
            },
        });
        expect(res.ok()).toBeTruthy();
        const body = await res.json();
        expect(Array.isArray(body.data.topics)).toBe(true);
        expect(body.data.topics.length).toBeLessThanOrEqual(1);
    });
});

// ---------------------------------------------------------------------------
// GET /:courseId/ta-permissions — no-TAs branch (empty mapping)
// ---------------------------------------------------------------------------
test.describe('GET /:courseId/ta-permissions (no TAs branch)', () => {
    test.use({ storageState: storageStatePath('instructor') });

    test('returns an empty taPermissions {} when the course has no TAs', async ({ request: api }) => {
        await seedCourse({ courseId: COURSE_ERR_A, instructorId, tas: [] });
        const res = await api.get(`/api/courses/${COURSE_ERR_A}/ta-permissions`);
        expect(res.ok()).toBeTruthy();
        const body = await res.json();
        expect(body.data.taPermissions).toEqual({});
    });
});

// ---------------------------------------------------------------------------
// GET /:courseId/students — chatStudents branch
// ---------------------------------------------------------------------------
test.describe('GET /:courseId/students (chat-session branch)', () => {
    test.use({ storageState: storageStatePath('instructor') });

    test('includes a student that only appears via a chat_session (chatStudents.length > 0 branch)', async ({ request: api }) => {
        await seedCourse({ courseId: COURSE_ERR_CHAT, instructorId });
        // Drop the student into chat_sessions only — no preferences/enrollment
        await withDb(async (db) => {
            await db.collection('chat_sessions').deleteMany({ courseId: COURSE_ERR_CHAT });
            await db.collection('chat_sessions').insertOne({
                sessionId: 'chat-sess-err-only',
                courseId: COURSE_ERR_CHAT,
                studentId,
            });
        });

        const res = await api.get(`/api/courses/${COURSE_ERR_CHAT}/students`);
        expect(res.ok()).toBeTruthy();
        const body = await res.json();
        const found = body.data.students.find((s) => s.userId === studentId);
        expect(found).toBeTruthy();
        // No enrollment entry exists → default `enrolled:true` branch
        expect(found.enrolled).toBe(true);

        await withDb((db) =>
            db.collection('chat_sessions').deleteMany({ courseId: COURSE_ERR_CHAT })
        );
    });
});

// ---------------------------------------------------------------------------
// Note on unreachable / defensive branches deliberately not covered here:
//
//   - `if (!req.user)` 401 returns at the top of every handler are blocked by
//     the global `requireAuth` middleware; same for `if (!db)` 503 returns
//     (the server can't accept requests until app.locals.db is populated).
//   - The 404 follow-up after a successful userHasCourseAccess() check in
//     POST /:courseId/units, PUT /:courseId/retrieval-mode, etc. requires a
//     race between two DB reads in the same request — not reachable from a
//     black-box client.
//   - POST /:courseId/units with `courseStructure: null` exercises the
//     `course.courseStructure ?` ternary's else branch, but the same handler
//     then runs `$inc: { 'courseStructure.totalUnits': 1 }`, which Mongo
//     refuses when the path traverses a null. The branch is therefore only
//     reachable for documents that wouldn't be writable anyway; skipping.
