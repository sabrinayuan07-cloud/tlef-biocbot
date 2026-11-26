/**
 * In-process route tests for src/routes/onboarding.js (supertest).
 *
 * Real: the Course model over the in-memory Mongo double, and llmKeyStore's crypto
 * helpers (buildKeySubdocument / publicKeySummary / stripPrivateKeyFields all run
 * for real under NODE_ENV=test). Only the network call `validateProviderKey` is stubbed.
 * Covers the create gate + key validation, the access guards on read/update/delete,
 * the instructor course list ordering, completion, and the /stats route ordering.
 */
jest.mock('../../../src/services/llmKeyStore', () => {
    const actual = jest.requireActual('../../../src/services/llmKeyStore');
    return {
        ...actual,
        validateApiKey: jest.fn(async () => ({ ok: true })),
        validateProviderKey: jest.fn(async () => ({ ok: true, status: 'valid', provider: 'openai' })),
    };
});

const { memoryDb } = require('../helpers/memory-db');
const { makeRouteApp, request } = require('../helpers/route-app');
const router = require('../../../src/routes/onboarding');
const llmKeyStore = require('../../../src/services/llmKeyStore');

const instructor = { userId: 'i1', role: 'instructor' };
const student = { userId: 's1', role: 'student' };
const app = (opts) => makeRouteApp(router, opts);
const failingDb = () => ({
    collection: () => new Proxy({}, { get: () => () => { throw new Error('db failed'); } }),
});
const callRegisteredHandler = async (path, method, params) => {
    const layer = router.stack.find(item => item.route?.path === path && item.route.methods[method]);
    const req = { params, app: { locals: {} } };
    const res = {
        statusCode: 200,
        status: jest.fn(function status(code) { this.statusCode = code; return this; }),
        json: jest.fn(function json(body) { this.body = body; return this; }),
    };
    await layer.route.stack[0].handle(req, res);
    return res;
};

