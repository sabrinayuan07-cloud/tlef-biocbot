/**
 * In-process route tests for src/routes/flags.js (supertest).
 * No heavy deps — the router uses FlaggedQuestion + Course models over memory-db
 * and req.user. Covers flag creation, the student "my flags" view, and the
 * instructor/TA-gated status-update / stats / delete paths.
 */
const { memoryDb } = require('../helpers/memory-db');
const { makeRouteApp, request } = require('../helpers/route-app');
const flagsRouter = require('../../../src/routes/flags');
const FlaggedQuestionModel = require('../../../src/models/FlaggedQuestion');

const student = { userId: 's1', role: 'student', username: 'stu', displayName: 'Stu' };
const instructor = { userId: 'i1', role: 'instructor', username: 'ins' };
const ta = { userId: 't1', role: 'ta' };
const app = (opts) => makeRouteApp(flagsRouter, opts);

const validFlag = { questionId: 'q1', courseId: 'C1', unitName: 'Unit 1', flagReason: 'incorrect', flagDescription: 'wrong answer' };

beforeAll(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterAll(() => jest.restoreAllMocks());

describe('POST / — create a flag', () => {
    test('401 without a user, 403 for a TA', async () => {
        expect((await request(app({ db: memoryDb({}) })).post('/').send(validFlag)).status).toBe(401);
        expect((await request(app({ db: memoryDb({}), user: ta })).post('/').send(validFlag)).status).toBe(403);
    });

    test('400 when required fields are missing', async () => {
        const res = await request(app({ db: memoryDb({}), user: student })).post('/').send({ courseId: 'C1' });
        expect(res.status).toBe(400);
    });

    test('404 when the (non-super) course does not exist', async () => {
        const res = await request(app({ db: memoryDb({ courses: [] }), user: student })).post('/').send(validFlag);
        expect(res.status).toBe(404);
    });

    test('403 when the student is not enrolled in the course', async () => {
        const db = memoryDb({ courses: [{ courseId: 'C1', courseName: 'Bio' }] }); // exists, but s1 not enrolled
        expect((await request(app({ db, user: student })).post('/').send(validFlag)).status).toBe(403);
    });

    test('201/200 creates the flag for an enrolled student', async () => {
        const db = memoryDb({ courses: [{ courseId: 'C1', courseName: 'Bio', studentEnrollment: { s1: { enrolled: true } } }] });
        const res = await request(app({ db, user: student })).post('/').send(validFlag);
        expect(res.status).toBe(200);
        expect(res.body.data.flagId).toBeTruthy();
        expect(await db.collection('flaggedQuestions').findOne({ flagId: res.body.data.flagId })).toBeTruthy();
    });

    test('allows an instructor to flag content in a course they teach', async () => {
        const db = memoryDb({ courses: [{ courseId: 'C1', courseName: 'Bio', instructorId: 'i1' }] });

        const res = await request(app({ db, user: instructor })).post('/').send(validFlag);

        expect(res.status).toBe(200);
        expect(await db.collection('flaggedQuestions').findOne({ flagId: res.body.data.flagId }))
            .toMatchObject({ reporterRole: 'instructor', reporterId: 'i1' });
    });

    test('rejects an instructor who does not teach the course', async () => {
        const db = memoryDb({ courses: [{ courseId: 'C1', courseName: 'Bio', instructorId: 'other' }] });

        expect((await request(app({ db, user: instructor })).post('/').send(validFlag)).status).toBe(403);
    });
});

describe('GET /my — student\'s own flags', () => {
    test('401 without a user, 403 for a non-student', async () => {
        expect((await request(app({ db: memoryDb({}) })).get('/my')).status).toBe(401);
        expect((await request(app({ db: memoryDb({}), user: instructor })).get('/my')).status).toBe(403);
    });

    test('returns the student\'s flags for an enrolled course', async () => {
        const db = memoryDb({
            courses: [{ courseId: 'C1', studentEnrollment: { s1: { enrolled: true } } }],
            flaggedQuestions: [{ flagId: 'f1', studentId: 's1', courseId: 'C1', status: 'pending' }],
        });
        const res = await request(app({ db, user: student })).get('/my?courseId=C1');
        expect(res.status).toBe(200);
        expect(res.body.data.flags.map(f => f.flagId)).toContain('f1');
    });
});

describe('PUT /:flagId/status — instructor/TA review', () => {
    test('400 when status is missing', async () => {
        const res = await request(app({ db: memoryDb({}), user: instructor })).put('/f1/status').send({});
        expect(res.status).toBe(400);
    });

    test('403 when a student tries to update status', async () => {
        const res = await request(app({ db: memoryDb({}), user: student })).put('/f1/status').send({ status: 'resolved' });
        expect(res.status).toBe(403);
    });

    test('400 when the flag does not exist (legacy not-found contract)', async () => {
        const db = memoryDb({ flaggedQuestions: [] });
        const res = await request(app({ db, user: instructor })).put('/missing/status').send({ status: 'resolved' });
        expect(res.status).toBe(400);
    });

    test('200 when the course instructor updates the status', async () => {
        const db = memoryDb({
            courses: [{ courseId: 'C1', instructorId: 'i1' }],
            flaggedQuestions: [{ flagId: 'f1', courseId: 'C1', status: 'pending' }],
        });
        const res = await request(app({ db, user: instructor })).put('/f1/status').send({ status: 'resolved' });
        expect(res.status).toBe(200);
        // The model persists the status under `flagStatus` (the API param is `status`).
        expect((await db.collection('flaggedQuestions').findOne({ flagId: 'f1' })).flagStatus).toBe('resolved');
    });

    test('rejects an arbitrary non-empty status without changing the flag', async () => {
        const db = memoryDb({
            courses: [{ courseId: 'C1', instructorId: 'i1' }],
            flaggedQuestions: [{ flagId: 'f1', courseId: 'C1', flagStatus: 'pending' }],
        });
        const res = await request(app({ db, user: instructor })).put('/f1/status').send({ status: 'banana' });
        expect(res.status).toBe(400);
        expect(res.body.message).toBe('Invalid flag status');
        expect((await db.collection('flaggedQuestions').findOne({ flagId: 'f1' })).flagStatus).toBe('pending');
    });
});

describe('GET /stats/:courseId', () => {
    test('403 when the user cannot read the course flags', async () => {
        const db = memoryDb({ courses: [{ courseId: 'C1', instructorId: 'someone-else' }] });
        expect((await request(app({ db, user: instructor })).get('/stats/C1')).status).toBe(403);
    });

    test('200 returns statistics for the course instructor', async () => {
        const db = memoryDb({
            courses: [{ courseId: 'C1', instructorId: 'i1' }],
            flaggedQuestions: [{ flagId: 'f1', courseId: 'C1', status: 'pending' }],
        });
        const res = await request(app({ db, user: instructor })).get('/stats/C1');
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({ courseId: 'C1' });
        expect(res.body.data.statistics).toBeDefined();
    });
});

describe('DELETE /:flagId', () => {
    test('the course instructor can delete a flag', async () => {
        const db = memoryDb({
            courses: [{ courseId: 'C1', instructorId: 'i1' }],
            flaggedQuestions: [{ flagId: 'f1', courseId: 'C1', status: 'pending' }],
        });
        const res = await request(app({ db, user: instructor })).delete('/f1');
        expect(res.status).toBe(200);
        expect(await db.collection('flaggedQuestions').findOne({ flagId: 'f1' })).toBeNull();
    });
});

describe('instructor and TA flag review readers', () => {
    test('GET /course filters flags and enforces course access', async () => {
        const db = memoryDb({
            courses: [{ courseId: 'C1', instructorId: 'i1' }],
            flaggedQuestions: [
                { flagId: 'f1', courseId: 'C1', flagStatus: 'pending' },
                { flagId: 'f2', courseId: 'C1', flagStatus: 'resolved' },
            ],
        });
        let res = await request(app({ db, user: instructor })).get('/course/C1?status=pending');
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({ courseId: 'C1', count: 1 });
        res = await request(app({ db, user: student })).get('/course/C1');
        expect(res.status).toBe(403);
    });

    test('GET /status scopes results to readable instructor courses', async () => {
        const db = memoryDb({
            courses: [{ courseId: 'C1', instructorId: 'i1' }, { courseId: 'C2', instructorId: 'other' }],
            flaggedQuestions: [
                { flagId: 'f1', courseId: 'C1', flagStatus: 'pending' },
                { flagId: 'f2', courseId: 'C2', flagStatus: 'pending' },
            ],
        });
        const res = await request(app({ db, user: instructor })).get('/status/pending');
        expect(res.status).toBe(200);
        expect(res.body.data.flags.map(flag => flag.flagId)).toEqual(['f1']);
        expect((await request(app({ db, user: student })).get('/status/pending')).status).toBe(403);
    });

    test('GET /:flagId returns an authorized flag and hides inaccessible flags', async () => {
        const db = memoryDb({
            courses: [{ courseId: 'C1', instructorId: 'i1' }],
            flaggedQuestions: [{ flagId: 'f1', courseId: 'C1', flagStatus: 'pending' }],
        });
        expect((await request(app({ db, user: instructor })).get('/f1')).body.data.flagId).toBe('f1');
        expect((await request(app({ db, user: student })).get('/f1')).status).toBe(403);
        expect((await request(app({ db, user: instructor })).get('/missing')).status).toBe(404);
    });
});

describe('PUT /:flagId/response', () => {
    test('validates response and access', async () => {
        expect((await request(app({ db: memoryDb({}), user: instructor })).put('/f1/response').send({})).status).toBe(400);
        const db = memoryDb({
            courses: [{ courseId: 'C1', instructorId: 'other' }],
            flaggedQuestions: [{ flagId: 'f1', courseId: 'C1' }],
        });
        expect((await request(app({ db, user: instructor })).put('/f1/response').send({ response: 'Reviewed' })).status).toBe(403);
    });

    test('persists the authenticated instructor response and optional status', async () => {
        const db = memoryDb({
            courses: [{ courseId: 'C1', instructorId: 'i1' }],
            flaggedQuestions: [{ flagId: 'f1', courseId: 'C1', flagStatus: 'pending' }],
        });
        const res = await request(app({ db, user: instructor })).put('/f1/response').send({ response: 'Corrected explanation', flagStatus: 'resolved' });
        expect(res.status).toBe(200);
        const stored = await db.collection('flaggedQuestions').findOne({ flagId: 'f1' });
        expect(stored).toMatchObject({ instructorResponse: 'Corrected explanation', flagStatus: 'resolved', instructorId: 'i1' });
    });
});

describe('POST / — validation, normalization, and Super Course flags', () => {
    test.each([
        ['an unknown reason', 'other'],
        ['markup', '<img src=x onerror=alert(1)>'],
        ['a non-string', ['incorrect']],
    ])('refuses a flag reason that is not on the list: %s', async (_label, flagReason) => {
        const db = memoryDb({});
        const res = await request(app({ db, user: student })).post('/').send({
            questionId: 'sq1', courseId: 'SUPER_COURSE', isSuperCourseFlag: true,
            flagReason, flagDescription: 'x',
        });
        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/Invalid flagReason/);
        expect(await db.collection('flaggedQuestions').find({}).toArray()).toHaveLength(0);
    });

    test.each(['incorrect', 'inappropriate', 'unclear', 'confusing', 'typo', 'offensive', 'irrelevant'])(
        'accepts the chat menu reason %s',
        async (flagReason) => {
            const db = memoryDb({});
            const res = await request(app({ db, user: student })).post('/').send({
                questionId: 'sq1', courseId: 'SUPER_COURSE', isSuperCourseFlag: true,
                flagReason, flagDescription: 'x',
            });
            expect(res.status).toBe(200);
        }
    );

    test('rejects an invalid bot mode and a missing database', async () => {
        let res = await request(app({ db: memoryDb({}), user: student }))
            .post('/').send({ ...validFlag, botMode: 'oracle' });
        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/Invalid botMode/);

        res = await request(app({ user: student })).post('/').send(validFlag);
        expect(res.status).toBe(503);
    });

    test('an instructor may create a normalized Super Course flag', async () => {
        const db = memoryDb({});
        const res = await request(app({ db, user: { ...instructor, displayName: 'Professor' } }))
            .post('/')
            .send({
                questionId: 'sq1', courseId: 'ignored', flagReason: 'irrelevant',
                flagDescription: 'Needs review', isSuperCourseFlag: true,
                sourceCourseIds: [' C1 ', 'C1', '', null, 7],
                sourceCourseNames: 'not-an-array', superchatId: 42,
            });
        expect(res.status).toBe(200);
        const stored = await db.collection('flaggedQuestions').findOne({ flagId: res.body.data.flagId });
        expect(stored).toMatchObject({
            courseId: 'SUPER_COURSE', courseName: 'Super Course', unitName: 'Super Course',
            reporterRole: 'instructor', botMode: 'supercourse-instructor',
            sourceCourseIds: ['C1', '7'], sourceCourseNames: [],
            isSuperCourseFlag: true, superchatId: null,
        });
    });

    test('accepts the sentinel course id as a Super Course flag and keeps a string superchat id', async () => {
        const db = memoryDb({});
        const res = await request(app({ db, user: student })).post('/').send({
            questionId: 'sq2', courseId: 'SUPER_COURSE', flagReason: 'incorrect',
            flagDescription: 'Nope', superchatId: 'sc1', botMode: 'supercourse-student',
        });
        expect(res.status).toBe(200);
        expect(await db.collection('flaggedQuestions').findOne({ superchatId: 'sc1' })).toBeTruthy();
    });

    test('an instructor can create an ordinary flag for a course they teach', async () => {
        const db = memoryDb({ courses: [{ courseId: 'C1', instructorId: 'i1' }] });
        const res = await request(app({ db, user: instructor })).post('/').send(validFlag);
        expect(res.status).toBe(200);
        expect(await db.collection('flaggedQuestions').findOne({ flagId: res.body.data.flagId }))
            .toMatchObject({ reporterRole: 'instructor', courseId: 'C1' });
    });

    test('falls back through course code and course id for the stored course name', async () => {
        for (const [course, expected] of [
            [{ courseId: 'C1', courseCode: 'BIO101', studentEnrollment: { s1: { enrolled: true } } }, 'BIO101'],
            [{ courseId: 'C1', studentEnrollment: { s1: { enrolled: true } } }, 'C1'],
        ]) {
            const db = memoryDb({ courses: [course] });
            const res = await request(app({ db, user: student })).post('/').send(validFlag);
            expect(res.status).toBe(200);
            expect((await db.collection('flaggedQuestions').findOne({ flagId: res.body.data.flagId })).courseName).toBe(expected);
        }
    });

    test('falls back to usernames when display names are absent', async () => {
        const db = memoryDb({ courses: [{ courseId: 'C1', studentEnrollment: { s2: { enrolled: true } } }] });
        const res = await request(app({ db, user: { userId: 's2', role: 'student', username: 'fallback-name' } }))
            .post('/').send(validFlag);
        expect(res.status).toBe(200);
        expect(await db.collection('flaggedQuestions').findOne({ studentName: 'fallback-name', reporterName: 'fallback-name' })).toBeTruthy();
    });
});

