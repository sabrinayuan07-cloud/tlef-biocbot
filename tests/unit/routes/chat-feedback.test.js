const { memoryDb } = require('../helpers/memory-db');
const { makeRouteApp, request } = require('../helpers/route-app');
const chatRouter = require('../../../src/routes/chat');
const MessageFeedback = require('../../../src/models/MessageFeedback');

const student = { userId: 's1', role: 'student', displayName: 'Student One', username: 'student1' };
const instructor = { userId: 'i1', role: 'instructor', displayName: 'Instructor One' };
const otherInstructor = { userId: 'i2', role: 'instructor' };
const taWithFlags = { userId: 'ta1', role: 'ta' };
const taWithoutFlags = { userId: 'ta2', role: 'ta' };

function seededDb(extra = {}) {
    return memoryDb({
        courses: [
            {
                courseId: 'C1',
                courseName: 'BIOC 401',
                instructorId: 'i1',
                instructors: ['i1'],
                tas: ['ta1', 'ta2'],
                taPermissions: {
                    ta1: { materials: true, questions: true, settings: true, transcripts: true, flags: true, roster: true },
                    ta2: { materials: true, questions: true, settings: true, transcripts: true, flags: false, roster: false }
                },
                studentEnrollment: {
                    s1: { enrolled: true },
                    blocked: { enrolled: false }
                },
                status: 'active'
            }
        ],
        ...extra
    });
}

function app(db, user) {
    return makeRouteApp(chatRouter, { db, user });
}

beforeAll(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterAll(() => jest.restoreAllMocks());

describe('chat feedback routes', () => {
    test('POST /feedback requires an authenticated student and rating', async () => {
        expect((await request(app(seededDb(), null)).post('/feedback').send({})).status).toBe(401);
        expect((await request(app(seededDb(), instructor)).post('/feedback').send({ rating: 'up' })).status).toBe(403);

        const missingRating = await request(app(seededDb(), student)).post('/feedback').send({
            courseId: 'C1',
            conversationId: 'session-1',
            messageId: 'msg-1'
        });
        expect(missingRating.status).toBe(400);
        expect(missingRating.body.message).toBe('rating is required');
    });

    test('POST /feedback validates course access and rating values', async () => {
        const invalidRating = await request(app(seededDb(), student)).post('/feedback').send({
            courseId: 'C1',
            conversationId: 'session-1',
            messageId: 'msg-1',
            rating: 'sideways'
        });
        expect(invalidRating.status).toBe(400);

        const missingCourse = await request(app(seededDb(), student)).post('/feedback').send({
            courseId: 'NOPE',
            conversationId: 'session-1',
            messageId: 'msg-1',
            rating: 'up'
        });
        expect(missingCourse.status).toBe(404);

        const blockedStudent = { userId: 'blocked', role: 'student' };
        const blocked = await request(app(seededDb(), blockedStudent)).post('/feedback').send({
            courseId: 'C1',
            conversationId: 'session-1',
            messageId: 'msg-1',
            rating: 'up'
        });
        expect(blocked.status).toBe(403);
    });

    test('POST /feedback upserts and clears a message rating', async () => {
        const db = seededDb();
        const payload = {
            courseId: 'C1',
            unitName: 'Unit 1',
            conversationId: 'session-1',
            messageId: 'msg-1',
            botMode: 'tutor',
            messageContent: 'This answer helped.'
        };

        const up = await request(app(db, student)).post('/feedback').send({ ...payload, rating: 'up' });
        expect(up.status).toBe(200);
        expect(up.body.data.feedback).toMatchObject({
            courseId: 'C1',
            studentId: 's1',
            rating: 'up',
            isActive: true,
            studentName: 'Student One'
        });

        const down = await request(app(db, student)).post('/feedback').send({ ...payload, rating: 'down' });
        expect(down.status).toBe(200);
        expect(down.body.data.feedback).toMatchObject({ rating: 'down', isActive: true });

        const cleared = await request(app(db, student)).post('/feedback').send({ ...payload, rating: null });
        expect(cleared.status).toBe(200);
        expect(cleared.body.data.feedback).toMatchObject({ rating: null, isActive: false });

        const stored = await db.collection(MessageFeedback.COLLECTION_NAME).find({}).toArray();
        expect(stored).toHaveLength(1);
        expect(stored[0].clearedAt).toBeInstanceOf(Date);
    });

    test('GET /feedback/course/:courseId lists active feedback for course instructors', async () => {
        const db = seededDb({
            [MessageFeedback.COLLECTION_NAME]: [
                { feedbackId: 'f1', courseId: 'C1', studentId: 's1', rating: 'up', isActive: true, updatedAt: new Date('2026-01-02') },
                { feedbackId: 'f2', courseId: 'C1', studentId: 's2', rating: null, isActive: false, updatedAt: new Date('2026-01-01') },
            ],
        });

        const denied = await request(app(db, otherInstructor)).get('/feedback/course/C1');
        expect(denied.status).toBe(403);

        const res = await request(app(db, instructor)).get('/feedback/course/C1');
        expect(res.status).toBe(200);
        expect(res.body.data.feedback.map(item => item.feedbackId)).toEqual(['f1']);
        expect(res.body.data.stats).toEqual({ total: 2, up: 1, down: 0, cleared: 1 });
    });

    test('GET /feedback/course/:courseId enforces TA flag permissions', async () => {
        const db = seededDb({
            [MessageFeedback.COLLECTION_NAME]: [
                { feedbackId: 'f1', courseId: 'C1', rating: 'down', isActive: true, updatedAt: new Date() },
            ],
        });

        const allowed = await request(app(db, taWithFlags)).get('/feedback/course/C1');
        expect(allowed.status).toBe(200);

        const denied = await request(app(db, taWithoutFlags)).get('/feedback/course/C1');
        expect(denied.status).toBe(403);
    });

    test('GET /feedback/course/:courseId/export returns CSV including cleared rows', async () => {
        const db = seededDb({
            [MessageFeedback.COLLECTION_NAME]: [
                { feedbackId: 'f1', courseId: 'C1', studentName: 'A, Student', rating: 'up', isActive: true, updatedAt: new Date('2026-01-02') },
                { feedbackId: 'f2', courseId: 'C1', studentName: 'Cleared Student', rating: null, isActive: false, updatedAt: new Date('2026-01-01') },
            ],
        });

        const res = await request(app(db, instructor)).get('/feedback/course/C1/export');
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toMatch(/text\/csv/);
        expect(res.headers['content-disposition']).toContain('message-feedback-C1.csv');
        expect(res.text).toContain('feedbackId,courseId,unitName');
        expect(res.text).toContain('"A, Student"');
        expect(res.text).toContain('Cleared Student');
    });
});