beforeAll(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterAll(() => jest.restoreAllMocks());
beforeEach(() => {
    llmKeyStore.validateApiKey.mockReset().mockResolvedValue({ ok: true });
    llmKeyStore.validateProviderKey.mockReset().mockResolvedValue({ ok: true, status: 'valid', provider: 'openai' });
});

describe('POST / — create course from onboarding', () => {
    const body = { courseId: 'C1', courseName: 'BIOC 202', apiKey: 'sk-test', courseStructure: { weeks: 1, lecturesPerWeek: 1 } };

    test('401 without a user, 403 for a non-instructor', async () => {
        expect((await request(app({ db: memoryDb({}) })).post('/').send(body)).status).toBe(401);
        expect((await request(app({ db: memoryDb({}), user: student })).post('/').send(body)).status).toBe(403);
    });

    test('400 when courseId or courseName is missing', async () => {
        const res = await request(app({ db: memoryDb({}), user: instructor })).post('/').send({ courseId: 'C1' });
        expect(res.status).toBe(400);
    });

    test('503 when the database is unavailable', async () => {
        expect((await request(app({ db: null, user: instructor })).post('/').send(body)).status).toBe(503);
    });

    test('400 LLM_KEY_INVALID when the key fails validation', async () => {
        llmKeyStore.validateProviderKey.mockResolvedValueOnce({ ok: false, status: 'invalid', message: 'bad key' });
        const res = await request(app({ db: memoryDb({}), user: instructor })).post('/').send(body);
        expect(res.status).toBe(400);
        expect(res.body).toMatchObject({ code: 'LLM_KEY_INVALID' });
    });

    test('400 LLM_KEY_QUOTA when the key is out of credits', async () => {
        llmKeyStore.validateProviderKey.mockResolvedValueOnce({ ok: false, status: 'quota_exhausted' });
        const res = await request(app({ db: memoryDb({}), user: instructor })).post('/').send(body);
        expect(res.body.code).toBe('LLM_KEY_QUOTA');
    });

    test('creates the course and stores a valid key summary', async () => {
        const db = memoryDb({});
        const res = await request(app({ db, user: instructor })).post('/').send(body);
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({ courseId: 'C1', created: true, llmKey: { status: 'valid' } });
        const saved = await db.collection('courses').findOne({ courseId: 'C1' });
        expect(saved.instructorId).toBe('i1');
        expect(saved.llmApiKey.status).toBe('valid');
    });

    test('applies validated Proxy defaults during onboarding before uploads begin', async () => {
        const oldStub = process.env.BIOCBOT_TEST_LLM_STUB;
        const oldVectorSize = process.env.BIOCBOT_TEST_PROXY_VECTOR_SIZE;
        process.env.BIOCBOT_TEST_LLM_STUB = '1';
        process.env.BIOCBOT_TEST_PROXY_VECTOR_SIZE = '1024';
        llmKeyStore.validateProviderKey.mockResolvedValueOnce({
            ok: true,
            status: 'valid',
            provider: 'ubc-llm-proxy',
            models: ['gpt-oss-120b', 'qwen3.6-35b-a3b', 'qwen3-embedding-0.6b']
        });
        const db = memoryDb({});

        try {
            const res = await request(app({ db, user: instructor })).post('/').send({
                ...body,
                courseId: 'PROXY-C1',
                llmProvider: 'ubc-llm-proxy',
                apiKey: 'prx-test-key'
            });
            expect(res.status).toBe(200);
            expect(res.body.data).toMatchObject({
                llmProvider: 'ubc-llm-proxy',
                llmConfigurationStatus: 'ready',
                aiAvailable: true
            });
            const saved = await db.collection('courses').findOne({ courseId: 'PROXY-C1' });
            expect(saved.llmModelSettings.providers['ubc-llm-proxy']).toMatchObject({
                chatModel: 'qwen3.6-35b-a3b',
                reasoningEffort: 'none',
                embeddingModel: 'qwen3-embedding-0.6b',
                vectorSize: 1024,
                configurationStatus: 'ready'
            });
        } finally {
            if (oldStub === undefined) delete process.env.BIOCBOT_TEST_LLM_STUB;
            else process.env.BIOCBOT_TEST_LLM_STUB = oldStub;
            if (oldVectorSize === undefined) delete process.env.BIOCBOT_TEST_PROXY_VECTOR_SIZE;
            else process.env.BIOCBOT_TEST_PROXY_VECTOR_SIZE = oldVectorSize;
        }
    });

    test('applies empty defaults when creating a minimal course', async () => {
        const db = memoryDb({});
        const res = await request(app({ db, user: instructor })).post('/').send({ courseId: 'C2', courseName: 'Minimal', apiKey: 'sk-test' });
        expect(res.status).toBe(200);
        expect(await db.collection('courses').findOne({ courseId: 'C2' })).toMatchObject({
            courseDescription: '', assessmentCriteria: '', courseMaterials: [], courseStructure: {},
        });
    });

    test('updates submitted onboarding fields for an existing owned course', async () => {
        const db = memoryDb({ courses: [{ courseId: 'C1', instructorId: 'i1', courseName: 'Original' }] });
        const res = await request(app({ db, user: instructor })).post('/').send({ courseId: 'C1', courseName: 'Renamed', apiKey: 'sk-test' });
        expect(res.body).toMatchObject({ message: 'Course updated successfully from onboarding', data: { created: false, modifiedCount: 1 } });
        expect((await db.collection('courses').findOne({ courseId: 'C1' })).courseName).toBe('Renamed');
    });

    test('does not update an existing course owned by another instructor', async () => {
        const db = memoryDb({ courses: [{ courseId: 'C1', instructorId: 'other', courseName: 'Original' }] });

        const res = await request(app({ db, user: instructor })).post('/').send({ courseId: 'C1', courseName: 'Renamed', apiKey: 'sk-test' });

        expect(res.status).toBe(403);
        expect((await db.collection('courses').findOne({ courseId: 'C1' })).courseName).toBe('Original');
    });

    test('evicts the course from the LLM registry cache after a key change', async () => {
        const llmRegistry = { evictCourse: jest.fn() };
        const db = memoryDb({});
        await request(app({ db, user: instructor, locals: { llmRegistry } })).post('/').send(body);
        expect(llmRegistry.evictCourse).toHaveBeenCalledWith('C1');
    });

    test('500 when validation or persistence throws', async () => {
        llmKeyStore.validateProviderKey.mockRejectedValueOnce(new Error('provider failed'));
        const res = await request(app({ db: memoryDb({}), user: instructor })).post('/').send(body);
        expect(res.status).toBe(500);
        expect(res.body.message).toMatch(/saving onboarding data/);
    });
});

describe('GET /test and GET /stats (static routes resolve before /:courseId)', () => {
    test('GET /test confirms the router is mounted', async () => {
        const res = await request(app({ db: memoryDb({}) })).get('/test');
        expect(res.status).toBe(200);
        expect(res.body.message).toMatch(/working/i);
    });

    test('GET /stats aggregates course + instructor counts (not treated as courseId="stats")', async () => {
        const db = memoryDb({ courses: [
            { courseId: 'C1', instructorId: 'i1' },
            { courseId: 'C2', instructorId: 'i2' },
        ] });
        const res = await request(app({ db, user: instructor })).get('/stats');
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({ totalCourses: 2, totalInstructors: 2 });
    });

    test('GET /stats handles unavailable and failing databases', async () => {
        expect((await request(app({ db: null })).get('/stats')).status).toBe(503);
        expect((await request(app({ db: failingDb() })).get('/stats')).status).toBe(500);
    });
});

describe('GET /:courseId', () => {
    test('503 without a database and 500 on persistence failure', async () => {
        expect((await request(app({ db: null, user: instructor })).get('/C1')).status).toBe(503);
        expect((await request(app({ db: failingDb(), user: instructor })).get('/C1')).status).toBe(500);
    });
    test('404 when the course does not exist', async () => {
        const res = await request(app({ db: memoryDb({ courses: [] }), user: instructor })).get('/C1');
        expect(res.status).toBe(404);
    });

    test('403 when the caller is not an instructor/TA on the course', async () => {
        const db = memoryDb({ courses: [{ courseId: 'C1', instructorId: 'someone-else' }] });
        const res = await request(app({ db, user: instructor })).get('/C1');
        expect(res.status).toBe(403);
    });

    test('returns the course with private key fields stripped for an owning instructor', async () => {
        const db = memoryDb({ courses: [{ courseId: 'C1', instructorId: 'i1', llmApiKey: { status: 'valid', ciphertext: 'secret' } }] });
        const res = await request(app({ db, user: instructor })).get('/C1');
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({ courseId: 'C1', aiAvailable: true });
        expect(res.body.data).not.toHaveProperty('llmApiKey'); // ciphertext never leaves the server
        expect(res.body.data.llmKey).toMatchObject({ status: 'valid' });
    });

    test('allows a listed instructor or TA, but not an anonymous caller', async () => {
        const course = { courseId: 'C1', instructorId: 'other', instructors: ['i1'], tas: ['ta1'] };
        expect((await request(app({ db: memoryDb({ courses: [course] }), user: instructor })).get('/C1')).status).toBe(200);
        expect((await request(app({ db: memoryDb({ courses: [course] }), user: { userId: 'ta1', role: 'ta' } })).get('/C1')).status).toBe(200);
        expect((await request(app({ db: memoryDb({ courses: [course] }) })).get('/C1')).status).toBe(403);
    });

    test('the instructor join code goes to the course\'s instructors, not its TAs', async () => {
        const course = {
            courseId: 'C1', instructorId: 'other', instructors: ['i1'], tas: ['ta1', 'i9'],
            courseCode: 'STU123', instructorCourseCode: 'INS456',
        };
        const coInstructor = await request(app({ db: memoryDb({ courses: [course] }), user: instructor })).get('/C1');
        expect(coInstructor.body.data).toMatchObject({ courseCode: 'STU123', instructorCourseCode: 'INS456' });

        for (const user of [{ userId: 'ta1', role: 'ta' }, { userId: 'i9', role: 'instructor' }]) {
            const res = await request(app({ db: memoryDb({ courses: [course] }), user })).get('/C1');
            expect(res.status).toBe(200);
            expect(res.body.data.courseCode).toBe('STU123');
            expect(res.body.data).not.toHaveProperty('instructorCourseCode');
        }
    });
});

describe('GET /instructor/:instructorId', () => {
    test('403 when requesting another instructor\'s course list', async () => {
        const res = await request(app({ db: memoryDb({}), user: instructor })).get('/instructor/someone-else');
        expect(res.status).toBe(403);
    });

    test('returns the instructor\'s own courses, active ones first', async () => {
        const db = memoryDb({ courses: [
            { courseId: 'C-inactive', instructorId: 'i1', status: 'inactive', courseName: 'Old' },
            { courseId: 'C-active', instructorId: 'i1', courseName: 'New', updatedAt: new Date() },
            { courseId: 'C-deleted', instructorId: 'i1', status: 'deleted' }, // excluded
        ] });
        const res = await request(app({ db, user: instructor })).get('/instructor/i1');
        expect(res.status).toBe(200);
        expect(res.body.data.count).toBe(2);
        expect(res.body.data.courses[0].courseId).toBe('C-active');
        expect(res.body.data.courses[1].courseId).toBe('C-inactive');
    });

    test('includes co-instructed courses and applies date/name tie-breakers', async () => {
        const db = memoryDb({ courses: [
            { courseId: 'B', instructors: ['i1'], status: 'active', createdAt: '2026-01-01' },
            { courseId: 'A', instructorId: 'i1', status: 'active', createdAt: '2026-01-01' },
            { courseId: 'Newest', instructorId: 'i1', updatedAt: '2026-02-01' },
        ] });
        const res = await request(app({ db, user: instructor })).get('/instructor/i1');
        expect(res.body.data.courses.map(course => course.courseId)).toEqual(['Newest', 'A', 'B']);
    });

    test('rejects anonymous/non-instructor callers and handles db failures', async () => {
        expect((await request(app({ db: memoryDb({}) })).get('/instructor/i1')).status).toBe(403);
        expect((await request(app({ db: memoryDb({}), user: student })).get('/instructor/i1')).status).toBe(403);
        expect((await request(app({ db: null, user: instructor })).get('/instructor/i1')).status).toBe(503);
        expect((await request(app({ db: failingDb(), user: instructor })).get('/instructor/i1')).status).toBe(500);
    });
});

describe('PUT /:courseId — update fields', () => {
    test('400 when there are no updates', async () => {
        const res = await request(app({ db: memoryDb({ courses: [{ courseId: 'C1', instructorId: 'i1' }] }), user: instructor })).put('/C1').send({});
        expect(res.status).toBe(400);
    });

    test('403 when a non-owning instructor tries to update', async () => {
        const db = memoryDb({ courses: [{ courseId: 'C1', instructorId: 'someone-else' }] });
        const res = await request(app({ db, user: instructor })).put('/C1').send({ courseDescription: 'x' });
        expect(res.status).toBe(403);
    });

    test('404 for a missing course and 403 for anonymous or non-instructor owners', async () => {
        expect((await request(app({ db: memoryDb({ courses: [] }), user: instructor })).put('/C1').send({ courseDescription: 'x' })).status).toBe(404);
        const course = { courseId: 'C1', instructorId: 'i1' };
        expect((await request(app({ db: memoryDb({ courses: [course] }) })).put('/C1').send({ courseDescription: 'x' })).status).toBe(403);
        expect((await request(app({ db: memoryDb({ courses: [course] }), user: { ...instructor, role: 'ta' } })).put('/C1').send({ courseDescription: 'x' })).status).toBe(403);
    });

    test('200 persists the updated fields', async () => {
        const db = memoryDb({ courses: [{ courseId: 'C1', instructorId: 'i1' }] });
        const res = await request(app({ db, user: instructor })).put('/C1').send({ courseDescription: 'Updated desc' });
        expect(res.status).toBe(200);
        expect((await db.collection('courses').findOne({ courseId: 'C1' })).courseDescription).toBe('Updated desc');
    });

    test('rejects mass assignment of ownership and identifier fields', async () => {
        const db = memoryDb({ courses: [{ courseId: 'C1', instructorId: 'i1' }] });
        const res = await request(app({ db, user: instructor })).put('/C1').send({ courseId: 'C2', instructorId: 'attacker' });
        expect(res.status).toBe(400);
        expect(await db.collection('courses').findOne({ courseId: 'C1' })).toMatchObject({ instructorId: 'i1' });
        expect(await db.collection('courses').findOne({ courseId: 'C2' })).toBeNull();
    });

    test('503 without a db and 500 on update failure', async () => {
        expect((await request(app({ db: null, user: instructor })).put('/C1').send({ courseDescription: 'x' })).status).toBe(503);
        expect((await request(app({ db: failingDb(), user: instructor })).put('/C1').send({ courseDescription: 'x' })).status).toBe(500);
    });
});

describe('PUT /:courseId/unit-files', () => {
    test('400 when files is not an array', async () => {
        const res = await request(app({ db: memoryDb({}), user: instructor })).put('/C1/unit-files').send({ unitName: 'Unit 1', files: 'x' });
        expect(res.status).toBe(400);
    });

    test('200 for an owning instructor on an existing unit', async () => {
        const db = memoryDb({ courses: [{ courseId: 'C1', instructorId: 'i1', lectures: [{ name: 'Unit 1' }] }] });
        const res = await request(app({ db, user: instructor })).put('/C1/unit-files').send({ unitName: 'Unit 1', files: ['a.pdf'] });
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({ unitName: 'Unit 1', filesCount: 1 });
    });

    test('404 for a missing course and 403 without instructor ownership', async () => {
        const payload = { unitName: 'Unit 1', files: [] };
        expect((await request(app({ db: memoryDb({ courses: [] }), user: instructor })).put('/C1/unit-files').send(payload)).status).toBe(404);
        const course = { courseId: 'C1', instructorId: 'other' };
        expect((await request(app({ db: memoryDb({ courses: [course] }), user: instructor })).put('/C1/unit-files').send(payload)).status).toBe(403);
        expect((await request(app({ db: memoryDb({ courses: [{ ...course, instructorId: 'i1' }] }), user: student })).put('/C1/unit-files').send(payload)).status).toBe(403);
    });

    test('404 when the named unit does not exist', async () => {
        const db = memoryDb({ courses: [{ courseId: 'C1', instructorId: 'i1', lectures: [] }] });
        const res = await request(app({ db, user: instructor })).put('/C1/unit-files').send({ unitName: 'Missing', files: ['a.pdf'] });
        expect(res.status).toBe(404);
        expect(res.body.message).toBe('Unit not found');
    });

    test('503 without a db and 500 on update failure', async () => {
        const payload = { unitName: 'Unit 1', files: [] };
        expect((await request(app({ db: null, user: instructor })).put('/C1/unit-files').send(payload)).status).toBe(503);
        expect((await request(app({ db: failingDb(), user: instructor })).put('/C1/unit-files').send(payload)).status).toBe(500);
    });
});

describe('DELETE /:courseId', () => {
    test('404 when the course does not exist', async () => {
        const res = await request(app({ db: memoryDb({ courses: [] }), user: instructor })).delete('/C1');
        expect(res.status).toBe(404);
    });

    test('an owning instructor deletes the course', async () => {
        const db = memoryDb({ courses: [{ courseId: 'C1', instructorId: 'i1' }] });
        const res = await request(app({ db, user: instructor })).delete('/C1');
        expect(res.status).toBe(200);
        expect(res.body.data.deletedCount).toBe(1);
        expect(await db.collection('courses').findOne({ courseId: 'C1' })).toBeNull();
    });

    test('403 without instructor ownership, 503 without db, and 500 on failure', async () => {
        const course = { courseId: 'C1', instructorId: 'other' };
        expect((await request(app({ db: memoryDb({ courses: [course] }), user: instructor })).delete('/C1')).status).toBe(403);
        expect((await request(app({ db: null, user: instructor })).delete('/C1')).status).toBe(503);
        expect((await request(app({ db: failingDb(), user: instructor })).delete('/C1')).status).toBe(500);
    });
});

describe('DELETE /:courseId/unit/:unitName', () => {
    test('409 when deleting the course\'s last unit', async () => {
        const db = memoryDb({ courses: [{ courseId: 'C1', instructorId: 'i1', lectures: [{ name: 'Unit 1' }] }] });
        const res = await request(app({ db, user: instructor })).delete('/C1/unit/Unit 1');
        expect(res.status).toBe(409);
        expect(res.body.message).toMatch(/at least one unit/i);
        const saved = await db.collection('courses').findOne({ courseId: 'C1' });
        expect(saved.lectures.map(l => l.name)).toEqual(['Unit 1']);
    });

    test('removes the named unit from the course', async () => {
        const db = memoryDb({ courses: [{ courseId: 'C1', instructorId: 'i1', lectures: [{ name: 'Unit 1' }, { name: 'Unit 2' }] }] });
        const res = await request(app({ db, user: instructor })).delete('/C1/unit/Unit 1');
        expect(res.status).toBe(200);
        const saved = await db.collection('courses').findOne({ courseId: 'C1' });
        expect(saved.lectures.map(l => l.name)).toEqual(['Unit 2']);
    });

    test('404 for a missing course and 403 without instructor ownership', async () => {
        expect((await request(app({ db: memoryDb({ courses: [] }), user: instructor })).delete('/C1/unit/U')).status).toBe(404);
        const course = { courseId: 'C1', instructorId: 'other' };
        expect((await request(app({ db: memoryDb({ courses: [course] }), user: instructor })).delete('/C1/unit/U')).status).toBe(403);
    });

    test('503 without a db and 500 on deletion failure', async () => {
        expect((await request(app({ db: null, user: instructor })).delete('/C1/unit/U')).status).toBe(503);
        expect((await request(app({ db: failingDb(), user: instructor })).delete('/C1/unit/U')).status).toBe(500);
    });
});

describe('POST /complete', () => {
    test('401 without a user, 403 for a non-instructor, and 400 without required ids', async () => {
        expect((await request(app({ db: memoryDb({}) })).post('/complete').send({ courseId: 'C1', instructorId: 'i1' })).status).toBe(401);
        expect((await request(app({ db: memoryDb({}), user: student })).post('/complete').send({ courseId: 'C1', instructorId: 's1' })).status).toBe(403);
        expect((await request(app({ db: memoryDb({}), user: instructor })).post('/complete').send({ courseId: 'C1' })).status).toBe(400);
    });
    test('403 when the body instructorId does not match the session user', async () => {
        const res = await request(app({ db: memoryDb({}), user: instructor })).post('/complete').send({ courseId: 'C1', instructorId: 'other' });
        expect(res.status).toBe(403);
    });

    test('404 when the course does not exist', async () => {
        const res = await request(app({ db: memoryDb({ courses: [] }), user: instructor })).post('/complete').send({ courseId: 'C1', instructorId: 'i1' });
        expect(res.status).toBe(404);
    });

    test('200 marks onboarding complete on the course', async () => {
        const db = memoryDb({ courses: [{ courseId: 'C1', instructorId: 'i1' }] });
        const res = await request(app({ db, user: instructor })).post('/complete').send({ courseId: 'C1', instructorId: 'i1' });
        expect(res.status).toBe(200);
        expect((await db.collection('courses').findOne({ courseId: 'C1' })).isOnboardingComplete).toBe(true);
    });

    test('403 when the instructor does not own the course', async () => {
        const db = memoryDb({ courses: [{ courseId: 'C1', instructorId: 'other' }] });
        expect((await request(app({ db, user: instructor })).post('/complete').send({ courseId: 'C1', instructorId: 'i1' })).status).toBe(403);
    });

    test('503 without a db and 500 on persistence failure', async () => {
        const payload = { courseId: 'C1', instructorId: 'i1' };
        expect((await request(app({ db: null, user: instructor })).post('/complete').send(payload)).status).toBe(503);
        expect((await request(app({ db: failingDb(), user: instructor })).post('/complete').send(payload)).status).toBe(500);
    });
});

describe('path-parameter guards precluded by Express route matching', () => {
    test.each([
        ['/:courseId', 'get', {}, 'Missing required parameter: courseId'],
        ['/instructor/:instructorId', 'get', {}, 'Missing required parameter: instructorId'],
        ['/:courseId', 'delete', {}, 'Missing required parameter: courseId'],
        ['/:courseId/unit/:unitName', 'delete', { courseId: 'C1' }, 'Missing required parameters: courseId, unitName'],
    ])('%s %s retains its defensive missing-parameter response', async (path, method, params, message) => {
        const res = await callRegisteredHandler(path, method, params);
        expect(res.statusCode).toBe(400);
        expect(res.body).toEqual({ success: false, message });
    });
});
