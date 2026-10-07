/**
 * In-process route tests for src/routes/documents.js (supertest).
 * Document/Course models are real over memory-db. Parsing, GridFS, tokenization,
 * and course AI resolution are isolated because they are external integrations.
 */
jest.mock('js-tiktoken', () => ({
    encodingForModel: jest.fn(() => ({ encode: (text) => Array.from(String(text)) })),
}));
jest.mock('ubc-genai-toolkit-document-parsing', () => ({ DocumentParsingModule: jest.fn() }));
jest.mock('ubc-genai-toolkit-core', () => ({ ConsoleLogger: jest.fn() }));
jest.mock('../../../src/services/gridfs', () => ({
    deleteFile: jest.fn(async () => undefined),
    openDownloadStream: jest.fn(),
    uploadBuffer: jest.fn(async () => 'grid-file-1'),
}));
// Deleting a document must sweep EVERY embedding profile's collection, so the
// route uses maintenance clients rather than the course's active Qdrant service.
const mockDeleteEverywhere = jest.fn(async () => ({
    deleted: [{ collection: 'biocbot_documents', profileKey: 'openai:text-embedding-3-small:v1', result: { success: true, deletedCount: 2 } }],
    errors: [],
}));
jest.mock('../../../src/services/qdrantMaintenance', () => ({
    deleteDocumentEverywhere: (...args) => mockDeleteEverywhere(...args),
    createMaintenanceFactory: jest.fn(() => jest.fn()),
}));
jest.mock('../../../src/routes/llmKeyMiddleware', () => ({
    resolveCourseAi: jest.fn(async () => ({
        llm: { sendMessage: jest.fn() },
        qdrant: {
            client: {},
            processAndStoreDocument: jest.fn(async () => ({ success: true, chunksStored: 3 })),
            deleteDocumentChunks: jest.fn(async () => ({ success: true, deletedCount: 2 })),
        },
    })),
    sendLlmKeyError: jest.fn(() => false),
}));

const { Readable } = require('stream');
const fs = require('fs');
const { memoryDb } = require('../helpers/memory-db');
const { makeRouteApp, request } = require('../helpers/route-app');
const { resolveCourseAi } = require('../../../src/routes/llmKeyMiddleware');
const { DocumentParsingModule } = require('ubc-genai-toolkit-document-parsing');
const gridfs = require('../../../src/services/gridfs');
const documentsRouter = require('../../../src/routes/documents');

const instructor = { userId: 'i1', role: 'instructor' };
const otherInstructor = { userId: 'i2', role: 'instructor' };
const student = { userId: 's1', role: 'student' };
const ta = { userId: 't1', role: 'ta' };
const app = (opts) => makeRouteApp(documentsRouter, opts);

function documentsDb({ documents, course = {} } = {}) {
    return memoryDb({
        courses: [{
            courseId: 'C1', instructorId: 'i1', tas: ['t1'],
            lectures: [{ name: 'Unit 1', documents: [] }],
            // Default TA (t1) is granted 'materials' - the permission that
            // gates every route in this file - since most tests here exist
            // to prove an assigned TA succeeds. Tests exercising denial pass
            // their own `course.taPermissions` override, which fully
            // replaces this default (object spread, not a deep merge).
            taPermissions: { t1: { materials: true } },
            ...course,
        }],
        documents: documents || [{
            documentId: 'd1', courseId: 'C1', lectureName: 'Unit 1',
            instructorId: 'i1', documentType: 'lecture-notes', type: 'lecture_notes',
            contentType: 'text', originalName: 'Notes', filename: 'Notes.txt',
            content: 'cell membrane', mimeType: 'text/plain', size: 13, status: 'uploaded',
            fileData: { data: [1, 2, 3] },
        }],
    });
}

