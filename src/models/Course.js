/**
 * Course Model for MongoDB
 * Stores course information and lecture publish status
 */

const { MongoClient } = require('mongodb');
const { isAcademicApiEnabled } = require('../services/academicApi');
const { createId } = require('../services/id');
const { parsePreviewUserId } = require('../services/previewSession');

const COURSE_STATUS = Object.freeze({
    ACTIVE: 'active',
    INACTIVE: 'inactive',
    DELETED: 'deleted'
});

const COURSE_STATUS_VALUES = Object.freeze(Object.values(COURSE_STATUS));

function normalizeCourseStatus(value, fallback = COURSE_STATUS.ACTIVE) {
    if (typeof value !== 'string') return fallback;
    const normalized = value.trim().toLowerCase();
    return COURSE_STATUS_VALUES.includes(normalized) ? normalized : fallback;
}

function isValidCourseStatus(value) {
    return typeof value === 'string' && COURSE_STATUS_VALUES.includes(value.trim().toLowerCase());
}

/**
 * Course Schema Structure:
 * {
 *   _id: ObjectId,
 *   courseId: String,           // Unique course identifier
 *   courseName: String,         // Display name of the course
 *   courseCode: String,         // Student course code
 *   instructorCourseCode: String, // Instructor course code
 *   instructorId: String,       // ID of the primary instructor (for backward compatibility)
 *   instructors: [String],      // Array of instructor IDs (primary instructor + additional instructors)
 *   tas: [String],              // Array of TA IDs
 *   taPermissions: {            // TA permission settings
 *     [taId]: {                 // Permission object for each TA - see
 *       materials: Boolean,     // TA_PERMISSION_KEYS in this file and
 *       questions: Boolean,     // src/services/permissions.js for the
 *       flags: Boolean,         // route mapping each key gates and the
 *       roster: Boolean,        // named role presets. A missing entry
 *       transcripts: Boolean,   // defaults to no access (fail-closed); a
 *       settings: Boolean,      // still-legacy {canAccessCourses,
 *       updatedAt: Date         // canAccessFlags} entry is normalized to
 *     }                         // this shape on read.
 *   },
 *   studentEnrollment: {        // Per-student enrollment overrides (optional)
 *     [studentId]: {
 *       enrolled: Boolean,      // If false, student is blocked from course features
 *       updatedAt: Date
 *     }
// ... (existing code)
 *   },
 *   rosterSource: 'academicSync' | 'canvas' | 'manual', // Exclusive enrollment owner
 *   studentIdleTimeout: Number, // Idle timeout for students in seconds (default: 300)
 *   lectures: [                 // Array of lectures/units
// ... (rest of the file)
 *     {
 *       name: String,           // e.g., "Unit 1", "Week 1"
 *       displayName: String,    // Custom title e.g., "Biology" (optional)
 *       showUnitNumber: Boolean, // Show "<N>. " prefix before displayName (optional, missing/undefined means true)
 *       isPublished: Boolean,   // Publish status
 *       createdAt: Date,        // When the lecture was created
 *       updatedAt: Date,        // Last update timestamp
 *       documents: [            // Array of uploaded documents
 *         {
 *           filename: String,
 *           originalName: String,
 *           size: Number,
 *           mimeType: String,
 *           uploadDate: Date,
 *           status: String      // "parsed", "needs-verify", "error"
 *         }
 *       ]
 *     }
 *   ],
 *   createdAt: Date,            // Course creation timestamp
 *   updatedAt: Date             // Last course update timestamp
 * }
 */

/**
 * Generate a random 6-character alphanumeric course code
 * @returns {string} Course code
 */
function generateCourseCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Excludes I, O, 1, 0 to avoid confusion
    let code = '';
    for (let i = 0; i < 6; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
}

function generateDistinctCourseCode(existingCodes = []) {
    const normalizedExistingCodes = new Set(
        existingCodes
            .filter(Boolean)
            .map((code) => String(code).trim().toUpperCase())
    );

    const maxAttempts = 20;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const code = generateCourseCode();
        if (!normalizedExistingCodes.has(code)) {
            return code;
        }
    }

    throw new Error(`Unable to generate a distinct course code after ${maxAttempts} attempts`);
}

function normalizeCode(code) {
    if (typeof code !== 'string') {
        return '';
    }

    return code.trim().toUpperCase();
}

// Year level is an integer 1-5, where 1-4 are years of undergraduate study and
// 5 represents Graduate. null means "not set / could not be determined".
const MIN_YEAR_LEVEL = 1;
const MAX_YEAR_LEVEL = 5; // 5 = Graduate

/**
 * Coerce an arbitrary value into a valid year level (1-5) or null.
 * @param {*} value - Raw value
 * @returns {number|null} Normalized year level or null
 */
function normalizeYearLevel(value) {
    if (typeof value === 'boolean' || value === null || value === '') {
        return null;
    }
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < MIN_YEAR_LEVEL || parsed > MAX_YEAR_LEVEL) {
        return null;
    }
    return parsed;
}

/**
 * Derive a default year level from a course name using the standard course-code
 * convention (the leading digit of the course number is the year). For example
 * "BIOC 401" -> 4, "CHEM 121" -> 1, "BIOC 530" -> 5 (Graduate). Numbers >= 500
 * map to Graduate (5). Returns null when no usable number is present so callers
 * can apply their own fallback.
 * @param {string} courseName - Course name/title
 * @returns {number|null} Derived year level or null
 */
function parseYearLevelFromName(courseName) {
    if (typeof courseName !== 'string') {
        return null;
    }

    // Prefer a standard 3-4 digit course number. A standalone single digit is
    // accepted only when it is itself a valid year label (1-5).
    const standardMatch = courseName.match(/\b(\d{3,4})\b/);
    const singleYearMatch = courseName.match(/\b([1-5])\b/);
    const match = standardMatch || singleYearMatch;
    if (!match) {
        return null;
    }

    // The leading digit of a course number is the year of study, for both the
    // common 3-digit convention ("401" -> 4) and 4-digit codes ("1010" -> 1).
    // Anything 5+ (e.g. "530") maps to Graduate.
    const firstDigit = parseInt(match[1][0], 10);
    if (!firstDigit || firstDigit < MIN_YEAR_LEVEL) {
        return null;
    }

    return Math.min(firstDigit, MAX_YEAR_LEVEL);
}

/**
 * Normalize a topic label for storage/display consistency
 * @param {string} topic - Raw topic text
 * @returns {string} Normalized topic text
 */
function normalizeTopicLabel(topic) {
    if (typeof topic !== 'string') return '';
    return topic.replace(/\s+/g, ' ').trim();
}

function getTopicLabel(topic) {
    if (typeof topic === 'string') {
        return normalizeTopicLabel(topic);
    }

    if (topic && typeof topic === 'object') {
        return normalizeTopicLabel(topic.topic);
    }

    return '';
}

function normalizeTopicSource(source, fallback = 'manual') {
    return source === 'scraped' || source === 'manual' ? source : fallback;
}

function normalizeTopicUnitId(unitId, fallback = null) {
    if (typeof unitId === 'string') {
        const normalized = unitId.trim();
        return normalized || null;
    }

    return fallback || null;
}

function normalizeTopicCreatedAt(createdAt, fallback = null) {
    const candidate = createdAt ? new Date(createdAt) : null;
    if (candidate && !Number.isNaN(candidate.getTime())) {
        return candidate;
    }

    return fallback || new Date();
}

/**
 * Normalize a topic object for storage. Legacy strings are represented as
 * unmapped manual topics when converted in memory.
 * @param {string|Object} rawTopic - Raw topic entry
 * @param {Object} existingTopic - Matching existing topic object, if any
 * @param {Object} defaults - Default metadata for new topics
 * @returns {Object|null} Normalized topic object
 */
function normalizeTopicObject(rawTopic, existingTopic = null, defaults = {}) {
    const topic = getTopicLabel(rawTopic);
    if (!topic) return null;

    const rawObject = rawTopic && typeof rawTopic === 'object' ? rawTopic : {};
    const existingObject = existingTopic && typeof existingTopic === 'object' ? existingTopic : {};
    const isStringTopic = typeof rawTopic === 'string';

    return {
        topic,
        unitId: isStringTopic
            ? normalizeTopicUnitId(existingObject.unitId, normalizeTopicUnitId(defaults.unitId, null))
            : normalizeTopicUnitId(rawObject.unitId, normalizeTopicUnitId(existingObject.unitId, normalizeTopicUnitId(defaults.unitId, null))),
        source: isStringTopic
            ? normalizeTopicSource(existingObject.source, normalizeTopicSource(defaults.source, 'manual'))
            : normalizeTopicSource(rawObject.source, normalizeTopicSource(existingObject.source, normalizeTopicSource(defaults.source, 'manual'))),
        createdAt: isStringTopic
            ? normalizeTopicCreatedAt(existingObject.createdAt, normalizeTopicCreatedAt(defaults.createdAt, null))
            : normalizeTopicCreatedAt(rawObject.createdAt, normalizeTopicCreatedAt(existingObject.createdAt, normalizeTopicCreatedAt(defaults.createdAt, null)))
    };
}

/**
 * Normalize + deduplicate topic list (case-insensitive)
 * @param {Array<string|Object>} topics - Raw topic list
 * @returns {Array<string>} Cleaned topic list
 */
function normalizeTopicList(topics = []) {
    if (!Array.isArray(topics)) return [];
    const seen = new Set();
    const output = [];

    for (const rawTopic of topics) {
        const normalized = getTopicLabel(rawTopic);
        if (!normalized) continue;

        const key = normalized.toLowerCase();
        if (seen.has(key)) continue;

        seen.add(key);
        output.push(normalized);
    }

    return output;
}

/**
 * Normalize + deduplicate topic objects (case-insensitive)
 * @param {Array<string|Object>} topics - Raw topic entries
 * @param {Object} defaults - Metadata defaults for new/legacy entries
 * @param {Array<string|Object>} existingTopics - Existing entries used to preserve metadata
 * @returns {Array<Object>} Cleaned topic object list
 */
