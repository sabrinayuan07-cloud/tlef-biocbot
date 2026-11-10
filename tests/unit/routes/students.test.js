/**
 * In-process route tests for src/routes/students.js (supertest).
 * No heavy deps to mock — the router only uses req.app.locals.db (chat_sessions
 * + courses) and req.user. Exercises the auth gates, the student-grouping +
 * duration logic, and the rename / student-delete write paths.
 */
const { memoryDb } = require('../helpers/memory-db');
const { makeRouteApp, request } = require('../helpers/route-app');
const studentsRouter = require('../../../src/routes/students');

const adminInstructor = { userId: 'i1', role: 'instructor', permissions: { systemAdmin: true } };
const plainInstructor = { userId: 'i1', role: 'instructor' }; // not a system admin
const student = (id) => ({ userId: id, role: 'student' });

beforeAll(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterAll(() => jest.restoreAllMocks());

describe('GET /:courseId — instructor-admin student list', () => {
    test('401 without a user', async () => {
        const res = await request(makeRouteApp(studentsRouter, { db: memoryDb({}) })).get('/C1');
        expect(res.status).toBe(401);
    });

    test('503 when the db is unavailable', async () => {
        const res = await request(makeRouteApp(studentsRouter, { db: null, user: adminInstructor })).get('/C1');
        expect(res.status).toBe(503);
    });

    test('403 for a plain instructor (download data is system-admin only)', async () => {
        const res = await request(makeRouteApp(studentsRouter, { db: memoryDb({}), user: plainInstructor })).get('/C1');
        expect(res.status).toBe(403);
        expect(res.body.message).toMatch(/system admins/i);
    });

    test('system admins can download from courses they do not teach', async () => {
        const db = memoryDb({ courses: [{ courseId: 'C1', instructorId: 'someone-else' }] });
        const res = await request(makeRouteApp(studentsRouter, { db, user: adminInstructor })).get('/C1');
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({ courseId: 'C1', totalStudents: 0, totalSessions: 0 });
    });

    test('200 groups sessions by student, extracts names, and computes duration', async () => {
        const db = memoryDb({
            courses: [{ courseId: 'C1', courseName: 'Bio 101', instructorId: 'i1' }],
            chat_sessions: [
                {
                    sessionId: 'a', courseId: 'C1', studentId: 's1', studentName: 'Alice',
                    savedAt: new Date('2026-02-01'), messageCount: 2,
                    chatData: { messages: [
                        { type: 'user', timestamp: '2026-02-01T00:00:00Z' },
                        { type: 'bot', timestamp: '2026-02-01T00:01:30Z' },
                    ] },
                },
                { sessionId: 'b', courseId: 'C1', studentId: 's1', studentName: 'Alice', savedAt: new Date('2026-01-01') },
                { sessionId: 'c', courseId: 'C1', studentId: 's2', studentName: { displayName: 'Bob' }, savedAt: new Date('2026-01-15') },
            ],
        });
        // 'b' and 'c' have no chatData (no student message), so they'd
        // otherwise be excluded by default (#519) - include them here since
        // this test is about grouping/name-extraction, not the filter itself.
        const res = await request(makeRouteApp(studentsRouter, { db, user: adminInstructor })).get('/C1?includeEmptyChats=true');
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({ courseName: 'Bio 101', totalStudents: 2, totalSessions: 3 });

        const alice = res.body.data.students.find(s => s.studentId === 's1');
        const bob = res.body.data.students.find(s => s.studentId === 's2');
        expect(alice.totalSessions).toBe(2);
        expect(bob.studentName).toBe('Bob'); // extracted from the object form
        expect(alice.sessions.find(s => s.sessionId === 'a').duration).toBe('1m 30s');
        // Sorted by last activity: Alice (Feb) before Bob (Jan).
        expect(res.body.data.students[0].studentId).toBe('s1');
    });

    test('covers malformed names and duration fallbacks without trusting stored duration', async () => {
        const at = (seconds) => `2026-01-01T00:${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}Z`;
        const db = memoryDb({
            courses: [{ courseId: 'C1', instructorId: 'i1' }],
            chat_sessions: [
                { sessionId: 'no-user', courseId: 'C1', studentId: 'a', studentName: { displayName: 42 }, savedAt: 1, chatData: { messages: [{ type: 'bot', timestamp: at(1) }] } },
                { sessionId: 'no-last-time', courseId: 'C1', studentId: 'b', savedAt: 2, chatData: { messages: [{ type: 'user', timestamp: at(0) }, { type: 'note' }] } },
                { sessionId: 'fallback-seconds', courseId: 'C1', studentId: 'c', savedAt: 3, chatData: { messages: [{ type: 'user', timestamp: at(0) }, { type: 'note', timestamp: at(8) }] } },
                { sessionId: 'fallback-minutes', courseId: 'C1', studentId: 'd', savedAt: 4, chatData: { messages: [{ type: 'user', timestamp: at(0) }, { type: 'note', timestamp: at(62) }] } },
                { sessionId: 'fallback-hours', courseId: 'C1', studentId: 'e', savedAt: 5, chatData: { messages: [{ type: 'user', timestamp: '2026-01-01T00:00:00Z' }, { type: 'note', timestamp: '2026-01-01T01:02:03Z' }] } },
            ],
        });
        // 'a' has no student message and would otherwise be excluded by
        // default (#519) - include it since this test is about duration
        // calculation itself, not the filter.
        const res = await request(makeRouteApp(studentsRouter, { db, user: adminInstructor })).get('/C1?includeEmptyChats=true');
        const byId = Object.fromEntries(res.body.data.students.map(s => [s.studentId, s]));
        expect(byId.a.studentName).toBe('Unknown Student');
        expect(byId.a.sessions[0].duration).toBe('0s');
        expect(byId.b.sessions[0].duration).toBe('0s');
        expect(byId.c.sessions[0].duration).toBe('8s');
        expect(byId.d.sessions[0].duration).toBe('1m 2s');
        expect(byId.e.sessions[0].duration).toBe('1h 2m 3s');
    });

    test('sessions with no student message are excluded by default, and students with only such sessions disappear entirely (#519)', async () => {
        const db = memoryDb({
            courses: [{ courseId: 'C1', instructorId: 'i1' }],
            chat_sessions: [
                // Only the auto-welcome bot message - no user message ever sent.
                { sessionId: 'welcome-only', courseId: 'C1', studentId: 'silent', savedAt: new Date('2026-03-01'), chatData: { messages: [
                    { type: 'bot', content: 'Welcome to BiocBot! I can see you have access to published units.', timestamp: '2026-03-01T00:00:00Z' },
                ] } },
                // A real conversation, for a different student.
                { sessionId: 'real', courseId: 'C1', studentId: 'chatty', savedAt: new Date('2026-03-02'), chatData: { messages: [
                    { type: 'user', timestamp: '2026-03-02T00:00:00Z' },
                    { type: 'bot', timestamp: '2026-03-02T00:01:00Z' },
                ] } },
            ],
        });

        const defaultRes = await request(makeRouteApp(studentsRouter, { db, user: adminInstructor })).get('/C1');
        expect(defaultRes.body.data).toMatchObject({ totalStudents: 1, totalSessions: 1 });
        expect(defaultRes.body.data.students.map(s => s.studentId)).toEqual(['chatty']);

        const includedRes = await request(makeRouteApp(studentsRouter, { db, user: adminInstructor })).get('/C1?includeEmptyChats=true');
        expect(includedRes.body.data).toMatchObject({ totalStudents: 2, totalSessions: 2 });
        expect(includedRes.body.data.students.map(s => s.studentId).sort()).toEqual(['chatty', 'silent']);
    });

    test('a student question with no reply is shown by default, even though its duration is 0s (#519)', async () => {
        const db = memoryDb({
            courses: [{ courseId: 'C1', instructorId: 'i1' }],
            chat_sessions: [{
                sessionId: 'no-reply', courseId: 'C1', studentId: 'asker', savedAt: new Date('2026-03-01'),
                chatData: { messages: [{ type: 'user', timestamp: '2026-03-01T00:00:00Z' }] },
            }],
        });
        const res = await request(makeRouteApp(studentsRouter, { db, user: adminInstructor })).get('/C1');
        expect(res.body.data.students.map(s => s.studentId)).toEqual(['asker']);
        expect(res.body.data.students[0].sessions[0].duration).toBe('0s');
    });

    test('a student question answered within a second is shown by default, even though its duration is 0s (#519)', async () => {
        const db = memoryDb({
            courses: [{ courseId: 'C1', instructorId: 'i1' }],
            chat_sessions: [{
                sessionId: 'fast-reply', courseId: 'C1', studentId: 'lucky', savedAt: new Date('2026-03-01'),
                chatData: { messages: [
                    { type: 'user', timestamp: '2026-03-01T00:00:00.000Z' },
                    { type: 'bot', timestamp: '2026-03-01T00:00:00.500Z' },
                ] },
            }],
        });
        const res = await request(makeRouteApp(studentsRouter, { db, user: adminInstructor })).get('/C1');
        expect(res.body.data.students.map(s => s.studentId)).toEqual(['lucky']);
        expect(res.body.data.students[0].sessions[0].duration).toBe('0s');
    });

    test('a conversation whose first student message has no timestamp is shown by default (#519)', async () => {
        const db = memoryDb({
            courses: [{ courseId: 'C1', instructorId: 'i1' }],
            chat_sessions: [{
                sessionId: 'no-timestamp', courseId: 'C1', studentId: 'untimed', savedAt: new Date('2026-03-01'),
                chatData: { messages: [
                    { type: 'user' },
                    { type: 'bot', timestamp: '2026-03-01T00:01:00Z' },
                ] },
            }],
        });
        const res = await request(makeRouteApp(studentsRouter, { db, user: adminInstructor })).get('/C1');
        expect(res.body.data.students.map(s => s.studentId)).toEqual(['untimed']);
        expect(res.body.data.students[0].sessions[0].duration).toBe('0s');
    });

    test('does not count a startup welcome appended during a later visit', async () => {
        const db = memoryDb({
            courses: [{ courseId: 'C1', instructorId: 'i1' }],
            chat_sessions: [{
                sessionId: 'stale-reopen',
                courseId: 'C1',
                studentId: 's1',
                savedAt: new Date('2026-07-13T23:02:26Z'),
                chatData: { messages: [
                    { type: 'user', timestamp: '2026-07-12T21:32:09.744Z' },
                    { type: 'bot', content: 'Real response', timestamp: '2026-07-12T21:40:31.708Z' },
                    {
                        type: 'bot',
                        content: '<strong>Welcome to BiocBot!</strong> I can see you have access to published units.',
                        timestamp: '2026-07-13T23:02:26.177Z',
                    },
                ] },
            }],
        });

        const res = await request(makeRouteApp(studentsRouter, { db, user: adminInstructor })).get('/C1');
        const session = res.body.data.students[0].sessions[0];
        expect(session.duration).toBe('8m 21s');
    });

    test('500 when a database read fails', async () => {
        const db = { collection: () => ({ findOne: async () => { throw new Error('db down'); } }) };
        const res = await request(makeRouteApp(studentsRouter, { db, user: adminInstructor })).get('/C1');
        expect(res.status).toBe(500);
        expect(res.body.message).toMatch(/fetching students/i);
    });
});

describe('GET /:courseId/:studentId/sessions/own — student access', () => {
    test('401 without a user', async () => {
        const res = await request(makeRouteApp(studentsRouter, { db: memoryDb({}) }))
            .get('/C1/s1/sessions/own');
        expect(res.status).toBe(401);
        expect(res.body).toEqual({ success: false, message: 'Authentication required' });
    });

    test('403 when a student requests another student\'s sessions', async () => {
        const res = await request(makeRouteApp(studentsRouter, { db: memoryDb({}), user: student('s1') }))
            .get('/C1/s2/sessions/own');
        expect(res.status).toBe(403);
        expect(res.body.message).toMatch(/your own chat sessions/i);
    });

    test('403 for a plain instructor (not a system admin)', async () => {
        const res = await request(makeRouteApp(studentsRouter, { db: memoryDb({}), user: plainInstructor }))
            .get('/C1/s1/sessions/own');
        expect(res.status).toBe(403);
    });

    test('403 for an unsupported role', async () => {
        const res = await request(makeRouteApp(studentsRouter, {
            db: memoryDb({}), user: { userId: 'x1', role: 'ta' },
        })).get('/C1/x1/sessions/own');
        expect(res.status).toBe(403);
        expect(res.body.message).toBe('Access denied');
    });

    test('503 when the db is unavailable', async () => {
        const res = await request(makeRouteApp(studentsRouter, { db: null, user: student('s1') }))
            .get('/C1/s1/sessions/own');
        expect(res.status).toBe(503);
    });

    test('404 when the requested course does not exist', async () => {
        const res = await request(makeRouteApp(studentsRouter, {
            db: memoryDb({ courses: [] }), user: student('s1'),
        })).get('/missing/s1/sessions/own');
        expect(res.status).toBe(404);
        expect(res.body.message).toBe('Course not found');
    });

    test('200 when a student requests their own sessions in an existing course', async () => {
        const db = memoryDb({ courses: [{ courseId: 'C1', studentEnrollment: { s1: { enrolled: true } } }], chat_sessions: [] });
        const res = await request(makeRouteApp(studentsRouter, { db, user: student('s1') }))
            .get('/C1/s1/sessions/own');
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data).toEqual({
            courseId: 'C1', studentId: 's1', studentName: 'Unknown Student', sessions: [],
        });
    });

    test('filters both deletion modes, sorts newest first, and recalculates duration', async () => {
        const messages = (end) => ({ messages: [
            { type: 'user', timestamp: '2026-01-01T00:00:00Z' },
            { type: 'bot', timestamp: end },
        ] });
        const db = memoryDb({
            courses: [{ courseId: 'C1', studentEnrollment: { s1: { enrolled: true } } }],
            chat_sessions: [
                { sessionId: 'new', courseId: 'C1', studentId: 's1', studentName: 'Alice', savedAt: new Date('2026-02-01'), chatData: messages('2026-01-01T02:03:04Z') },
                { sessionId: 'old', courseId: 'C1', studentId: 's1', studentName: 'Alice', savedAt: new Date('2026-01-01'), chatData: messages('2026-01-01T00:00:09Z') },
                { sessionId: 'student-hidden', courseId: 'C1', studentId: 's1', studentDeleted: true },
                { sessionId: 'globally-hidden', courseId: 'C1', studentId: 's1', isDeleted: true },
                { sessionId: 'other-student', courseId: 'C1', studentId: 's2' },
            ],
        });
        const res = await request(makeRouteApp(studentsRouter, { db, user: student('s1') }))
            .get('/C1/s1/sessions/own');
        expect(res.status).toBe(200);
        expect(res.body.data.studentName).toBe('Alice');
        expect(res.body.data.sessions.map(({ sessionId, duration }) => ({ sessionId, duration }))).toEqual([
            { sessionId: 'new', duration: '2h 3m 4s' },
            { sessionId: 'old', duration: '9s' },
        ]);
    });

    test('403 when the student is not enrolled in the course', async () => {
        const db = memoryDb({ courses: [{ courseId: 'C1', studentEnrollment: {} }], chat_sessions: [] });
        const res = await request(makeRouteApp(studentsRouter, { db, user: student('s1') }))
            .get('/C1/s1/sessions/own');
        expect(res.status).toBe(403);
    });

    test('allows a system admin to access any course', async () => {
        const otherCourse = await request(makeRouteApp(studentsRouter, {
            db: memoryDb({ courses: [{ courseId: 'C1', instructorId: 'other' }] }), user: adminInstructor,
        })).get('/C1/s1/sessions/own');
        expect(otherCourse.status).toBe(200);

        const allowed = await request(makeRouteApp(studentsRouter, {
            db: memoryDb({ courses: [{ courseId: 'C1', instructorId: 'i1' }], chat_sessions: [] }), user: adminInstructor,
        })).get('/C1/s1/sessions/own');
        expect(allowed.status).toBe(200);
    });

    test('500 when a database read fails', async () => {
        const db = { collection: () => ({ findOne: async () => { throw new Error('db down'); } }) };
        const res = await request(makeRouteApp(studentsRouter, { db, user: student('s1') }))
            .get('/C1/s1/sessions/own');
        expect(res.status).toBe(500);
        expect(res.body.message).toMatch(/fetching student sessions/i);
    });
});

