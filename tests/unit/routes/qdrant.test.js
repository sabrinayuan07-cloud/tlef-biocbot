const mockService = {
    client: null,
    collectionName: 'documents',
    initialize: jest.fn(async function initialize() { mockService.client = mockClient; }),
    getCollectionStats: jest.fn(),
    deleteDocumentChunks: jest.fn(),
    deleteCollection: jest.fn(),
};
const mockClient = { scroll: jest.fn() };

jest.mock('../../../src/services/qdrantService', () => jest.fn(() => mockService));
jest.mock('../../../src/models/Course', () => ({
    userHasCourseAccess: jest.fn(),
    checkTAPermission: jest.fn(),
}));
jest.mock('../../../src/routes/llmKeyMiddleware', () => ({
    resolveCourseAi: jest.fn(),
    sendLlmKeyError: jest.fn(() => false),
}));

const { memoryDb } = require('../helpers/memory-db');
const { makeRouteApp, request } = require('../helpers/route-app');
const Course = require('../../../src/models/Course');
const { buildEmbeddingProfile } = require('../../../src/services/embeddingConfig');
const { contentHash } = require('../../../src/services/embeddingIndexService');
const { resolveCourseAi, sendLlmKeyError } = require('../../../src/routes/llmKeyMiddleware');
const router = require('../../../src/routes/qdrant');

const instructor = { userId: 'i1', role: 'instructor' };
const ta = { userId: 't1', role: 'ta' };
const student = { userId: 's1', role: 'student' };
const admin = { userId: 'a1', role: 'instructor', permissions: { systemAdmin: true } };
const app = options => makeRouteApp(router, options);
const maintenanceDb = (data = {}) => memoryDb({
    courses: [{ courseId: 'C1', instructorId: 'i1', tas: ['t1'] }],
    ...data,
});

beforeAll(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
});

beforeEach(() => {
    mockService.client = null;
    mockService.initialize.mockClear();
    mockService.getCollectionStats.mockReset().mockResolvedValue({ name: 'documents', pointsCount: 3 });
    mockService.deleteDocumentChunks.mockReset().mockResolvedValue({ success: true, message: 'deleted', deletedCount: 2 });
    mockService.deleteCollection.mockReset().mockResolvedValue({ success: true, message: 'deleted', deletedCount: 'all' });
    mockClient.scroll.mockReset().mockResolvedValue({ points: [], next_page_offset: null });
    Course.userHasCourseAccess.mockReset().mockResolvedValue(true);
    Course.checkTAPermission.mockReset().mockResolvedValue(true);
    resolveCourseAi.mockReset();
    sendLlmKeyError.mockReset().mockReturnValue(false);
});

afterAll(() => jest.restoreAllMocks());

describe('Qdrant route access and status', () => {
    test('status initializes the maintenance service and returns stats', async () => {
        const res = await request(app({})).get('/status');
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({ status: 'connected', collection: { pointsCount: 3 } });
        expect(mockService.initialize).toHaveBeenCalled();
    });

    test('status maps initialization failures', async () => {
        mockService.initialize.mockRejectedValueOnce(new Error('offline'));
        const res = await request(app({})).get('/status');
        expect(res.status).toBe(500);
        expect(res.body.error).toBe('offline');
    });

    test('direct operations require authentication and staff role', async () => {
        expect((await request(app({})).post('/search').send({ courseId: 'C1', query: 'ATP' })).status).toBe(401);
        expect((await request(app({ user: student })).post('/search').send({ courseId: 'C1', query: 'ATP' })).status).toBe(403);
    });

    test('existing courses require instructor access or TA permission', async () => {
        const db = memoryDb({ courses: [{ courseId: 'C1' }] });
        Course.userHasCourseAccess.mockResolvedValueOnce(false);
        expect((await request(app({ db, user: instructor })).post('/search').send({ courseId: 'C1', query: 'ATP' })).status).toBe(403);
        Course.checkTAPermission.mockResolvedValueOnce(false);
        expect((await request(app({ db, user: ta })).post('/search').send({ courseId: 'C1', query: 'ATP' })).status).toBe(403);
    });

    test('admin bypasses course lookup while allowed staff and new courses pass access checks', async () => {
        expect((await request(app({ user: admin })).post('/search').send({ courseId: 'C1' })).status).toBe(400);

        const db = memoryDb({ courses: [{ courseId: 'C1' }] });
        expect((await request(app({ db, user: instructor })).post('/search').send({ courseId: 'C1' })).status).toBe(400);
        expect(Course.userHasCourseAccess).toHaveBeenCalledWith(db, 'C1', 'i1', 'instructor');
        expect((await request(app({ db, user: ta })).post('/search').send({ courseId: 'C1' })).status).toBe(400);
        expect(Course.checkTAPermission).toHaveBeenCalledWith(db, 'C1', 't1', 'materials');

        expect((await request(app({ db, user: instructor })).post('/search').send({ courseId: 'NEW' })).status).toBe(400);
    });

    test('course-scoped access reports an unavailable database', async () => {
        const res = await request(app({ user: instructor })).post('/search').send({ courseId: 'C1', query: 'ATP' });
        expect(res.status).toBe(503);
        expect(res.body.message).toBe('Database connection not available');
    });
});