beforeAll(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterAll(() => jest.restoreAllMocks());

describe('POST /upload — multipart document upload', () => {
    function upload(req, fields = {}) {
        let chain = req
            .field('courseId', fields.courseId || 'C1')
            .field('lectureName', fields.lectureName || 'Unit 1')
            .field('documentType', fields.documentType || 'lecture-notes')
            .field('instructorId', fields.instructorId || 'i1');
        if (fields.title) chain = chain.field('title', fields.title);
        return chain.attach('file', Buffer.from(fields.content || 'ATP is cellular energy.'), {
            filename: fields.filename || 'notes.txt',
            contentType: fields.contentType || 'text/plain',
        });
    }

    test('requires authentication and matching instructor identity', async () => {
        expect((await upload(request(app({ db: documentsDb() })).post('/upload'))).status).toBe(401);
        expect((await upload(request(app({ db: documentsDb(), user: otherInstructor })).post('/upload'))).status).toBe(403);
    });

    test('stores text files in mocked GridFS, Mongo, course structure, and mocked Qdrant', async () => {
        const db = documentsDb({ documents: [] });
        const res = await upload(request(app({ db, user: instructor })).post('/upload'), { title: 'Lecture Notes - Unit 1', content: 'ATP synthesis uses a gradient.' });
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({ filename: 'Lecture Notes - Unit 1', linkedToCourse: true, qdrantProcessed: true, chunksStored: 3 });
        expect(gridfs.uploadBuffer).toHaveBeenCalledWith(db, expect.any(Buffer), 'notes.txt', expect.objectContaining({ contentType: 'text/plain' }));
        const stored = await db.collection('documents').findOne({ documentId: res.body.data.documentId });
        expect(stored).toMatchObject({ fileId: 'grid-file-1', contentType: 'file', content: 'ATP synthesis uses a gradient.' });
    });

    test('accepts an assigned TA but stores the owning instructor ID', async () => {
        const db = documentsDb({ documents: [] });
        const res = await upload(request(app({ db, user: ta })).post('/upload'), { instructorId: 'i1' });
        expect(res.status).toBe(200);
        const stored = await db.collection('documents').findOne({ documentId: res.body.data.documentId });
        expect(stored.instructorId).toBe('i1');
    });
});

describe('POST /text', () => {
    const payload = {
        courseId: 'C1', lectureName: 'Unit 1', documentType: 'lecture-notes',
        instructorId: 'i1', content: 'A membrane surrounds the cell.', title: 'Cell notes',
        tags: 'cells, membranes', learningObjectives: 'Identify cells, Explain membranes',
    };

    test('400 when required fields are missing and 503 without db', async () => {
        expect((await request(app({ db: documentsDb(), user: instructor })).post('/text').send({})).status).toBe(400);
        expect((await request(app({ db: null, user: instructor })).post('/text').send(payload)).status).toBe(503);
    });

    test('401 without authentication and 403 for a student', async () => {
        expect((await request(app({ db: documentsDb() })).post('/text').send(payload)).status).toBe(401);
        expect((await request(app({ db: documentsDb(), user: student })).post('/text').send(payload)).status).toBe(403);
    });

    test('403 when an instructor submits another instructorId', async () => {
        const res = await request(app({ db: documentsDb(), user: otherInstructor })).post('/text').send(payload);
        expect(res.status).toBe(403);
    });

    test('stores text metadata and reports vector processing', async () => {
        const db = documentsDb({ documents: [] });
        const res = await request(app({ db, user: instructor })).post('/text').send(payload);
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({
            title: 'Cell notes', linkedToCourse: true, qdrantProcessed: true, chunksStored: 3,
        });
        const stored = await db.collection('documents').findOne({ documentId: res.body.data.documentId });
        expect(stored).toMatchObject({
            courseId: 'C1', lectureName: 'Unit 1', instructorId: 'i1',
            contentType: 'text', type: 'lecture_notes', status: 'uploaded',
            metadata: {
                tags: ['cells', 'membranes'],
                learningObjectives: ['Identify cells', 'Explain membranes'],
            },
        });
    });
});

describe('GET /lecture', () => {
    test('400 when parameters are missing', async () => {
        expect((await request(app({ db: documentsDb(), user: instructor })).get('/lecture?courseId=C1')).status).toBe(400);
    });

    test('401 without authentication and 403 for a student', async () => {
        const path = '/lecture?courseId=C1&lectureName=Unit%201';
        expect((await request(app({ db: documentsDb() })).get(path)).status).toBe(401);
        expect((await request(app({ db: documentsDb(), user: student })).get(path)).status).toBe(403);
    });

    test('returns lecture documents without binary fileData', async () => {
        const res = await request(app({ db: documentsDb(), user: instructor }))
            .get('/lecture?courseId=C1&lectureName=Unit%201');
        expect(res.status).toBe(200);
        expect(res.body.data.count).toBe(1);
        expect(res.body.data.documents[0]).toMatchObject({ documentId: 'd1', content: 'cell membrane' });
        expect(res.body.data.documents[0]).not.toHaveProperty('fileData');
    });

    test('allows an assigned TA with course permission', async () => {
        const res = await request(app({ db: documentsDb(), user: ta }))
            .get('/lecture?courseId=C1&lectureName=Unit%201');
        expect(res.status).toBe(200);
    });
});

describe('GET /stats', () => {
    test('400 without courseId and 403 for an unrelated instructor', async () => {
        expect((await request(app({ db: documentsDb(), user: instructor })).get('/stats')).status).toBe(400);
        expect((await request(app({ db: documentsDb(), user: otherInstructor })).get('/stats?courseId=C1')).status).toBe(403);
    });

    test('returns aggregate counts and sizes for an authorized instructor', async () => {
        const db = documentsDb({ documents: [
            { documentId: 'd1', courseId: 'C1', status: 'uploaded', size: 10 },
            { documentId: 'd2', courseId: 'C1', status: 'uploaded', size: 5 },
            { documentId: 'd3', courseId: 'C1', status: 'parsed', size: 20 },
            { documentId: 'other', courseId: 'C2', status: 'parsed', size: 99 },
        ] });
        const res = await request(app({ db, user: instructor })).get('/stats?courseId=C1');
        expect(res.status).toBe(200);
        expect(res.body.data.stats).toMatchObject({ totalDocuments: 3, totalSize: 35 });
        expect(res.body.data.stats.statusBreakdown).toEqual(expect.arrayContaining([
            { status: 'uploaded', count: 2 }, { status: 'parsed', count: 1 },
        ]));
    });
});

describe('GET /:documentId and /:documentId/download', () => {
    test('404 for an unknown document', async () => {
        expect((await request(app({ db: documentsDb(), user: instructor })).get('/missing')).status).toBe(404);
    });

    test('403 when the user cannot manage the owning course', async () => {
        expect((await request(app({ db: documentsDb(), user: otherInstructor })).get('/d1')).status).toBe(403);
    });

    test('returns document metadata to the course instructor', async () => {
        const res = await request(app({ db: documentsDb(), user: instructor })).get('/d1');
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({ documentId: 'd1', courseId: 'C1', originalName: 'Notes' });
    });

    test('download rejects students and unrelated instructors', async () => {
        expect((await request(app({ db: documentsDb(), user: student })).get('/d1/download')).status).toBe(403);
        expect((await request(app({ db: documentsDb(), user: otherInstructor })).get('/d1/download')).status).toBe(403);
    });

    test('downloads text with a safe attachment filename', async () => {
        const db = documentsDb({ documents: [{
            documentId: 'd1', courseId: 'C1', contentType: 'text',
            originalName: '../Notes', content: 'cell membrane', mimeType: 'text/plain',
        }] });
        const res = await request(app({ db, user: instructor })).get('/d1/download');
        expect(res.status).toBe(200);
        expect(res.text).toBe('cell membrane');
        expect(res.headers['content-disposition']).toContain('filename="Notes.txt"');
    });

    test('returns 500 for malformed inline file data', async () => {
        const db = documentsDb({ documents: [{
            documentId: 'd1', courseId: 'C1', contentType: 'file',
            originalName: 'slides.pdf', mimeType: 'application/pdf', fileData: { nope: true },
        }] });
        const res = await request(app({ db, user: instructor })).get('/d1/download');
        expect(res.status).toBe(500);
        expect(res.body.message).toBe('Stored file data is invalid');
    });
});

describe('DELETE /:documentId', () => {
    test('400 without instructorId and 404 for a missing document', async () => {
        expect((await request(app({ db: documentsDb(), user: instructor })).delete('/d1').send({})).status).toBe(400);
        expect((await request(app({ db: documentsDb(), user: instructor })).delete('/missing').send({ instructorId: 'i1' })).status).toBe(404);
    });

    test('deletes the document and reports vector cleanup', async () => {
        const db = documentsDb();
        const res = await request(app({ db, user: instructor })).delete('/d1').send({ instructorId: 'i1' });
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({
            documentId: 'd1', deletedCount: 1, removedFromCourse: true,
            removedFromQdrant: true, qdrantChunksDeleted: 2,
        });
        expect(await db.collection('documents').findOne({ documentId: 'd1' })).toBeNull();
    });

    test('deletes the GridFS backing file when fileId is present', async () => {
        const db = documentsDb({ documents: [{
            documentId: 'd1', courseId: 'C1', contentType: 'file', fileId: 'grid-1',
        }] });
        const res = await request(app({ db, user: instructor })).delete('/d1').send({ instructorId: 'i1' });
        expect(res.status).toBe(200);
        expect(gridfs.deleteFile).toHaveBeenCalledWith(db, 'grid-1');
    });
});

describe('POST /:documentId/extract-questions', () => {
    test('404 for an unknown document and 400 when it has no text', async () => {
        expect((await request(app({ db: documentsDb(), user: instructor })).post('/missing/extract-questions')).status).toBe(404);

        const db = documentsDb({ documents: [{ documentId: 'd1', courseId: 'C1', content: '' }] });
        const res = await request(app({ db, user: instructor })).post('/d1/extract-questions');
        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/No text content/);
        expect(resolveCourseAi).toHaveBeenCalled();
    });

    test('requires authentication and course authorization before invoking the LLM', async () => {
        expect((await request(app({ db: documentsDb() })).post('/d1/extract-questions')).status).toBe(401);
        expect((await request(app({ db: documentsDb(), user: otherInstructor })).post('/d1/extract-questions')).status).toBe(403);
        expect(resolveCourseAi).not.toHaveBeenCalled();
    });
});

