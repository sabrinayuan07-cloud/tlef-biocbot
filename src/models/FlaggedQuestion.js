const { createId } = require('../services/id');

/**
 * Flagged Question Model for MongoDB
 * Stores student flags on questions and instructor responses
 */

const { MongoClient } = require('mongodb');
const VALID_FLAG_STATUSES = new Set(['pending', 'reviewed', 'resolved', 'dismissed']);
// The reasons the chat pages' flag menus offer (student chat, both Super
// Course chats). A flag must give one of them.
const FLAG_REASONS = Object.freeze(['incorrect', 'inappropriate', 'unclear', 'confusing', 'typo', 'offensive', 'irrelevant']);

/**
 * Flagged Question Schema Structure:
 * {
 *   _id: ObjectId,
 *   flagId: String,              // Unique flag identifier
 *   questionId: String,          // ID of the flagged question
 *   courseId: String,            // Course where the question was flagged
 *   courseName: String,          // Display name/code for the course where the question was flagged
 *   unitName: String,            // Unit/lecture name where question appears
 *   studentId: String,           // ID of the student who flagged
 *   studentName: String,         // Name of the student (for display)
 *   flagReason: String,          // Reason for flagging (e.g., "unclear", "incorrect", "inappropriate")
 *   flagDescription: String,     // Detailed description of the issue
 *   botMode: String,             // Bot mode when flag was submitted ("protege" or "tutor")
 *   reporterId: String,          // ID of the user who submitted the flag
 *   reporterName: String,        // Display name of the user who submitted the flag
 *   reporterRole: String,        // Role of the user who submitted the flag
 *   sourceCourseIds: Array,      // Source course IDs cited by a Super Course answer
 *   sourceCourseNames: Array,    // Source course names cited by a Super Course answer
 *   isSuperCourseFlag: Boolean,  // True when submitted from a Super Course chat
 *   superchatId: String,         // Which superchat bucket the flag came from (super-course flags only; null = legacy/all)
 *   flagStatus: String,          // "pending", "reviewed", "resolved", "dismissed"
 *   instructorResponse: String,  // Instructor's response/explanation
 *   instructorId: String,        // ID of instructor who responded
 *   instructorName: String,      // Name of instructor who responded
 *   questionContent: {           // Snapshot of question content when flagged
 *     question: String,
 *     questionType: String,
 *     options: Object,
 *     correctAnswer: String,
 *     explanation: String
 *   },
 *   createdAt: Date,             // When the flag was created
 *   updatedAt: Date,             // Last update timestamp
 *   resolvedAt: Date,            // When the flag was resolved (if applicable)
 *   priority: String             // "low", "medium", "high" - based on flag reason and impact
 * }
 */

/**
 * Get the flagged questions collection from the database
 * @param {Object} db - MongoDB database instance
 * @returns {Collection} Flagged questions collection
 */
function getFlaggedQuestionsCollection(db) {
    return db.collection('flaggedQuestions');
}

/**
 * Create a new flagged question
 * @param {Object} db - MongoDB database instance
 * @param {Object} flagData - Flag data object
 * @returns {Promise<Object>} Created flag result
 */
async function createFlaggedQuestion(db, flagData) {
    const collection = getFlaggedQuestionsCollection(db);
    
    const now = new Date();
    
    // Generate unique flag ID
    const flagId = createId('flag');
    
    const flag = {
        ...flagData,
        // Both are optional, and the encryption wrapper refuses an undefined
        // value in a field it protects.
        questionContent: flagData.questionContent ?? null,
        flagDescription: flagData.flagDescription ?? null,
        flagId,
        flagStatus: 'pending',
        createdAt: now,
        updatedAt: now,
        priority: determinePriority(flagData.flagReason)
    };
    
    const result = await collection.insertOne(flag);
    
    console.log(`Flagged question created: ${flagId} for question ${flagData.questionId}`);
    
    return {
        success: true,
        flagId,
        insertedId: result.insertedId
    };
}

/**
 * Get all flagged questions for a course
 * @param {Object} db - MongoDB database instance
 * @param {string} courseId - Course identifier
 * @param {string} status - Optional status filter
 * @returns {Promise<Array>} Array of flagged questions
 */
