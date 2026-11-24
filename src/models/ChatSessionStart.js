/**
 * ChatSessionStart Model
 *
 * Which chats a student has started, so `chat.session.started` is published
 * once per chat (src/services/activityEvents.js). A chat is the session id the
 * student page sends with each message (`conversationId`, the same id its saved
 * chat has). The first message of a chat inserts its row; every later message
 * finds the row there. The insert is atomic and the pair is unique, so two
 * application servers, or a message retried, can't both count as the start.
 *
 * A row holds only the pseudonymous user id, the course and the session id.
 * Rows expire a week after the chat started: a chat goes stale long before
 * that (a new one starts after the student is idle), so a row is never needed
 * by then. A preview's rows go with its sandbox (src/models/PreviewState.js).
 */

const COLLECTION_NAME = 'chatSessionStarts';

// A week. Rows are only kept while their chat could still get messages.
const EXPIRE_AFTER_SECONDS = 7 * 24 * 60 * 60;

// MongoDB's duplicate key error: another request inserted the row first.
const DUPLICATE_KEY = 11000;

function getCollection(db) {
    return db.collection(COLLECTION_NAME);
}

async function ensureIndexes(db) {
    const collection = getCollection(db);
    await collection.createIndex(
        { userId: 1, sessionId: 1 },
        { unique: true, name: 'unique_chat_session_start_per_student' }
    );
    await collection.createIndex(
        { startedAt: 1 },
        { expireAfterSeconds: EXPIRE_AFTER_SECONDS, name: 'expire_chat_session_starts' }
    );
}

/**
 * Record that a student's chat got a message, and say whether it was the
 * chat's first.
 *
 * @param {Object} db
 * @param {{ userId: string, courseId: string, sessionId: string }} chat
 * @returns {Promise<boolean>} True only for the message that started the chat
 */
async function recordStart(db, { userId, courseId, sessionId }) {
    try {
        const result = await getCollection(db).updateOne(
            { userId, sessionId },
            { $setOnInsert: { courseId, startedAt: new Date() } },
            { upsert: true }
        );
        return result.upsertedCount === 1;
    } catch (error) {
        // Both inserted at once, and the other one won: not this one's start.
        if (error && error.code === DUPLICATE_KEY) return false;
        throw error;
    }
}

module.exports = {
    COLLECTION_NAME,
    EXPIRE_AFTER_SECONDS,
    ensureIndexes,
    recordStart
};