describe('GET /my — enrollment filtering and Super Course merging', () => {
    test('returns 503 without a database and 403 for an inaccessible course filter', async () => {
        expect((await request(app({ user: student })).get('/my')).status).toBe(503);
        const db = memoryDb({ courses: [{ courseId: 'C1' }] });
        expect((await request(app({ db, user: student })).get('/my?courseId=C1')).status).toBe(403);
    });

    test('filters unenrolled courses, caches enrollment checks, merges and sorts unique Super Course flags', async () => {
        const db = memoryDb({
            courses: [
                { courseId: 'C1', studentEnrollment: { s1: { enrolled: true } } },
                { courseId: 'C2' },
            ],
            flaggedQuestions: [
                { flagId: 'f1', studentId: 's1', courseId: 'C1', createdAt: '2025-01-01' },
                { flagId: 'f2', studentId: 's1', courseId: 'C1', createdAt: '2025-01-02' },
                { flagId: 'hidden', studentId: 's1', courseId: 'C2', createdAt: '2025-01-03' },
                { flagId: 'super', studentId: 's1', courseId: 'SUPER_COURSE', createdAt: '2025-02-01' },
            ],
        });
        const res = await request(app({ db, user: student })).get('/my');
        expect(res.status).toBe(200);
        expect(res.body.data.flags.map(flag => flag.flagId)).toEqual(['super', 'f2', 'f1']);
        expect(res.body.data.count).toBe(3);
    });

    test('does not perform the extra merge when explicitly filtering Super Course', async () => {
        const db = memoryDb({
            courses: [{ courseId: 'SUPER_COURSE', studentEnrollment: { s1: { enrolled: true } } }],
            flaggedQuestions: [{ flagId: 'super', studentId: 's1', courseId: 'SUPER_COURSE' }],
        });
        const res = await request(app({ db, user: student })).get('/my?courseId=SUPER_COURSE');
        expect(res.status).toBe(200);
        expect(res.body.data.flags.map(flag => flag.flagId)).toEqual(['super']);
    });

    test('deduplicates a Super Course flag already admitted by enrollment, including _id fallback keys', async () => {
        const db = memoryDb({
            courses: [{ courseId: 'SUPER_COURSE', studentEnrollment: { s1: { enrolled: true } } }],
            flaggedQuestions: [{ _id: 'mongo-id', studentId: 's1', courseId: 'SUPER_COURSE', createdAt: '2025-01-01' }],
        });
        const res = await request(app({ db, user: student })).get('/my');
        expect(res.status).toBe(200);
        expect(res.body.data.count).toBe(1);
    });
});

