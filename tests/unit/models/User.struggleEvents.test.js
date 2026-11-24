/**
 * Struggle changes as events (the pub/sub toolkit's rung 3, PRD section 8).
 *
 * updateUserStruggleState and resetUserStruggleState publish one event next to
 * each struggleActivity row they write. These tests run them on the in-memory
 * database with the real StruggleActivity and PersistenceTopic models, and
 * check that the rows are the same with the events on, with the toolkit
 * missing, and with a listener that throws; that a listener on `struggle.*`
 * gets the change; and that a listener on everything doesn't, unless it asks
 * for sensitive events.
 */
const { memoryDb } = require('../helpers/memory-db');
const User = require('../../../src/models/User');
const eventsService = require('../../../src/services/events');
const previewSession = require('../../../src/services/previewSession');

const describeWithToolkit = eventsService.loadToolkit() !== null ? describe : describe.skip;

const STUDENT_ID = 'user_5f1c';

function studentDoc(overrides = {}) {
    return {
        userId: STUDENT_ID,
        username: 'jstudent',
        displayName: 'Jane Student',
        email: 'jane@example.com',
        puid: 'PUID123',
        role: 'student',
        isActive: true,
        preferences: { courseId: 'C1' },
        struggleState: { topics: [{ topic: 'glycolysis', count: 2, lastStruggle: new Date('2026-11-01'), isActive: false }] },
        ...overrides
    };
}

/**
 * What a student does: a third struggle with glycolysis (it becomes active),
 * a first with ATP (counted, no row), a third with glycolysis again (already
 * active, no row), then a reset of every topic.
 */
async function struggleThenReset(user, models = User) {
    const db = memoryDb({ users: [studentDoc(user)] });
    const userId = (user && user.userId) || STUDENT_ID;
    await models.updateUserStruggleState(db, userId, { topic: 'Glycolysis', isStruggling: true }, 'C1');
    await models.updateUserStruggleState(db, userId, { topic: 'ATP', isStruggling: true }, 'C1');
    await models.updateUserStruggleState(db, userId, { topic: 'glycolysis', isStruggling: true }, 'C1');
    await models.resetUserStruggleState(db, userId, 'ALL', 'C1');
    return db;
}

/** The rows, without the fields that hold the time they were written. */
async function rows(db) {
    const docs = await db.collection('struggleActivity').find({}).toArray();
    return docs.map(({ _id, timestamp, createdAt, ...row }) => row);
}

async function users(db) {
    const docs = await db.collection('users').find({}).toArray();
    return docs.map(({ _id, updatedAt, struggleState, ...user }) => ({
        ...user,
        topics: struggleState.topics.map(({ lastStruggle, ...topic }) => topic)
    }));
}

const delivered = () => new Promise(resolve => setImmediate(resolve));

const missingPackage = () => {
    const error = new Error('Cannot find module');
    error.code = 'MODULE_NOT_FOUND';
    throw error;
};

/** User.js with the toolkit not installed. */
function userWithoutToolkit() {
    let isolated;
    jest.isolateModules(() => {
        jest.doMock('@ubc/genai-toolkit-pubsub-core', missingPackage, { virtual: true });
        jest.doMock('@ubc/genai-toolkit-pubsub-events', missingPackage, { virtual: true });
        jest.doMock('@ubc/genai-toolkit-pubsub-server', missingPackage, { virtual: true });
        isolated = require('../../../src/models/User');
    });
    return isolated;
}

const EXPECTED_ROWS = [
    { userId: STUDENT_ID, studentName: 'Jane Student', courseId: 'C1', topic: 'glycolysis', state: 'Active', source: 'course', superchatId: null },
    { userId: STUDENT_ID, studentName: 'Jane Student', courseId: 'C1', topic: 'glycolysis', state: 'Inactive', source: 'course', superchatId: null },
    { userId: STUDENT_ID, studentName: 'Jane Student', courseId: 'C1', topic: 'atp', state: 'Inactive', source: 'course', superchatId: null }
];

let logs;
let stops;
beforeEach(() => {
    logs = [];
    for (const level of ['log', 'warn', 'error']) {
        jest.spyOn(console, level).mockImplementation((...args) => { logs.push(args.map(String).join(' ')); });
    }
    stops = [];
});
afterEach(() => {
    stops.forEach(stop => stop());
    jest.restoreAllMocks();
});

function listen(subscribeTo, ...args) {
    const got = [];
    stops.push(subscribeTo(event => { got.push(event); }, ...args));
    return got;
}

