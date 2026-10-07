// @ts-check
/**
 * API coverage for src/routes/documents.js (42% → target much higher).
 *
 * Focus: validation paths, /text upload happy path, /lecture & /stats queries,
 * /:documentId GET/DELETE, /:documentId/download (instructor+TA, including
 * binary, text, missing payload), /cleanup-orphans, /:documentId/extract-questions
 * validation.
 *
 * Skips: heavy multipart/PDF upload — the parsing path is exercised by the
 * existing instructor-upload UI specs.
 */

const fs = require('fs');
const path = require('path');
const { test, expect, request } = require('./fixtures/monocart');
const { TEST_USERS, storageStatePath } = require('./helpers/users');
const {
    withDb,
    getUserIdByUsername,
    seedCourse,
    cleanupCourses,
    cleanupCoursesForUser,
} = require('./helpers/courses-test');

const COURSE_A = 'BIOC-E2E-API-DOCS-A';
const COURSE_B = 'BIOC-E2E-API-DOCS-B';

let instructorId;
let instructorFreshId;
let taId;

test.beforeAll(async () => {
    instructorId = await getUserIdByUsername(TEST_USERS.instructor.username);
    instructorFreshId = await getUserIdByUsername(TEST_USERS.instructor_fresh.username);
    taId = await getUserIdByUsername(TEST_USERS.ta.username);
});

test.beforeEach(async () => {
    await cleanupCoursesForUser(instructorId);
    await cleanupCoursesForUser(instructorFreshId);
    // Make sure the TA stays a TA between tests
    await withDb((db) =>
        db.collection('users').updateOne(
            { userId: taId },
            { $set: { role: 'ta', isActive: true }, $unset: { invitedCourses: '' } }
        )
    );
    // Wipe any documents tied to our test courses
    await withDb((db) =>
        db.collection('documents').deleteMany({
            courseId: { $in: [COURSE_A, COURSE_B] },
        })
    );
});

test.afterAll(async () => {
    await cleanupCourses([COURSE_A, COURSE_B]);
    await cleanupCoursesForUser(instructorId);
    await cleanupCoursesForUser(instructorFreshId);
});

