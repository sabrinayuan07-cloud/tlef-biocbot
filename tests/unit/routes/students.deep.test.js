/**
 * Deeper in-process route tests for src/routes/students.js (supertest) — the
 * instructor/admin views of a student's chat sessions (list, single, delete) not
 * covered by students.test.js (which exercises the student-facing "own" routes).
 * No heavy deps: chat_sessions + courses over the in-memory Mongo + req.user.
 */
const { memoryDb } = require('../helpers/memory-db');
const { makeRouteApp, request } = require('../helpers/route-app');
const studentsRouter = require('../../../src/routes/students');

const adminInstructor = { userId: 'i1', role: 'instructor', permissions: { systemAdmin: true } };
const plainInstructor = { userId: 'i1', role: 'instructor' };
const student = { userId: 's1', role: 'student' };
const app = (opts) => makeRouteApp(studentsRouter, opts);

const ownedCourse = { courseId: 'C1', instructorId: 'i1' };
const session = (over = {}) => ({
    sessionId: 'sess1', courseId: 'C1', studentId: 's1', studentName: 'Alice',
    savedAt: new Date('2026-02-01'), isDeleted: false, ...over,
});

beforeAll(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterAll(() => jest.restoreAllMocks());

describe('GET /:courseId/:studentId/sessions — admin list', () => {
    test('401 without a user, 403 for a plain (non-admin) instructor', async () => {
        expect((await request(app({ db: memoryDb({}) })).get('/C1/s1/sessions')).status).toBe(401);
        expect((await request(app({ db: memoryDb({}), user: plainInstructor })).get('/C1/s1/sessions')).status).toBe(403);
    });

    test('allows a system admin to read a course they do not teach', async () => {
        const db = memoryDb({ courses: [{ courseId: 'C1', instructorId: 'someone-else' }] });
        const res = await request(app({ db, user: adminInstructor })).get('/C1/s1/sessions');
        expect(res.status).toBe(200);
    });

    test('503 when the db is unavailable', async () => {
        const res = await request(app({ db: null, user: adminInstructor })).get('/C1/s1/sessions');
        expect(res.status).toBe(503);
    });

    test('returns the student\'s non-deleted sessions with a recalculated duration', async () => {
        const db = memoryDb({
            courses: [ownedCourse],
            chat_sessions: [
                session({ sessionId: 'a' }),
                session({ sessionId: 'b', isDeleted: true }), // soft-deleted by instructor → hidden
                session({ sessionId: 'c', studentId: 's2' }), // different student
            ],
        });
        // session() has no chatData (no student message), so 'a' would
        // otherwise be excluded by default (#519) - include it here since
        // this test is about deletion-mode filtering, not the message filter.
        const res = await request(app({ db, user: adminInstructor })).get('/C1/s1/sessions?includeEmptyChats=true');
        expect(res.status).toBe(200);
        expect(res.body.data.sessions.map(s => s.sessionId)).toEqual(['a']);
        expect(res.body.data.studentName).toBe('Alice');
        expect(res.body.data.sessions[0]).toHaveProperty('duration');
    });

    test('excludes a session with no student message by default; includeEmptyChats=true brings it back (#519)', async () => {
        const db = memoryDb({
            courses: [ownedCourse],
            chat_sessions: [session({ sessionId: 'a' })], // no chatData -> no student message
        });

        const defaultRes = await request(app({ db, user: adminInstructor })).get('/C1/s1/sessions');
        expect(defaultRes.body.data.sessions).toEqual([]);

        const includedRes = await request(app({ db, user: adminInstructor })).get('/C1/s1/sessions?includeEmptyChats=true');
        expect(includedRes.body.data.sessions.map(s => s.sessionId)).toEqual(['a']);
    });

    test('500 when a database read fails', async () => {
        const db = { collection: () => ({ findOne: async () => { throw new Error('db down'); } }) };
        const res = await request(app({ db, user: adminInstructor })).get('/C1/s1/sessions');
        expect(res.status).toBe(500);
    });
});

describe('GET /:courseId/:studentId/sessions/:sessionId — admin single', () => {
    test('401 without a user, 503 without a db, and 403 for a non-admin', async () => {
        expect((await request(app({ db: memoryDb({}) })).get('/C1/s1/sessions/sess1')).status).toBe(401);
        expect((await request(app({ db: null, user: adminInstructor })).get('/C1/s1/sessions/sess1')).status).toBe(503);
        expect((await request(app({ db: memoryDb({}), user: plainInstructor })).get('/C1/s1/sessions/sess1')).status).toBe(403);
    });

    test('404 when the admin has no access to the course', async () => {
        const db = memoryDb({ courses: [{ courseId: 'C1', instructorId: 'other' }] });
        expect((await request(app({ db, user: adminInstructor })).get('/C1/s1/sessions/sess1')).status).toBe(404);
    });

    test('404 when the session does not exist', async () => {
        const db = memoryDb({ courses: [ownedCourse], chat_sessions: [] });
        const res = await request(app({ db, user: adminInstructor })).get('/C1/s1/sessions/missing');
        expect(res.status).toBe(404);
    });

    test('200 returns the full session for download', async () => {
        const db = memoryDb({ courses: [ownedCourse], chat_sessions: [session()] });
        const res = await request(app({ db, user: adminInstructor })).get('/C1/s1/sessions/sess1');
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({ sessionId: 'sess1', studentId: 's1' });
        expect(res.body.data).toHaveProperty('duration');
    });

    test('500 when a database read fails', async () => {
        const db = { collection: () => ({ findOne: async () => { throw new Error('db down'); } }) };
        expect((await request(app({ db, user: adminInstructor })).get('/C1/s1/sessions/sess1')).status).toBe(500);
    });
});

describe('DELETE /:courseId/:studentId/sessions/:sessionId — instructor soft delete', () => {
    test('401 without a user and 500 without a db', async () => {
        expect((await request(app({ db: memoryDb({}) })).delete('/C1/s1/sessions/sess1')).status).toBe(401);
        expect((await request(app({ db: null, user: plainInstructor })).delete('/C1/s1/sessions/sess1')).status).toBe(500);
    });

    test('403 for a student', async () => {
        const db = memoryDb({ chat_sessions: [session()] });
        const res = await request(app({ db, user: student })).delete('/C1/s1/sessions/sess1');
        expect(res.status).toBe(403);
    });

    test('404 when the session is missing', async () => {
        const db = memoryDb({ courses: [{ courseId: 'C1', instructorId: 'i1' }], chat_sessions: [] });
        const res = await request(app({ db, user: plainInstructor })).delete('/C1/s1/sessions/missing');
        expect(res.status).toBe(404);
    });

    test('a plain instructor (no admin) can soft-delete the session', async () => {
        const db = memoryDb({ courses: [{ courseId: 'C1', instructorId: 'i1' }], chat_sessions: [session()] });
        const res = await request(app({ db, user: plainInstructor })).delete('/C1/s1/sessions/sess1');
        expect(res.status).toBe(200);
        expect((await db.collection('chat_sessions').findOne({ sessionId: 'sess1' })).isDeleted).toBe(true);
    });

    test('403 when an instructor does not own the course', async () => {
        const db = memoryDb({ courses: [{ courseId: 'C1', instructorId: 'other' }], chat_sessions: [session()] });
        expect((await request(app({ db, user: plainInstructor })).delete('/C1/s1/sessions/sess1')).status).toBe(403);
    });

    test('500 when the session lookup fails', async () => {
        const db = { collection: () => ({ findOne: async () => { throw new Error('db down'); } }) };
        expect((await request(app({ db, user: plainInstructor })).delete('/C1/s1/sessions/sess1')).status).toBe(500);
    });

    test('404 when the session disappears between lookup and update', async () => {
        const db = { collection: () => ({
            findOne: async () => ({ sessionId: 'sess1' }),
            updateOne: async () => ({ matchedCount: 0 }),
        }) };
        expect((await request(app({ db, user: plainInstructor })).delete('/C1/s1/sessions/sess1')).status).toBe(404);
    });
});
