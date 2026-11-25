/**
 * What a student does in BiocBot, as events: the ones the gamification toolkit
 * counts for BiocBot (chats about a unit, chat messages, practice questions),
 * and accepting the user agreement. Their meaning is in BiocBot's dictionary
 * (src/services/events.js), apart from agreement.accepted, which is the
 * toolkit's general event.
 *
 * Each is published by the route that already does the thing, after it has
 * done it, and changes nothing about it: nothing here throws, and where the
 * pub/sub toolkit isn't installed nothing is published or stored.
 *
 * Only a student's own activity counts, including a "View as Student" preview,
 * which is marked `preview` so gamification awards nothing for it. Instructors
 * and TAs trying a route out publish nothing. `user` is always the
 * pseudonymous `req.user.userId`.
 */

const events = require('./events');
const ChatSessionStart = require('../models/ChatSessionStart');

// BiocBot's own session ids are about 30 characters ("autosave_<time>_<random>").
const MAX_SESSION_ID = 128;
// Unit names are written by instructors. A longer one is cut, not dropped.
const MAX_UNIT = 200;
// Agreement versions are short, such as "1.0".
const MAX_AGREEMENT_VERSION = 32;

function isText(value, max = Infinity) {
    return typeof value === 'string' && value.trim() !== '' && value.length <= max;
}

/** The student behind a request, or null for anyone else. */
function studentOf(user) {
    if (!user || user.role !== 'student' || !isText(user.userId)) return null;
    return { user: user.userId, preview: user.isPreview === true };
}

/**
 * A unit's name for an event's data, or null when there's none. The toolkit
 * requires every field an event defines, so an event without its unit isn't
 * published. The routes always have one: they refuse a request without it.
 */
function unitName(unit) {
    if (typeof unit !== 'string' || unit.trim() === '') return null;
    return unit.trim().slice(0, MAX_UNIT);
}

/**
 * After POST /api/quiz/attempt saved a student's answer.
 *
 * @param {Object} user - req.user
 * @param {{ courseId: string, unit: string, correct: boolean }} answer
 * @returns {boolean} Whether an event was published
 */
function publishQuestionAnswered(user, { courseId, unit, correct }) {
    const student = studentOf(user);
    const name = unitName(unit);
    if (!student || !isText(courseId) || name === null) return false;
    return events.publishEvent('quiz.question.answered', {
        user: student.user,
        course: courseId,
        preview: student.preview,
        data: { correct: correct === true, unit: name }
    }).ok;
}

/**
 * After POST /api/chat accepted a student's message to answer: one
 * `chat.message.sent`, and before it `chat.session.started` when the message
 * is the chat's first. Messages BiocBot doesn't answer (the language check's)
 * and the explanations the page asks for itself aren't sent here.
 *
 * Nothing is stored where the toolkit isn't installed. It never rejects.
 *
 * @param {Object} db
 * @param {Object} user - req.user
 * @param {{ courseId: string, sessionId: string, unit: string }} message
 * @returns {Promise<{ started: boolean, sent: boolean }>} What was published
 */
async function announceChatMessage(db, user, { courseId, sessionId, unit }) {
    const nothing = { started: false, sent: false };
    try {
        const student = studentOf(user);
        const name = unitName(unit);
        if (!student || !isText(courseId) || !isText(sessionId, MAX_SESSION_ID) || name === null || !events.getEvents()) {
            return nothing;
        }
        const who = { user: student.user, course: courseId, session: sessionId, preview: student.preview };

        let started = false;
        try {
            if (await ChatSessionStart.recordStart(db, { userId: student.user, courseId, sessionId })) {
                started = events.publishEvent('chat.session.started', { ...who, data: { unit: name } }).ok;
            }
        } catch (error) {
            // The message still counts. Only whether it started a chat is unknown.
            console.error('⚠️ [EVENTS] Could not record whether a chat started:', error && error.message);
        }

        const sent = events.publishEvent('chat.message.sent', who).ok;
        return { started, sent };
    } catch (error) {
        console.error('❌ [EVENTS] Could not announce a chat message:', error && error.message);
        return nothing;
    }
}

/**
 * After POST /api/user-agreement/agree recorded an agreement the user hadn't
 * accepted before, in this version. The id is the one the page publishes
 * (public/common/scripts/agreement-modal.js): `user-agreement-<version>`.
 * Anyone signs it, so this isn't only for students.
 *
 * @param {Object} user - req.user
 * @param {string} version - The agreement's version, such as "1.0"
 * @returns {boolean} Whether an event was published
 */
function publishAgreementAccepted(user, version) {
    if (!user || !isText(user.userId) || !isText(version, MAX_AGREEMENT_VERSION)) return false;
    return events.publishEvent('agreement.accepted', {
        user: user.userId,
        preview: user.isPreview === true,
        data: { agreement: `user-agreement-${version}` }
    }).ok;
}

module.exports = {
    MAX_SESSION_ID,
    MAX_UNIT,
    publishQuestionAnswered,
    announceChatMessage,
    publishAgreementAccepted
};