describe('POST /cleanup-orphans', () => {
    test('validates fields, DB, course, and ownership', async () => {
        expect((await request(app({ db: documentsDb(), user: instructor })).post('/cleanup-orphans').send({})).status).toBe(400);
        expect((await request(app({ db: null, user: instructor })).post('/cleanup-orphans').send({ courseId: 'C1', instructorId: 'i1' })).status).toBe(503);
        expect((await request(app({ db: memoryDb({ courses: [] }), user: instructor })).post('/cleanup-orphans').send({ courseId: 'C1', instructorId: 'i1' })).status).toBe(404);
        expect((await request(app({ db: documentsDb(), user: otherInstructor })).post('/cleanup-orphans').send({ courseId: 'C1', instructorId: 'i1' })).status).toBe(403);
    });

    test('removes missing references while preserving real documents', async () => {
        const db = documentsDb({
            documents: [{ documentId: 'valid', courseId: 'C1' }],
            course: { lectures: [{ name: 'Unit 1', documents: [{ documentId: 'valid' }, { documentId: 'missing' }] }] },
        });
        const res = await request(app({ db, user: instructor })).post('/cleanup-orphans').send({ courseId: 'C1', instructorId: 'i1' });
        expect(res.status).toBe(200);
        expect(res.body.data).toEqual({ totalOrphans: 1, cleanedUnits: 1 });
    });
});