describeWithToolkit('struggle events', () => {
    test('a listener on struggle.* gets each change, and a default listener on everything gets none', async () => {
        const struggles = [];
        stops.push(eventsService.subscribe('struggle.*', event => { struggles.push(event); }));
        const everything = listen(eventsService.subscribeAll);
        const everythingSensitive = listen(eventsService.subscribeAll, { sensitive: true });

        await struggleThenReset();
        await delivered();

        expect(struggles.map(event => [event.type, event.data.topic])).toEqual([
            ['struggle.topic.activated', 'glycolysis'],
            ['struggle.topic.cleared', 'glycolysis'],
            ['struggle.topic.cleared', 'atp']
        ]);
        expect(everything).toEqual([]);
        expect(everythingSensitive.map(event => event.id)).toEqual(struggles.map(event => event.id));
    });

    test('each event says who, where and what it means, and holds nothing personal', async () => {
        const struggles = [];
        stops.push(eventsService.subscribe('struggle.*', event => { struggles.push(event); }));

        await struggleThenReset();
        await delivered();

        expect(struggles[0]).toMatchObject({
            type: 'struggle.topic.activated',
            version: 1,
            app: 'biocbot',
            origin: 'server',
            source: { server: eventsService.serverName() },
            user: STUDENT_ID,
            course: 'C1',
            preview: false,
            data: { topic: 'glycolysis' },
            meta: {
                label: 'starts struggling with a topic',
                sensitive: true,
                props: { topic: { type: 'text', label: 'Topic' } }
            }
        });
        expect(struggles[1]).toMatchObject({
            type: 'struggle.topic.cleared',
            user: STUDENT_ID,
            course: 'C1',
            preview: false,
            data: { topic: 'glycolysis' },
            meta: { label: 'clears a struggle topic', sensitive: true }
        });
        const text = JSON.stringify(struggles);
        for (const personal of ['jstudent', 'Jane Student', 'jane@example.com', 'PUID123']) {
            expect(text).not.toContain(personal);
        }
    });

    test('writes the same rows and the same struggle state as with the toolkit missing', async () => {
        const withEvents = await struggleThenReset();
        const withoutEvents = await struggleThenReset({}, userWithoutToolkit());

        expect(await rows(withEvents)).toEqual(EXPECTED_ROWS);
        expect(await rows(withoutEvents)).toEqual(EXPECTED_ROWS);
        expect(await users(withEvents)).toEqual(await users(withoutEvents));
    });

    test('writes the same rows when a struggle listener throws, and logs no topic for it', async () => {
        stops.push(eventsService.subscribe('struggle.*', () => { throw new Error('a listener failed'); }));

        const db = await struggleThenReset();
        await delivered();

        expect(await rows(db)).toEqual(EXPECTED_ROWS);
        const failures = logs.filter(line => line.includes('[EVENTS]'));
        expect(failures).toHaveLength(3);
        expect(failures.join('\n')).not.toMatch(/glycolysis|atp/i);
    });

    test('marks a "View as Student" sandbox\'s struggle as a preview', async () => {
        const previewUserId = previewSession.buildPreviewUserId('user_17d0', 'C1');
        const struggles = [];
        stops.push(eventsService.subscribe('struggle.*', event => { struggles.push(event); }));

        await struggleThenReset({ userId: previewUserId, isPreview: true, displayName: 'Preview Student' });
        await delivered();

        expect(struggles).toHaveLength(3);
        expect(struggles.every(event => event.preview === true && event.user === previewUserId)).toBe(true);
    });

    test('leaves the course off when the row has none', async () => {
        const struggles = [];
        stops.push(eventsService.subscribe('struggle.*', event => { struggles.push(event); }));
        const db = memoryDb({ users: [studentDoc({ preferences: {} })] });

        await User.updateUserStruggleState(db, STUDENT_ID, { topic: 'glycolysis', isStruggling: true });
        await delivered();

        expect((await rows(db))[0].courseId).toBeNull();
        expect(struggles).toHaveLength(1);
        expect(struggles[0]).not.toHaveProperty('course');
    });

    test('publishes nothing for Super Chat, which writes its own rows (skipActivityLog)', async () => {
        const struggles = [];
        stops.push(eventsService.subscribe('struggle.*', event => { struggles.push(event); }));
        const db = memoryDb({ users: [studentDoc()] });

        const result = await User.updateUserStruggleState(db, STUDENT_ID, { topic: 'glycolysis', isStruggling: true }, 'C1', {
            source: 'superCourse',
            skipActivityLog: true
        });
        await delivered();

        expect(result.state.isActive).toBe(true);
        expect(await rows(db)).toEqual([]);
        expect(struggles).toEqual([]);
    });

    test('publishes nothing when no row is written: below the threshold, or already active', async () => {
        const struggles = [];
        stops.push(eventsService.subscribe('struggle.*', event => { struggles.push(event); }));
        const db = memoryDb({ users: [studentDoc({ struggleState: { topics: [] } })] });

        await User.updateUserStruggleState(db, STUDENT_ID, { topic: 'glycolysis', isStruggling: true }, 'C1');
        await User.updateUserStruggleState(db, STUDENT_ID, { topic: 'glycolysis', isStruggling: false }, 'C1');
        await delivered();

        expect(await rows(db)).toEqual([]);
        expect(struggles).toEqual([]);
    });
});
