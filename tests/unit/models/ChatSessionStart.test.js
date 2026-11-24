/**
 * Which chats a student has started (src/models/ChatSessionStart.js), so a
 * chat's start is announced once: the first message's insert says yes, every
 * later one, a retry, or a second server racing it, says no.
 */
const { memoryDb } = require('../helpers/memory-db');
const ChatSessionStart = require('../../../src/models/ChatSessionStart');

const chat = { userId: 'user_5f1c', courseId: 'C1', sessionId: 'autosave_1764000000000_abc123def' };

describe('recordStart', () => {
    test("only a chat's first message is its start", async () => {
        const db = memoryDb({});

        expect(await ChatSessionStart.recordStart(db, chat)).toBe(true);
        expect(await ChatSessionStart.recordStart(db, chat)).toBe(false);
        expect(await ChatSessionStart.recordStart(db, { ...chat, sessionId: 'autosave_2' })).toBe(true);
        // The same session id from another student is that student's own chat.
        expect(await ChatSessionStart.recordStart(db, { ...chat, userId: 'user_9e0d' })).toBe(true);

        const rows = (await db.collection('chatSessionStarts').find({}).toArray()).map(({ _id, ...row }) => row);
        expect(rows).toHaveLength(3);
        // Only the pseudonymous id, the course, the chat, and when.
        expect(rows[0]).toEqual({
            userId: 'user_5f1c',
            sessionId: 'autosave_1764000000000_abc123def',
            courseId: 'C1',
            startedAt: expect.any(Date)
        });
    });

    test('losing a race to insert the same row is not a start, and other errors are thrown', async () => {
        const duplicate = Object.assign(new Error('E11000 duplicate key error'), { code: 11000 });
        const racing = { collection: () => ({ updateOne: jest.fn().mockRejectedValue(duplicate) }) };
        expect(await ChatSessionStart.recordStart(racing, chat)).toBe(false);

        const down = { collection: () => ({ updateOne: jest.fn().mockRejectedValue(new Error('connection lost')) }) };
        await expect(ChatSessionStart.recordStart(down, chat)).rejects.toThrow('connection lost');
    });
});

describe('ensureIndexes', () => {
    test('one row per student and chat, kept for a week', async () => {
        const createIndex = jest.fn().mockResolvedValue('ok');
        const db = { collection: jest.fn(() => ({ createIndex })) };

        await ChatSessionStart.ensureIndexes(db);

        expect(db.collection).toHaveBeenCalledWith('chatSessionStarts');
        expect(createIndex).toHaveBeenCalledWith(
            { userId: 1, sessionId: 1 },
            { unique: true, name: 'unique_chat_session_start_per_student' }
        );
        expect(createIndex).toHaveBeenCalledWith(
            { startedAt: 1 },
            { expireAfterSeconds: 7 * 24 * 60 * 60, name: 'expire_chat_session_starts' }
        );
    });
});
