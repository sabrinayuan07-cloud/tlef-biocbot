/**
 * What a student does, as events (src/services/activityEvents.js): a practice
 * question answered, a chat started and each chat message, and the user
 * agreement accepted. These run on BiocBot's real publisher and the in-memory
 * database, and check what a listener on everything gets (gamification's
 * listener is one): the fields, the order, one start per chat, nothing for
 * anyone but a student, and nothing stored where the toolkit isn't installed.
 */
const { memoryDb } = require('../helpers/memory-db');
const eventsService = require('../../../src/services/events');
const activityEvents = require('../../../src/services/activityEvents');
const ChatSessionStart = require('../../../src/models/ChatSessionStart');

const describeWithToolkit = eventsService.loadToolkit() !== null ? describe : describe.skip;

const student = { userId: 'user_5f1c', role: 'student', displayName: 'Jane Student', email: 'jane@example.com' };
const previewStudent = { userId: 'preview_7a2b', role: 'student', isPreview: true };
const instructor = { userId: 'user_i1', role: 'instructor' };
const ta = { userId: 'user_t1', role: 'ta' };

/** Listeners run on a microtask, after publish returns. */
const settled = () => new Promise(resolve => setTimeout(resolve, 0));

let published;
let stopListening;
beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    published = [];
    // As gamification's listener does: everything, without sensitive events.
    stopListening = eventsService.subscribeAll(event => { published.push(event); });
});
afterEach(() => {
    stopListening();
    jest.restoreAllMocks();
});

async function startRows(db) {
    const rows = await db.collection(ChatSessionStart.COLLECTION_NAME).find({}).toArray();
    return rows.map(({ _id, startedAt, ...row }) => ({ ...row, startedAt: startedAt instanceof Date }));
}

describeWithToolkit('a practice question answered', () => {
    test("publishes the answer's course, unit and whether it was right, as BiocBot's server", async () => {
        const ok = activityEvents.publishQuestionAnswered(student, { courseId: 'C1', unit: 'Unit 1', correct: true });
        await settled();

        expect(ok).toBe(true);
        expect(published).toHaveLength(1);
        expect(published[0]).toMatchObject({
            type: 'quiz.question.answered',
            app: 'biocbot',
            origin: 'server',
            user: 'user_5f1c',
            course: 'C1',
            preview: false,
            source: { server: eventsService.serverName() },
            data: { correct: true, unit: 'Unit 1' },
            meta: { volume: true, sensitive: false }
        });
        // Who the student is stays with BiocBot.
        expect(JSON.stringify(published[0])).not.toMatch(/Jane|jane@example\.com/);
    });

    test('a wrong answer, a preview, and a unit name that is too long', async () => {
        activityEvents.publishQuestionAnswered(previewStudent, { courseId: 'C1', unit: '  Unit 2  ', correct: false });
        activityEvents.publishQuestionAnswered(student, { courseId: 'C1', unit: 'x'.repeat(500), correct: 'yes' });
        await settled();

        expect(published.map(event => [event.preview, event.data])).toEqual([
            [true, { correct: false, unit: 'Unit 2' }],
            // Only `true` is right.
            [false, { correct: false, unit: 'x'.repeat(activityEvents.MAX_UNIT) }]
        ]);
    });

    test('nothing for an instructor, a TA, no one, no course or no unit, and no warning logged', async () => {
        for (const user of [instructor, ta, null, { role: 'student' }]) {
            expect(activityEvents.publishQuestionAnswered(user, { courseId: 'C1', unit: 'Unit 1', correct: true })).toBe(false);
        }
        expect(activityEvents.publishQuestionAnswered(student, { courseId: '', unit: 'Unit 1', correct: true })).toBe(false);
        expect(activityEvents.publishQuestionAnswered(student, { courseId: 'C1', unit: ' ', correct: true })).toBe(false);
        await settled();
        expect(published).toEqual([]);
        expect(console.warn).not.toHaveBeenCalled();
    });
});