function normalizeTopicObjectList(topics = [], defaults = {}, existingTopics = []) {
    if (!Array.isArray(topics)) return [];

    const existingByLabel = new Map();
    if (Array.isArray(existingTopics)) {
        for (const existing of existingTopics) {
            const existingObject = normalizeTopicObject(existing);
            if (!existingObject) continue;
            existingByLabel.set(existingObject.topic.toLowerCase(), existingObject);
        }
    }

    const seen = new Set();
    const output = [];

    for (const rawTopic of topics) {
        const label = getTopicLabel(rawTopic);
        if (!label) continue;

        const key = label.toLowerCase();
        if (seen.has(key)) continue;

        const normalized = normalizeTopicObject(rawTopic, existingByLabel.get(key), defaults);

        seen.add(key);
        output.push(normalized);
    }

    return output;
}

/**
 * Get the courses collection from the database
 * @param {Object} db - MongoDB database instance
 * @returns {Collection} Courses collection
 */
function getCoursesCollection(db) {
    return db.collection('courses');
}

function isInactiveCourse(course = {}) {
    return normalizeCourseStatus(course.status) === COURSE_STATUS.INACTIVE;
}

function compareCoursesWithInactiveLast(a = {}, b = {}) {
    const aInactive = isInactiveCourse(a) ? 1 : 0;
    const bInactive = isInactiveCourse(b) ? 1 : 0;

    if (aInactive !== bInactive) {
        return aInactive - bInactive;
    }

    const aUpdatedAt = new Date(a.updatedAt || a.createdAt || 0).getTime();
    const bUpdatedAt = new Date(b.updatedAt || b.createdAt || 0).getTime();

    if (aUpdatedAt !== bUpdatedAt) {
        return bUpdatedAt - aUpdatedAt;
    }

    return String(a.courseName || a.courseId || '').localeCompare(
        String(b.courseName || b.courseId || '')
    );
}

const DEFAULT_STUDENT_RAG_TOP_K = 3;
const MIN_RAG_TOP_K = 1;
const MAX_RAG_TOP_K = 20;
const MIN_CHAT_SURVEY_TRIGGER_MESSAGES = 2;
const MAX_CHAT_SURVEY_TRIGGER_MESSAGES = 30;
const DEFAULT_CHAT_SUMMARY_TRIGGER_MESSAGES = 25;
const MIN_CHAT_SUMMARY_TRIGGER_MESSAGES = 2;
const MAX_CHAT_SUMMARY_TRIGGER_MESSAGES = 40;
const DEFAULT_CHAT_SURVEY_SETTINGS = Object.freeze({
    enabled: false,
    triggerMessageCount: 10,
    promptText: 'How useful is this chat so far',
    introText: 'So BIOCBOT would like your help to improve the user and learning experience, if you are able to please rate your recent experience with BIOCBOT',
    accuracyPrompt: 'Has BIOCBOT been presenting accurate and appropriate content?',
    satisfactionPrompt: 'Are you satisfied with your learning experience using BIOCBOT?',
    allowFreeText: false,
    summaryTriggerMessageCount: DEFAULT_CHAT_SUMMARY_TRIGGER_MESSAGES
});

function normalizeRagTopK(value, fallback = DEFAULT_STUDENT_RAG_TOP_K) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < MIN_RAG_TOP_K || parsed > MAX_RAG_TOP_K) {
        return fallback;
    }

    return parsed;
}

function resolveRagSettings(courseDoc = {}) {
    const studentSettings = courseDoc && courseDoc.ragSettings && courseDoc.ragSettings.student
        ? courseDoc.ragSettings.student
        : {};

    return {
        student: {
            topK: normalizeRagTopK(studentSettings.topK)
        }
    };
}

function normalizeChatSurveyTriggerMessageCount(value, fallback = DEFAULT_CHAT_SURVEY_SETTINGS.triggerMessageCount) {
    const parsed = Number(value);
    if (
        !Number.isInteger(parsed)
        || parsed < MIN_CHAT_SURVEY_TRIGGER_MESSAGES
        || parsed > MAX_CHAT_SURVEY_TRIGGER_MESSAGES
    ) {
        return fallback;
    }

    return parsed;
}

function normalizeChatSummaryTriggerMessageCount(value, fallback = DEFAULT_CHAT_SUMMARY_TRIGGER_MESSAGES) {
    const parsed = Number(value);
    if (
        !Number.isInteger(parsed)
        || parsed < MIN_CHAT_SUMMARY_TRIGGER_MESSAGES
        || parsed > MAX_CHAT_SUMMARY_TRIGGER_MESSAGES
    ) {
        return fallback;
    }

    return parsed;
}

function normalizeChatSurveyPrompt(value, fallback) {
    if (typeof value !== 'string') return fallback;
    const normalized = value.replace(/\s+/g, ' ').trim();
    return normalized || fallback;
}

function resolveChatSurveySettings(courseDoc = {}) {
    const settings = courseDoc && courseDoc.chatSurveySettings && typeof courseDoc.chatSurveySettings === 'object'
        ? courseDoc.chatSurveySettings
        : {};

    return {
        enabled: settings.enabled === true,
        triggerMessageCount: normalizeChatSurveyTriggerMessageCount(settings.triggerMessageCount),
        promptText: normalizeChatSurveyPrompt(settings.promptText, DEFAULT_CHAT_SURVEY_SETTINGS.promptText),
        introText: normalizeChatSurveyPrompt(settings.introText, DEFAULT_CHAT_SURVEY_SETTINGS.introText),
        accuracyPrompt: normalizeChatSurveyPrompt(settings.accuracyPrompt, DEFAULT_CHAT_SURVEY_SETTINGS.accuracyPrompt),
        satisfactionPrompt: normalizeChatSurveyPrompt(settings.satisfactionPrompt, DEFAULT_CHAT_SURVEY_SETTINGS.satisfactionPrompt),
        summaryTriggerMessageCount: normalizeChatSummaryTriggerMessageCount(settings.summaryTriggerMessageCount),
        allowFreeText: settings.allowFreeText !== undefined
            ? settings.allowFreeText === true
            : DEFAULT_CHAT_SURVEY_SETTINGS.allowFreeText
    };
}

async function getChatSurveySettings(db, courseId) {
    const collection = getCoursesCollection(db);
    const course = await collection.findOne(
        { courseId, status: { $ne: 'deleted' } },
        { projection: { chatSurveySettings: 1, courseId: 1 } }
    );

    if (!course) {
        return { success: false, error: 'Course not found' };
    }

    return {
        success: true,
        settings: resolveChatSurveySettings(course),
        defaults: {
            ...DEFAULT_CHAT_SURVEY_SETTINGS,
            minTriggerMessageCount: MIN_CHAT_SURVEY_TRIGGER_MESSAGES,
            maxTriggerMessageCount: MAX_CHAT_SURVEY_TRIGGER_MESSAGES,
            minSummaryTriggerMessageCount: MIN_CHAT_SUMMARY_TRIGGER_MESSAGES,
            maxSummaryTriggerMessageCount: MAX_CHAT_SUMMARY_TRIGGER_MESSAGES
        }
    };
}

async function updateChatSurveySettings(db, courseId, settings = {}, updatedById = null) {
    const hasTriggerMessageCount = settings.triggerMessageCount !== undefined
        && settings.triggerMessageCount !== null
        && settings.triggerMessageCount !== '';
    const triggerMessageCount = hasTriggerMessageCount
        ? normalizeChatSurveyTriggerMessageCount(settings.triggerMessageCount, null)
        : DEFAULT_CHAT_SURVEY_SETTINGS.triggerMessageCount;
    if (triggerMessageCount === null) {
        return {
            success: false,
            error: `Survey trigger must be an integer from ${MIN_CHAT_SURVEY_TRIGGER_MESSAGES} to ${MAX_CHAT_SURVEY_TRIGGER_MESSAGES}`
        };
    }

    const hasSummaryTriggerMessageCount = settings.summaryTriggerMessageCount !== undefined
        && settings.summaryTriggerMessageCount !== null
        && settings.summaryTriggerMessageCount !== '';
    const summaryTriggerMessageCount = hasSummaryTriggerMessageCount
        ? normalizeChatSummaryTriggerMessageCount(settings.summaryTriggerMessageCount, null)
        : DEFAULT_CHAT_SUMMARY_TRIGGER_MESSAGES;
    if (summaryTriggerMessageCount === null) {
        return {
            success: false,
            error: `Summary trigger must be an integer from ${MIN_CHAT_SUMMARY_TRIGGER_MESSAGES} to ${MAX_CHAT_SUMMARY_TRIGGER_MESSAGES}`
        };
    }

    const now = new Date();
    const chatSurveySettings = {
        enabled: settings.enabled === true,
        triggerMessageCount,
        promptText: normalizeChatSurveyPrompt(settings.promptText, DEFAULT_CHAT_SURVEY_SETTINGS.promptText),
        introText: normalizeChatSurveyPrompt(settings.introText, DEFAULT_CHAT_SURVEY_SETTINGS.introText),
        accuracyPrompt: normalizeChatSurveyPrompt(settings.accuracyPrompt, DEFAULT_CHAT_SURVEY_SETTINGS.accuracyPrompt),
        satisfactionPrompt: normalizeChatSurveyPrompt(settings.satisfactionPrompt, DEFAULT_CHAT_SURVEY_SETTINGS.satisfactionPrompt),
        summaryTriggerMessageCount,
        allowFreeText: settings.allowFreeText !== undefined
            ? settings.allowFreeText === true
            : DEFAULT_CHAT_SURVEY_SETTINGS.allowFreeText,
        updatedAt: now
    };

    if (updatedById) {
        chatSurveySettings.updatedById = updatedById;
    }

    const collection = getCoursesCollection(db);
    const result = await collection.updateOne(
        { courseId, status: { $ne: 'deleted' } },
        {
            $set: {
                chatSurveySettings,
                updatedAt: now,
                lastUpdatedById: updatedById
            }
        }
    );

    return {
        success: result.matchedCount > 0,
        settings: chatSurveySettings,
        error: result.matchedCount > 0 ? null : 'Course not found'
    };
}

function getAllowInSuperCourse(courseDoc = {}) {
    return courseDoc.allowInSuperCourse === true;
}

async function getRagSettings(db, courseId) {
    const collection = getCoursesCollection(db);
    const course = await collection.findOne(
        { courseId, status: { $ne: 'deleted' } },
        { projection: { ragSettings: 1, allowInSuperCourse: 1, courseId: 1 } }
    );

    if (!course) {
        return { success: false, error: 'Course not found' };
    }

    return {
        success: true,
        ragSettings: resolveRagSettings(course),
        allowInSuperCourse: getAllowInSuperCourse(course)
    };
}