// ---------------------------------------------------------------------------
// POST /api/documents/text
// ---------------------------------------------------------------------------
test.describe('POST /api/documents/text', () => {
    test.use({ storageState: storageStatePath('instructor') });

    test.beforeEach(async () => {
        await seedCourse({ courseId: COURSE_A, instructorId });
    });

    test('400 when required fields missing', async ({ request: api }) => {
        const res = await api.post('/api/documents/text', {
            data: { courseId: COURSE_A, title: 't' },
        });
        expect(res.status()).toBe(400);
    });

    test('happy path uploads text content and stores doc + linked unit ref', async ({ request: api }) => {
        const res = await api.post('/api/documents/text', {
            data: {
                courseId: COURSE_A,
                lectureName: 'Unit 1',
                documentType: 'lecture-notes',
                instructorId,
                content: 'ATP is the cellular energy currency.',
                title: 'Unit 1 Notes',
                description: 'intro material',
                tags: 'atp, energy, intro',
                learningObjectives: 'Identify energy carriers',
            },
        });
        expect(res.ok()).toBeTruthy();
        const body = await res.json();
        expect(body.success).toBe(true);
        expect(body.data.title).toBe('Unit 1 Notes');
        expect(body.data.documentId).toBeTruthy();

        // Document collection has the record
        const stored = await withDb((db) =>
            db.collection('documents').findOne({ documentId: body.data.documentId })
        );
        expect(stored).toBeTruthy();
        expect(stored.contentType).toBe('text');
        expect(stored.content).toContain('ATP is the cellular energy currency');

        // Unit references it
        const course = await withDb((db) =>
            db.collection('courses').findOne({ courseId: COURSE_A })
        );
        const unit = course.lectures.find((l) => l.name === 'Unit 1');
        expect(unit.documents.some((d) => d.documentId === body.data.documentId)).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// POST /api/documents/upload (multipart)
// Focus: cheap validation branches; full upload is exercised elsewhere.
// ---------------------------------------------------------------------------
test.describe('POST /api/documents/upload', () => {
    test.use({ storageState: storageStatePath('instructor') });

    test('400 when required fields missing (no file)', async ({ request: api }) => {
        const res = await api.post('/api/documents/upload', {
            multipart: {
                courseId: COURSE_A,
            },
        });
        expect(res.status()).toBe(400);
    });

    test('happy path uploads a small text file via multipart', async ({ request: api }) => {
        await seedCourse({ courseId: COURSE_A, instructorId });
        const tmpPath = path.join(require('os').tmpdir(), `biocbot-e2e-${Date.now()}.txt`);
        fs.writeFileSync(tmpPath, 'Cells are the basic unit of life.');
        try {
            const res = await api.post('/api/documents/upload', {
                multipart: {
                    courseId: COURSE_A,
                    lectureName: 'Unit 1',
                    documentType: 'lecture-notes',
                    instructorId,
                    title: 'Cell Basics',
                    description: 'desc',
                    tags: 'cells',
                    learningObjectives: 'Define a cell',
                    file: {
                        name: 'cell-basics.txt',
                        mimeType: 'text/plain',
                        buffer: fs.readFileSync(tmpPath),
                    },
                },
            });
            expect(res.ok()).toBeTruthy();
            const body = await res.json();
            expect(body.data.documentId).toBeTruthy();
        } finally {
            fs.unlinkSync(tmpPath);
        }
    });
});

// ---------------------------------------------------------------------------
// GET /api/documents/lecture
// ---------------------------------------------------------------------------
test.describe('GET /api/documents/lecture', () => {
    test.use({ storageState: storageStatePath('instructor') });

    test('400 when params missing', async ({ request: api }) => {
        const res = await api.get('/api/documents/lecture?courseId=X');
        expect(res.status()).toBe(400);
    });

    test('returns list of stored docs', async ({ request: api }) => {
        await seedCourse({ courseId: COURSE_A, instructorId });
        const now = new Date();
        await withDb((db) =>
            db.collection('documents').insertOne({
                documentId: 'doc-lec-a',
                courseId: COURSE_A,
                lectureName: 'Unit 1',
                documentType: 'lecture-notes',
                contentType: 'text',
                content: 'hello',
                originalName: 'lec.txt',
                filename: 'lec.txt',
                mimeType: 'text/plain',
                size: 5,
                status: 'parsed',
                uploadDate: now,
                lastModified: now,
            })
        );
        const res = await api.get(`/api/documents/lecture?courseId=${COURSE_A}&lectureName=${encodeURIComponent('Unit 1')}`);
        expect(res.ok()).toBeTruthy();
        const body = await res.json();
        expect(body.data.count).toBe(1);
        expect(body.data.documents[0].documentId).toBe('doc-lec-a');
        // fileData should be stripped from the response
        expect(body.data.documents[0].fileData).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// GET /api/documents/stats
//
// PRODUCT BUG: `/stats` is registered AFTER `/:documentId/download` and
// `/:documentId`, so Express matches /:documentId before reaching /stats —
// the handler is unreachable.
// ---------------------------------------------------------------------------
test.describe('GET /api/documents/stats', () => {
    test.use({ storageState: storageStatePath('instructor') });

    test('PRODUCT BUG: /stats is shadowed by /:documentId (route ordering)', async ({ request: api }) => {
        // EXPECTED: 400 from the missing-courseId validation in /stats.
        // Currently /:documentId picks it up (documentId='stats') and returns 404.
        const res = await api.get('/api/documents/stats');
        expect(res.status()).toBe(400);
    });
});

// ---------------------------------------------------------------------------
// GET /api/documents/:documentId
// ---------------------------------------------------------------------------
test.describe('GET /api/documents/:documentId', () => {
    test.use({ storageState: storageStatePath('instructor') });

    test('404 when document does not exist', async ({ request: api }) => {
        const res = await api.get('/api/documents/doc_does_not_exist');
        expect(res.status()).toBe(404);
    });

    test('happy path returns the stored document', async ({ request: api }) => {
        await seedCourse({ courseId: COURSE_A, instructorId });
        const now = new Date();
        await withDb((db) =>
            db.collection('documents').insertOne({
                documentId: 'doc-get-a',
                courseId: COURSE_A,
                lectureName: 'Unit 1',
                documentType: 'lecture-notes',
                contentType: 'text',
                content: 'x',
                originalName: 'x.txt',
                filename: 'x.txt',
                mimeType: 'text/plain',
                size: 1,
                status: 'parsed',
                uploadDate: now,
                lastModified: now,
            })
        );
        const res = await api.get('/api/documents/doc-get-a');
        expect(res.ok()).toBeTruthy();
        const body = await res.json();
        expect(body.data.documentId).toBe('doc-get-a');
    });
});

// ---------------------------------------------------------------------------
// GET /api/documents/:documentId/download
// ---------------------------------------------------------------------------
test.describe('GET /api/documents/:documentId/download', () => {
    test('403 when caller is a student', async ({ baseURL }) => {
        const api = await request.newContext({
            baseURL,
            storageState: storageStatePath('student'),
        });
        try {
            const res = await api.get('/api/documents/anything/download');
            expect(res.status()).toBe(403);
        } finally {
            await api.dispose();
        }
    });

    test.describe('as instructor', () => {
        test.use({ storageState: storageStatePath('instructor') });

        test('404 when document does not exist', async ({ request: api }) => {
            const res = await api.get('/api/documents/missing/download');
            expect(res.status()).toBe(404);
        });

        test('serves text content with attachment headers', async ({ request: api }) => {
            await seedCourse({ courseId: COURSE_A, instructorId });
            const now = new Date();
            await withDb((db) =>
                db.collection('documents').insertOne({
                    documentId: 'doc-dl-text',
                    courseId: COURSE_A,
                    lectureName: 'Unit 1',
                    documentType: 'lecture-notes',
                    contentType: 'text',
                    content: 'Hello from a text doc.',
                    originalName: 'hello.txt',
                    filename: 'hello.txt',
                    mimeType: 'text/plain',
                    size: 22,
                    status: 'parsed',
                    uploadDate: now,
                    lastModified: now,
                })
            );
            const res = await api.get('/api/documents/doc-dl-text/download');
            expect(res.ok()).toBeTruthy();
            const disp = res.headers()['content-disposition'] || '';
            expect(disp.toLowerCase()).toContain('attachment');
            expect(disp).toContain('hello.txt');
            const text = await res.text();
            expect(text).toContain('Hello from a text doc.');
        });

        test('serves a binary file with the stored mime type', async ({ request: api }) => {
            await seedCourse({ courseId: COURSE_A, instructorId });
            const now = new Date();
            const payload = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2D, 0x31, 0x2E, 0x34, 0x0A]);
            await withDb((db) =>
                db.collection('documents').insertOne({
                    documentId: 'doc-dl-bin',
                    courseId: COURSE_A,
                    lectureName: 'Unit 1',
                    documentType: 'lecture-notes',
                    contentType: 'file',
                    fileData: payload,
                    originalName: 'Lecture.pdf',
                    filename: 'Lecture.pdf',
                    mimeType: 'application/pdf',
                    size: payload.length,
                    status: 'parsed',
                    uploadDate: now,
                    lastModified: now,
                })
            );
            const res = await api.get('/api/documents/doc-dl-bin/download');
            expect(res.ok()).toBeTruthy();
            expect(res.headers()['content-type']).toContain('application/pdf');
            const body = await res.body();
            expect(Buffer.compare(body, payload)).toBe(0);
        });

        test('500 when contentType=file but fileData is invalid', async ({ request: api }) => {
            await seedCourse({ courseId: COURSE_A, instructorId });
            const now = new Date();
            await withDb((db) =>
                db.collection('documents').insertOne({
                    documentId: 'doc-dl-broken',
                    courseId: COURSE_A,
                    lectureName: 'Unit 1',
                    documentType: 'lecture-notes',
                    contentType: 'file',
                    fileData: { not: 'buffer' },
                    originalName: 'broken.bin',
                    filename: 'broken.bin',
                    mimeType: 'application/octet-stream',
                    size: 0,
                    status: 'parsed',
                    uploadDate: now,
                    lastModified: now,
                })
            );
            const res = await api.get('/api/documents/doc-dl-broken/download');
            expect(res.status()).toBe(500);
        });

        test('403 when document belongs to a course the instructor cannot access', async ({ request: api }) => {
            await seedCourse({ courseId: COURSE_B, instructorId: instructorFreshId });
            const now = new Date();
            await withDb((db) =>
                db.collection('documents').insertOne({
                    documentId: 'doc-dl-foreign',
                    courseId: COURSE_B,
                    lectureName: 'Unit 1',
                    documentType: 'lecture-notes',
                    contentType: 'text',
                    content: 'secret',
                    originalName: 'secret.txt',
                    filename: 'secret.txt',
                    mimeType: 'text/plain',
                    size: 6,
                    status: 'parsed',
                    uploadDate: now,
                    lastModified: now,
                })
            );
            const res = await api.get('/api/documents/doc-dl-foreign/download');
            expect(res.status()).toBe(403);
        });
    });

    test.describe('as TA', () => {
        test.use({ storageState: storageStatePath('ta') });

        test('403 when TA lacks the materials permission', async ({ request: api }) => {
            await seedCourse({
                courseId: COURSE_A,
                instructorId,
                tas: [taId],
                taPermissions: { [taId]: { materials: false } },
            });
            const now = new Date();
            await withDb((db) =>
                db.collection('documents').insertOne({
                    documentId: 'doc-ta-noperm',
                    courseId: COURSE_A,
                    lectureName: 'Unit 1',
                    documentType: 'lecture-notes',
                    contentType: 'text',
                    content: 'x',
                    originalName: 'x.txt',
                    filename: 'x.txt',
                    mimeType: 'text/plain',
                    size: 1,
                    status: 'parsed',
                    uploadDate: now,
                    lastModified: now,
                })
            );
            const res = await api.get('/api/documents/doc-ta-noperm/download');
            expect(res.status()).toBe(403);
        });

        test('200 when TA has the materials permission', async ({ request: api }) => {
            await seedCourse({
                courseId: COURSE_A,
                instructorId,
                tas: [taId],
                taPermissions: { [taId]: { materials: true } },
            });
            const now = new Date();
            await withDb((db) =>
                db.collection('documents').insertOne({
                    documentId: 'doc-ta-yesperm',
                    courseId: COURSE_A,
                    lectureName: 'Unit 1',
                    documentType: 'lecture-notes',
                    contentType: 'text',
                    content: 'ta-readable',
                    originalName: 'r.txt',
                    filename: 'r.txt',
                    mimeType: 'text/plain',
                    size: 12,
                    status: 'parsed',
                    uploadDate: now,
                    lastModified: now,
                })
            );
            const res = await api.get('/api/documents/doc-ta-yesperm/download');
            expect(res.ok()).toBeTruthy();
            const txt = await res.text();
            expect(txt).toContain('ta-readable');
        });
    });
});

// ---------------------------------------------------------------------------
// DELETE /api/documents/:documentId
// ---------------------------------------------------------------------------
test.describe('DELETE /api/documents/:documentId', () => {
    test.use({ storageState: storageStatePath('instructor') });

    test('400 when instructorId missing', async ({ request: api }) => {
        const res = await api.delete('/api/documents/doc-anything', { data: {} });
        expect(res.status()).toBe(400);
    });

    test('404 when document not found', async ({ request: api }) => {
        const res = await api.delete('/api/documents/doc-missing', {
            data: { instructorId },
        });
        expect(res.status()).toBe(404);
    });

    test('403 when caller is not an instructor on the course', async ({ request: api }) => {
        await seedCourse({ courseId: COURSE_B, instructorId: instructorFreshId });
        const now = new Date();
        await withDb((db) =>
            db.collection('documents').insertOne({
                documentId: 'doc-del-foreign',
                courseId: COURSE_B,
                lectureName: 'Unit 1',
                documentType: 'lecture-notes',
                contentType: 'text',
                content: 'x',
                originalName: 'x.txt',
                filename: 'x.txt',
                mimeType: 'text/plain',
                size: 1,
                status: 'parsed',
                uploadDate: now,
                lastModified: now,
            })
        );
        const res = await api.delete('/api/documents/doc-del-foreign', {
            data: { instructorId },
        });
        expect(res.status()).toBe(403);
    });

    test('happy path deletes the document and removes unit references', async ({ request: api }) => {
        await seedCourse({
            courseId: COURSE_A,
            instructorId,
            lectures: [
                {
                    name: 'Unit 1',
                    isPublished: false,
                    learningObjectives: [],
                    passThreshold: 2,
                    documents: [{ documentId: 'doc-del-mine', filename: 'mine.txt' }],
                    assessmentQuestions: [],
                },
            ],
        });
        const now = new Date();
        await withDb((db) =>
            db.collection('documents').insertOne({
                documentId: 'doc-del-mine',
                courseId: COURSE_A,
                lectureName: 'Unit 1',
                documentType: 'lecture-notes',
                contentType: 'text',
                content: 'x',
                originalName: 'mine.txt',
                filename: 'mine.txt',
                mimeType: 'text/plain',
                size: 1,
                status: 'parsed',
                uploadDate: now,
                lastModified: now,
            })
        );
        const res = await api.delete('/api/documents/doc-del-mine', {
            data: { instructorId },
        });
        expect(res.ok()).toBeTruthy();
        // Document removed
        const stillThere = await withDb((db) =>
            db.collection('documents').findOne({ documentId: 'doc-del-mine' })
        );
        expect(stillThere).toBeFalsy();
        // Unit ref pulled
        const course = await withDb((db) =>
            db.collection('courses').findOne({ courseId: COURSE_A })
        );
        const unit = course.lectures.find((l) => l.name === 'Unit 1');
        expect(unit.documents.find((d) => d.documentId === 'doc-del-mine')).toBeFalsy();
    });
});

// ---------------------------------------------------------------------------
// POST /api/documents/cleanup-orphans
// ---------------------------------------------------------------------------
test.describe('POST /api/documents/cleanup-orphans', () => {
    test.use({ storageState: storageStatePath('instructor') });

    test('400 when fields missing', async ({ request: api }) => {
        const res = await api.post('/api/documents/cleanup-orphans', {
            data: { courseId: COURSE_A },
        });
        expect(res.status()).toBe(400);
    });

    test('404 when course does not exist', async ({ request: api }) => {
        const res = await api.post('/api/documents/cleanup-orphans', {
            data: { courseId: 'BIOC-E2E-API-NOPE', instructorId },
        });
        expect(res.status()).toBe(404);
    });

    test('removes orphaned document references and reports the count', async ({ request: api }) => {
        // Seed a course whose units reference docs that don't exist in the
        // documents collection. The cleanup should remove those references.
        await seedCourse({
            courseId: COURSE_A,
            instructorId,
            lectures: [
                {
                    name: 'Unit 1',
                    isPublished: false,
                    learningObjectives: [],
                    passThreshold: 2,
                    documents: [
                        { documentId: 'doc-real', filename: 'r.txt' },
                        { documentId: 'doc-ghost-1', filename: 'g1.txt' },
                        { documentId: 'doc-ghost-2', filename: 'g2.txt' },
                    ],
                    assessmentQuestions: [],
                },
            ],
        });
        const now = new Date();
        await withDb((db) =>
            db.collection('documents').insertOne({
                documentId: 'doc-real',
                courseId: COURSE_A,
                lectureName: 'Unit 1',
                documentType: 'lecture-notes',
                contentType: 'text',
                content: 'x',
                originalName: 'r.txt',
                filename: 'r.txt',
                mimeType: 'text/plain',
                size: 1,
                status: 'parsed',
                uploadDate: now,
                lastModified: now,
            })
        );

        const res = await api.post('/api/documents/cleanup-orphans', {
            data: { courseId: COURSE_A, instructorId },
        });
        expect(res.ok()).toBeTruthy();
        const body = await res.json();
        expect(body.data.totalOrphans).toBe(2);
        expect(body.data.cleanedUnits).toBe(1);

        const course = await withDb((db) =>
            db.collection('courses').findOne({ courseId: COURSE_A })
        );
        const unit = course.lectures.find((l) => l.name === 'Unit 1');
        expect(unit.documents.map((d) => d.documentId)).toEqual(['doc-real']);
    });
});

// ---------------------------------------------------------------------------
// POST /api/documents/:documentId/extract-questions
// Drive validation branches (the LLM-heavy success path is exercised
// indirectly elsewhere).
// ---------------------------------------------------------------------------
test.describe('POST /api/documents/:documentId/extract-questions', () => {
    test.use({ storageState: storageStatePath('instructor') });

    test('404 when document does not exist', async ({ request: api }) => {
        const res = await api.post('/api/documents/doc-missing/extract-questions', { data: {} });
        expect(res.status()).toBe(404);
    });

    test('400 when document has no text content', async ({ request: api }) => {
        await seedCourse({ courseId: COURSE_A, instructorId });
        const now = new Date();
        await withDb((db) =>
            db.collection('documents').insertOne({
                documentId: 'doc-empty',
                courseId: COURSE_A,
                lectureName: 'Unit 1',
                documentType: 'practice-quiz',
                contentType: 'text',
                content: '',
                originalName: 'empty.txt',
                filename: 'empty.txt',
                mimeType: 'text/plain',
                size: 0,
                status: 'parsed',
                uploadDate: now,
                lastModified: now,
            })
        );
        const res = await api.post('/api/documents/doc-empty/extract-questions', { data: {} });
        expect(res.status()).toBe(400);
    });
});