describe('document processing and search with mocked AI/vector service', () => {
    test('process-document validates required fields', async () => {
        const res = await request(app({ db: memoryDb({}), user: instructor })).post('/process-document').send({ courseId: 'C1' });
        expect(res.status).toBe(400);
    });

    test('process-document delegates to the resolved mocked course vector service', async () => {
        const qdrant = { processAndStoreDocument: jest.fn(async () => ({ success: true, message: 'stored', chunksProcessed: 2, chunksStored: 2 })) };
        resolveCourseAi.mockResolvedValueOnce({ qdrant });
        const payload = { courseId: 'C1', lectureName: 'Unit 1', documentId: 'd1', content: 'ATP content', fileName: 'notes.txt' };
        const res = await request(app({ db: memoryDb({}), user: instructor })).post('/process-document').send(payload);
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({ chunksStored: 2, documentId: 'd1' });
        expect(qdrant.processAndStoreDocument).toHaveBeenCalledWith(expect.objectContaining({ ...payload, mimeType: 'text/plain' }));
    });

    test('process-document records the embedding profile after storing vectors', async () => {
        const profile = buildEmbeddingProfile({
            provider: 'openai', embeddingModel: 'text-embedding-3-small',
        });
        const qdrant = {
            embeddingProfile: profile,
            processAndStoreDocument: jest.fn(async () => ({
                success: true, message: 'stored', chunksProcessed: 1, chunksStored: 1,
            })),
        };
        resolveCourseAi.mockResolvedValueOnce({ qdrant });
        const content = 'ATP content';
        const db = memoryDb({
            documents: [{ documentId: 'd1', courseId: 'C1', content, status: 'uploaded' }],
        });

        const res = await request(app({ db, user: instructor })).post('/process-document').send({
            courseId: 'C1', lectureName: 'Unit 1', documentId: 'd1', content, fileName: 'notes.txt',
        });

        expect(res.status).toBe(200);
        const stored = await db.collection('documents').findOne({ documentId: 'd1' });
        expect(stored.status).toBe('uploaded');
        expect(stored.embeddingIndexes[profile.storageKey]).toMatchObject({
            provider: 'openai', model: 'text-embedding-3-small',
            contentHash: contentHash(content), status: 'ready',
        });
    });

    test('process-document maps a vector processing failure', async () => {
        resolveCourseAi.mockResolvedValueOnce({ qdrant: { processAndStoreDocument: jest.fn(async () => ({ success: false, error: 'embedding failed' })) } });
        const res = await request(app({ db: memoryDb({}), user: instructor })).post('/process-document').send({ courseId: 'C1', lectureName: 'U', documentId: 'd', content: 'text', fileName: 'f' });
        expect(res.status).toBe(500);
        expect(res.body.error).toBe('embedding failed');
    });

    test('process-document stops when AI resolution responds and maps ordinary and key errors', async () => {
        resolveCourseAi.mockImplementationOnce(async (_req, response) => {
            response.status(409).json({ success: false, message: 'AI unavailable' });
            return null;
        });
        let res = await request(app({ db: memoryDb({}), user: instructor })).post('/process-document').send({ courseId: 'C1', lectureName: 'U', documentId: 'd', content: 'text', fileName: 'f' });
        expect(res.status).toBe(409);

        resolveCourseAi.mockRejectedValueOnce(new Error('resolver exploded'));
        res = await request(app({ db: memoryDb({}), user: instructor })).post('/process-document').send({ courseId: 'C1', lectureName: 'U', documentId: 'd', content: 'text', fileName: 'f' });
        expect(res.status).toBe(500);
        expect(res.body.error).toBe('resolver exploded');

        resolveCourseAi.mockRejectedValueOnce(new Error('missing key'));
        sendLlmKeyError.mockImplementationOnce((response) => {
            response.status(422).json({ success: false, message: 'key required' });
            return true;
        });
        res = await request(app({ db: memoryDb({}), user: instructor })).post('/process-document').send({ courseId: 'C1', lectureName: 'U', documentId: 'd', content: 'text', fileName: 'f' });
        expect(res.status).toBe(422);
    });

    test('search validates course and query', async () => {
        expect((await request(app({ user: instructor })).post('/search').send({ query: 'ATP' })).status).toBe(400);
        expect((await request(app({ db: memoryDb({ courses: [] }), user: instructor })).post('/search').send({ courseId: 'C1' })).status).toBe(400);
    });

    test('search delegates with scoped filters and limit', async () => {
        const qdrant = { searchDocuments: jest.fn(async () => [{ id: 'p1' }]) };
        resolveCourseAi.mockResolvedValueOnce({ qdrant });
        const res = await request(app({ db: memoryDb({}), user: instructor })).post('/search').send({ query: 'ATP', courseId: 'C1', lectureName: 'Unit 1', limit: 4 });
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({ totalResults: 1, filters: { courseId: 'C1', lectureName: 'Unit 1' } });
        expect(qdrant.searchDocuments).toHaveBeenCalledWith('ATP', { courseId: 'C1', lectureName: 'Unit 1' }, 4);
    });

    test('search uses default limit, omits lecture filter, and stops on absent AI', async () => {
        const qdrant = { searchDocuments: jest.fn(async () => []) };
        resolveCourseAi.mockResolvedValueOnce({ qdrant });
        let res = await request(app({ db: memoryDb({}), user: instructor })).post('/search').send({ query: 'ATP', courseId: 'C1' });
        expect(res.status).toBe(200);
        expect(qdrant.searchDocuments).toHaveBeenCalledWith('ATP', { courseId: 'C1' }, 10);

        resolveCourseAi.mockImplementationOnce(async (_req, response) => {
            response.status(409).json({ success: false, message: 'AI unavailable' });
            return null;
        });
        res = await request(app({ db: memoryDb({}), user: instructor })).post('/search').send({ query: 'ATP', courseId: 'C1' });
        expect(res.status).toBe(409);
    });

    test('search maps ordinary and delegated key errors', async () => {
        resolveCourseAi.mockRejectedValueOnce(new Error('search exploded'));
        let res = await request(app({ db: memoryDb({}), user: instructor })).post('/search').send({ query: 'ATP', courseId: 'C1' });
        expect(res.status).toBe(500);
        expect(res.body.error).toBe('search exploded');

        resolveCourseAi.mockRejectedValueOnce(new Error('missing key'));
        sendLlmKeyError.mockImplementationOnce((response) => {
            response.status(422).json({ success: false, message: 'key required' });
            return true;
        });
        res = await request(app({ db: memoryDb({}), user: instructor })).post('/search').send({ query: 'ATP', courseId: 'C1' });
        expect(res.status).toBe(422);
    });
});