describe('PUT /:courseId/:studentId/sessions/:sessionId/title — rename', () => {
    test('400 when the title is missing', async () => {
        const res = await request(makeRouteApp(studentsRouter, { db: memoryDb({}), user: student('s1') }))
            .put('/C1/s1/sessions/sess1/title').send({});
        expect(res.status).toBe(400);
    });

    test('403 when a student renames another student\'s session', async () => {
        const res = await request(makeRouteApp(studentsRouter, { db: memoryDb({}), user: student('s1') }))
            .put('/C1/s2/sessions/sess1/title').send({ title: 'x' });
        expect(res.status).toBe(403);
    });

    test('403 when an instructor does not own the session course', async () => {
        const db = memoryDb({
            courses: [{ courseId: 'C1', instructorId: 'other' }],
            chat_sessions: [{ sessionId: 'sess1', courseId: 'C1', studentId: 's1' }],
        });
        const res = await request(makeRouteApp(studentsRouter, { db, user: plainInstructor }))
            .put('/C1/s1/sessions/sess1/title').send({ title: 'x' });
        expect(res.status).toBe(403);
        expect((await db.collection('chat_sessions').findOne({ sessionId: 'sess1' })).title).toBeUndefined();
    });

    test('401 without a user and 403 for an unsupported role', async () => {
        const db = memoryDb({});
        expect((await request(makeRouteApp(studentsRouter, { db }))
            .put('/C1/s1/sessions/sess1/title').send({ title: 'x' })).status).toBe(401);
        expect((await request(makeRouteApp(studentsRouter, { db, user: { userId: 'x', role: 'ta' } }))
            .put('/C1/s1/sessions/sess1/title').send({ title: 'x' })).status).toBe(403);
    });

    test('500 when the db is unavailable', async () => {
        const res = await request(makeRouteApp(studentsRouter, { db: null, user: student('s1') }))
            .put('/C1/s1/sessions/sess1/title').send({ title: 'x' });
        expect(res.status).toBe(500);
        expect(res.body.error).toMatch(/database connection/i);
    });

    test('404 when the session does not exist', async () => {
        const db = memoryDb({ chat_sessions: [] });
        const res = await request(makeRouteApp(studentsRouter, { db, user: student('s1') }))
            .put('/C1/s1/sessions/missing/title').send({ title: 'x' });
        expect(res.status).toBe(404);
    });

    test('200 updates the title and persists it', async () => {
        const db = memoryDb({ chat_sessions: [{ sessionId: 'sess1', courseId: 'C1', studentId: 's1', title: 'Old' }] });
        const res = await request(makeRouteApp(studentsRouter, { db, user: student('s1') }))
            .put('/C1/s1/sessions/sess1/title').send({ title: 'Renamed' });
        expect(res.status).toBe(200);
        expect(res.body.data).toEqual({ sessionId: 'sess1', title: 'Renamed' });
        expect((await db.collection('chat_sessions').findOne({ sessionId: 'sess1' })).title).toBe('Renamed');
    });

    test('500 when the session lookup fails', async () => {
        const db = { collection: () => ({ findOne: async () => { throw new Error('db down'); } }) };
        const res = await request(makeRouteApp(studentsRouter, { db, user: student('s1') }))
            .put('/C1/s1/sessions/sess1/title').send({ title: 'x' });
        expect(res.status).toBe(500);
        expect(res.body.error).toBe('Failed to update chat session title');
    });

    test('404 when the session disappears between lookup and update', async () => {
        const db = { collection: () => ({
            findOne: async () => ({ sessionId: 'sess1' }),
            updateOne: async () => ({ matchedCount: 0 }),
        }) };
        const res = await request(makeRouteApp(studentsRouter, { db, user: student('s1') }))
            .put('/C1/s1/sessions/sess1/title').send({ title: 'x' });
        expect(res.status).toBe(404);
    });
});