describeWithToolkit('chat messages', () => {
    const message = (sessionId = 'autosave_1764000000000_abc123def', unit = 'Unit 1') => ({ courseId: 'C1', sessionId, unit });

    test("a chat's first message publishes its start, then the message; later ones only the message", async () => {
        const db = memoryDb({});

        expect(await activityEvents.announceChatMessage(db, student, message())).toEqual({ started: true, sent: true });
        expect(await activityEvents.announceChatMessage(db, student, message())).toEqual({ started: false, sent: true });
        expect(await activityEvents.announceChatMessage(db, student, message())).toEqual({ started: false, sent: true });
        await settled();

        expect(published.map(event => event.type)).toEqual([
            'chat.session.started', 'chat.message.sent', 'chat.message.sent', 'chat.message.sent'
        ]);
        expect(published[0]).toMatchObject({
            origin: 'server',
            user: 'user_5f1c',
            course: 'C1',
            session: 'autosave_1764000000000_abc123def',
            preview: false,
            data: { unit: 'Unit 1' },
            meta: { volume: false }
        });
        expect(published[1]).toMatchObject({ session: 'autosave_1764000000000_abc123def', data: {}, meta: { volume: true } });
        expect(await startRows(db)).toEqual([
            { userId: 'user_5f1c', sessionId: 'autosave_1764000000000_abc123def', courseId: 'C1', startedAt: true }
        ]);
    });

    test('a new chat starts again, and another student with the same session id starts their own', async () => {
        const db = memoryDb({});
        await activityEvents.announceChatMessage(db, student, message('autosave_1'));
        await activityEvents.announceChatMessage(db, student, message('autosave_2', 'Unit 2'));
        await activityEvents.announceChatMessage(db, previewStudent, message('autosave_1'));
        await settled();

        const starts = published.filter(event => event.type === 'chat.session.started');
        expect(starts.map(event => [event.user, event.session, event.preview, event.data.unit])).toEqual([
            ['user_5f1c', 'autosave_1', false, 'Unit 1'],
            ['user_5f1c', 'autosave_2', false, 'Unit 2'],
            ['preview_7a2b', 'autosave_1', true, 'Unit 1']
        ]);
    });

    test('nothing, and nothing stored, for anyone but a student, or without a usable session id, course or unit', async () => {
        const db = memoryDb({});
        const nothing = { started: false, sent: false };
        for (const user of [instructor, ta, null]) {
            expect(await activityEvents.announceChatMessage(db, user, message())).toEqual(nothing);
        }
        for (const sessionId of [undefined, null, '', '   ', 42, 'x'.repeat(activityEvents.MAX_SESSION_ID + 1)]) {
            expect(await activityEvents.announceChatMessage(db, student, { courseId: 'C1', sessionId, unit: 'Unit 1' })).toEqual(nothing);
        }
        expect(await activityEvents.announceChatMessage(db, student, { sessionId: 'autosave_1', unit: 'Unit 1' })).toEqual(nothing);
        expect(await activityEvents.announceChatMessage(db, student, { courseId: 'C1', sessionId: 'autosave_1' })).toEqual(nothing);
        await settled();

        expect(published).toEqual([]);
        expect(await startRows(db)).toEqual([]);
        expect(console.warn).not.toHaveBeenCalled();
    });

    test("when it can't tell whether the chat started, the message still counts, and the log holds no data", async () => {
        jest.spyOn(ChatSessionStart, 'recordStart').mockRejectedValueOnce(new Error('connection lost'));

        expect(await activityEvents.announceChatMessage(memoryDb({}), student, message())).toEqual({ started: false, sent: true });
        await settled();

        expect(published.map(event => event.type)).toEqual(['chat.message.sent']);
        const logged = JSON.stringify(console.error.mock.calls);
        expect(logged).toContain('connection lost');
        expect(logged).not.toMatch(/user_5f1c|autosave_|Unit 1/);
    });
});

describe('where the pub/sub toolkit is not installed', () => {
    test('a chat message stores nothing and publishes nothing', async () => {
        jest.spyOn(eventsService, 'getEvents').mockReturnValue(null);
        const db = memoryDb({});

        expect(await activityEvents.announceChatMessage(db, student, { courseId: 'C1', sessionId: 'autosave_1', unit: 'Unit 1' }))
            .toEqual({ started: false, sent: false });
        expect(await startRows(db)).toEqual([]);
    });

    test('an answer or an agreement publishes nothing and throws nothing', () => {
        jest.spyOn(eventsService, 'publishEvent').mockReturnValue({ ok: false, problems: [{ field: 'type', code: 'not_installed' }] });

        expect(activityEvents.publishQuestionAnswered(student, { courseId: 'C1', unit: 'Unit 1', correct: true })).toBe(false);
        expect(activityEvents.publishAgreementAccepted(student, '1.0')).toBe(false);
    });
});

describeWithToolkit('the user agreement', () => {
    test("publishes the toolkit's general agreement.accepted with the page's id, for anyone who signs it", async () => {
        expect(activityEvents.publishAgreementAccepted(student, '1.0')).toBe(true);
        expect(activityEvents.publishAgreementAccepted(instructor, '2.1')).toBe(true);
        expect(activityEvents.publishAgreementAccepted(previewStudent, '1.0')).toBe(true);
        await settled();

        expect(published.map(event => [event.type, event.user, event.course, event.preview, event.data])).toEqual([
            ['agreement.accepted', 'user_5f1c', undefined, false, { agreement: 'user-agreement-1.0' }],
            ['agreement.accepted', 'user_i1', undefined, false, { agreement: 'user-agreement-2.1' }],
            ['agreement.accepted', 'preview_7a2b', undefined, true, { agreement: 'user-agreement-1.0' }]
        ]);
    });

    test('nothing without a user or a short version', async () => {
        expect(activityEvents.publishAgreementAccepted(null, '1.0')).toBe(false);
        expect(activityEvents.publishAgreementAccepted(student, '')).toBe(false);
        expect(activityEvents.publishAgreementAccepted(student, 'v'.repeat(33))).toBe(false);
        await settled();
        expect(published).toEqual([]);
    });
});