describe('course readers and reviewer authorization branches', () => {
    test('returns 503 from each reader when the database is unavailable', async () => {
        expect((await request(app({ user: instructor })).get('/course/C1')).status).toBe(503);
        expect((await request(app({ user: instructor })).get('/status/pending')).status).toBe(503);
        expect((await request(app({ user: instructor })).get('/f1')).status).toBe(503);
        expect((await request(app({ user: instructor })).get('/stats/C1')).status).toBe(503);
    });

    test('requires authentication and TA flags permission for course access', async () => {
        const db = memoryDb({ courses: [{
            courseId: 'C1', tas: ['t1'], taPermissions: { t1: { canAccessFlags: true } },
        }] });
        expect((await request(app({ db })).get('/course/C1')).status).toBe(403);
        const allowed = await request(app({ db, user: ta })).get('/course/C1');
        expect(allowed.status).toBe(200);

        const deniedDb = memoryDb({ courses: [{
            courseId: 'C1', tas: ['t1'], taPermissions: { t1: { canAccessFlags: false } },
        }] });
        expect((await request(app({ db: deniedDb, user: ta })).get('/course/C1')).status).toBe(403);
    });

    test('only a system-admin instructor can read Super Course flags', async () => {
        const db = memoryDb({ flaggedQuestions: [{ flagId: 'sf', courseId: 'SUPER_COURSE', flagStatus: 'pending' }] });
        expect((await request(app({ db, user: instructor })).get('/course/SUPER_COURSE')).status).toBe(403);
        const admin = { ...instructor, permissions: { systemAdmin: true } };
        expect((await request(app({ db, user: admin })).get('/course/SUPER_COURSE')).status).toBe(200);
        expect((await request(app({ db, user: { ...ta, permissions: { systemAdmin: true } } })).get('/course/SUPER_COURSE')).status).toBe(403);
    });

    test('returns an empty status result for an instructor but 403 for a TA with no readable matches', async () => {
        const db = memoryDb({
            courses: [{ courseId: 'C1', instructorId: 'other' }],
            flaggedQuestions: [{ flagId: 'f1', courseId: 'C1', flagStatus: 'pending' }],
        });
        let res = await request(app({ db, user: instructor })).get('/status/pending');
        expect(res.status).toBe(200);
        expect(res.body.data.count).toBe(0);
        res = await request(app({ db, user: ta })).get('/status/pending');
        expect(res.status).toBe(403);
    });

    test('status filtering handles repeated flags from the same readable course', async () => {
        const db = memoryDb({
            courses: [{ courseId: 'C1', instructorId: 'i1' }],
            flaggedQuestions: [
                { flagId: 'f1', courseId: 'C1', flagStatus: 'pending' },
                { flagId: 'f2', courseId: 'C1', flagStatus: 'pending' },
            ],
        });
        const res = await request(app({ db, user: instructor })).get('/status/pending');
        expect(res.status).toBe(200);
        expect(res.body.data.count).toBe(2);
    });
});