async function getFlaggedQuestionsForCourse(db, courseId, status = null) {
    const collection = getFlaggedQuestionsCollection(db);
    
    const filter = { courseId };
    if (status) {
        filter.flagStatus = status;
    }
    
    const flags = await collection.find(filter)
        .sort({ createdAt: -1 }) // Most recent first
        .toArray();
    
    return flags;
}

/**
 * Get flagged questions by status
 * @param {Object} db - MongoDB database instance
 * @param {string} status - Status to filter by
 * @returns {Promise<Array>} Array of flagged questions
 */
async function getFlaggedQuestionsByStatus(db, status) {
    const collection = getFlaggedQuestionsCollection(db);
    
    const flags = await collection.find({ flagStatus: status })
        .sort({ createdAt: -1 })
        .toArray();
    
    return flags;
}

/**
 * Get a specific flagged question by ID
 * @param {Object} db - MongoDB database instance
 * @param {string} flagId - Flag identifier
 * @returns {Promise<Object>} Flagged question object
 */
async function getFlaggedQuestionById(db, flagId) {
    const collection = getFlaggedQuestionsCollection(db);
    
    const flag = await collection.findOne({ flagId });
    return flag;
}

/**
 * Get all flagged questions for a specific student (optionally scoped to a course)
 * @param {Object} db - MongoDB database instance
 * @param {string} studentId - Student identifier
 * @param {string|null} courseId - Optional course identifier to filter
 * @returns {Promise<Array>} Array of flagged questions for the student
 */
async function getFlaggedQuestionsForStudent(db, studentId, courseId = null) {
    const collection = getFlaggedQuestionsCollection(db);
    const filter = { studentId };
    if (courseId) {
        filter.courseId = courseId;
    }
    const flags = await collection
        .find(filter)
        .sort({ createdAt: -1 })
        .toArray();
    return flags;
}

/**
 * Update instructor response to a flagged question
 * @param {Object} db - MongoDB database instance
 * @param {string} flagId - Flag identifier
 * @param {Object} responseData - Response data from instructor
 * @returns {Promise<Object>} Update result
 */
async function updateInstructorResponse(db, flagId, responseData) {
    const collection = getFlaggedQuestionsCollection(db);
    
    const now = new Date();
    
    const finalStatus = responseData.flagStatus || 'resolved';
    if (!VALID_FLAG_STATUSES.has(finalStatus)) {
        return { success: false, error: 'Invalid flag status' };
    }

    const updateData = {
        instructorResponse: responseData.response,
        instructorId: responseData.instructorId,
        instructorName: responseData.instructorName ?? null,
        flagStatus: finalStatus,
        updatedAt: now
    };

    if (finalStatus === 'resolved') {
        updateData.resolvedAt = now;
    }
    
    const result = await collection.updateOne(
        { flagId },
        { $set: updateData }
    );
    
    if (result.modifiedCount > 0) {
        console.log(`Instructor response updated for flag: ${flagId}`);
        return { success: true, modifiedCount: result.modifiedCount };
    } else {
        return { success: false, error: 'Flag not found or no changes made' };
    }
}

/**
 * Update flag status
 * @param {Object} db - MongoDB database instance
 * @param {string} flagId - Flag identifier
 * @param {string} newStatus - New status to set
 * @param {string} instructorId - ID of instructor making the change
 * @returns {Promise<Object>} Update result
 */
async function updateFlagStatus(db, flagId, newStatus, instructorId) {
    const collection = getFlaggedQuestionsCollection(db);

    if (!VALID_FLAG_STATUSES.has(newStatus)) {
        return { success: false, error: 'Invalid flag status' };
    }
    
    const now = new Date();
    
    const updateData = {
        flagStatus: newStatus,
        instructorId,
        updatedAt: now
    };
    
    if (newStatus === 'resolved') {
        updateData.resolvedAt = now;
    }
    
    const result = await collection.updateOne(
        { flagId },
        { $set: updateData }
    );
    
    if (result.modifiedCount > 0) {
        console.log(`Flag status updated to ${newStatus} for flag: ${flagId}`);
        return { success: true, modifiedCount: result.modifiedCount };
    } else {
        return { success: false, error: 'Flag not found or no changes made' };
    }
}