describe('question extraction with mocked LLM and vector chunks', () => {
    test('normalizes mocked multiple-choice and true-false responses', async () => {
        const sendMessage = jest.fn(async () => ({ content: `Here is JSON: {"questions":[
            {"questionType":"multiple-choice","question":"ATP?","options":{"one":"ATP","two":"DNA"},"correctAnswer":" b ","explanation":"E"},
            {"questionType":"true-false","question":"Cells?","correctAnswer":"t","explanation":"E"}
        ]}` }));
        resolveCourseAi.mockResolvedValueOnce({ llm: { sendMessage }, qdrant: {} });
        const res = await request(app({ db: documentsDb(), user: instructor })).post('/d1/extract-questions');
        expect(res.status).toBe(200);
        expect(res.body.data.totalFound).toBe(2);
        expect(res.body.data.questions[0]).toMatchObject({ options: { A: 'ATP', B: 'DNA' }, correctAnswer: 'B', hasAnswer: true });
        expect(res.body.data.questions[1].correctAnswer).toBe('True');
    });

    test('uses mocked Qdrant chunks for oversized content and batches LLM calls', async () => {
        const longContent = 'x'.repeat(32001);
        const db = documentsDb({ documents: [{ documentId: 'd1', courseId: 'C1', lectureName: 'Unit 1', content: longContent }] });
        const sendMessage = jest.fn(async () => ({ content: '{"questions":[{"questionType":"short-answer","question":"Q?","correctAnswer":"A"}]}' }));
        const getDocumentChunks = jest.fn(async () => ['chunk one', 'chunk two']);
        resolveCourseAi.mockResolvedValueOnce({ llm: { sendMessage }, qdrant: { getDocumentChunks } });
        const res = await request(app({ db, user: instructor })).post('/d1/extract-questions');
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({ wasChunked: true, totalFound: 1 });
        expect(getDocumentChunks).toHaveBeenCalledWith('d1');
    });

    test('reports missing or failed chunks for oversized content', async () => {
        const db = documentsDb({ documents: [{ documentId: 'd1', courseId: 'C1', content: 'x'.repeat(32001) }] });
        resolveCourseAi.mockResolvedValueOnce({ llm: {}, qdrant: { getDocumentChunks: jest.fn(async () => []) } });
        expect((await request(app({ db, user: instructor })).post('/d1/extract-questions')).status).toBe(400);
        resolveCourseAi.mockResolvedValueOnce({ llm: {}, qdrant: { getDocumentChunks: jest.fn(async () => { throw new Error('mock vector failure'); }) } });
        expect((await request(app({ db, user: instructor })).post('/d1/extract-questions')).status).toBe(400);
    });

    test('true-false "false" answers normalize to "False"', async () => {
        const sendMessage = jest.fn(async () => ({ content: '{"questions":[{"questionType":"true-false","question":"Q?","correctAnswer":"f","explanation":"E"}]}' }));
        resolveCourseAi.mockResolvedValueOnce({ llm: { sendMessage }, qdrant: {} });
        const res = await request(app({ db: documentsDb(), user: instructor })).post('/d1/extract-questions');
        expect(res.body.data.questions[0].correctAnswer).toBe('False');
    });

    test('503 without a db and surfaces an LlmKeyError from extraction as the mapped status', async () => {
        expect((await request(app({ db: null, user: instructor })).post('/d1/extract-questions')).status).toBe(503);

        const { sendLlmKeyError } = require('../../../src/routes/llmKeyMiddleware');
        sendLlmKeyError.mockImplementationOnce((res) => { res.status(402).json({ success: false, code: 'invalid' }); return true; });
        resolveCourseAi.mockResolvedValueOnce({ llm: { sendMessage: jest.fn(async () => { throw new Error('boom'); }) }, qdrant: {} });
        const res = await request(app({ db: documentsDb(), user: instructor })).post('/d1/extract-questions');
        expect(res.status).toBe(402);
        sendLlmKeyError.mockReturnValue(false);
    });
});