describe('mutation authorization and model failures', () => {
    const seeded = () => memoryDb({
        courses: [{ courseId: 'C1', instructorId: 'i1' }],
        flaggedQuestions: [{ flagId: 'f1', courseId: 'C1', flagStatus: 'pending' }],
    });

    test('mutation endpoints return 401 without a user and 503 without a database', async () => {
        for (const [method, path, body] of [
            ['put', '/f1/response', { response: 'x' }],
            ['put', '/f1/status', { status: 'resolved' }],
            ['delete', '/f1', undefined],
        ]) {
            let call = request(app({ db: seeded() }))[method](path);
            if (body) call = call.send(body);
            expect((await call).status).toBe(401);
            call = request(app({ user: instructor }))[method](path);
            if (body) call = call.send(body);
            expect((await call).status).toBe(503);
        }
    });

    test('a TA with flags permission can respond, update status, and delete', async () => {
        const db = memoryDb({
            courses: [{ courseId: 'C1', tas: ['t1'], taPermissions: { t1: { canAccessFlags: true } } }],
            flaggedQuestions: [
                { flagId: 'response', courseId: 'C1' },
                { flagId: 'status', courseId: 'C1' },
                { flagId: 'delete', courseId: 'C1' },
            ],
        });
        expect((await request(app({ db, user: ta })).put('/response/response').send({ response: 'Done' })).status).toBe(200);
        expect((await request(app({ db, user: ta })).put('/status/status').send({ status: 'resolved' })).status).toBe(200);
        expect((await request(app({ db, user: ta })).delete('/delete')).status).toBe(200);
    });

    test('delete returns the legacy not-found response and blocks an inaccessible instructor', async () => {
        expect((await request(app({ db: memoryDb({}), user: instructor })).delete('/missing')).status).toBe(400);
        const db = memoryDb({
            courses: [{ courseId: 'C1', instructorId: 'other' }],
            flaggedQuestions: [{ flagId: 'f1', courseId: 'C1' }],
        });
        expect((await request(app({ db, user: instructor })).delete('/f1')).status).toBe(403);
    });
});