async function updateRagSettings(db, courseId, settings = {}, updatedById = null) {
    const topK = normalizeRagTopK(settings.student && settings.student.topK, null);
    if (topK === null) {
        return {
            success: false,
            error: `Student Chat Top-K must be an integer from ${MIN_RAG_TOP_K} to ${MAX_RAG_TOP_K}`
        };
    }

    const collection = getCoursesCollection(db);
    const update = {
        'ragSettings.student.topK': topK,
        updatedAt: new Date()
    };

    if (updatedById) {
        update.lastUpdatedById = updatedById;
    }

    const result = await collection.updateOne(
        { courseId, status: { $ne: 'deleted' } },
        { $set: update }
    );

    return {
        success: result.matchedCount > 0,
        ragSettings: { student: { topK } },
        error: result.matchedCount > 0 ? null : 'Course not found'
    };
}

async function updateAllowInSuperCourse(db, courseId, allowInSuperCourse, updatedById = null) {
    const collection = getCoursesCollection(db);
    const update = {
        allowInSuperCourse: allowInSuperCourse === true,
        updatedAt: new Date()
    };

    if (updatedById) {
        update.lastUpdatedById = updatedById;
    }

    const result = await collection.updateOne(
        { courseId, status: { $ne: 'deleted' } },
        { $set: update }
    );

    return {
        success: result.matchedCount > 0,
        allowInSuperCourse: allowInSuperCourse === true,
        error: result.matchedCount > 0 ? null : 'Course not found'
    };
}

/**
 * Normalize an arbitrary value into a clean array of superchat IDs (deduped,
 * trimmed strings). Used by both reads and writes of course.superchatIds.
 * @param {*} value
 * @returns {string[]}
 */
function normalizeSuperchatIds(value) {
    if (!Array.isArray(value)) return [];
    const seen = new Set();
    const out = [];
    for (const raw of value) {
        const id = typeof raw === 'string' ? raw.trim() : '';
        if (id && !seen.has(id)) {
            seen.add(id);
            out.push(id);
        }
    }
    return out;
}

/**
 * Get the superchat buckets a course belongs to.
 * @param {Object} courseDoc
 * @returns {string[]}
 */
function getCourseSuperchatIds(courseDoc = {}) {
    return normalizeSuperchatIds(courseDoc.superchatIds);
}

/**
 * Replace the set of superchat buckets a course belongs to.
 * @param {Object} db
 * @param {string} courseId
 * @param {string[]} superchatIds
 * @param {string|null} updatedById
 * @returns {Promise<Object>} { success, superchatIds, error }
 */
async function updateCourseSuperchats(db, courseId, superchatIds, updatedById = null) {
    const collection = getCoursesCollection(db);
    const normalized = normalizeSuperchatIds(superchatIds);
    const update = {
        superchatIds: normalized,
        updatedAt: new Date()
    };

    if (updatedById) {
        update.lastUpdatedById = updatedById;
    }

    const result = await collection.updateOne(
        { courseId, status: { $ne: 'deleted' } },
        { $set: update }
    );

    return {
        success: result.matchedCount > 0,
        superchatIds: normalized,
        error: result.matchedCount > 0 ? null : 'Course not found'
    };
}

/**
 * Ensure all courses have both student and instructor course codes (Migration)
 * @param {Object} db - MongoDB database instance
 */
async function ensureCourseCodes(db) {
    const collection = getCoursesCollection(db);
    const courses = await collection.find({
        $or: [
            { courseCode: { $exists: false } },
            { instructorCourseCode: { $exists: false } },
            { $expr: { $eq: ['$courseCode', '$instructorCourseCode'] } }
        ]
    }).toArray();
    
    if (courses.length > 0) {
        console.log(`Migrating ${courses.length} courses to have student/instructor course codes...`);
        for (const course of courses) {
            const studentCode = course.courseCode || generateDistinctCourseCode([course.instructorCourseCode]);
            const instructorCode = (!course.instructorCourseCode || normalizeCode(course.instructorCourseCode) === normalizeCode(studentCode))
                ? generateDistinctCourseCode([studentCode])
                : course.instructorCourseCode;

            await collection.updateOne(
                { _id: course._id },
                {
                    $set: {
                        courseCode: studentCode,
                        instructorCourseCode: instructorCode
                    }
                }
            );
            console.log(`Assigned missing course codes to course ${course.courseId}`);
        }
    }
}

/**
 * Create or update a course with lecture publish status
 * @param {Object} db - MongoDB database instance
 * @param {Object} courseData - Course data object
 * @returns {Promise<Object>} Created/updated course
 */
async function upsertCourse(db, courseData) {
    const collection = getCoursesCollection(db);
    
    const now = new Date();
    const course = {
        ...courseData,
        updatedAt: now
    };
    
    if (!course.createdAt) {
        course.createdAt = now;
    }

    // Ensure course codes exist
    if (!course.courseCode) {
        course.courseCode = generateDistinctCourseCode([course.instructorCourseCode]);
    }

    if (!course.instructorCourseCode) {
        course.instructorCourseCode = generateDistinctCourseCode([course.courseCode]);
    } else if (normalizeCode(course.instructorCourseCode) === normalizeCode(course.courseCode)) {
        course.instructorCourseCode = generateDistinctCourseCode([course.courseCode]);
    }
    
    const result = await collection.updateOne(
        { courseId: courseData.courseId },
        { $set: course },
        { upsert: true }
    );
    
    return result;
}

/**
 * Update the publish status of a specific lecture
 * @param {Object} db - MongoDB database instance
 * @param {string} courseId - Course identifier
 * @param {string} lectureName - Name of the lecture/unit
 * @param {boolean} isPublished - New publish status
 * @param {string} instructorId - ID of the instructor making the change
 * @returns {Promise<Object>} Update result
 */
async function updateLecturePublishStatus(db, courseId, lectureName, isPublished, updatedById) {
    const collection = getCoursesCollection(db);
    
    const now = new Date();
    
    // First, ensure the course exists
    const course = await collection.findOne({ courseId });
    if (!course) {
        console.error(`Course ${courseId} not found for publish status update`);
        return { success: false, error: 'Course not found' };
    }
    
    // Check if the lecture already exists
    const existingLecture = course.lectures ? course.lectures.find(l => l.name === lectureName) : null;
    
    if (existingLecture) {
        // Update existing lecture with publish status
        const result = await collection.updateOne(
            { 
                courseId,
                'lectures.name': lectureName 
            },
            {
                $set: {
                    'lectures.$.isPublished': isPublished,
                    'lectures.$.updatedAt': now,
                    updatedAt: now,
                    lastUpdatedById: updatedById
                }
            }
        );

        if (result.matchedCount === 0) {
            return { success: false, error: 'Course or lecture no longer exists' };
        }
        
        console.log(`Updated existing lecture ${lectureName} publish status to ${isPublished}`);
        return { success: true, created: false, modifiedCount: result.modifiedCount };
    } else {
        console.error(`Lecture ${lectureName} not found in course ${courseId}`);
        return { success: false, error: 'Lecture not found' };
    }
}

/**
 * Get the publish status of all lectures for a course
 * @param {Object} db - MongoDB database instance
 * @param {string} courseId - Course identifier
 * @returns {Promise<Object>} Publish status for each lecture
 */
async function getLecturePublishStatus(db, courseId) {
    const collection = getCoursesCollection(db);
    
    const course = await collection.findOne(
        { courseId },
        { projection: { lectures: 1 } }
    );
    
    if (!course || !course.lectures) {
        return {};
    }
    
    // Convert to a simple object mapping lecture names to publish status
    const publishStatus = {};
    course.lectures.forEach(lecture => {
        publishStatus[lecture.name] = lecture.isPublished;
    });
    
    return publishStatus;
}

/**
 * Get all published lectures for student access
 * @param {Object} db - MongoDB database instance
 * @param {string} courseId - Course identifier
 * @returns {Promise<Array>} Array of published lecture names
 */
async function getPublishedLectures(db, courseId) {
    const collection = getCoursesCollection(db);
    
    const course = await collection.findOne(
        { courseId },
        { projection: { lectures: 1 } }
    );
    
    if (!course || !course.lectures) {
        return [];
    }
    
    return course.lectures
        .filter(lecture => lecture.isPublished)
        .map(lecture => lecture.name);
}

/**
 * Update learning objectives for a specific lecture
 * @param {Object} db - MongoDB database instance
 * @param {string} courseId - Course identifier
 * @param {string} lectureName - Name of the lecture/unit
 * @param {Array} objectives - Array of learning objectives
 * @param {string} instructorId - ID of the instructor making the change
 * @returns {Promise<Object>} Update result
 */
async function updateLearningObjectives(db, courseId, lectureName, objectives, instructorId) {
    const collection = getCoursesCollection(db);
    
    const now = new Date();
    
    // First, ensure the course exists
    const course = await collection.findOne({ courseId });
    if (!course) {
        console.error(`Course ${courseId} not found for learning objectives update`);
        return { success: false, error: 'Course not found' };
    }
    
    // Check if the lecture already exists
    const existingLecture = course.lectures ? course.lectures.find(l => l.name === lectureName) : null;
    
    if (existingLecture) {
        // Update existing lecture with learning objectives
        const result = await collection.updateOne(
            { 
                courseId,
                'lectures.name': lectureName 
            },
            {
                $set: {
                    'lectures.$.learningObjectives': objectives,
                    'lectures.$.updatedAt': now,
                    updatedAt: now,
                    lastUpdatedById: instructorId
                }
            }
        );

        if (result.matchedCount === 0) {
            return { success: false, error: 'Course or lecture no longer exists' };
        }
        
        console.log(`Updated existing lecture ${lectureName} with learning objectives`);
        return { success: true, created: false, modifiedCount: result.modifiedCount };
    } else {
        console.error(`Lecture ${lectureName} not found in course ${courseId}`);
        return { success: false, error: 'Lecture not found' };
    }
}

/**
 * Add or update assessment questions for a specific lecture
 * @param {Object} db - MongoDB database instance
 * @param {string} courseId - Course identifier
 * @param {string} lectureName - Name of the lecture/unit
 * @param {Object} questionData - Question data to add/update
 * @param {string} instructorId - ID of the instructor making the change
 * @param {Object} [options] - Update behavior
 * @param {boolean} [options.requireExisting=false] - Reject rather than create a missing question
 * @returns {Promise<Object>} Update result
 */
