/**
 * PreviewState Model
 *
 * Per-previewer, per-course state for the "View as Student" sandbox: whether
 * the previewer has already been through the student first-run flow.
 *
 * Sandbox *content* (chats, quiz attempts, flashcard progress) is not stored
 * here — it lives in the ordinary student collections under the namespaced
 * preview user id. This document only records the state that has nowhere else
 * to live, plus it gives "Reset preview" and "Exit preview" a single place to
 * start from.
 */

const { buildPreviewUserDocument } = require('../services/previewSession');

const COLLECTION_NAME = 'previewStates';

/**
 * Student-data collections written during a preview, with the field each one
 * uses to identify the user. "Reset preview" clears the preview id from all of
 * them.
 *
 * Kept explicit rather than derived: a collection missing from this list keeps
 * stale sandbox data after a reset, which is easier to spot in one list than
 * scattered across call sites.
 */
const PREVIEW_DATA_COLLECTIONS = [
    { collection: 'chat_sessions', field: 'studentId' },
    { collection: 'quizAttempts', field: 'studentId' },
    { collection: 'flashcardProgress', field: 'studentId' },
    { collection: 'messageFeedback', field: 'studentId' },
    { collection: 'chatSurveyResponses', field: 'studentId' },
    { collection: 'flaggedQuestions', field: 'studentId' },
    { collection: 'struggleActivity', field: 'userId' },
    { collection: 'userAgreements', field: 'userId' },
    { collection: 'student_super_course_chat_sessions', field: 'studentId' },
    { collection: 'superchats', field: 'studentId' },
    { collection: 'chatSessionStarts', field: 'userId' }
];

/**
 * Collections that reference users inside an array rather than by a scalar
 * field, and so need a $pull instead of a delete.
 */
const PREVIEW_ARRAY_REFERENCES = [
    { collection: 'persistenceTopics', field: 'studentIds' }
];

/**
 * Get the preview state collection
 * @param {Object} db - MongoDB database instance
 * @returns {Collection} MongoDB collection
 */
function getPreviewStateCollection(db) {
    return db.collection(COLLECTION_NAME);
}

/**
 * Fetch the stored preview state, or a default shape when none exists yet
 * @param {Object} db - MongoDB database instance
 * @param {string} previewUserId - Namespaced preview user id
 * @returns {Promise<Object>} Preview state
 */
async function getState(db, previewUserId) {
    const existing = await getPreviewStateCollection(db).findOne({ previewUserId });

    if (!existing) {
        return {
            previewUserId,
            firstRunCompleted: false
        };
    }

    return {
        ...existing,
        firstRunCompleted: existing.firstRunCompleted === true
    };
}

/**
 * Create (or refresh) the `users` document that backs the sandbox.
 *
 * Parts of the student experience read from the user document rather than a
 * side collection — struggle state most visibly — so without this record the
 * student pages fail on a 404 instead of rendering. Marked isPreview so user
 * listings can filter it out.
 *
 * @param {Object} db - MongoDB database instance
 * @param {Object} realUser - The authenticated instructor/TA/admin
 * @param {Object} grant - Preview grant
 * @returns {Promise<void>}
 */
async function ensurePreviewUser(db, realUser, grant) {
    const document = buildPreviewUserDocument(realUser, grant);
    const { userId, ...rest } = document;
    const now = new Date();

    await db.collection('users').updateOne(
        { userId },
        {
            // struggleState is deliberately only set on insert: it is sandbox
            // data the previewer accumulates, and reopening the preview must
            // not wipe it.
            $set: {
                username: rest.username,
                displayName: rest.displayName,
                role: rest.role,
                isActive: true,
                isPreview: true,
                previewOwnerId: rest.previewOwnerId,
                previewCourseId: rest.previewCourseId,
                authProvider: rest.authProvider,
                preferences: rest.preferences,
                permissions: rest.permissions,
                lastLogin: now
            },
            $setOnInsert: {
                userId,
                email: null,
                struggleState: rest.struggleState,
                // Only on insert: once the previewer has been through the
                // welcome flow it must not restart on every visit.
                studentOnboardingComplete: rest.studentOnboardingComplete,
                createdAt: now
            }
        },
        { upsert: true }
    );
}

/**
 * Create the state document if it is missing, and return the current state
 * @param {Object} db - MongoDB database instance
 * @param {Object} grant - Preview grant
 * @returns {Promise<Object>} Preview state
 */
async function ensureState(db, grant) {
    const now = new Date();

    await getPreviewStateCollection(db).updateOne(
        { previewUserId: grant.previewUserId },
        {
            $setOnInsert: {
                previewUserId: grant.previewUserId,
                ownerUserId: grant.ownerUserId,
                courseId: grant.courseId,
                firstRunCompleted: false,
                createdAt: now
            },
            $set: { lastOpenedAt: now }
        },
        { upsert: true }
    );

    return getState(db, grant.previewUserId);
}

