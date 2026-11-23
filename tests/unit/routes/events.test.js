/**
 * POST /api/events/:courseId: what the student page may report, and what the
 * server sets on it (the pub/sub toolkit's rung 3, PRD section 8).
 *
 * The route runs with BiocBot's real guards (src/middleware/auth.js) on the
 * in-memory database, behind a stand-in for Passport that signs a user in, and
 * with resolvePreview ahead of it as server.js mounts it. Each test listens on
 * BiocBot's own publisher for what was published.
 */
const express = require('express');
const request = require('supertest');
const { memoryDb } = require('../helpers/memory-db');
const createAuthMiddleware = require('../../../src/middleware/auth');
const previewSession = require('../../../src/services/previewSession');
const eventsService = require('../../../src/services/events');
const { createEventReportRoute } = require('../../../src/routes/events');

const describeWithToolkit = eventsService.loadToolkit() !== null ? describe : describe.skip;

const student = { userId: 'user_5f1c', role: 'student', username: 'jstudent', displayName: 'Jane Student', email: 'jane@example.com', puid: 'PUID123' };
const otherStudent = { userId: 'user_9a2b', role: 'student' };
const instructor = { userId: 'user_17d0', role: 'instructor', displayName: 'Dr Instructor' };

function courses() {
    return [
        { courseId: 'C1', status: 'active', studentEnrollment: { [student.userId]: { enrolled: true } } },
        { courseId: 'C2', status: 'active', studentEnrollment: { [otherStudent.userId]: { enrolled: true } } },
        { courseId: 'C3', status: 'inactive', studentEnrollment: { [student.userId]: { enrolled: true } } }
    ];
}

/** The route as server.js mounts it, with `user` signed in and an optional session. */
function reportApp({ user = student, session = null } = {}) {
    const db = memoryDb({ courses: courses(), users: [student, otherStudent, instructor] });
    const auth = createAuthMiddleware(db);
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        if (user) req.user = { ...user };
        if (session) req.session = session;
        next();
    });
    app.use(auth.resolvePreview);
    app.post('/api/events/:courseId', createEventReportRoute(auth));
    return app;
}

const SWITCH = Object.freeze({ type: 'chat.mode.changed', data: { from: 'protege', to: 'tutor' } });

let received;
let stop;
beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    received = [];
    stop = eventsService.subscribeAll(event => { received.push(event); }, { sensitive: true });
});
afterEach(() => {
    stop();
    jest.restoreAllMocks();
});

/** Listeners run after publish returns, so let them. */
const delivered = () => new Promise(resolve => setImmediate(resolve));