async function updateAssessmentQuestions(db, courseId, lectureName, questionData, instructorId, options = {}) {
    const collection = getCoursesCollection(db);
    
    const now = new Date();
    
    // First, ensure the course exists
    const course = await collection.findOne({ courseId });
    if (!course) {
        console.error(`Course ${courseId} not found for assessment questions update`);
        return { success: false, error: 'Course not found' };
    }
    
    // Check if the lecture already exists
    const existingLecture = course.lectures ? course.lectures.find(l => l.name === lectureName) : null;
    
    if (existingLecture) {
        // Generate unique question ID if not provided
        if (!questionData.questionId) {
            questionData.questionId = createId('q');
        }
        
        // Add timestamp if not present
        if (!questionData.createdAt) {
            questionData.createdAt = now;
        }
        questionData.updatedAt = now;
        
        // Check if question already exists (for updates)
        const existingQuestionIndex = existingLecture.assessmentQuestions ? 
            existingLecture.assessmentQuestions.findIndex(q => q.questionId === questionData.questionId) : -1;
        
        if (existingQuestionIndex >= 0) {
            const existingQuestion = existingLecture.assessmentQuestions[existingQuestionIndex] || {};
            const updatedQuestion = {
                ...existingQuestion,
                ...questionData,
                questionId: existingQuestion.questionId || questionData.questionId,
                createdAt: existingQuestion.createdAt || questionData.createdAt || now,
                updatedAt: now
            };

            const updatedQuestions = [...(existingLecture.assessmentQuestions || [])];
            updatedQuestions[existingQuestionIndex] = updatedQuestion;

            // Update existing question
            const updateFilter = {
                courseId,
                'lectures.name': lectureName
            };
            if (options.requireExisting) {
                updateFilter['lectures.assessmentQuestions.questionId'] = questionData.questionId;
            }

            const result = await collection.updateOne(
                updateFilter,
                {
                    $set: {
                        'lectures.$.assessmentQuestions': updatedQuestions,
                        'lectures.$.updatedAt': now,
                        updatedAt: now,
                        lastUpdatedById: instructorId
                    }
                }
            );

            if (options.requireExisting && result.matchedCount === 0) {
                return { success: false, notFound: true, error: 'Question not found' };
            }
            
            console.log(`Updated existing assessment question in ${lectureName}`);
            return { success: true, created: false, modifiedCount: result.modifiedCount, questionId: questionData.questionId };
        } else {
            if (options.requireExisting) {
                return { success: false, notFound: true, error: 'Question not found' };
            }

            // Add new question
            const result = await collection.updateOne(
                { 
                    courseId,
                    'lectures.name': lectureName 
                },
                {
                    $push: {
                        'lectures.$.assessmentQuestions': questionData
                    },
                    $set: {
                        'lectures.$.updatedAt': now,
                        updatedAt: now,
                        lastUpdatedById: instructorId
                    }
                }
            );
            
            console.log(`Added new assessment question to ${lectureName}`);
            return { success: true, created: true, modifiedCount: result.modifiedCount, questionId: questionData.questionId };
        }
    } else {
        console.error(`Lecture ${lectureName} not found in course ${courseId}`);
        return { success: false, error: 'Lecture not found' };
    }
}

/**
 * Get assessment questions for a specific lecture
 * @param {Object} db - MongoDB database instance
 * @param {string} courseId - Course identifier
 * @param {string} lectureName - Name of the lecture/unit
 * @returns {Promise<Array>} Array of assessment questions
 */
async function getAssessmentQuestions(db, courseId, lectureName) {
    const collection = getCoursesCollection(db);
    
    const course = await collection.findOne(
        { courseId },
        { projection: { lectures: 1 } }
    );
    
    if (!course || !course.lectures) {
        return [];
    }
    
    // Find the specific lecture and return its assessment questions
    const lecture = course.lectures.find(l => l.name === lectureName);
    return lecture ? (lecture.assessmentQuestions || []) : [];
}

/**
 * Delete an assessment question from a specific lecture
 * @param {Object} db - MongoDB database instance
 * @param {string} courseId - Course identifier
 * @param {string} lectureName - Name of the lecture/unit
 * @param {string} questionId - ID of the question to delete
 * @param {string} instructorId - ID of the instructor making the change
 * @returns {Promise<Object>} Deletion result
 */
async function deleteAssessmentQuestion(db, courseId, lectureName, questionId, instructorId) {
    const collection = getCoursesCollection(db);
    
    const now = new Date();
    
    // First, ensure the course exists
    const course = await collection.findOne({ courseId });
    if (!course) {
        console.error(`Course ${courseId} not found for assessment question deletion`);
        return { success: false, error: 'Course not found' };
    }
    
    // Check if the lecture already exists
    const existingLecture = course.lectures ? course.lectures.find(l => l.name === lectureName) : null;
    
    if (existingLecture) {
        // $set always bumps updatedAt, so result.modifiedCount is 1 even when
        // $pull matched nothing. Check existence first so deletedCount is honest
        // and we don't spuriously stamp updatedAt on a no-op delete.
        const exists = (existingLecture.assessmentQuestions || []).some(
            q => q.questionId === questionId
        );
        if (!exists) {
            return { success: true, deletedCount: 0, questionId };
        }

        await collection.updateOne(
            {
                courseId,
                'lectures.name': lectureName
            },
            {
                $pull: {
                    'lectures.$.assessmentQuestions': { questionId: questionId }
                },
                $set: {
                    'lectures.$.updatedAt': now,
                    updatedAt: now,
                    lastUpdatedById: instructorId
                }
            }
        );

        console.log(`Deleted assessment question from ${lectureName}`);
        return { success: true, deletedCount: 1, questionId };
    } else {
        console.error(`Lecture ${lectureName} not found in course ${courseId}`);
        return { success: false, error: 'Lecture not found' };
    }
}

/**
 * Update pass threshold for a specific lecture
 * @param {Object} db - MongoDB database instance
 * @param {string} courseId - Course identifier
 * @param {string} lectureName - Name of the lecture/unit
 * @param {number} passThreshold - Number of questions required to pass
 * @param {string} instructorId - ID of the instructor making the change
 * @returns {Promise<Object>} Update result
 */
async function updatePassThreshold(db, courseId, lectureName, passThreshold, instructorId) {
    const collection = getCoursesCollection(db);
    
    const now = new Date();
    
    // First, ensure the course exists
    const course = await collection.findOne({ courseId });
    if (!course) {
        console.error(`Course ${courseId} not found for pass threshold update`);
        return { success: false, error: 'Course not found' };
    }
    
    // Check if the lecture already exists
    const existingLecture = course.lectures ? course.lectures.find(l => l.name === lectureName) : null;
    
    if (existingLecture) {
        // Update existing lecture with pass threshold
        const result = await collection.updateOne(
            { 
                courseId,
                'lectures.name': lectureName 
            },
            {
                $set: {
                    'lectures.$.passThreshold': passThreshold,
                    'lectures.$.updatedAt': now,
                    updatedAt: now,
                    lastUpdatedById: instructorId
                }
            }
        );

        if (result.matchedCount === 0) {
            return { success: false, error: 'Course or lecture no longer exists' };
        }
        
        console.log(`Updated existing lecture ${lectureName} with pass threshold ${passThreshold}`);
        return { success: true, created: false, modifiedCount: result.modifiedCount };
    } else {
        console.error(`Lecture ${lectureName} not found in course ${courseId}`);
        return { success: false, error: 'Lecture not found' };
    }
}

/**
 * Get pass threshold for a specific lecture
 * @param {Object} db - MongoDB database instance
 * @param {string} courseId - Course identifier
 * @param {string} lectureName - Name of the lecture/unit
 * @returns {Promise<number>} Pass threshold value
 */
async function getPassThreshold(db, courseId, lectureName) {
    const collection = getCoursesCollection(db);
    
    const course = await collection.findOne(
        { courseId },
        { projection: { lectures: 1 } }
    );
    
    if (!course || !course.lectures) {
        return 0; // Default threshold when no threshold is set
    }
    
    // Find the specific lecture and return its pass threshold
    const lecture = course.lectures.find(l => l.name === lectureName);
    // Return 0 if no threshold is set (null, undefined, or not found)
    if (!lecture) {
        return 0;
    }
    return lecture.passThreshold !== undefined && lecture.passThreshold !== null ? lecture.passThreshold : 0;
}



/**
 * Get learning objectives for a specific lecture
 * @param {Object} db - MongoDB database instance
 * @param {string} courseId - Course identifier
 * @param {string} lectureName - Name of the lecture/unit
 * @returns {Promise<Array>} Array of learning objectives
 */
async function getLearningObjectives(db, courseId, lectureName) {
    const collection = getCoursesCollection(db);
    
    const course = await collection.findOne(
        { courseId },
        { projection: { lectures: 1 } }
    );
    
    if (!course || !course.lectures) {
        return [];
    }
    
    // Find the specific lecture and return its learning objectives
    const lecture = course.lectures.find(l => l.name === lectureName);
    return lecture ? (lecture.learningObjectives || []) : [];
}

/**
 * Create or update a course with onboarding data and generate units
 * @param {Object} db - MongoDB database instance
 * @param {Object} onboardingData - Onboarding data including course structure
 * @returns {Promise<Object>} Created/updated course with units
 */