describe('maintenance operations', () => {
    test('document deletion initializes and reports success or failure', async () => {
        const db = maintenanceDb({ documents: [{ documentId: 'd1', courseId: 'C1' }] });
        let res = await request(app({ db, user: instructor })).delete('/document/d1');
        expect(res.status).toBe(200);
        expect(res.body.data).toEqual({ documentId: 'd1', deletedCount: 2 });
        expect(mockService.deleteDocumentChunks).toHaveBeenCalledWith('d1', 'C1');
        mockService.client = mockClient;
        mockService.deleteDocumentChunks.mockResolvedValueOnce({ success: false, error: 'delete failed' });
        res = await request(app({ db, user: instructor })).delete('/document/d1');
        expect(res.status).toBe(500);
    });

    test('document deletion maps service exceptions', async () => {
        mockService.deleteDocumentChunks.mockRejectedValueOnce(new Error('delete exploded'));
        const res = await request(app({ db: maintenanceDb({ documents: [{ documentId: 'd1', courseId: 'C1' }] }), user: instructor })).delete('/document/d1');
        expect(res.status).toBe(500);
        expect(res.body.error).toBe('delete exploded');
    });

    test('document deletion requires a known document and access to its course', async () => {
        expect((await request(app({ db: maintenanceDb(), user: instructor })).delete('/document/missing')).status).toBe(404);
        Course.userHasCourseAccess.mockResolvedValueOnce(false);
        const db = maintenanceDb({ documents: [{ documentId: 'd1', courseId: 'C1' }] });
        expect((await request(app({ db, user: instructor })).delete('/document/d1')).status).toBe(403);
        expect(mockService.deleteDocumentChunks).not.toHaveBeenCalled();
    });

    test('collection stats require staff and return mocked stats', async () => {
        expect((await request(app({ user: student })).get('/collection-stats')).status).toBe(403);
        const res = await request(app({ user: instructor })).get('/collection-stats');
        expect(res.status).toBe(200);
        expect(res.body.data.pointsCount).toBe(3);
    });

    test('collection stats maps service exceptions without reinitializing an active client', async () => {
        mockService.client = mockClient;
        mockService.getCollectionStats.mockRejectedValueOnce(new Error('stats exploded'));
        const res = await request(app({ user: instructor })).get('/collection-stats');
        expect(res.status).toBe(500);
        expect(res.body.error).toBe('stats exploded');
        expect(mockService.initialize).not.toHaveBeenCalled();
    });

    test('collection deletion is system-admin only', async () => {
        expect((await request(app({ user: instructor })).delete('/collection')).status).toBe(403);
        let res = await request(app({ user: admin })).delete('/collection');
        expect(res.status).toBe(200);
        mockService.client = mockClient;
        mockService.deleteCollection.mockResolvedValueOnce({ success: false, error: 'cannot delete' });
        res = await request(app({ user: admin })).delete('/collection');
        expect(res.status).toBe(500);
    });

    test('collection deletion initializes when needed and maps thrown errors', async () => {
        mockService.deleteCollection.mockRejectedValueOnce(new Error('collection exploded'));
        const res = await request(app({ user: admin })).delete('/collection');
        expect(res.status).toBe(500);
        expect(res.body.error).toBe('collection exploded');
        expect(mockService.initialize).toHaveBeenCalled();
    });

    test('delete-all-collections enforces admin and reports Qdrant or database precondition failures', async () => {
        expect((await request(app({ user: instructor })).delete('/delete-all-collections')).status).toBe(403);

        mockService.deleteCollection.mockResolvedValueOnce({ success: false, error: 'qdrant retained' });
        let res = await request(app({ user: admin })).delete('/delete-all-collections');
        expect(res.status).toBe(500);
        expect(res.body.message).toBe('Failed to delete Qdrant collection');

        res = await request(app({ user: admin })).delete('/delete-all-collections');
        expect(res.status).toBe(500);
        expect(res.body.error).toBe('Database not initialized');
    });

    test('delete-all-collections drops each Mongo collection and records per-collection failures', async () => {
        const db = {
            listCollections: jest.fn(() => ({ toArray: jest.fn(async () => [{ name: 'courses' }, { name: 'users' }]) })),
            collection: jest.fn((name) => ({ countDocuments: jest.fn(async () => name === 'courses' ? 3 : 2) })),
            dropCollection: jest.fn(async (name) => { if (name === 'users') throw new Error('drop denied'); }),
        };
        const res = await request(app({ db, user: admin })).delete('/delete-all-collections');
        expect(res.status).toBe(200);
        expect(res.body.data).toEqual({
            qdrantDeletedCount: 'all',
            mongoDeletedCount: 3,
            mongoResults: {
                courses: { exists: true, deleted: 3, success: true },
                users: { exists: true, deleted: 0, success: false, error: 'drop denied' },
            },
        });
    });

    test('delete-all-collections maps unexpected failures', async () => {
        mockService.deleteCollection.mockRejectedValueOnce(new Error('qdrant exploded'));
        const res = await request(app({ user: admin })).delete('/delete-all-collections');
        expect(res.status).toBe(500);
        expect(res.body.error).toBe('qdrant exploded');
    });

    test('cleanup-vectors removes only IDs absent from Mongo', async () => {
        mockService.client = mockClient;
        mockClient.scroll.mockResolvedValueOnce({
            points: [{ payload: { documentId: 'valid' } }, { payload: { documentId: 'orphan' } }],
            next_page_offset: null,
        });
        mockService.deleteDocumentChunks.mockResolvedValueOnce({ success: true, deletedCount: 3 });
        const db = maintenanceDb({ documents: [{ _id: 'mongo-id', documentId: 'valid', courseId: 'C1' }] });
        const res = await request(app({ db, user: instructor })).post('/cleanup-vectors').send({ courseId: 'C1' });
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({ validMongoDocs: 2, qdrantDocs: 2, orphanedDocs: 1, deletedChunks: 3, deletedDocIds: ['orphan'] });
        expect(mockService.deleteDocumentChunks).toHaveBeenCalledWith('orphan', 'C1');
    });

    test('cleanup validates course scope and database availability', async () => {
        expect((await request(app({ user: instructor })).post('/cleanup-vectors').send({})).status).toBe(400);
        const res = await request(app({ user: admin })).post('/cleanup-vectors').send({ courseId: 'C1' });
        expect(res.status).toBe(503);
    });

    test('cleanup initializes, follows scroll pages, ignores malformed payloads, and tolerates delete failures', async () => {
        mockClient.scroll
            .mockResolvedValueOnce({ points: [{}, { payload: {} }, { payload: { documentId: 'orphan' } }], next_page_offset: 'next' })
            .mockResolvedValueOnce({ points: null, next_page_offset: null });
        mockService.deleteDocumentChunks.mockResolvedValueOnce({ success: false, error: 'retained' });
        const res = await request(app({ db: maintenanceDb({ documents: [] }), user: instructor })).post('/cleanup-vectors').send({ courseId: 'C1' });
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({ orphanedDocs: 1, deletedChunks: 0, deletedDocIds: [] });
        expect(mockService.initialize).toHaveBeenCalled();
        expect(mockClient.scroll).toHaveBeenCalledTimes(2);
    });

    test('cleanup maps scroll failures', async () => {
        mockService.client = mockClient;
        mockClient.scroll.mockRejectedValueOnce(new Error('scroll exploded'));
        const res = await request(app({ db: maintenanceDb({ documents: [] }), user: instructor })).post('/cleanup-vectors').send({ courseId: 'C1' });
        expect(res.status).toBe(500);
        expect(res.body.error).toBe('scroll exploded');
    });

    test('cleanup rejects an unknown course before scanning vectors', async () => {
        const res = await request(app({ db: memoryDb({ courses: [] }), user: instructor }))
            .post('/cleanup-vectors').send({ courseId: 'missing' });
        expect(res.status).toBe(404);
        expect(mockClient.scroll).not.toHaveBeenCalled();
    });
});