describeWithToolkit('POST /api/events/:courseId', () => {
    test('accepts a mode switch and publishes it once, with both modes described and who and where set by the server', async () => {
        const res = await request(reportApp()).post('/api/events/C1').send(SWITCH);
        await delivered();

        expect(res.status).toBe(202);
        expect(res.body).toEqual({ ok: true, id: expect.any(String) });
        expect(received).toHaveLength(1);
        const [event] = received;
        expect(event).toMatchObject({
            id: res.body.id,
            type: 'chat.mode.changed',
            version: 1,
            app: 'biocbot',
            origin: 'browser',
            user: 'user_5f1c',
            course: 'C1',
            preview: false,
            data: { from: 'protege', to: 'tutor' }
        });
        expect(Number.isNaN(Date.parse(event.at))).toBe(false);
        expect(event).not.toHaveProperty('session');
        expect(event.meta).toEqual({
            label: 'switches chat mode',
            description: "The student moved BiocBot between tutor and protégé mode, with the mode toggle or through the assessment's result.",
            sensitive: false,
            volume: false,
            props: {
                from: { type: 'ref', label: 'Mode before', collection: 'modes' },
                to: { type: 'ref', label: 'Mode after', collection: 'modes' }
            },
            refs: {
                modes: {
                    label: 'mode',
                    items: {
                        protege: {
                            label: 'Protégé mode',
                            description: 'The student teaches. BiocBot plays a curious but slightly confused student who asks follow-up questions and never explains the concept itself.'
                        },
                        tutor: {
                            label: 'Tutor mode',
                            description: "BiocBot explains concepts and answers the student's questions about the course material."
                        }
                    }
                }
            }
        });
    });

    test('puts no name, email or PUID on the event, only the pseudonymous id', async () => {
        await request(reportApp()).post('/api/events/C1').send(SWITCH);
        await delivered();

        const text = JSON.stringify(received);
        for (const personal of ['jstudent', 'Jane Student', 'jane@example.com', 'PUID123']) {
            expect(text).not.toContain(personal);
        }
    });

    test.each([
        ['user', 'user_9a2b'],
        ['course', 'C2'],
        ['at', '2020-01-01T00:00:00.000Z'],
        ['id', 'forged-id'],
        ['origin', 'server'],
        ['preview', true],
        ['meta', { label: 'forged' }],
        ['version', 2]
    ])('refuses a report that sets `%s`, and publishes nothing', async (field, value) => {
        const res = await request(reportApp()).post('/api/events/C1').send({ ...SWITCH, [field]: value });
        await delivered();

        expect(res.status).toBe(400);
        expect(res.body).toEqual({
            ok: false,
            problems: [{ field, code: 'field_not_allowed', message: expect.any(String) }]
        });
        expect(received).toEqual([]);
    });

    test('refuses a course named in the query string, which the guards would check instead of the path', async () => {
        // C1 is the student's own course and C2 is not. Without the check, the
        // guards would pass on C1 and the event would be published for C2.
        const res = await request(reportApp()).post('/api/events/C2?courseId=C1').send(SWITCH);
        await delivered();

        expect(res.status).toBe(400);
        expect(res.body.problems).toEqual([{ field: 'query.courseId', code: 'field_not_allowed', message: expect.any(String) }]);
        expect(received).toEqual([]);
    });

    test('refuses a course named in the body', async () => {
        const res = await request(reportApp()).post('/api/events/C2').send({ ...SWITCH, courseId: 'C1' });
        await delivered();

        expect(res.status).toBe(400);
        expect(res.body.problems).toEqual([{ field: 'courseId', code: 'field_not_allowed', message: expect.any(String) }]);
        expect(received).toEqual([]);
    });

    test('refuses a course the student is not enrolled in, an inactive one and one that does not exist', async () => {
        const app = reportApp();
        const notEnrolled = await request(app).post('/api/events/C2').send(SWITCH);
        const inactive = await request(app).post('/api/events/C3').send(SWITCH);
        const missing = await request(app).post('/api/events/NOPE').send(SWITCH);
        await delivered();

        expect(notEnrolled.status).toBe(403);
        expect(inactive.status).toBe(403);
        expect(missing.status).toBe(404);
        expect(received).toEqual([]);
    });

    test.each([
        ['struggle.topic.activated', { topic: 'glycolysis' }],
        ['struggle.topic.cleared', { topic: 'glycolysis' }],
        ['user.logged-in', {}],
        ['quiz.completed', { score: 90 }]
    ])('refuses a %s report: only chat.mode.changed is reportable', async (type, data) => {
        const res = await request(reportApp()).post('/api/events/C1').send({ type, data });
        await delivered();

        expect(res.status).toBe(403);
        expect(res.body.problems).toEqual([{ field: 'type', code: 'not_reportable', message: expect.any(String) }]);
        expect(received).toEqual([]);
    });

    test('refuses a mode that BiocBot does not have, with what the dictionary says', async () => {
        const res = await request(reportApp()).post('/api/events/C1').send({ type: 'chat.mode.changed', data: { from: 'tutor', to: 'explain' } });
        await delivered();

        expect(res.status).toBe(400);
        expect(res.body.problems).toEqual([{ field: 'data.to', code: 'not_ref', message: expect.any(String) }]);
        expect(received).toEqual([]);
    });

    test('keeps no session the page sends', async () => {
        const res = await request(reportApp()).post('/api/events/C1').send({ ...SWITCH, session: 'chat_forged' });
        await delivered();

        expect(res.status).toBe(202);
        expect(received).toHaveLength(1);
        expect(received[0]).not.toHaveProperty('session');
    });

    test('marks a report from a "View as Student" tab as a preview, with the sandbox id and the previewed course', async () => {
        const grant = previewSession.createGrant(instructor, 'C2');
        const app = reportApp({ user: instructor, session: { userId: instructor.userId, preview: grant } });

        const res = await request(app).post('/api/events/C2').set('X-Preview-Session', '1').send(SWITCH);
        await delivered();

        expect(res.status).toBe(202);
        expect(received).toHaveLength(1);
        expect(received[0]).toMatchObject({
            user: previewSession.buildPreviewUserId(instructor.userId, 'C2'),
            course: 'C2',
            preview: true,
            origin: 'browser'
        });
    });

    test('keeps a preview tab to the course it previews', async () => {
        const grant = previewSession.createGrant(instructor, 'C2');
        const app = reportApp({ user: instructor, session: { userId: instructor.userId, preview: grant } });

        const res = await request(app).post('/api/events/C1').set('X-Preview-Session', '1').send(SWITCH);
        await delivered();

        expect(res.status).toBe(403);
        expect(received).toEqual([]);
    });

    test('refuses an instructor outside a preview, whom the enrollment guard does not check', async () => {
        const grant = previewSession.createGrant(instructor, 'C2');
        // The same session without the tab's preview header is the instructor.
        const app = reportApp({ user: instructor, session: { userId: instructor.userId, preview: grant } });

        const res = await request(app).post('/api/events/C2').send(SWITCH);
        await delivered();

        expect(res.status).toBe(403);
        expect(received).toEqual([]);
    });

    test('refuses a report when nobody is signed in', async () => {
        const res = await request(reportApp({ user: null })).post('/api/events/C1').send(SWITCH);
        await delivered();

        expect(res.status).toBe(401);
        expect(received).toEqual([]);
    });
});