async function createCourseFromOnboarding(db, onboardingData) {
    const collection = getCoursesCollection(db);
    
    const now = new Date();
    const {
        courseId,
        courseName,
        instructorId,
        courseDescription,
        learningOutcomes,
        assessmentCriteria,
        courseMaterials,
        courseStructure
    } = onboardingData;
    
    try {
        // With the academic API on, an instructor can set up more than one course
        // (one per section), so we only treat it as "already exists" when this
        // exact course id is present. With it off (the default), restore the
        // pre-feature rule: one course per instructor — matching on instructorId
        // blocks creating a second.
        const academicEnabled = await isAcademicApiEnabled(db);
        const existingCourse = academicEnabled
            ? await collection.findOne({ courseId: onboardingData.courseId })
            : await collection.findOne({
                $or: [
                    { courseId: onboardingData.courseId },
                    { instructorId: onboardingData.instructorId }
                ]
            });

        if (existingCourse) {
            console.log(`Course already exists for instructor ${instructorId}: ${existingCourse.courseId}`);
            return {
                success: true,
                created: false,
                modifiedCount: 0,
                courseId: existingCourse.courseId,
                totalUnits: existingCourse.courseStructure?.totalUnits || 0,
                message: 'Course already exists'
            };
        }
        
        // Calculate total units from weeks and lectures per week
        const totalUnits = courseStructure.weeks * courseStructure.lecturesPerWeek;
        
        // Generate units array
        const units = [];
        for (let i = 1; i <= totalUnits; i++) {
            const unitName = `Unit ${i}`;
            
            // Check if we have existing data for this unit from onboarding
            // Note: Documents are now handled separately through the documents array
            
            // For Unit 1, use learning outcomes from onboarding if available
            let learningObjectives = [];
            if (i === 1 && learningOutcomes && learningOutcomes.length > 0) {
                learningObjectives = learningOutcomes;
                console.log(`Setting Unit 1 learning objectives:`, learningObjectives);
            }
            
            // Debug: Log what we're setting for each unit
            console.log(`Unit ${i} (${unitName}): learningObjectives =`, learningObjectives);
            
            units.push({
                name: unitName,
                isPublished: false,
                learningObjectives: learningObjectives, // This should now work correctly
                passThreshold: 2, // Default threshold
                createdAt: now,
                updatedAt: now,
                documents: [],
                assessmentQuestions: [] // Initialize empty assessment questions array
            });
        }
        
        // Prepare the course document
        const studentCourseCode = generateCourseCode();
        const instructorCourseCode = generateDistinctCourseCode([studentCourseCode]);

        const course = {
            courseId,
            courseName,
            yearLevel: parseYearLevelFromName(courseName), // Derived from course number; editable in settings
            superchatIds: [], // Superchat buckets this course belongs to (instructor-managed)
            courseCode: studentCourseCode, // Generate student course code
            instructorCourseCode, // Generate instructor course code
            instructorId,
            instructors: [instructorId], // Initialize with primary instructor
            tas: [], // Initialize empty TA array
            rosterSource: 'manual',
            courseDescription: courseDescription || '',
            assessmentCriteria: assessmentCriteria || '',
            courseMaterials: courseMaterials || [],
            approvedStruggleTopics: [],
            // Retrieval behavior setting will be inherited from global settings if not set
            // isAdditiveRetrieval: false,
            courseStructure: {
                weeks: courseStructure.weeks,
                lecturesPerWeek: courseStructure.lecturesPerWeek,
                totalUnits: totalUnits
            },
            isOnboardingComplete: false, // Flag to track onboarding completion - set to true only after Unit 1 setup is complete
            lectures: units, // Use the existing lectures field for units
            createdAt: now,
            updatedAt: now
        };
        
        console.log(`Creating course from onboarding: ${courseId} with ${totalUnits} units`);
        
        const result = await collection.insertOne(course);
        
        console.log(`Course created with ${totalUnits} units`);
        
        return {
            success: true,
            created: true,
            modifiedCount: 1,
            courseId,
            totalUnits
        };
    } catch (error) {
        console.error('Error creating course from onboarding:', error);
        throw error;
    }
}

/**
 * Get course with onboarding data
 * @param {Object} db - MongoDB database instance
 * @param {string} courseId - Course identifier
 * @returns {Promise<Object|null>} Course data or null if not found
 */
async function getCourseWithOnboarding(db, courseId) {
    const collection = getCoursesCollection(db);
    
    try {
        const course = await collection.findOne({ courseId });
        return course;
    } catch (error) {
        console.error('Error fetching course with onboarding data:', error);
        throw error;
    }
}

/**
 * Delete a unit from a course
 * @param {Object} db - MongoDB database instance
 * @param {string} courseId - Course identifier
 * @param {string} unitName - Name of the unit to delete
 * @returns {Promise<Object>} Deletion result
 */
async function deleteUnit(db, courseId, unitName) {
    const collection = getCoursesCollection(db);
    
    const now = new Date();
    
    try {
        const result = await collection.updateOne(
            { courseId },
            {
                $pull: { lectures: { name: unitName } },
                $set: { updatedAt: now }
            }
        );
        
        return {
            success: true,
            deletedCount: result.modifiedCount,
            courseId,
            unitName
        };
    } catch (error) {
        console.error('Error deleting unit:', error);
        throw error;
    }
}

/**
 * Update the display name of a unit (for custom unit titles)
 * @param {Object} db - MongoDB database instance
 * @param {string} courseId - Course identifier
 * @param {string} unitName - Internal name of the unit (e.g., "Unit 1")
 * @param {string} displayName - Custom display name (e.g., "Biology") or null to clear
 * @param {string} instructorId - ID of the instructor making the change
 * @param {boolean} [showUnitNumber=true] - Whether to prefix the display name with "<N>. ". Ignored when displayName is cleared.
 * @returns {Promise<Object>} Update result
 */
async function updateUnitDisplayName(db, courseId, unitName, displayName, instructorId, showUnitNumber = true) {
    const collection = getCoursesCollection(db);
    
    const now = new Date();
    
    // First, ensure the course exists and find the unit
    const course = await collection.findOne({ courseId });
    if (!course) {
        console.error(`Course ${courseId} not found for display name update`);
        return { success: false, error: 'Course not found' };
    }
    
    // Check if the unit exists
    const existingUnit = course.lectures ? course.lectures.find(l => l.name === unitName) : null;
    if (!existingUnit) {
        console.error(`Unit ${unitName} not found in course ${courseId}`);
        return { success: false, error: 'Unit not found' };
    }
    
    // Build the update - set displayName or unset if empty/null
    const updateFields = {
        'lectures.$.updatedAt': now,
        updatedAt: now,
        lastUpdatedById: instructorId
    };
    const unsetFields = {};

    // If displayName is empty or null, remove the field (and showUnitNumber with
    // it, so the unit returns to a clean state); otherwise set both.
    if (displayName && displayName.trim()) {
        updateFields['lectures.$.displayName'] = displayName.trim();
        updateFields['lectures.$.showUnitNumber'] = showUnitNumber !== false;
    } else {
        unsetFields['lectures.$.displayName'] = '';
        unsetFields['lectures.$.showUnitNumber'] = '';
    }

    const updateOp = {
        $set: updateFields
    };
    if (Object.keys(unsetFields).length > 0) {
        updateOp.$unset = unsetFields;
    }
    
    const result = await collection.updateOne(
        { 
            courseId,
            'lectures.name': unitName 
        },
        updateOp
    );

    if (result.matchedCount === 0) {
        return { success: false, error: 'Course or unit no longer exists' };
    }
    
    console.log(`Updated display name for ${unitName} to "${displayName || '(cleared)'}" in course ${courseId}`);
    
    const clearedName = !(displayName && displayName.trim());
    return {
        success: true,
        modifiedCount: result.modifiedCount,
        unitName,
        displayName: clearedName ? null : displayName.trim(),
        showUnitNumber: clearedName ? true : showUnitNumber !== false
    };
}

/**
 * Add or update a document reference within a specific unit
 * @param {Object} db - MongoDB database instance
 * @param {string} courseId - Course identifier
 * @param {string} unitName - Name of the unit
 * @param {Object} documentData - Document data to store
 * @param {string} instructorId - ID of the instructor
 * @returns {Promise<Object>} Update result
 */
async function addDocumentToUnit(db, courseId, unitName, documentData, instructorId) {
    const collection = getCoursesCollection(db);
    
    const now = new Date();
    
    // First, ensure the course exists
    const course = await collection.findOne({ courseId });
    if (!course) {
        console.error(`Course ${courseId} not found for document addition`);
        return { success: false, error: 'Course not found' };
    }
    
    // Check if the unit already exists
    const existingUnit = course.lectures ? course.lectures.find(l => l.name === unitName) : null;
    
    if (existingUnit) {
        // Check if document already exists (for updates)
        const existingDocIndex = existingUnit.documents ? 
            existingUnit.documents.findIndex(d => d.documentId === documentData.documentId) : -1;
        
        if (existingDocIndex >= 0) {
            // Update existing document
            const result = await collection.updateOne(
                { 
                    courseId,
                    'lectures.name': unitName,
                    'lectures.documents.documentId': documentData.documentId
                },
                {
                    $set: {
                        'lectures.$.documents.$': {
                            ...documentData,
                            updatedAt: now
                        },
                        'lectures.$.updatedAt': now,
                        updatedAt: now,
                        instructorId
                    }
                }
            );

            if (result.matchedCount === 0) {
                return { success: false, error: 'Document or unit no longer exists' };
            }
            
            console.log(`Updated existing document in ${unitName}`);
            return { success: true, created: false, modifiedCount: result.modifiedCount };
        } else {
            // Add new document
            const result = await collection.updateOne(
                { 
                    courseId,
                    'lectures.name': unitName 
                },
                {
                    $push: {
                        'lectures.$.documents': {
                            ...documentData,
                            createdAt: now,
                            updatedAt: now
                        }
                    },
                    $set: {
                        'lectures.$.updatedAt': now,
                        updatedAt: now,
                        instructorId
                    }
                }
            );

            if (result.matchedCount === 0) {
                return { success: false, error: 'Course or unit no longer exists' };
            }
            
            console.log(`Added new document to ${unitName}`);
            return { success: true, created: true, modifiedCount: result.modifiedCount };
        }
    } else {
        console.error(`Unit ${unitName} not found in course ${courseId}`);
        return { success: false, error: 'Unit not found' };
    }
}

/**
 * Remove a document from any unit in a course (fallback method)
 * @param {Object} db - MongoDB database instance
 * @param {string} courseId - Course identifier
 * @param {string} documentId - ID of the document to remove
 * @param {string} instructorId - ID of the instructor
 * @returns {Promise<Object>} Removal result
 */
