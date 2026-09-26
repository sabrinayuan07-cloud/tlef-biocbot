/**
 * In-process route tests for src/routes/courses.js (supertest) — a cross-section
 * of the large router: the instructor course list, single-course access, and TA
 * management. Heavy collaborators (Qdrant vector service, GridFS, the LLM key
 * store/middleware) are mocked so requiring the router is side-effect-free; the
 * Course model runs for real over the in-memory Mongo.
 */
jest.mock('../../../src/services/qdrantService', () => jest.fn().mockImplementation(() => ({
    initialize: jest.fn().mockResolvedValue(undefined),
})));
jest.mock('../../../src/services/gridfs', () => ({}));
// Real provider-state readers (publicProviderKeyState / credentialSetFields /
// readProviderState) so per-course provider resolution is exercised; only
// crypto and the network probe are stubbed.
jest.mock('../../../src/services/llmKeyStore', () => {
    const actual = jest.requireActual('../../../src/services/llmKeyStore');
    return {
        ...actual,
        buildKeySubdocument: jest.fn((apiKey, userId, provider) => ({
            ciphertext: 'encrypted', last4: '1234', status: 'valid', provider: provider || 'openai',
            validatedAt: new Date(), updatedAt: new Date(), updatedBy: userId || null,
        })),
        decryptApiKey: jest.fn(() => 'sk'),
        validateApiKey: jest.fn(async () => ({ ok: true })),
        validateProviderKey: jest.fn(async () => ({ ok: true, status: 'valid', provider: 'openai' })),
    };
});
jest.mock('../../../src/routes/llmKeyMiddleware', () => ({ resolveCourseAi: jest.fn() }));

const { memoryDb } = require('../helpers/memory-db');
const { makeRouteApp, request } = require('../helpers/route-app');
const coursesRouter = require('../../../src/routes/courses');

const instructor = { userId: 'i1', role: 'instructor', puid: 'PUID-I1' };
const otherInstructor = { userId: 'i2', role: 'instructor' };
const ta = { userId: 't1', role: 'ta' };
const student = { userId: 's1', role: 'student' };
const app = (opts) => makeRouteApp(coursesRouter, opts);