describe('POST /api/events/:courseId without the toolkit', () => {
    test('answers 404 and publishes nothing, as /vendor/pubsub.js does', async () => {
        await jest.isolateModulesAsync(async () => {
            const missing = () => {
                const error = new Error('Cannot find module');
                error.code = 'MODULE_NOT_FOUND';
                throw error;
            };
            jest.doMock('@ubc/genai-toolkit-pubsub-core', missing, { virtual: true });
            jest.doMock('@ubc/genai-toolkit-pubsub-events', missing, { virtual: true });
            jest.doMock('@ubc/genai-toolkit-pubsub-server', missing, { virtual: true });
            const isolatedEvents = require('../../../src/services/events');
            const { createEventReportRoute: isolatedRoute } = require('../../../src/routes/events');
            const isolatedAuth = require('../../../src/middleware/auth');

            const db = memoryDb({ courses: courses() });
            const app = express();
            app.use(express.json());
            app.use((req, res, next) => { req.user = { ...student }; next(); });
            app.post('/api/events/:courseId', isolatedRoute(isolatedAuth(db)));

            const res = await request(app).post('/api/events/C1').send(SWITCH);

            expect(isolatedEvents.getEvents()).toBeNull();
            expect(res.status).toBe(404);
            expect(res.body).toEqual({ ok: false, problems: [{ field: 'type', code: 'not_installed', message: expect.any(String) }] });
            expect(isolatedEvents.publishEvent('chat.mode.changed', { user: 'u', course: 'C1', data: SWITCH.data }))
                .toEqual({ ok: false, problems: [expect.objectContaining({ code: 'not_installed' })] });
        });
    });
});