async function removeDocumentFromAnyUnit(db, courseId, documentId, instructorId) {
    const collection = getCoursesCollection(db);
    
    const now = new Date();
    
    // Remove the document from any unit that contains it using a direct approach
    // First, get the current course to modify it directly
    const currentCourse = await collection.findOne({ courseId });
    if (!currentCourse) {
        return { success: false, error: 'Course not found during update' };
    }
    
    // Find and remove the document from any unit
    let documentRemoved = false;
    let removedCount = 0;
    if (currentCourse.lectures) {
        for (let i = 0; i < currentCourse.lectures.length; i++) {
            const unit = currentCourse.lectures[i];
            if (unit.documents) {
                const initialLength = unit.documents.length;
                unit.documents = unit.documents.filter(doc => doc.documentId !== documentId);
                if (unit.documents.length < initialLength) {
                    documentRemoved = true;
                    removedCount += (initialLength - unit.documents.length);
                    unit.updatedAt = now;
                }
            }
        }
    }
    
    if (!documentRemoved) {
        console.log(`Document ${documentId} not found in any unit`);
        return { success: false, error: 'Document not found in any unit' };
    }
    
    // Update the course with the modified data
    const result = await collection.updateOne(
        { courseId },
        {
            $set: {
                lectures: currentCourse.lectures,
                updatedAt: now,
                lastUpdatedById: instructorId
            }
        }
    );
    
    console.log(`Removed document ${documentId} from any unit in course ${courseId}`);
    return { success: true, removedCount: result.modifiedCount, documentId };
}

/**
 * Add an instructor to a course
 * @param {Object} db - MongoDB database instance
 * @param {string} courseId - Course identifier
 * @param {string} instructorId - ID of the instructor to add
 * @returns {Promise<Object>} Update result
 */
async function addInstructorToCourse(db, courseId, instructorId) {
    const collection = getCoursesCollection(db);
    
    const now = new Date();
    
    // First, ensure the course exists
    const course = await collection.findOne({ courseId });
    if (!course) {
        return { success: false, error: 'Course not found' };
    }
    
    // Initialize arrays if they don't exist
    const updateData = {
        $addToSet: { instructors: instructorId },
        $set: { updatedAt: now }
    };
    
    // If this is the first instructor, also set instructorId for backward compatibility
    if (!course.instructorId) {
        updateData.$set.instructorId = instructorId;
    }
    
    const result = await collection.updateOne(
        { courseId },
        updateData
    );
    
    console.log(`Added instructor ${instructorId} to course ${courseId}`);
    return { success: true, modifiedCount: result.modifiedCount };
}

/**
 * Add a TA to a course
 * @param {Object} db - MongoDB database instance
 * @param {string} courseId - Course identifier
 * @param {string} taId - ID of the TA to add
 * @returns {Promise<Object>} Update result
 */
async function addTAToCourse(db, courseId, taId) {
    const collection = getCoursesCollection(db);
    
    const now = new Date();
    
    // First, ensure the course exists
    const course = await collection.findOne({ courseId });
    if (!course) {
        return { success: false, error: 'Course not found' };
    }
    
    const result = await collection.updateOne(
        { courseId },
        {
            $addToSet: { tas: taId },
            $set: { updatedAt: now }
        }
    );
    
    console.log(`Added TA ${taId} to course ${courseId}`);
    return { success: true, modifiedCount: result.modifiedCount };
}



/**
 * Get all courses for a user (instructor or TA)
 * @param {Object} db - MongoDB database instance
 * @param {string} userId - User identifier
 * @param {string} role - User role ('instructor' or 'ta')
 * @returns {Promise<Array>} Array of courses
 */
async function getCoursesForUser(db, userId, role) {
    const collection = getCoursesCollection(db);
    
    let query = {};
    if (role === 'instructor') {
        query = {
            status: { $ne: 'deleted' },
            $or: [
                { instructorId: userId },
                { instructors: userId }
            ]
        };
    } else if (role === 'ta') {
        query = {
            tas: userId,
            status: { $ne: 'deleted' }
        };
    }
    
    const courses = await collection.find(query)
        .project({
            courseId: 1,
            courseName: 1,
            instructorId: 1,
            instructors: 1,
            tas: 1,
            status: 1,
            llmApiKey: 1,
            courseStructure: 1,
            createdAt: 1,
            updatedAt: 1
        })
        .sort({ updatedAt: -1 })
        .toArray();

    return courses.sort(compareCoursesWithInactiveLast);
}

/**
 * Check if a user has access to a course
 * @param {Object} db - MongoDB database instance
 * @param {string} courseId - Course identifier
 * @param {string} userId - User identifier
 * @param {string} role - User role
 * @returns {Promise<boolean>} True if user has access
 */
async function userHasCourseAccess(db, courseId, userId, role) {
    const collection = getCoursesCollection(db);

    // A "View as Student" sandbox has no enrollment record, so grant it access
    // to exactly the course its id encodes. This is self-limiting: the id names
    // one course, real accounts can never hold an id in this namespace, and the
    // middleware only assigns one after validating the preview grant.
    const previewIdentity = parsePreviewUserId(userId);
    if (previewIdentity) {
        return previewIdentity.courseId === courseId;
    }

    let query = { courseId, status: { $ne: COURSE_STATUS.DELETED } };
    if (role === 'instructor') {
        query.$or = [
            { instructorId: userId },
            { instructors: userId }
        ];
    } else if (role === 'ta') {
        query.tas = userId;
        query.status = { $ne: COURSE_STATUS.DELETED };
    } else if (role === 'student') {
        // Defer to getStudentEnrollment so this matches the chat path and the
        // requireActiveCourseForNonInstructors middleware exactly: a course with
        // no status field is treated as active (only 'inactive'/'deleted' block
        // access). A strict `status === 'active'` query here wrongly 403'd
        // students on enrolled courses whose status was never set.
        const enrollment = await getStudentEnrollment(db, courseId, userId);
        return !!(enrollment.success && enrollment.enrolled === true);
    }
    
    const course = await collection.findOne(query);
    return !!course;
}

/**
 * Get a course by its ID
 * @param {Object} db - MongoDB database instance
 * @param {string} courseId - Course ID to find
 * @returns {Promise<Object|null>} Course object or null if not found
 */
async function getCourseById(db, courseId) {
    const collection = getCoursesCollection(db);
    
    const course = await collection.findOne({
        courseId,
        status: { $ne: COURSE_STATUS.DELETED }
    });
    return course;
}

async function getCourseByIdIncludingDeleted(db, courseId) {
    return getCoursesCollection(db).findOne({ courseId });
}

/**
 * The six grantable TA permissions. Each gates a specific cluster of routes -
 * see src/services/permissions.js for the full route mapping and role presets.
 */
const TA_PERMISSION_KEYS = ['materials', 'questions', 'flags', 'roster', 'transcripts', 'settings'];

/**
 * A TA record predates the six-flag model if it still carries either of the
 * old two booleans. Old keys win over any stale partial new-shape data, since
 * a record can only have been partially migrated by a lazy read that was
 * itself interrupted.
 */
function isLegacyTAPermissions(permissions) {
    return !!permissions && ('canAccessCourses' in permissions || 'canAccessFlags' in permissions);
}

/**
 * Map the old two-boolean shape to the new six-flag shape, preserving each
 * TA's *current effective access* rather than granting anything new.
 *
 * canAccessCourses covered materials/questions/settings, and - via a bug in
 * mentalHealthFlags.js that checked the same 'courses' feature - transcripts
 * too; migrating it to true for all four is bug-for-bug faithful, not a new
 * grant. canAccessFlags covered flag review and (bundled in) the student
 * roster, so it maps to both flags and roster.
 *
 * Uses `!== false` rather than `=== true`, matching the truthiness the
 * frontend and checkTAPermission's old switch already treated as "allowed"
 * (an `undefined` field was never actually enforced as denied) so the
 * migration doesn't silently revoke access that was effectively granted.
 */
function migrateLegacyTAPermissions(legacy) {
    const canAccessCourses = legacy.canAccessCourses !== false;
    const canAccessFlags = legacy.canAccessFlags !== false;
    return {
        materials: canAccessCourses,
        questions: canAccessCourses,
        settings: canAccessCourses,
        transcripts: canAccessCourses,
        flags: canAccessFlags,
        roster: canAccessFlags
    };
}

/**
 * Update TA permissions for a specific course.
 *
 * Accepts a partial permissions object - only the keys present are
 * validated and written, via a per-field $set - so callers can toggle one
 * permission without first reading and re-sending all six (avoids a
 * read-modify-write race between two toggles in flight).
 * @param {Object} db - MongoDB database instance
 * @param {string} courseId - Course identifier
 * @param {string} taId - TA identifier
 * @param {Object} permissions - Partial permission object; keys from TA_PERMISSION_KEYS
 * @returns {Promise<Object>} Update result
 */
async function updateTAPermissions(db, courseId, taId, permissions) {
    const collection = getCoursesCollection(db);

    const now = new Date();

    // First, ensure the course exists
    const course = await collection.findOne({ courseId });
    if (!course) {
        return { success: false, error: 'Course not found' };
    }

    // Check if TA is assigned to this course
    if (!course.tas || !course.tas.includes(taId)) {
        return { success: false, error: 'TA is not assigned to this course' };
    }

    const setFields = { updatedAt: now, [`taPermissions.${taId}.updatedAt`]: now };
    for (const key of TA_PERMISSION_KEYS) {
        if (Object.prototype.hasOwnProperty.call(permissions, key)) {
            setFields[`taPermissions.${taId}.${key}`] = permissions[key];
        }
    }

    // Update TA permissions
    const result = await collection.updateOne(
        { courseId },
        { $set: setFields }
    );

    if (result.modifiedCount > 0) {
        console.log(`Updated TA permissions for ${taId} in course ${courseId}`);
        return { success: true, modifiedCount: result.modifiedCount };
    } else {
        return { success: false, error: 'Failed to update TA permissions' };
    }
}

/**
 * Get TA permissions for a specific course and TA.
 *
 * Always returns the current six-flag shape. A genuinely-absent record
 * (a TA who has never had permissions set) defaults to fail-closed - no
 * access - reversing the old fail-open default. A record still in the old
 * two-boolean shape (not yet touched by the migration script) is normalized
 * on the fly via migrateLegacyTAPermissions, so reads are correct even
 * before/without the one-time backfill running.
 * @param {Object} db - MongoDB database instance
 * @param {string} courseId - Course identifier
 * @param {string} taId - TA identifier
 * @returns {Promise<Object>} TA permissions or default permissions
 */
async function getTAPermissions(db, courseId, taId) {
    const collection = getCoursesCollection(db);

    const course = await collection.findOne({ courseId });
    if (!course) {
        return { success: false, error: 'Course not found' };
    }

    // Check if TA is assigned to this course
    if (!course.tas || !course.tas.includes(taId)) {
        return { success: false, error: 'TA is not assigned to this course' };
    }

    const stored = course.taPermissions && course.taPermissions[taId];
    let permissions;
    if (!stored) {
        // No record at all: fail-closed default for TAs added after this shipped.
        permissions = Object.fromEntries(TA_PERMISSION_KEYS.map(key => [key, false]));
    } else if (isLegacyTAPermissions(stored)) {
        permissions = migrateLegacyTAPermissions(stored);
    } else {
        permissions = Object.fromEntries(TA_PERMISSION_KEYS.map(key => [key, stored[key] === true]));
    }

    return { success: true, permissions };
}