beforeAll(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterAll(() => jest.restoreAllMocks());

describe('GET / — instructor course list', () => {
    test('401 without a user', async () => {
        expect((await request(app({ db: memoryDb({}) })).get('/')).status).toBe(401);
    });

    test('403 for a non-instructor', async () => {
        expect((await request(app({ db: memoryDb({}), user: student })).get('/')).status).toBe(403);
    });

    test('503 when the db is unavailable', async () => {
        expect((await request(app({ db: null, user: instructor })).get('/')).status).toBe(503);
    });

    test('200 returns the instructor\'s active courses, transformed, excluding deleted', async () => {
        const db = memoryDb({ courses: [
            { courseId: 'C1', courseName: 'Bio', instructorId: 'i1', llmApiKey: { ciphertext: 'k', status: 'valid', last4: '1234' }, courseStructure: { weeks: 2, lecturesPerWeek: 3, totalUnits: 6 } },
            { courseId: 'C2', courseName: 'Gone', instructorId: 'i1', status: 'deleted' },
            { courseId: 'C3', courseName: 'Other', instructorId: 'someone-else' },
        ] });
        const res = await request(app({ db, user: instructor })).get('/');
        expect(res.status).toBe(200);
        expect(res.body.data).toHaveLength(1);
        expect(res.body.data[0]).toMatchObject({ id: 'C1', name: 'Bio', aiAvailable: true, weeks: 2, totalUnits: 6 });
    });
});

describe('GET /:courseId', () => {
    test('401 without a user', async () => {
        expect((await request(app({ db: memoryDb({}) })).get('/C1')).status).toBe(401);
    });

    test('404 when the instructor has no access to the course', async () => {
        const db = memoryDb({ courses: [{ courseId: 'C1', instructorId: 'someone-else' }] });
        expect((await request(app({ db, user: instructor })).get('/C1')).status).toBe(404);
    });

    test('200 for the course instructor', async () => {
        const db = memoryDb({ courses: [{ courseId: 'C1', courseName: 'Bio', instructorId: 'i1' }] });
        const res = await request(app({ db, user: instructor })).get('/C1');
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });

    test('200 for a TA assigned to the course', async () => {
        const db = memoryDb({ courses: [{ courseId: 'C1', courseName: 'Bio', tas: ['t1'] }] });
        expect((await request(app({ db, user: ta })).get('/C1')).status).toBe(200);
    });
});

describe('POST /:courseId/tas — add a TA', () => {
    test('403 for a non-instructor', async () => {
        expect((await request(app({ db: memoryDb({}), user: ta })).post('/C1/tas').send({ taId: 't2' })).status).toBe(403);
    });

    test('400 when taId is missing', async () => {
        const db = memoryDb({ courses: [{ courseId: 'C1', instructorId: 'i1' }] });
        expect((await request(app({ db, user: instructor })).post('/C1/tas').send({})).status).toBe(400);
    });

    test('200 adds the TA and persists it', async () => {
        const db = memoryDb({ courses: [{ courseId: 'C1', instructorId: 'i1' }] });
        const res = await request(app({ db, user: instructor })).post('/C1/tas').send({ taId: 't1' });
        expect(res.status).toBe(200);
        expect((await db.collection('courses').findOne({ courseId: 'C1' })).tas).toContain('t1');
    });

    test('400 when the course does not exist', async () => {
        const res = await request(app({ db: memoryDb({ courses: [] }), user: instructor })).post('/NOPE/tas').send({ taId: 't1' });
        expect(res.status).toBe(400);
    });
});

describe('approved struggle topics', () => {
    function topicsDb(overrides = {}) {
        return memoryDb({ courses: [{
            courseId: 'C1', instructorId: 'i1', tas: ['t1'],
            lectures: [{ name: 'Unit 1' }, { name: 'Unit 2' }],
            approvedStruggleTopics: ['Enzyme Kinetics', { topic: 'Protein Folding', unitId: 'Unit 2', source: 'manual' }],
            ...overrides,
        }] });
    }

    test('GET requires authentication and course access', async () => {
        expect((await request(app({ db: topicsDb() })).get('/C1/approved-topics')).status).toBe(401);
        expect((await request(app({ db: topicsDb(), user: otherInstructor })).get('/C1/approved-topics')).status).toBe(403);
    });

    test('GET returns normalized objects and labels to an enrolled student', async () => {
        const db = topicsDb({ studentEnrollment: { s1: { enrolled: true } } });
        const res = await request(app({ db, user: student })).get('/C1/approved-topics');
        expect(res.status).toBe(200);
        expect(res.body.data.topicLabels).toEqual(['Enzyme Kinetics', 'Protein Folding']);
        expect(res.body.data.topics[1]).toMatchObject({ topic: 'Protein Folding', unitId: 'Unit 2' });
    });

    test('PUT validates the topics array and blocks a TA without course permission', async () => {
        expect((await request(app({ db: topicsDb(), user: instructor })).put('/C1/approved-topics').send({ topics: 'ATP' })).status).toBe(400);

        const db = topicsDb({ taPermissions: { t1: { canAccessCourses: false, canAccessFlags: true } } });
        expect((await request(app({ db, user: ta })).put('/C1/approved-topics').send({ topics: ['ATP'] })).status).toBe(403);
    });

    test('PUT replaces, normalizes, and persists topics for the instructor', async () => {
        const db = topicsDb();
        const res = await request(app({ db, user: instructor })).put('/C1/approved-topics').send({
            topics: ['  ATP Synthesis ', 'atp synthesis', { topic: 'Membrane Transport', unitId: 'Unit 1' }],
        });
        expect(res.status).toBe(200);
        expect(res.body.data.topicLabels).toEqual(['ATP Synthesis', 'Membrane Transport']);
        const stored = await db.collection('courses').findOne({ courseId: 'C1' });
        expect(stored.lastUpdatedById).toBe('i1');
        expect(stored.approvedStruggleTopics).toHaveLength(2);
    });

    test('PATCH rejects unknown topics and units', async () => {
        expect((await request(app({ db: topicsDb(), user: instructor }))
            .patch('/C1/approved-topics/unit').send({ topic: 'Unknown', unitId: 'Unit 1' })).status).toBe(404);
        const invalidUnit = await request(app({ db: topicsDb(), user: instructor }))
            .patch('/C1/approved-topics/unit').send({ topic: 'Enzyme Kinetics', unitId: 'Unit 99' });
        expect(invalidUnit.status).toBe(400);
    });

    test('PATCH converts a legacy string topic and assigns its unit', async () => {
        const db = topicsDb();
        const res = await request(app({ db, user: instructor }))
            .patch('/C1/approved-topics/unit').send({ topic: 'enzyme kinetics', unitId: 'Unit 1' });
        expect(res.status).toBe(200);
        expect(res.body.data.topic).toMatchObject({ topic: 'Enzyme Kinetics', unitId: 'Unit 1' });
        const stored = await db.collection('courses').findOne({ courseId: 'C1' });
        expect(stored.approvedStruggleTopics[0]).toMatchObject({ topic: 'Enzyme Kinetics', unitId: 'Unit 1' });
    });
});

describe('available and joinable course lists', () => {
    test('GET /available/all returns active courses and enrollment state for a student', async () => {
        const db = memoryDb({ courses: [
            { courseId: 'C1', courseName: 'Bio', status: 'active', studentEnrollment: { s1: { enrolled: true } } },
            { courseId: 'C2', courseName: 'Chem', status: 'inactive' },
            { courseId: 'C3', courseName: 'Gone', status: 'deleted' },
        ] });
        const res = await request(app({ db, user: student })).get('/available/all');
        expect(res.status).toBe(200);
        expect(res.body.data).toHaveLength(1);
        expect(res.body.data[0]).toMatchObject({ courseId: 'C1', isEnrolled: true, status: 'active' });
    });

    test('with the academic API off, a student can browse active courses they are not enrolled in', async () => {
        const db = memoryDb({ courses: [ // no global setting → gate off (default)
            { courseId: 'C1', courseName: 'Bio', status: 'active', studentEnrollment: { s1: { enrolled: true } } },
            { courseId: 'C2', courseName: 'Chem', status: 'active' },
        ] });
        const res = await request(app({ db, user: student })).get('/available/all');
        expect(res.status).toBe(200);
        expect(res.body.data.map(course => course.courseId)).toEqual(['C1', 'C2']);
        expect(res.body.data.find(course => course.courseId === 'C2')).toMatchObject({ isEnrolled: false });
    });

    test('with the academic API on, a student only sees courses they are enrolled in', async () => {
        const db = memoryDb({
            settings: [{ _id: 'global', academicApiEnabled: true }],
            courses: [
                { courseId: 'C1', courseName: 'Bio', status: 'active', studentEnrollment: { s1: { enrolled: true } } },
                { courseId: 'C2', courseName: 'Chem', status: 'active' },
            ]
        });
        const res = await request(app({ db, user: student })).get('/available/all');
        expect(res.status).toBe(200);
        expect(res.body.data.map(course => course.courseId)).toEqual(['C1']);
    });

    test('GET /available/all limits instructors to courses they own or co-teach', async () => {
        const db = memoryDb({ courses: [
            { courseId: 'C1', instructorId: 'i1' },
            { courseId: 'C2', instructorId: 'owner', instructors: ['i1'] },
            { courseId: 'C3', instructorId: 'owner' },
        ] });
        const res = await request(app({ db, user: instructor })).get('/available/all');
        expect(res.body.data.map(course => course.courseId)).toEqual(['C1', 'C2']);
    });

    test('GET /available/all does not reintroduce inactive courses for TAs', async () => {
        const db = memoryDb({ courses: [
            { courseId: 'ACTIVE', status: 'active', tas: [] },
            { courseId: 'ASSIGNED-INACTIVE', status: 'inactive', tas: ['t1'] },
            { courseId: 'INVITED-INACTIVE', status: 'inactive', tas: [] },
        ] });
        const invitedTa = { ...ta, invitedCourses: ['INVITED-INACTIVE'] };
        const res = await request(app({ db, user: invitedTa })).get('/available/all');
        expect(res.status).toBe(200);
        expect(res.body.data.map(course => course.courseId)).toEqual(['ACTIVE']);
    });

    test('GET /available/joinable rejects non-instructors', async () => {
        expect((await request(app({ db: memoryDb({}), user: student })).get('/available/joinable')).status).toBe(403);
    });

    test('GET /available/joinable excludes courses the instructor already teaches', async () => {
        const db = memoryDb({ courses: [
            { courseId: 'own', instructorId: 'i1' },
            { courseId: 'shared', instructorId: 'owner', instructors: ['i1'] },
            { courseId: 'open', courseName: 'Open', instructorId: 'owner' },
            { courseId: 'deleted', instructorId: 'owner', status: 'deleted' },
        ] });
        const res = await request(app({ db, user: instructor })).get('/available/joinable');
        expect(res.status).toBe(200);
        expect(res.body.data.map(course => course.courseId)).toEqual(['open']);
    });
});

describe('canonical course status updates', () => {
    test('rejects non-canonical status strings', async () => {
        const db = memoryDb({ courses: [{ courseId: 'C1', instructorId: 'i1', status: 'active' }] });
        const res = await request(app({ db, user: instructor }))
            .put('/C1').send({ instructorId: 'i1', status: 'archived' });
        expect(res.status).toBe(400);
        expect((await db.collection('courses').findOne({ courseId: 'C1' })).status).toBe('active');
    });
});

describe('joining courses', () => {
    test('student join requires a code and rejects an invalid code', async () => {
        const db = memoryDb({ courses: [{ courseId: 'C1', courseCode: 'ABC123' }] });
        expect((await request(app({ db, user: student })).post('/C1/join').send({})).status).toBe(400);
        expect((await request(app({ db, user: student })).post('/C1/join').send({ code: 'wrong' })).status).toBe(403);
    });

    test('student join accepts a case-insensitive code and persists enrollment', async () => {
        const db = memoryDb({ courses: [{ courseId: 'C1', courseCode: 'ABC123' }] });
        const res = await request(app({ db, user: student })).post('/C1/join').send({ code: ' abc123 ' });
        expect(res.status).toBe(200);
        expect(res.body.data).toEqual({ courseId: 'C1', enrolled: true });
        expect((await db.collection('courses').findOne({ courseId: 'C1' })).studentEnrollment.s1.enrolled).toBe(true);
    });

    test('student join cannot override an instructor revocation', async () => {
        const db = memoryDb({ courses: [{ courseId: 'C1', courseCode: 'ABC123', studentEnrollment: { s1: { enrolled: false } } }] });
        const res = await request(app({ db, user: student })).post('/C1/join').send({ code: 'ABC123' });
        expect(res.status).toBe(403);
        expect(res.body.message).toBe('Access revoked by instructor');
    });

    test('TA join requires a code when not assigned or invited', async () => {
        const db = memoryDb({ courses: [{ courseId: 'C1', courseCode: 'TA1234', tas: [] }] });
        expect((await request(app({ db, user: ta })).post('/C1/join').send({})).status).toBe(400);
        expect((await request(app({ db, user: ta })).post('/C1/join').send({ code: 'bad' })).status).toBe(403);
    });

    test('invited TA joins without a code and the invitation is removed', async () => {
        const invitedTA = { ...ta, invitedCourses: ['C1'] };
        const db = memoryDb({
            courses: [{ courseId: 'C1', courseName: 'Bio', tas: [] }],
            users: [{ userId: 't1', role: 'ta', invitedCourses: ['C1', 'C2'] }],
        });
        const res = await request(app({ db, user: invitedTA })).post('/C1/join').send({});
        expect(res.status).toBe(200);
        expect((await db.collection('courses').findOne({ courseId: 'C1' })).tas).toContain('t1');
        expect((await db.collection('users').findOne({ userId: 't1' })).invitedCourses).toEqual(['C2']);
    });

    test('instructor join validates identity and instructor code', async () => {
        const db = memoryDb({ courses: [{ courseId: 'C1', instructorId: 'owner', instructorCourseCode: 'INST12' }] });
        expect((await request(app({ db, user: instructor })).post('/C1/instructors').send({ instructorId: 'someone-else', code: 'INST12' })).status).toBe(403);
        expect((await request(app({ db, user: instructor })).post('/C1/instructors').send({ instructorId: 'i1', code: 'bad' })).status).toBe(403);
    });

    test('instructor joins with the correct code and is persisted as a co-instructor', async () => {
        const db = memoryDb({ courses: [{ courseId: 'C1', instructorId: 'owner', instructorCourseCode: 'INST12' }] });
        const res = await request(app({ db, user: instructor })).post('/C1/instructors').send({ instructorId: 'i1', code: ' inst12 ' });
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({ courseId: 'C1', instructorId: 'i1', alreadyJoined: false });
        expect((await db.collection('courses').findOne({ courseId: 'C1' })).instructors).toContain('i1');
    });

    test('instructor of record joins an academically linked course without a code', async () => {
        const db = memoryDb({
            settings: [{ _id: 'global', academicApiEnabled: true }],
            courses: [{
                courseId: 'C1',
                instructorId: 'owner',
                instructorCourseCode: 'INST12',
                academicSync: { academicPeriod: 'AP-2026W1', sectionIds: ['SEC-BIOC302-101'] }
            }]
        });
        const academicApi = {
            getInstructorSections: jest.fn().mockResolvedValue([
                { courseSectionId: 'SEC-BIOC302-101' }
            ])
        };

        const status = await request(app({ db, user: instructor, locals: { academicApi } }))
            .get('/C1/instructor-join-status');
        expect(status.status).toBe(200);
        expect(status.body.data).toMatchObject({ requiresCode: false, reason: 'instructorOfRecord' });

        const joined = await request(app({ db, user: instructor, locals: { academicApi } }))
            .post('/C1/instructors').send({ instructorId: 'i1' });
        expect(joined.status).toBe(200);
        expect((await db.collection('courses').findOne({ courseId: 'C1' })).instructors).toContain('i1');
        expect(academicApi.getInstructorSections).toHaveBeenCalledWith('PUID-I1', 'AP-2026W1');
    });

    test('academic verification fails closed and still requires the instructor code', async () => {
        const db = memoryDb({
            settings: [{ _id: 'global', academicApiEnabled: true }],
            courses: [{
                courseId: 'C1',
                instructorId: 'owner',
                instructorCourseCode: 'INST12',
                academicSync: { academicPeriod: 'AP-2026W1', sectionIds: ['SEC-BIOC302-101'] }
            }]
        });
        const academicApi = { getInstructorSections: jest.fn().mockRejectedValue(new Error('API unavailable')) };

        const status = await request(app({ db, user: instructor, locals: { academicApi } }))
            .get('/C1/instructor-join-status');
        expect(status.status).toBe(200);
        expect(status.body.data).toMatchObject({ requiresCode: true, reason: 'courseCode' });
        expect(academicApi.getInstructorSections).toHaveBeenCalled();

        const joined = await request(app({ db, user: instructor, locals: { academicApi } }))
            .post('/C1/instructors').send({ instructorId: 'i1' });
        expect(joined.status).toBe(400);
        expect(joined.body.message).toMatch(/course code is required/i);
    });

    test('with the academic API off, instructor-of-record never verifies and a code is required', async () => {
        const db = memoryDb({ courses: [{ // no global setting → gate off (default)
            courseId: 'C1',
            instructorId: 'owner',
            instructorCourseCode: 'INST12',
            academicSync: { academicPeriod: 'AP-2026W1', sectionIds: ['SEC-BIOC302-101'] }
        }] });
        const academicApi = {
            getInstructorSections: jest.fn().mockResolvedValue([{ courseSectionId: 'SEC-BIOC302-101' }])
        };

        const status = await request(app({ db, user: instructor, locals: { academicApi } }))
            .get('/C1/instructor-join-status');
        expect(status.status).toBe(200);
        expect(status.body.data).toMatchObject({ requiresCode: true, reason: 'courseCode' });
        // Gated off: we never even reach the academic API.
        expect(academicApi.getInstructorSections).not.toHaveBeenCalled();
    });
});

describe('TA removal and permissions', () => {
    function taDb(overrides = {}, users = [{ userId: 't1', role: 'ta', invitedCourses: [] }]) {
        return memoryDb({
            courses: [{ courseId: 'C1', instructorId: 'i1', tas: ['t1'], ...overrides }],
            users,
        });
    }

    test('DELETE TA requires the owning instructor', async () => {
        expect((await request(app({ db: taDb(), user: ta })).delete('/C1/tas/t1')).status).toBe(403);
        expect((await request(app({ db: taDb(), user: otherInstructor })).delete('/C1/tas/t1')).status).toBe(403);
    });

    test('DELETE TA removes permissions and demotes a TA with no remaining assignments', async () => {
        const db = taDb({ taPermissions: { t1: { canAccessCourses: true, canAccessFlags: true } } });
        const res = await request(app({ db, user: instructor })).delete('/C1/tas/t1');
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({ taId: 't1', remainingCourseCount: 0, role: 'student' });
        const course = await db.collection('courses').findOne({ courseId: 'C1' });
        const user = await db.collection('users').findOne({ userId: 't1' });
        expect(course.tas).not.toContain('t1');
        expect(course.taPermissions.t1).toBeUndefined();
        expect(user.role).toBe('student');
    });

    test('PUT permissions rejects an empty/unrecognized body and validates course ownership', async () => {
        expect((await request(app({ db: taDb(), user: instructor })).put('/C1/ta-permissions/t1').send({ notAPermission: true })).status).toBe(400);
        expect((await request(app({ db: taDb({ instructorId: 'owner' }), user: instructor })).put('/C1/ta-permissions/t1')
            .send({ materials: true, flags: false })).status).toBe(403);
    });

    test('PUT permissions accepts a partial patch and only changes the keys sent', async () => {
        const db = taDb();
        const res = await request(app({ db, user: instructor })).put('/C1/ta-permissions/t1')
            .send({ materials: false, flags: true });
        expect(res.status).toBe(200);
        expect(res.body.data.permissions).toMatchObject({ materials: false, flags: true, questions: false, roster: false });
        expect((await db.collection('courses').findOne({ courseId: 'C1' })).taPermissions.t1)
            .toMatchObject({ materials: false, flags: true });

        // A second, single-key patch must not clobber the first change.
        const res2 = await request(app({ db, user: instructor })).put('/C1/ta-permissions/t1').send({ roster: true });
        expect(res2.body.data.permissions).toMatchObject({ materials: false, flags: true, roster: true });
    });

    test('PUT permissions accepts a named role preset', async () => {
        const db = taDb();
        const res = await request(app({ db, user: instructor })).put('/C1/ta-permissions/t1').send({ role: 'grader' });
        expect(res.status).toBe(200);
        expect(res.body.data.permissions).toEqual({ materials: false, questions: false, flags: true, roster: true, transcripts: false, settings: false });
        expect(res.body.data.roleLabel).toBe('grader');
    });

    test('GET one permission allows a TA to view only their own defaults (fail-closed)', async () => {
        const res = await request(app({ db: taDb(), user: ta })).get('/C1/ta-permissions/t1');
        expect(res.status).toBe(200);
        expect(res.body.data.permissions).toEqual({ materials: false, questions: false, flags: false, roster: false, transcripts: false, settings: false });
        expect(res.body.data.roleLabel).toBe('custom');
        expect((await request(app({ db: taDb(), user: ta })).get('/C1/ta-permissions/t2')).status).toBe(403);
    });

    test('GET all permissions returns explicit and default values, with a roleLabel, for every TA', async () => {
        const db = taDb({
            tas: ['t1', 't2'],
            taPermissions: { t1: { materials: false, questions: false, flags: true, roster: true, transcripts: false, settings: false } },
        });
        const res = await request(app({ db, user: instructor })).get('/C1/ta-permissions');
        expect(res.status).toBe(200);
        expect(res.body.data.taPermissions).toEqual({
            t1: { materials: false, questions: false, flags: true, roster: true, transcripts: false, settings: false, roleLabel: 'grader' },
            t2: { materials: false, questions: false, flags: false, roster: false, transcripts: false, settings: false, roleLabel: 'custom' },
        });
    });
});

describe('student enrollment management', () => {
    test('PUT validates boolean enrollment and instructor ownership', async () => {
        const db = memoryDb({ courses: [{ courseId: 'C1', instructorId: 'i1' }] });
        expect((await request(app({ db, user: instructor })).put('/C1/student-enrollment/s1').send({ enrolled: 'yes' })).status).toBe(400);
        expect((await request(app({ db, user: student })).put('/C1/student-enrollment/s1').send({ enrolled: true })).status).toBe(403);
        expect((await request(app({ db, user: otherInstructor })).put('/C1/student-enrollment/s1').send({ enrolled: true })).status).toBe(403);
    });

    test('PUT persists a revoked enrollment', async () => {
        const db = memoryDb({ courses: [{ courseId: 'C1', instructorId: 'i1' }] });
        const res = await request(app({ db, user: instructor })).put('/C1/student-enrollment/s1').send({ enrolled: false });
        expect(res.status).toBe(200);
        expect(res.body.data).toEqual({ courseId: 'C1', studentId: 's1', enrolled: false });
        expect((await db.collection('courses').findOne({ courseId: 'C1' })).studentEnrollment.s1.enrolled).toBe(false);
    });

    test('GET enrollment is student-only and reports explicit bans', async () => {
        const db = memoryDb({ courses: [{ courseId: 'C1', studentEnrollment: { s1: { enrolled: false } } }] });
        expect((await request(app({ db })).get('/C1/student-enrollment')).status).toBe(401);
        expect((await request(app({ db, user: instructor })).get('/C1/student-enrollment')).status).toBe(403);
        const res = await request(app({ db, user: student })).get('/C1/student-enrollment');
        expect(res.status).toBe(200);
        expect(res.body.data).toEqual({ courseId: 'C1', enrolled: false, status: 'banned' });
    });

    test('GET students merges preference, chat, and enrollment-only students', async () => {
        const db = memoryDb({
            courses: [{ courseId: 'C1', courseName: 'Bio', instructorId: 'i1', studentEnrollment: {
                s1: { enrolled: false }, s3: { enrolled: true },
            } }],
            users: [
                { userId: 's1', role: 'student', isActive: true, displayName: 'Alpha', preferences: { courseId: 'C1' } },
                { userId: 's2', role: 'student', isActive: true, displayName: 'Beta' },
            ],
            chat_sessions: [{ studentId: 's2', courseId: 'C1' }],
        });
        const res = await request(app({ db, user: instructor })).get('/C1/students');
        expect(res.status).toBe(200);
        expect(res.body.data.totalStudents).toBe(3);
        expect(res.body.data.students.map(s => s.userId)).toEqual(['s1', 's2', 's3']);
        expect(res.body.data.students.find(s => s.userId === 's1').enrolled).toBe(false);
        expect(res.body.data.students.find(s => s.userId === 's3')).toMatchObject({ displayName: 's3', enrolled: true });
    });

    test('GET students blocks a TA whose roster permission is disabled', async () => {
        const db = memoryDb({ courses: [{
            courseId: 'C1', tas: ['t1'], taPermissions: { t1: { materials: true, roster: false } },
        }] });
        const res = await request(app({ db, user: ta })).get('/C1/students');
        expect(res.status).toBe(403);
        expect(res.body.message).toMatch(/permission to view the student roster/);
    });
});