describe('DELETE /:courseId/:studentId/sessions/:sessionId/own — student soft-delete', () => {
    test('403 when a student deletes another student\'s session', async () => {
        const res = await request(makeRouteApp(studentsRouter, { db: memoryDb({}), user: student('s1') }))
            .delete('/C1/s2/sessions/sess1/own');
        expect(res.status).toBe(403);
    });

    test('401 without a user and 403 for an unsupported role', async () => {
        const db = memoryDb({});
        expect((await request(makeRouteApp(studentsRouter, { db }))
            .delete('/C1/s1/sessions/sess1/own')).status).toBe(401);
        expect((await request(makeRouteApp(studentsRouter, { db, user: { userId: 'x', role: 'ta' } }))
            .delete('/C1/s1/sessions/sess1/own')).status).toBe(403);
    });

    test('500 when the db is unavailable', async () => {
        const res = await request(makeRouteApp(studentsRouter, { db: null, user: student('s1') }))
            .delete('/C1/s1/sessions/sess1/own');
        expect(res.status).toBe(500);
    });

    test('404 when the session does not exist', async () => {
        const db = memoryDb({ chat_sessions: [] });
        const res = await request(makeRouteApp(studentsRouter, { db, user: student('s1') }))
            .delete('/C1/s1/sessions/missing/own');
        expect(res.status).toBe(404);
    });

    test('200 marks the session studentDeleted (kept visible to instructors)', async () => {
        const db = memoryDb({ chat_sessions: [{ sessionId: 'sess1', courseId: 'C1', studentId: 's1' }] });
        const res = await request(makeRouteApp(studentsRouter, { db, user: student('s1') }))
            .delete('/C1/s1/sessions/sess1/own');
        expect(res.status).toBe(200);
        const stored = await db.collection('chat_sessions').findOne({ sessionId: 'sess1' });
        expect(stored.studentDeleted).toBe(true);
        expect(stored.studentDeletedAt).toBeDefined();
        expect(stored.isDeleted).toBeUndefined(); // not hidden from instructors
    });

    test('500 when the session lookup fails', async () => {
        const db = { collection: () => ({ findOne: async () => { throw new Error('db down'); } }) };
        const res = await request(makeRouteApp(studentsRouter, { db, user: student('s1') }))
            .delete('/C1/s1/sessions/sess1/own');
        expect(res.status).toBe(500);
        expect(res.body.error).toBe('Failed to delete chat session');
    });

    test('404 when the session disappears between lookup and update', async () => {
        const db = { collection: () => ({
            findOne: async () => ({ sessionId: 'sess1' }),
            updateOne: async () => ({ matchedCount: 0 }),
        }) };
        const res = await request(makeRouteApp(studentsRouter, { db, user: student('s1') }))
            .delete('/C1/s1/sessions/sess1/own');
        expect(res.status).toBe(404);
    });
});