/**
 * Check if a TA has permission to access a specific feature.
 * @param {Object} db - MongoDB database instance
 * @param {string} courseId - Course identifier
 * @param {string} taId - TA identifier
 * @param {string} feature - One of TA_PERMISSION_KEYS
 * @returns {Promise<boolean>} True if TA has permission
 */
async function checkTAPermission(db, courseId, taId, feature) {
    // Explicit whitelist, not an unguarded object lookup: the stored
    // subdocument also carries `updatedAt`, which is a truthy Date - an
    // unguarded permissions[feature] read would let 'updatedAt' resolve as
    // a granted permission for any TA who's ever been touched.
    if (!TA_PERMISSION_KEYS.includes(feature)) {
        return false;
    }

    const course = await getCourseById(db, courseId);
    if (!course || course.status === 'deleted') {
        return false;
    }

    const result = await getTAPermissions(db, courseId, taId);

    if (!result.success) {
        return false;
    }

    return result.permissions[feature] === true;
}

/**
 * Update student enrollment override for a course
 * @param {Object} db - MongoDB database instance
 * @param {string} courseId - Course identifier
 * @param {string} studentId - Student identifier
 * @param {boolean} enrolled - Whether the student is enrolled (true) or blocked (false)
 * @returns {Promise<Object>} Update result
 */
async function updateStudentEnrollment(db, courseId, studentId, enrolled) {
    const collection = getCoursesCollection(db);

    const now = new Date();

    // Ensure course exists
    const course = await collection.findOne({ courseId });
    if (!course) {
        return { success: false, error: 'Course not found' };
    }

    const result = await collection.updateOne(
        { courseId },
        {
            $set: {
                [`studentEnrollment.${studentId}`]: {
                    enrolled: !!enrolled,
                    updatedAt: now
                },
                updatedAt: now
            }
        }
    );

    if (result.modifiedCount > 0) {
        return { success: true, modifiedCount: result.modifiedCount };
    }
    return { success: false, error: 'Failed to update student enrollment' };
}

/**
 * Get student enrollment override for a course (defaults to enrolled=false)
 * @param {Object} db - MongoDB database instance
 * @param {string} courseId - Course identifier
 * @param {string} studentId - Student identifier
 * @returns {Promise<{ success: boolean, enrolled?: boolean, status?: string, error?: string }>} Result
 */
async function getStudentEnrollment(db, courseId, studentId) {
    const collection = getCoursesCollection(db);

    const course = await collection.findOne(
        { courseId },
        { projection: { studentEnrollment: 1, status: 1 } }
    );

    if (!course) {
        return { success: false, error: 'Course not found' };
    }

    // A "View as Student" sandbox is enrolled by grant rather than by record —
    // writing one would put a fake student in the roster. Handled here rather
    // than at each caller because several route handlers check enrollment
    // directly instead of going through userHasCourseAccess.
    //
    // Inactive courses stay previewable on purpose: instructors check how a
    // course reads before switching it on. Deleted courses are gone for everyone.
    const previewIdentity = parsePreviewUserId(studentId);
    if (previewIdentity) {
        const allowed = previewIdentity.courseId === courseId && course.status !== 'deleted';
        return {
            success: true,
            enrolled: allowed,
            status: allowed ? 'enrolled' : 'none',
            preview: true
        };
    }

    if (course.status === 'inactive' || course.status === 'deleted') {
        return {
            success: true,
            enrolled: false,
            status: 'banned',
            reason: 'course_inactive'
        };
    }

    const enrollment = course.studentEnrollment && course.studentEnrollment[studentId];
    
    let status = 'none'; // Default: Not Joined
    let enrolled = false;

    if (enrollment) {
        if (enrollment.enrolled) {
            status = 'enrolled';
            enrolled = true;
        } else {
            status = 'banned'; // Explicitly false means banned
            enrolled = false;
        }
    }

    return { success: true, enrolled, status };
}

/**
 * Join a course using a student course code
 * @param {Object} db - MongoDB database instance
 * @param {string} courseId - Course identifier
 * @param {string} studentId - Student identifier
 * @param {string} code - Course code provided by student
 * @param {Object} options - Join options
 * @param {boolean} options.skipCodeValidation - Whether to bypass code validation
 * @returns {Promise<{ success: boolean, enrolled?: boolean, error?: string, message?: string }>} Result
 */
async function joinCourse(db, courseId, studentId, code, options = {}) {
    const collection = getCoursesCollection(db);
    const now = new Date();
    const { skipCodeValidation = false } = options;

    // A "View as Student" sandbox must never enter the enrollment map — it has
    // access by grant, and an entry here would surface it in the Student Hub
    // roster as a real student. Report success so the student UI proceeds.
    const previewIdentity = parsePreviewUserId(studentId);
    if (previewIdentity) {
        return {
            success: previewIdentity.courseId === courseId,
            enrolled: previewIdentity.courseId === courseId,
            preview: true,
            ...(previewIdentity.courseId === courseId ? {} : { error: 'Course not available in this preview' })
        };
    }

    const course = await collection.findOne({ courseId });
    if (!course) {
        return { success: false, error: 'Course not found' };
    }

    if (course.status === 'inactive' || course.status === 'deleted') {
        return { success: false, error: 'Course is deactivated by the instructor' };
    }

    // Check if currently blocked
    const currentEnrollment = course.studentEnrollment && course.studentEnrollment[studentId];
    if (currentEnrollment && currentEnrollment.enrolled === false) {
        return { success: false, error: 'Access revoked by instructor' };
    }

    // Verify code (case-insensitive)
    if (!skipCodeValidation && normalizeCode(course.courseCode) !== normalizeCode(code)) {
        return { success: false, error: 'Invalid course code' };
    }

    // Enroll the student
    await collection.updateOne(
        { courseId },
        {
            $set: {
                [`studentEnrollment.${studentId}`]: {
                    enrolled: true,
                    joinedAt: now,
                    updatedAt: now
                },
                updatedAt: now
            }
        }
    );

    return { success: true, enrolled: true, message: 'Successfully joined course' };
}

/**
 * Join a course as an instructor using an instructor course code
 * @param {Object} db - MongoDB database instance
 * @param {string} courseId - Course identifier
 * @param {string} instructorId - Instructor identifier
 * @param {string} code - Instructor course code provided by instructor
 * @param {Object} options - Join options
 * @param {boolean} options.skipCodeValidation - Whether to bypass code validation
 * @returns {Promise<{ success: boolean, alreadyJoined?: boolean, error?: string, message?: string }>} Result
 */
async function joinCourseAsInstructor(db, courseId, instructorId, code, options = {}) {
    const collection = getCoursesCollection(db);
    const now = new Date();
    const { skipCodeValidation = false } = options;

    const course = await collection.findOne({ courseId });
    if (!course) {
        return { success: false, error: 'Course not found' };
    }

    // Reject joins to courses the UI would not list (deleted or inactive).
    // /api/courses/available/joinable already hides these; the direct-join path
    // must not be a side door around that.
    const courseStatus = course.status || 'active';
    if (courseStatus === 'deleted' || courseStatus === 'inactive') {
        return { success: false, error: 'Course is not available to join' };
    }

    const instructors = Array.isArray(course.instructors) ? course.instructors : [];
    if (course.instructorId === instructorId || instructors.includes(instructorId)) {
        return {
            success: true,
            alreadyJoined: true,
            message: 'Instructor already has access to this course'
        };
    }

    if (!skipCodeValidation && normalizeCode(course.instructorCourseCode) !== normalizeCode(code)) {
        return { success: false, error: 'Invalid instructor course code' };
    }

    const updateData = {
        $addToSet: { instructors: instructorId },
        $set: {
            updatedAt: now
        }
    };

    if (!course.instructorId) {
        updateData.$set.instructorId = instructorId;
    }

    await collection.updateOne({ courseId }, updateData);

    return { success: true, message: 'Successfully joined course as instructor' };
}

/**
 * Get approved struggle topics for a course
 * @param {Object} db - MongoDB database instance
 * @param {string} courseId - Course identifier
 * @returns {Promise<Array<string>>} Approved topic list
 */
async function getApprovedStruggleTopics(db, courseId) {
    const collection = getCoursesCollection(db);
    const course = await collection.findOne(
        { courseId },
        { projection: { approvedStruggleTopics: 1 } }
    );

    if (!course || !Array.isArray(course.approvedStruggleTopics)) {
        return [];
    }

    return normalizeTopicList(course.approvedStruggleTopics);
}

/**
 * Get approved struggle topic objects for a course
 * @param {Object} db - MongoDB database instance
 * @param {string} courseId - Course identifier
 * @returns {Promise<Array<Object>>} Approved topic object list
 */
async function getApprovedStruggleTopicObjects(db, courseId) {
    const collection = getCoursesCollection(db);
    const course = await collection.findOne(
        { courseId },
        { projection: { approvedStruggleTopics: 1 } }
    );

    if (!course || !Array.isArray(course.approvedStruggleTopics)) {
        return [];
    }

    return normalizeTopicObjectList(course.approvedStruggleTopics);
}

/**
 * Replace approved struggle topics for a course
 * @param {Object} db - MongoDB database instance
 * @param {string} courseId - Course identifier
 * @param {Array<string|Object>} topics - Topic list
 * @param {string} updatedById - User making update
 * @param {Object} defaults - Defaults for new/legacy topic metadata
 * @returns {Promise<Object>} Update result
 */