describe('POST /upload — binary parse, slides, and image description', () => {
    // The parser, fs temp-file IO, and tokenizer are external; only the route's
    // orchestration of them is under test. Keep fs side-effect-free.
    let writeSpy;
    let unlinkSpy;
    beforeEach(() => {
        writeSpy = jest.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
        unlinkSpy = jest.spyOn(fs, 'unlinkSync').mockImplementation(() => {});
        DocumentParsingModule.mockImplementation((config) => ({
            __config: config,
            parse: async () => ({ content: 'Extracted PDF text about ATP.' }),
        }));
    });
    afterEach(() => { writeSpy.mockRestore(); unlinkSpy.mockRestore(); });

    function uploadBinary(req, fields = {}) {
        return req
            .field('courseId', fields.courseId || 'C1')
            .field('lectureName', fields.lectureName || 'Unit 1')
            .field('documentType', fields.documentType || 'lecture-notes')
            .field('instructorId', fields.instructorId || 'i1')
            .attach('file', Buffer.from('%PDF-1.4 binary'), {
                filename: fields.filename || 'slides.pdf',
                contentType: fields.contentType || 'application/pdf',
            });
    }

    test('parses a PDF via the toolkit, writes/cleans a temp file, and stores the text', async () => {
        const db = documentsDb({ documents: [] });
        const res = await uploadBinary(request(app({ db, user: instructor })).post('/upload'));
        expect(res.status).toBe(200);
        expect(writeSpy).toHaveBeenCalled();
        expect(unlinkSpy).toHaveBeenCalled();
        const stored = await db.collection('documents').findOne({ documentId: res.body.data.documentId });
        expect(stored.content).toBe('Extracted PDF text about ATP.');
    });

    test('a parse failure is swallowed and the document is still stored without text', async () => {
        DocumentParsingModule.mockImplementation(() => ({ parse: async () => ({ content: '' }) }));
        const db = documentsDb({ documents: [] });
        const res = await uploadBinary(request(app({ db, user: instructor })).post('/upload'));
        expect(res.status).toBe(200);
        expect(res.body.data.qdrantProcessed).toBe(false);
        const stored = await db.collection('documents').findOne({ documentId: res.body.data.documentId });
        expect(stored.content).toBe('');
    });

    test('a temp-file cleanup error is swallowed', async () => {
        unlinkSpy.mockImplementation(() => { throw new Error('cleanup failed'); });
        const db = documentsDb({ documents: [] });
        const res = await uploadBinary(request(app({ db, user: instructor })).post('/upload'));
        expect(res.status).toBe(200);
    });

    test('a PPTX upload stores slide chunks through the mocked vector store', async () => {
        const generateEmbeddings = jest.fn(async (chunks) => chunks.map(() => [0.1, 0.2]));
        const storeChunks = jest.fn(async (_d, chunks) => chunks.map((c, i) => ({ id: i })));
        resolveCourseAi.mockResolvedValueOnce({
            llm: { isReady: () => true, describeImage: jest.fn(async () => 'a chart') },
            qdrant: { client: {}, generateEmbeddings, storeChunks },
        });
        DocumentParsingModule.mockImplementation((config) => ({
            parse: async () => {
                await config.onSlide({ text: 'Slide one text', slideNumber: 1, describedImageCount: 1 });
                await config.onSlide({ text: '   ', slideNumber: 2 }); // blank slide ignored
                return { content: 'full deck text' };
            },
        }));
        const db = documentsDb({ documents: [] });
        const res = await request(app({ db, user: instructor })).post('/upload')
            .field('courseId', 'C1').field('lectureName', 'Unit 1')
            .field('documentType', 'lecture-notes').field('instructorId', 'i1')
            .attach('file', Buffer.from('PPTX'), { filename: 'deck.pptx', contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' });
        expect(res.status).toBe(200);
        expect(generateEmbeddings).toHaveBeenCalledWith(['Slide one text']);
        expect(storeChunks).toHaveBeenCalled();
        expect(res.body.data.chunksStored).toBe(1);
    });

    test('imageDescriber returns a description when the LLM is ready, and null otherwise', async () => {
        const describeImage = jest.fn(async () => 'a labelled diagram');
        let capturedConfig;
        DocumentParsingModule.mockImplementation((config) => { capturedConfig = config; return { parse: async () => ({ content: 'x' }) }; });
        resolveCourseAi.mockResolvedValueOnce({
            llm: { isReady: () => true, describeImage },
            qdrant: { client: {}, processAndStoreDocument: jest.fn(async () => ({ success: true, chunksStored: 1 })) },
        });
        await uploadBinary(request(app({ db: documentsDb({ documents: [] }), user: instructor })).post('/upload'));

        // Drive the captured hook directly across its branches.
        await expect(capturedConfig.imageDescriber({ data: 'b', mimeType: 'image/png', slideNumber: 3 })).resolves.toBe('a labelled diagram');
        expect(describeImage).toHaveBeenCalledWith('b', 'image/png', { slideNumber: 3 });
    });

    test('imageDescriber returns null when the LLM is not ready', async () => {
        let capturedConfig;
        DocumentParsingModule.mockImplementation((config) => { capturedConfig = config; return { parse: async () => ({ content: 'x' }) }; });
        const describeImage = jest.fn();
        resolveCourseAi.mockResolvedValueOnce({
            llm: { isReady: () => false, describeImage },
            qdrant: { client: {}, processAndStoreDocument: jest.fn(async () => ({ success: true, chunksStored: 1 })) },
        });
        await uploadBinary(request(app({ db: documentsDb({ documents: [] }), user: instructor })).post('/upload'));
        await expect(capturedConfig.imageDescriber({ data: 'b', mimeType: 'image/png', slideNumber: 1 })).resolves.toBeNull();
        expect(describeImage).not.toHaveBeenCalled();
    });

    test('imageDescriber swallows a generic describe error but rethrows an LlmKeyError', async () => {
        let capturedConfig;
        const describeImage = jest.fn();
        DocumentParsingModule.mockImplementation((config) => { capturedConfig = config; return { parse: async () => ({ content: 'x' }) }; });
        resolveCourseAi.mockResolvedValueOnce({
            llm: { isReady: () => true, describeImage },
            qdrant: { client: {}, processAndStoreDocument: jest.fn(async () => ({ success: true, chunksStored: 1 })) },
        });
        await uploadBinary(request(app({ db: documentsDb({ documents: [] }), user: instructor })).post('/upload'));

        describeImage.mockRejectedValueOnce(new Error('vision down'));
        await expect(capturedConfig.imageDescriber({ data: 'b', mimeType: 'image/png', slideNumber: 1 })).resolves.toBeNull();

        const keyErr = Object.assign(new Error('bad key'), { name: 'LlmKeyError' });
        describeImage.mockRejectedValueOnce(keyErr);
        await expect(capturedConfig.imageDescriber({ data: 'b', mimeType: 'image/png', slideNumber: 1 })).rejects.toBe(keyErr);
    });

});

describe('upload/text — metadata, link warnings, qdrant failures, and catches', () => {
    test('upload parses comma-separated tags and learning objectives', async () => {
        const db = documentsDb({ documents: [] });
        const res = await request(app({ db, user: instructor })).post('/upload')
            .field('courseId', 'C1').field('lectureName', 'Unit 1')
            .field('documentType', 'lecture-notes').field('instructorId', 'i1')
            .field('tags', 'a, b').field('learningObjectives', 'lo1, lo2')
            .attach('file', Buffer.from('text body'), { filename: 'n.txt', contentType: 'text/plain' });
        expect(res.status).toBe(200);
        const stored = await db.collection('documents').findOne({ documentId: res.body.data.documentId });
        expect(stored.metadata).toMatchObject({ tags: ['a', 'b'], learningObjectives: ['lo1', 'lo2'] });
    });

    test('upload warns but succeeds when the lecture link fails, and reports qdrant failure', async () => {
        resolveCourseAi.mockResolvedValueOnce({
            llm: { isReady: () => false },
            qdrant: { client: {}, processAndStoreDocument: jest.fn(async () => ({ success: false, error: 'vector boom' })) },
        });
        const db = documentsDb({ documents: [], course: { lectures: [{ name: 'Unit 1', documents: [] }] } });
        const res = await request(app({ db, user: instructor })).post('/upload')
            .field('courseId', 'C1').field('lectureName', 'Nonexistent Unit')
            .field('documentType', 'lecture-notes').field('instructorId', 'i1')
            .attach('file', Buffer.from('text body'), { filename: 'n.txt', contentType: 'text/plain' });
        expect(res.status).toBe(200);
        expect(res.body.data.linkedToCourse).toBe(false);
        expect(res.body.data.qdrantProcessed).toBe(false);
    });

    test('upload rethrows an LlmKeyError raised during qdrant processing and maps it', async () => {
        const { sendLlmKeyError } = require('../../../src/routes/llmKeyMiddleware');
        sendLlmKeyError.mockImplementationOnce((res) => { res.status(402).json({ success: false }); return true; });
        resolveCourseAi.mockResolvedValueOnce({
            llm: { isReady: () => false },
            qdrant: { client: {}, processAndStoreDocument: jest.fn(async () => { throw Object.assign(new Error('k'), { name: 'LlmKeyError' }); }) },
        });
        const res = await request(app({ db: documentsDb({ documents: [] }), user: instructor })).post('/upload')
            .field('courseId', 'C1').field('lectureName', 'Unit 1')
            .field('documentType', 'lecture-notes').field('instructorId', 'i1')
            .attach('file', Buffer.from('text body'), { filename: 'n.txt', contentType: 'text/plain' });
        expect(res.status).toBe(402);
    });

    test('upload returns 500 when GridFS storage throws', async () => {
        gridfs.uploadBuffer.mockRejectedValueOnce(new Error('gridfs down'));
        const res = await request(app({ db: documentsDb({ documents: [] }), user: instructor })).post('/upload')
            .field('courseId', 'C1').field('lectureName', 'Unit 1')
            .field('documentType', 'lecture-notes').field('instructorId', 'i1')
            .attach('file', Buffer.from('text body'), { filename: 'n.txt', contentType: 'text/plain' });
        expect(res.status).toBe(500);
        expect(res.body.message).toMatch(/Internal server error/);
    });

    test('text reports a failed lecture link and a failed qdrant result', async () => {
        resolveCourseAi.mockResolvedValueOnce({ llm: {}, qdrant: { processAndStoreDocument: jest.fn(async () => ({ success: false, error: 'x' })) } });
        const db = documentsDb({ documents: [] });
        const res = await request(app({ db, user: instructor })).post('/text').send({
            courseId: 'C1', lectureName: 'Missing Unit', documentType: 'lecture-notes',
            instructorId: 'i1', content: 'body', title: 'T',
        });
        expect(res.status).toBe(200);
        expect(res.body.data.linkedToCourse).toBe(false);
        expect(res.body.data.qdrantProcessed).toBe(false);
    });

    test('text returns 500 when the model upload throws', async () => {
        jest.spyOn(require('../../../src/models/Document'), 'uploadDocument').mockRejectedValueOnce(new Error('mongo down'));
        const res = await request(app({ db: documentsDb({ documents: [] }), user: instructor })).post('/text').send({
            courseId: 'C1', lectureName: 'Unit 1', documentType: 'lecture-notes',
            instructorId: 'i1', content: 'body', title: 'T',
        });
        expect(res.status).toBe(500);
    });
});

describe('GET handlers — db guards and catches', () => {
    test('lecture and stats return 503 without a db', async () => {
        expect((await request(app({ db: null, user: instructor })).get('/lecture?courseId=C1&lectureName=Unit%201')).status).toBe(503);
        expect((await request(app({ db: null, user: instructor })).get('/stats?courseId=C1')).status).toBe(503);
    });

    test('GET /:documentId returns 503 without a db and 404 for a missing doc', async () => {
        expect((await request(app({ db: null, user: instructor })).get('/whatever')).status).toBe(503);
        expect((await request(app({ db: documentsDb(), user: instructor })).get('/missing')).status).toBe(404);
    });

    test('GET /:documentId proceeds when the owning course no longer exists', async () => {
        const db = documentsDb({ documents: [{ documentId: 'd1', courseId: 'GONE', contentType: 'text', content: 'x' }] });
        const res = await request(app({ db, user: instructor })).get('/d1');
        expect(res.status).toBe(200);
        expect(res.body.data.documentId).toBe('d1');
    });

    test('lecture and stats map model errors to 500', async () => {
        const db = documentsDb();
        jest.spyOn(require('../../../src/models/Document'), 'getDocumentsForLecture').mockRejectedValueOnce(new Error('boom'));
        expect((await request(app({ db, user: instructor })).get('/lecture?courseId=C1&lectureName=Unit%201')).status).toBe(500);
        jest.spyOn(require('../../../src/models/Document'), 'getDocumentStats').mockRejectedValueOnce(new Error('boom'));
        expect((await request(app({ db, user: instructor })).get('/stats?courseId=C1')).status).toBe(500);
    });
});

describe('GET /:documentId/download — binary payload shapes and streaming', () => {
    function fileDoc(fileData, extra = {}) {
        return documentsDb({ documents: [{
            documentId: 'd1', courseId: 'C1', contentType: 'file',
            originalName: 'slides', mimeType: 'application/pdf', fileData, ...extra,
        }] });
    }

    test('503 without a db and 404 for a missing document', async () => {
        expect((await request(app({ db: null, user: instructor })).get('/d1/download')).status).toBe(503);
        expect((await request(app({ db: documentsDb({ documents: [] }), user: instructor })).get('/missing/download')).status).toBe(404);
    });

    test('streams a GridFS-backed file and infers a .pdf extension from the mime type', async () => {
        gridfs.openDownloadStream.mockReturnValueOnce(Readable.from([Buffer.from('PDFBYTES')]));
        const res = await request(app({ db: fileDoc(undefined, { fileId: 'grid-1' }), user: instructor })).get('/d1/download');
        expect(res.status).toBe(200);
        expect(res.headers['content-disposition']).toContain('filename="slides.pdf"');
        expect(gridfs.openDownloadStream).toHaveBeenCalledWith(expect.anything(), 'grid-1');
    });

    test('a GridFS stream error before headers yields 500', async () => {
        // Emit the error only after the route has attached its handler and called pipe(),
        // so it is never an unhandled stream error (which would crash the worker / hang).
        const fakeStream = {
            on(event, cb) { if (event === 'error') this._onError = cb; return this; },
            pipe(res) { setImmediate(() => this._onError(new Error('read fail'))); return res; },
        };
        gridfs.openDownloadStream.mockReturnValueOnce(fakeStream);
        const res = await request(app({ db: fileDoc(undefined, { fileId: 'grid-err' }), user: instructor })).get('/d1/download');
        expect(res.status).toBe(500);
    });

    // memory-db's deep clone strips Buffer-ness, so the raw-Buffer branch (Buffer.isBuffer)
    // can't be represented through a stored document; the other stored shapes round-trip fine.
    test.each([
        ['object with buffer', { buffer: [66, 85, 70] }],
        ['object with data array', { data: [66, 85, 70] }],
        ['base64 string', Buffer.from('BUF').toString('base64')],
    ])('sends inline file data stored as %s', async (_label, fileData) => {
        const res = await request(app({ db: fileDoc(fileData), user: instructor })).get('/d1/download');
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toContain('application/pdf');
    });

    test('500 when a file document has no usable stored bytes', async () => {
        const res = await request(app({ db: fileDoc(undefined), user: instructor })).get('/d1/download');
        expect(res.status).toBe(500);
        expect(res.body.message).toBe('Stored file data is invalid');
    });

    test('an assigned TA without the courses permission is denied', async () => {
        const db = documentsDb({
            documents: [{ documentId: 'd1', courseId: 'C1', contentType: 'text', content: 'x' }],
            course: { tas: ['t1'], taPermissions: { t1: { canAccessCourses: false } } },
        });
        expect((await request(app({ db, user: ta })).get('/d1/download')).status).toBe(403);
    });

    test('maps a model error to 500', async () => {
        jest.spyOn(require('../../../src/models/Document'), 'getDocumentById').mockRejectedValueOnce(new Error('boom'));
        expect((await request(app({ db: documentsDb(), user: instructor })).get('/d1/download')).status).toBe(500);
    });
});

describe('GET /:documentId and DELETE — remaining guards and catches', () => {
    test('GET /:documentId maps a model error to 500', async () => {
        jest.spyOn(require('../../../src/models/Document'), 'getDocumentById').mockRejectedValueOnce(new Error('boom'));
        expect((await request(app({ db: documentsDb(), user: instructor })).get('/d1')).status).toBe(500);
    });

    test('DELETE returns 503 without a db', async () => {
        expect((await request(app({ db: null, user: instructor })).delete('/d1').send({ instructorId: 'i1' })).status).toBe(503);
    });

    test('DELETE reports a per-collection cleanup failure without failing the delete', async () => {
        mockDeleteEverywhere.mockResolvedValueOnce({
            deleted: [],
            errors: [{ collection: 'biocbot_documents', profileKey: 'openai:text-embedding-3-small:v1', error: 'no chunks' }],
        });
        const db = documentsDb();
        const res = await request(app({ db, user: instructor })).delete('/d1').send({ instructorId: 'i1' });
        expect(res.status).toBe(200);
        expect(res.body.data.removedFromQdrant).toBe(false);
    });

    test('DELETE tolerates a thrown Qdrant cleanup error', async () => {
        mockDeleteEverywhere.mockRejectedValueOnce(new Error('vector boom'));
        const db = documentsDb();
        const res = await request(app({ db, user: instructor })).delete('/d1').send({ instructorId: 'i1' });
        expect(res.status).toBe(200);
        expect(res.body.data.removedFromQdrant).toBe(false);
    });

    test('DELETE maps a thrown error to 500', async () => {
        jest.spyOn(require('../../../src/models/Document'), 'getDocumentById').mockResolvedValueOnce({ documentId: 'd1', courseId: 'C1' });
        jest.spyOn(require('../../../src/models/Document'), 'deleteDocument').mockRejectedValueOnce(new Error('mongo down'));
        const res = await request(app({ db: documentsDb(), user: instructor })).delete('/d1').send({ instructorId: 'i1' });
        expect(res.status).toBe(500);
    });
});

describe('POST /cleanup-orphans — counting and catches', () => {
    test('counts a document-existence check error as an orphan', async () => {
        const db = documentsDb({
            documents: [],
            course: { lectures: [{ name: 'Unit 1', documents: [{ documentId: 'boom-doc' }] }] },
        });
        jest.spyOn(require('../../../src/models/Document'), 'getDocumentById').mockRejectedValueOnce(new Error('lookup boom'));
        const res = await request(app({ db, user: instructor })).post('/cleanup-orphans').send({ courseId: 'C1', instructorId: 'i1' });
        expect(res.status).toBe(200);
        expect(res.body.data).toEqual({ totalOrphans: 1, cleanedUnits: 1 });
    });

    test('maps a thrown error to 500', async () => {
        jest.spyOn(require('../../../src/models/Course'), 'getCourseWithOnboarding').mockRejectedValueOnce(new Error('boom'));
        const res = await request(app({ db: documentsDb(), user: instructor })).post('/cleanup-orphans').send({ courseId: 'C1', instructorId: 'i1' });
        expect(res.status).toBe(500);
    });
});

describe('chunk batching boundary', () => {
    test('oversized content splits chunks across multiple LLM batches', async () => {
        // Each chunk ~ the limit so the batcher must flush between chunks (covers the batch-push boundary).
        const big = 'y'.repeat(20000);
        const db = documentsDb({ documents: [{ documentId: 'd1', courseId: 'C1', lectureName: 'Unit 1', content: 'z'.repeat(40000) }] });
        const sendMessage = jest.fn(async () => ({ content: '{"questions":[{"questionType":"short-answer","question":"Q?","correctAnswer":"A"}]}' }));
        const getDocumentChunks = jest.fn(async () => [big, big, big]);
        resolveCourseAi.mockResolvedValueOnce({ llm: { sendMessage }, qdrant: { getDocumentChunks } });
        const res = await request(app({ db, user: instructor })).post('/d1/extract-questions');
        expect(res.status).toBe(200);
        // Three ~20k chunks under a 32k limit → multiple batches → multiple LLM calls.
        expect(sendMessage.mock.calls.length).toBeGreaterThan(1);
    });
});