/**
 * Record whether the previewer has been through the student first-run flow.
 *
 * Set true after the first preview so later visits land straight on the
 * dashboard; set false again when they ask to replay it.
 *
 * @param {Object} db - MongoDB database instance
 * @param {string} previewUserId - Namespaced preview user id
 * @param {boolean} completed - New value
 * @returns {Promise<void>}
 */
async function setFirstRunCompleted(db, previewUserId, completed) {
    await getPreviewStateCollection(db).updateOne(
        { previewUserId },
        { $set: { firstRunCompleted: completed === true, updatedAt: new Date() } },
        { upsert: true }
    );
}

/**
 * Delete every trace of a preview sandbox: all student data written under the
 * preview id, plus the first-run flag.
 *
 * The sandbox's `users` document survives, cleared rather than removed, because
 * "Reset preview data" reloads straight back into the same preview and the page
 * scripts would 404 on a missing user. Exiting the preview has no such
 * constraint — see destroySandbox.
 *
 * @param {Object} db - MongoDB database instance
 * @param {string} previewUserId - Namespaced preview user id
 * @returns {Promise<Object>} Per-collection deleted counts
 */
async function resetPreviewData(db, previewUserId) {
    const deleted = {};

    for (const { collection, field } of PREVIEW_DATA_COLLECTIONS) {
        try {
            const result = await db.collection(collection).deleteMany({ [field]: previewUserId });
            deleted[collection] = result.deletedCount || 0;
        } catch (error) {
            // A collection that has never been created is not an error here.
            console.warn(`[PREVIEW] Reset skipped ${collection}:`, error.message);
            deleted[collection] = 0;
        }
    }

    for (const { collection, field } of PREVIEW_ARRAY_REFERENCES) {
        try {
            await db.collection(collection).updateMany(
                { [field]: previewUserId },
                { $pull: { [field]: previewUserId } }
            );
        } catch (error) {
            console.warn(`[PREVIEW] Reset skipped ${collection}:`, error.message);
        }
    }

    // Drop any course enrollment entry a preview left behind. Joining is
    // blocked for preview ids now, so this only matters for sandboxes created
    // before that guard — but leaving one behind puts a fake row in the
    // instructor's Student Hub.
    try {
        await db.collection('courses').updateMany(
            { [`studentEnrollment.${previewUserId}`]: { $exists: true } },
            { $unset: { [`studentEnrollment.${previewUserId}`]: '' } }
        );
    } catch (error) {
        console.warn('[PREVIEW] Reset skipped course enrollment:', error.message);
    }

    // struggleState lives on the sandbox's user document, so clear it there
    // rather than deleting the document — deleting it would break the preview
    // tab that is still open and about to reload.
    try {
        await db.collection('users').updateOne(
            { userId: previewUserId, isPreview: true },
            {
                $set: {
                    struggleState: { topics: [] },
                    // A full reset means the next visit is a first visit again.
                    studentOnboardingComplete: false,
                    updatedAt: new Date()
                }
            }
        );
    } catch (error) {
        console.warn('[PREVIEW] Reset skipped user struggle state:', error.message);
    }

    await setFirstRunCompleted(db, previewUserId, false);

    return deleted;
}

/**
 * Tear a preview sandbox down completely, for "Exit preview".
 *
 * Everything resetPreviewData removes, and then the two documents it has to
 * leave behind: the sandbox's `users` record and its state document. Nothing
 * survives, so re-entering the preview builds a genuinely new sandbox with no
 * chat history, no quiz attempts, and the student first-run flow ahead of it.
 *
 * @param {Object} db - MongoDB database instance
 * @param {string} previewUserId - Namespaced preview user id
 * @returns {Promise<Object>} Per-collection deleted counts
 */
async function destroySandbox(db, previewUserId) {
    const deleted = await resetPreviewData(db, previewUserId);

    // isPreview is part of the filter as well as the id prefix: a real account
    // can never hold an id in this namespace, but a delete of a `users` record
    // is worth making impossible to aim at one by accident.
    try {
        const result = await db.collection('users').deleteOne({ userId: previewUserId, isPreview: true });
        deleted.users = result.deletedCount || 0;
    } catch (error) {
        console.warn('[PREVIEW] Exit could not remove the sandbox user:', error.message);
        deleted.users = 0;
    }

    try {
        const result = await getPreviewStateCollection(db).deleteMany({ previewUserId });
        deleted[COLLECTION_NAME] = result.deletedCount || 0;
    } catch (error) {
        console.warn('[PREVIEW] Exit could not remove the sandbox state:', error.message);
        deleted[COLLECTION_NAME] = 0;
    }

    return deleted;
}

module.exports = {
    COLLECTION_NAME,
    PREVIEW_DATA_COLLECTIONS,
    PREVIEW_ARRAY_REFERENCES,
    getPreviewStateCollection,
    getState,
    ensurePreviewUser,
    ensureState,
    setFirstRunCompleted,
    resetPreviewData,
    destroySandbox
};