/**
 * Edit a flag's own reason/description (#756): lets an instructor correct a
 * flag that was submitted incorrectly (e.g. wrong category), as opposed to
 * updateInstructorResponse which records the instructor's reply to it.
 * @param {Object} db - MongoDB database instance
 * @param {string} flagId - Flag identifier
 * @param {{flagReason?: string, flagDescription?: string}} edits - Fields to change
 * @returns {Promise<Object>} Update result
 */
async function updateFlagDetails(db, flagId, edits) {
    const collection = getFlaggedQuestionsCollection(db);

    const updateData = { updatedAt: new Date() };
    if (edits.flagReason !== undefined) {
        if (!isValidFlagReason(edits.flagReason)) {
            return { success: false, error: 'Invalid flag reason' };
        }
        updateData.flagReason = edits.flagReason;
    }
    if (edits.flagDescription !== undefined) {
        updateData.flagDescription = edits.flagDescription;
    }

    const result = await collection.updateOne(
        { flagId },
        { $set: updateData }
    );

    if (result.matchedCount === 0) {
        return { success: false, error: 'Flag not found' };
    }

    console.log(`Flag details updated for flag: ${flagId}`);
    return { success: true, modifiedCount: result.modifiedCount };
}

/**
 * Get flag statistics for a course
 * @param {Object} db - MongoDB database instance
 * @param {string} courseId - Course identifier
 * @returns {Promise<Object>} Flag statistics
 */
async function getFlagStatistics(db, courseId) {
    const collection = getFlaggedQuestionsCollection(db);
    
    // Counted here rather than with $group: the encryption wrapper rejects
    // $group on protected collections, and a course has few flags.
    const flags = await collection.find({ courseId }, { projection: { flagStatus: 1 } }).toArray();

    const statistics = {
        total: 0,
        pending: 0,
        reviewed: 0,
        resolved: 0,
        dismissed: 0
    };

    flags.forEach(({ flagStatus }) => {
        statistics[flagStatus] = (statistics[flagStatus] || 0) + 1;
        statistics.total += 1;
    });
    
    return statistics;
}

/**
 * Determine priority based on flag reason
 * @param {string} flagReason - Reason for flagging
 * @returns {string} Priority level
 */
function determinePriority(flagReason) {
    const highPriorityReasons = ['incorrect', 'inappropriate', 'offensive'];
    const mediumPriorityReasons = ['unclear', 'confusing', 'typo'];
    
    if (highPriorityReasons.includes(flagReason)) {
        return 'high';
    } else if (mediumPriorityReasons.includes(flagReason)) {
        return 'medium';
    } else {
        return 'low';
    }
}

function isValidFlagStatus(status) {
    return VALID_FLAG_STATUSES.has(status);
}

function isValidFlagReason(reason) {
    return FLAG_REASONS.includes(reason);
}

/**
 * Delete a flagged question (for cleanup purposes)
 * @param {Object} db - MongoDB database instance
 * @param {string} flagId - Flag identifier
 * @returns {Promise<Object>} Deletion result
 */
async function deleteFlaggedQuestion(db, flagId) {
    const collection = getFlaggedQuestionsCollection(db);
    
    const result = await collection.deleteOne({ flagId });
    
    if (result.deletedCount > 0) {
        console.log(`Flagged question deleted: ${flagId}`);
        return { success: true, deletedCount: result.deletedCount };
    } else {
        return { success: false, error: 'Flag not found' };
    }
}

module.exports = {
    createFlaggedQuestion,
    getFlaggedQuestionsForCourse,
    getFlaggedQuestionsByStatus,
    getFlaggedQuestionById,
    getFlaggedQuestionsForStudent,
    updateInstructorResponse,
    updateFlagStatus,
    updateFlagDetails,
    getFlagStatistics,
    deleteFlaggedQuestion,
    isValidFlagStatus,
    FLAG_REASONS,
    isValidFlagReason
};