describe('route exception handling', () => {
    const brokenDb = { collection: () => { throw new Error('database exploded'); } };

    test('returns each route-specific 500 response when persistence throws', async () => {
        const cases = [
            ['post', '/', student, validFlag, /creating flagged question/],
            ['get', '/my', student, null, /retrieving flags/],
            ['get', '/course/C1', instructor, null, /retrieving flagged questions/],
            ['get', '/status/pending', instructor, null, /retrieving flagged questions/],
            ['get', '/f1', instructor, null, /retrieving flagged question/],
            ['put', '/f1/response', instructor, { response: 'x' }, /updating instructor response/],
            ['put', '/f1/status', instructor, { status: 'resolved' }, /updating flag status/],
            ['get', '/stats/C1', instructor, null, /retrieving flag statistics/],
            ['delete', '/f1', instructor, null, /deleting flagged question/],
        ];
        for (const [method, path, user, body, message] of cases) {
            let call = request(app({ db: brokenDb, user }))[method](path);
            if (body) call = call.send(body);
            const res = await call;
            expect(res.status).toBe(500);
            expect(`${path}: ${res.body.message}`).toMatch(message);
        }
    });
});

describe('model-declared failures and rejected operations', () => {
    const db = () => memoryDb({
        courses: [{ courseId: 'C1', instructorId: 'i1', studentEnrollment: { s1: { enrolled: true } } }],
        flaggedQuestions: [{ flagId: 'f1', courseId: 'C1' }],
    });

    test.each([
        ['createFlaggedQuestion', 'post', '/', student, validFlag, 'create failed'],
        ['updateInstructorResponse', 'put', '/f1/response', instructor, { response: 'x' }, 'response failed'],
        ['updateFlagStatus', 'put', '/f1/status', instructor, { status: 'resolved' }, 'status failed'],
        ['deleteFlaggedQuestion', 'delete', '/f1', instructor, null, 'delete failed'],
    ])('%s exposes its model error as a 400', async (methodName, method, path, user, body, error) => {
        jest.spyOn(FlaggedQuestionModel, methodName).mockResolvedValueOnce({ success: false, error });
        let call = request(app({ db: db(), user }))[method](path);
        if (body) call = call.send(body);
        const res = await call;
        expect(res.status).toBe(400);
        expect(res.body.message).toBe(error);
    });

    test.each([
        ['createFlaggedQuestion', 'post', '/', student, validFlag, 'Failed to create flagged question'],
        ['updateInstructorResponse', 'put', '/f1/response', instructor, { response: 'x' }, 'Failed to update instructor response'],
        ['updateFlagStatus', 'put', '/f1/status', instructor, { status: 'resolved' }, 'Failed to update flag status'],
        ['deleteFlaggedQuestion', 'delete', '/f1', instructor, null, 'Failed to delete flagged question'],
    ])('%s uses its fallback message when the model omits an error', async (methodName, method, path, user, body, message) => {
        jest.spyOn(FlaggedQuestionModel, methodName).mockResolvedValueOnce({ success: false });
        let call = request(app({ db: db(), user }))[method](path);
        if (body) call = call.send(body);
        const res = await call;
        expect(res.status).toBe(400);
        expect(res.body.message).toBe(message);
    });

    test.each([
        ['createFlaggedQuestion', 'post', '/', student, validFlag, /creating flagged question/],
        ['getFlaggedQuestionById', 'get', '/f1', instructor, null, /retrieving flagged question/],
        ['updateInstructorResponse', 'put', '/f1/response', instructor, { response: 'x' }, /updating instructor response/],
        ['updateFlagStatus', 'put', '/f1/status', instructor, { status: 'resolved' }, /updating flag status/],
        ['getFlagStatistics', 'get', '/stats/C1', instructor, null, /retrieving flag statistics/],
        ['deleteFlaggedQuestion', 'delete', '/f1', instructor, null, /deleting flagged question/],
    ])('%s rejection reaches the route-specific 500 handler', async (methodName, method, path, user, body, message) => {
        jest.spyOn(FlaggedQuestionModel, methodName).mockRejectedValueOnce(new Error('forced rejection'));
        let call = request(app({ db: db(), user }))[method](path);
        if (body) call = call.send(body);
        const res = await call;
        expect(res.status).toBe(500);
        expect(res.body.message).toMatch(message);
    });
});