async function setApprovedStruggleTopics(db, courseId, topics, updatedById, defaults = {}) {
    const collection = getCoursesCollection(db);
    const existingCourse = await collection.findOne(
        { courseId },
        { projection: { approvedStruggleTopics: 1 } }
    );

    if (!existingCourse) {
        return {
            success: false,
            modifiedCount: 0,
            topics: [],
            topicLabels: [],
            error: 'Course not found'
        };
    }

    const normalizedTopics = normalizeTopicObjectList(
        topics,
        {
            source: defaults.source || 'manual',
            unitId: defaults.unitId || null,
            createdAt: defaults.createdAt || new Date()
        },
        existingCourse.approvedStruggleTopics || []
    );
    const existingRawByLabel = new Map();
    for (const existingTopic of existingCourse.approvedStruggleTopics || []) {
        const label = getTopicLabel(existingTopic);
        if (label) {
            existingRawByLabel.set(label.toLowerCase(), existingTopic);
        }
    }
    const storageTopics = normalizedTopics.map((topicEntry) => {
        const existingRawTopic = existingRawByLabel.get(topicEntry.topic.toLowerCase());
        const shouldPreserveLegacyString = typeof existingRawTopic === 'string' &&
            !topicEntry.unitId &&
            topicEntry.source === 'manual';

        return shouldPreserveLegacyString ? topicEntry.topic : topicEntry;
    });
    const now = new Date();

    const result = await collection.updateOne(
        { courseId },
        {
            $set: {
                approvedStruggleTopics: storageTopics,
                updatedAt: now,
                lastUpdatedById: updatedById
            }
        }
    );

    return {
        success: result.matchedCount > 0,
        modifiedCount: result.modifiedCount,
        topics: normalizeTopicObjectList(storageTopics),
        topicLabels: normalizeTopicList(storageTopics),
        error: result.matchedCount > 0 ? null : 'Course not found'
    };
}

/**
 * Update the unit mapping for a single approved struggle topic.
 * Legacy string entries are converted to topic objects on write.
 * @param {Object} db - MongoDB database instance
 * @param {string} courseId - Course identifier
 * @param {string} topicLabel - Topic label to update
 * @param {string|null} unitId - Stable unit name, or null for unassigned
 * @param {string} updatedById - User making update
 * @returns {Promise<Object>} Update result
 */
async function updateApprovedStruggleTopicUnit(db, courseId, topicLabel, unitId, updatedById) {
    const collection = getCoursesCollection(db);
    const course = await collection.findOne(
        { courseId },
        { projection: { approvedStruggleTopics: 1, lectures: 1 } }
    );

    if (!course) {
        return { success: false, error: 'Course not found' };
    }

    const normalizedLabel = normalizeTopicLabel(topicLabel);
    if (!normalizedLabel) {
        return { success: false, error: 'Topic is required' };
    }

    const normalizedUnitId = normalizeTopicUnitId(unitId, null);
    if (normalizedUnitId) {
        const validUnit = Array.isArray(course.lectures)
            ? course.lectures.some((lecture) => lecture && lecture.name === normalizedUnitId)
            : false;

        if (!validUnit) {
            return { success: false, error: 'Unit not found in this course' };
        }
    }

    const existingTopics = Array.isArray(course.approvedStruggleTopics)
        ? course.approvedStruggleTopics
        : [];
    const normalizedTopics = normalizeTopicObjectList(existingTopics);
    const topicIndex = normalizedTopics.findIndex(
        (entry) => entry.topic.toLowerCase() === normalizedLabel.toLowerCase()
    );

    if (topicIndex === -1) {
        return { success: false, error: 'Approved topic not found' };
    }

    normalizedTopics[topicIndex] = {
        ...normalizedTopics[topicIndex],
        unitId: normalizedUnitId,
        source: normalizeTopicSource(normalizedTopics[topicIndex].source, 'manual')
    };

    const result = await collection.updateOne(
        { courseId },
        {
            $set: {
                approvedStruggleTopics: normalizedTopics,
                updatedAt: new Date(),
                lastUpdatedById: updatedById
            }
        }
    );

    return {
        success: result.matchedCount > 0,
        modifiedCount: result.modifiedCount,
        topic: normalizedTopics[topicIndex],
        topics: normalizedTopics,
        topicLabels: normalizeTopicList(normalizedTopics),
        error: result.matchedCount > 0 ? null : 'Course not found'
    };
}

/**
 * Get quiz practice settings for a course
 * @param {Object} db - MongoDB database instance
 * @param {string} courseId - Course identifier
 * @returns {Promise<Object>} Quiz settings with defaults
 */
async function getQuizSettings(db, courseId) {
    const collection = getCoursesCollection(db);
    const course = await collection.findOne(
        { courseId },
        { projection: { quizSettings: 1 } }
    );

    const defaults = {
        enabled: false,
        testableUnits: 'all',
        allowLectureMaterialAccess: true,
        allowSourceAttributionDownloads: false
    };

    if (!course) {
        return defaults;
    }

    const settings = course.quizSettings || {};

    return {
        enabled: settings.enabled !== undefined ? settings.enabled : defaults.enabled,
        testableUnits: settings.testableUnits !== undefined ? settings.testableUnits : defaults.testableUnits,
        allowLectureMaterialAccess: settings.allowLectureMaterialAccess !== undefined ? settings.allowLectureMaterialAccess : defaults.allowLectureMaterialAccess,
        allowSourceAttributionDownloads: settings.allowSourceAttributionDownloads !== undefined
            ? settings.allowSourceAttributionDownloads
            : defaults.allowSourceAttributionDownloads
    };
}

/**
 * Update quiz practice settings for a course
 * @param {Object} db - MongoDB database instance
 * @param {string} courseId - Course identifier
 * @param {Object} settings - { enabled, testableUnits, allowLectureMaterialAccess, allowSourceAttributionDownloads }
 * @param {string} instructorId - ID of the instructor making the change
 * @returns {Promise<Object>} Update result
 */
async function updateQuizSettings(db, courseId, settings, instructorId) {
    const collection = getCoursesCollection(db);
    const now = new Date();

    const quizSettings = {
        enabled: settings.enabled !== undefined ? settings.enabled : false,
        testableUnits: settings.testableUnits !== undefined ? settings.testableUnits : 'all',
        allowLectureMaterialAccess: settings.allowLectureMaterialAccess !== undefined ? settings.allowLectureMaterialAccess : true,
        allowSourceAttributionDownloads: settings.allowSourceAttributionDownloads !== undefined
            ? settings.allowSourceAttributionDownloads
            : false
    };

    const result = await collection.updateOne(
        { courseId },
        {
            $set: {
                quizSettings,
                updatedAt: now,
                lastUpdatedById: instructorId
            }
        }
    );

    return {
        success: result.matchedCount > 0,
        modifiedCount: result.modifiedCount,
        error: result.matchedCount > 0 ? null : 'Course not found'
    };
}

/**
 * Get anonymize students setting for a specific instructor and course
 * @param {Object} db - MongoDB database instance
 * @param {string} courseId - Course identifier
 * @param {string} instructorId - Instructor user identifier
 * @returns {Promise<Object>} { success: true, enabled: Boolean }
 */
async function getAnonymizeStudents(db, courseId, instructorId) {
    const collection = getCoursesCollection(db);
    const course = await collection.findOne({ courseId });
    if (!course) {
        return { success: false, error: 'Course not found' };
    }
    const enabled = course.anonymizeStudents && course.anonymizeStudents[instructorId]
        ? course.anonymizeStudents[instructorId].enabled === true
        : true;
    return { success: true, enabled };
}

/**
 * Update anonymize students setting for a specific instructor and course
 * @param {Object} db - MongoDB database instance
 * @param {string} courseId - Course identifier
 * @param {string} instructorId - Instructor user identifier
 * @param {boolean} enabled - Whether to anonymize students
 * @returns {Promise<Object>} Result of the update
 */
async function updateAnonymizeStudents(db, courseId, instructorId, enabled) {
    const collection = getCoursesCollection(db);
    const now = new Date();

    const result = await collection.updateOne(
        { courseId },
        {
            $set: {
                [`anonymizeStudents.${instructorId}.enabled`]: !!enabled,
                [`anonymizeStudents.${instructorId}.updatedAt`]: now,
                updatedAt: now
            }
        }
    );

    if (result.matchedCount > 0) {
        return { success: true };
    } else {
        return { success: false, error: 'Course not found' };
    }
}

module.exports = {
    COURSE_STATUS,
    COURSE_STATUS_VALUES,
    normalizeCourseStatus,
    isValidCourseStatus,
    getCoursesCollection,
    ensureCourseCodes,
    upsertCourse,
    updateLecturePublishStatus,
    getLecturePublishStatus,
    getPublishedLectures,
    updateLearningObjectives,
    getLearningObjectives,
    updatePassThreshold,
    getPassThreshold,
    createCourseFromOnboarding,
    getCourseWithOnboarding,
    deleteUnit,
    updateAssessmentQuestions,
    getAssessmentQuestions,
    deleteAssessmentQuestion,
    addDocumentToUnit,
    removeDocumentFromAnyUnit,
    addInstructorToCourse,
    addTAToCourse,
    getCoursesForUser,
    userHasCourseAccess,
    getCourseById,
    getCourseByIdIncludingDeleted,
    updateTAPermissions,
    getTAPermissions,
    checkTAPermission,
    TA_PERMISSION_KEYS,
    isLegacyTAPermissions,
    migrateLegacyTAPermissions,
    updateStudentEnrollment,
    getStudentEnrollment,
    joinCourse,
    joinCourseAsInstructor,
    updateUnitDisplayName,
    getApprovedStruggleTopics,
    getApprovedStruggleTopicObjects,
    setApprovedStruggleTopics,
    updateApprovedStruggleTopicUnit,
    normalizeTopicList,
    normalizeTopicObjectList,
    getQuizSettings,
    updateQuizSettings,
    getAnonymizeStudents,
    updateAnonymizeStudents,
    DEFAULT_STUDENT_RAG_TOP_K,
    MIN_RAG_TOP_K,
    MAX_RAG_TOP_K,
    DEFAULT_CHAT_SURVEY_SETTINGS,
    MIN_CHAT_SURVEY_TRIGGER_MESSAGES,
    MAX_CHAT_SURVEY_TRIGGER_MESSAGES,
    normalizeRagTopK,
    resolveRagSettings,
    normalizeChatSurveyTriggerMessageCount,
    resolveChatSurveySettings,
    getChatSurveySettings,
    updateChatSurveySettings,
    getRagSettings,
    updateRagSettings,
    getAllowInSuperCourse,
    updateAllowInSuperCourse,
    normalizeSuperchatIds,
    getCourseSuperchatIds,
    updateCourseSuperchats,
    MIN_YEAR_LEVEL,
    MAX_YEAR_LEVEL,
    normalizeYearLevel,
    parseYearLevelFromName
};
