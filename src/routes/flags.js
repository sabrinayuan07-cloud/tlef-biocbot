/**
 * Flagged Questions API Routes
 * Handles student flags on questions and instructor responses
 */

const express = require('express');
const router = express.Router();

// Import the FlaggedQuestion model
const FlaggedQuestionModel = require('../models/FlaggedQuestion');
const CourseModel = require('../models/Course');
const { hasSystemAdminAccess } = require('../services/authorization');
const { hasPermission } = require('../services/permissions');
const previewSession = require('../services/previewSession');

const SUPER_COURSE_FLAG_COURSE_ID = 'SUPER_COURSE';
const VALID_BOT_MODES = new Set(['protege', 'tutor', 'supercourse-student', 'supercourse-instructor']);

// Middleware for JSON parsing
router.use(express.json());

/**
 * Shared gate for flag mutation endpoints (DELETE, PUT /:flagId/response,
 * PUT /:flagId/status). Verifies the caller is an instructor/TA AND has
 * access to the specific course the flag belongs to. Writes the response
 * and returns null on failure; returns the flag doc on success.
 */
async function loadFlagAndAssertCourseAccess(req, res, flagId) {
    const user = req.user;
    if (!user) {
        res.status(401).json({ success: false, message: 'Authentication required' });
        return null;
    }
    if (user.role !== 'instructor' && user.role !== 'ta') {
        res.status(403).json({ success: false, message: 'Only instructors and TAs can manage flags' });
        return null;
    }
    const db = req.app.locals.db;
    const flag = await FlaggedQuestionModel.getFlaggedQuestionById(db, flagId);
    if (!flag) {
        // 400 here preserves the legacy contract — see Redundancies R12b.
        // The REST-correct shape for "unknown :flagId" is 404; tests at
        // flags-api-coverage.spec.js:{437,513,570} currently pin 400, mirroring
        // the model's `{success:false}` → 400 mapping. Flip to 404 (and update
        // those three tests) when the broader `error`-vs-`message` /
        // not-found-status audit lands.
        res.status(400).json({ success: false, message: 'Flag not found' });
        return null;
    }
    const hasAccess = await canReadCourseFlags(db, user, flag.courseId);
    if (!hasAccess) {
        res.status(403).json({ success: false, message: 'No access to this course' });
        return null;
    }
    return flag;
}

async function canReadCourseFlags(db, user, courseId) {
    if (!user) return false;

    // Super-course flags aren't scoped to any one course a TA could be
    // granted access to - only system-admin instructors can see them,
    // regardless of the 'flags' permission.
    if (courseId === SUPER_COURSE_FLAG_COURSE_ID) {
        return user.role === 'instructor' && hasSystemAdminAccess(user);
    }

    return hasPermission(db, user, courseId, 'flags');
}

async function filterFlagsByReadableCourse(db, user, flags) {
    const allowedByCourse = new Map();
    const filtered = [];

    for (const flag of flags) {
        if (!allowedByCourse.has(flag.courseId)) {
            allowedByCourse.set(flag.courseId, await canReadCourseFlags(db, user, flag.courseId));
        }

        if (allowedByCourse.get(flag.courseId)) {
            filtered.push(flag);
        }
    }

    return filtered;
}

function normalizeStringArray(value) {
    if (!Array.isArray(value)) return [];

    const seen = new Set();
    const normalized = [];
    for (const item of value) {
        const text = String(item || '').trim();
        if (!text || seen.has(text)) continue;
        seen.add(text);
        normalized.push(text);
    }
    return normalized;
}

async function canCreateFlagForCourse(db, user, courseId, isSuperCourseFlag) {
    if (!user) return false;
    if (user.role !== 'student' && user.role !== 'instructor') return false;

    if (isSuperCourseFlag || courseId === SUPER_COURSE_FLAG_COURSE_ID) {
        return true;
    }

    if (user.role === 'instructor') {
        return CourseModel.userHasCourseAccess(db, courseId, user.userId, 'instructor');
    }

    return CourseModel.userHasCourseAccess(db, courseId, user.userId, 'student');
}

/**
 * GET /api/flags/my
 * Get all flagged questions created by the authenticated student (optional course filter)
 */
router.get('/my', async (req, res) => {
    try {
        const user = req.user;
        if (!user) {
            return res.status(401).json({ success: false, message: 'Authentication required' });
        }
        if (user.role !== 'student') {
            return res.status(403).json({ success: false, message: 'Only students can view their own flags' });
        }
        const { courseId } = req.query;
        const db = req.app.locals.db;
        if (!db) {
            return res.status(503).json({ success: false, message: 'Database connection not available' });
        }
        if (courseId) {
            const hasAccess = await CourseModel.userHasCourseAccess(db, courseId, user.userId, 'student');
            if (!hasAccess) {
                return res.status(403).json({ success: false, message: 'No access to this course' });
            }
        }

        const flags = await FlaggedQuestionModel.getFlaggedQuestionsForStudent(db, user.userId, courseId || null);
        const visibleFlags = courseId
            ? flags
            : await filterStudentFlagsByEnrollment(db, user.userId, flags);

        // Super Course flags belong to the student but aren't tied to a real
        // course, so they never match a course filter or the enrollment check.
        // Always fold in the student's own Super Course flags (deduped) so they
        // appear in the Flagged page regardless of the selected course.
        if (courseId !== SUPER_COURSE_FLAG_COURSE_ID) {
            const superFlags = await FlaggedQuestionModel.getFlaggedQuestionsForStudent(
                db, user.userId, SUPER_COURSE_FLAG_COURSE_ID
            );
            const seen = new Set(visibleFlags.map(f => f.flagId || String(f._id)));
            for (const sf of superFlags) {
                const key = sf.flagId || String(sf._id);
                if (!seen.has(key)) {
                    seen.add(key);
                    visibleFlags.push(sf);
                }
            }
            visibleFlags.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        }

        return res.json({ success: true, data: { flags: visibleFlags, count: visibleFlags.length } });
    } catch (error) {
        console.error('Error retrieving student flags:', error);
        return res.status(500).json({ success: false, message: 'Internal server error while retrieving flags' });
    }
});

async function filterStudentFlagsByEnrollment(db, studentId, flags) {
    const allowedByCourse = new Map();
    const filtered = [];

    for (const flag of flags) {
        if (!allowedByCourse.has(flag.courseId)) {
            allowedByCourse.set(flag.courseId, await CourseModel.userHasCourseAccess(db, flag.courseId, studentId, 'student'));
        }

        if (allowedByCourse.get(flag.courseId)) {
            filtered.push(flag);
        }
    }

    return filtered;
}

/**
 * POST /api/flags
 * Create a new flagged question (student flags a question)
 */
router.post('/', async (req, res) => {
    try {
        const {
            questionId,
            courseId,
            unitName,
            flagReason,
            flagDescription,
            botMode,
            questionContent,
            sourceCourseIds,
            sourceCourseNames,
            isSuperCourseFlag,
            superchatId
        } = req.body;
        
        // Get authenticated user information
        const user = req.user;
        if (!user) {
            return res.status(401).json({
                success: false,
                message: 'Authentication required'
            });
        }
        
        // Students and instructors can flag responses. TAs review flags but do not create them.
        if (user.role !== 'student' && user.role !== 'instructor') {
            return res.status(403).json({
                success: false,
                message: 'Only students and instructors can flag questions'
            });
        }

        const superCourseFlag = isSuperCourseFlag === true || courseId === SUPER_COURSE_FLAG_COURSE_ID;
        const effectiveCourseId = superCourseFlag ? SUPER_COURSE_FLAG_COURSE_ID : courseId;
        
        // Validate required fields
        if (!questionId || !effectiveCourseId || !flagReason || !flagDescription || (!superCourseFlag && !unitName)) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields: questionId, courseId, unitName, flagReason, flagDescription'
            });
        }
        
        // Validate botMode if provided.
        if (botMode && !VALID_BOT_MODES.has(botMode)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid botMode. Must be "protege", "tutor", "supercourse-student", or "supercourse-instructor"'
            });
        }
        
        // Get database instance from app.locals
        const db = req.app.locals.db;
        if (!db) {
            return res.status(503).json({
                success: false,
                message: 'Database connection not available'
            });
        }

        let course = null;
        if (!superCourseFlag) {
            course = await CourseModel.getCourseById(db, effectiveCourseId);
            if (!course) {
                return res.status(404).json({
                    success: false,
                    message: 'Course not found'
                });
            }
        }

        // In "View as Student" the flag UI must behave exactly as a student
        // sees it, but nothing may reach the real flag queue — an instructor
        // testing the button should not create work for themselves or their
        // TAs. Acknowledge and stop before both the enrollment check (a preview
        // student has no enrollment record) and the write.
        if (previewSession.isPreviewRequest(req)) {
            console.log('🧪 [FLAGS] Preview flag acknowledged without persisting');
            return res.json({
                success: true,
                message: 'Question flagged successfully!',
                preview: true,
                data: {
                    questionId,
                    courseId: effectiveCourseId
                }
            });
        }

        const hasCourseAccess = await canCreateFlagForCourse(db, user, effectiveCourseId, superCourseFlag);
        if (!hasCourseAccess) {
            return res.status(403).json({
                success: false,
                message: 'No access to flag content for this course'
            });
        }

        let courseName = 'Super Course';
        if (!superCourseFlag) {
            courseName = course?.courseName || course?.courseCode || effectiveCourseId;
        }
        
        // Create the flagged question with authenticated user info
        const result = await FlaggedQuestionModel.createFlaggedQuestion(db, {
            questionId,
            courseId: effectiveCourseId,
            courseName,
            unitName: unitName || (superCourseFlag ? 'Super Course' : null),
            studentId: user.userId,
            studentName: user.displayName || user.username,
            reporterId: user.userId,
            reporterName: user.displayName || user.username,
            reporterRole: user.role,
            flagReason,
            flagDescription,
            botMode: botMode || (superCourseFlag ? `supercourse-${user.role}` : 'tutor'),
            questionContent,
            sourceCourseIds: normalizeStringArray(sourceCourseIds),
            sourceCourseNames: normalizeStringArray(sourceCourseNames),
            isSuperCourseFlag: superCourseFlag,
            // Which superchat bucket the flag came from (super-course flags only).
            superchatId: superCourseFlag && typeof superchatId === 'string' ? superchatId : null
        });
        
        if (!result.success) {
            return res.status(400).json({
                success: false,
                message: result.error || 'Failed to create flagged question'
            });
        }
        
        console.log(`Flagged question created by ${user.role} ${user.userId} for question ${questionId}`);
        
        res.json({
            success: true,
            message: 'Question flagged successfully!',
            data: {
                flagId: result.flagId,
                createdAt: new Date().toISOString()
            }
        });
        
    } catch (error) {
        console.error('Error creating flagged question:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error while creating flagged question'
        });
    }
});

/**
 * GET /api/flags/course/:courseId
 * Get all flagged questions for a specific course
 */
router.get('/course/:courseId', async (req, res) => {
    try {
        const { courseId } = req.params;
        const { status } = req.query; // Optional status filter
        
        if (!courseId) {
            return res.status(400).json({
                success: false,
                message: 'Missing required parameter: courseId'
            });
        }
        
        // Get database instance from app.locals
        const db = req.app.locals.db;
        if (!db) {
            return res.status(503).json({
                success: false,
                message: 'Database connection not available'
            });
        }
        
        const user = req.user;
        const hasAccess = await canReadCourseFlags(db, user, courseId);
        if (!hasAccess) {
            return res.status(403).json({
                success: false,
                message: 'No access to flagged content for this course'
            });
        }

        // Get flagged questions for the course
        const flags = await FlaggedQuestionModel.getFlaggedQuestionsForCourse(db, courseId, status);
        
        console.log(`Retrieved ${flags.length} flagged questions for course ${courseId}`);
        
        res.json({
            success: true,
            data: {
                courseId,
                flags,
                count: flags.length
            }
        });
        
    } catch (error) {
        console.error('Error retrieving flagged questions:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error while retrieving flagged questions'
        });
    }
});

/**
 * GET /api/flags/status/:status
 * Get flagged questions by status
 */
router.get('/status/:status', async (req, res) => {
    try {
        const { status } = req.params;
        
        if (!status) {
            return res.status(400).json({
                success: false,
                message: 'Missing required parameter: status'
            });
        }
        
        // Get database instance from app.locals
        const db = req.app.locals.db;
        if (!db) {
            return res.status(503).json({
                success: false,
                message: 'Database connection not available'
            });
        }
        
        const user = req.user;
        if (!user || (user.role !== 'instructor' && user.role !== 'ta')) {
            return res.status(403).json({
                success: false,
                message: 'Only instructors and TAs can view flags by status'
            });
        }

        // Get flagged questions by status, then scope to courses the caller can review.
        const allFlags = await FlaggedQuestionModel.getFlaggedQuestionsByStatus(db, status);
        const flags = await filterFlagsByReadableCourse(db, user, allFlags);

        if (user.role === 'ta' && allFlags.length > 0 && flags.length === 0) {
            return res.status(403).json({
                success: false,
                message: 'No access to flagged content for these courses'
            });
        }
        
        console.log(`Retrieved ${flags.length} flagged questions with status ${status}`);
        
        res.json({
            success: true,
            data: {
                status,
                flags,
                count: flags.length
            }
        });
        
    } catch (error) {
        console.error('Error retrieving flagged questions by status:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error while retrieving flagged questions'
        });
    }
});

/**
 * GET /api/flags/:flagId
 * Get a specific flagged question by ID
 */
router.get('/:flagId', async (req, res) => {
    try {
        const { flagId } = req.params;
        
        if (!flagId) {
            return res.status(400).json({
                success: false,
                message: 'Missing required parameter: flagId'
            });
        }
        
        // Get database instance from app.locals
        const db = req.app.locals.db;
        if (!db) {
            return res.status(503).json({
                success: false,
                message: 'Database connection not available'
            });
        }
        
        // Get the flagged question
        const flag = await FlaggedQuestionModel.getFlaggedQuestionById(db, flagId);
        
        if (!flag) {
            return res.status(404).json({
                success: false,
                message: 'Flagged question not found'
            });
        }

        const user = req.user;
        const hasAccess = await canReadCourseFlags(db, user, flag.courseId);
        if (!hasAccess) {
            return res.status(403).json({
                success: false,
                message: 'No access to flagged content for this course'
            });
        }
        
        console.log(`Retrieved flagged question: ${flagId}`);
        
        res.json({
            success: true,
            data: flag
        });
        
    } catch (error) {
        console.error('Error retrieving flagged question:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error while retrieving flagged question'
        });
    }
});

/**
 * PUT /api/flags/:flagId/response
 * Update instructor response to a flagged question
 */
router.put('/:flagId/response', async (req, res) => {
    try {
        const { flagId } = req.params;
        const {
            response,
            flagStatus
        } = req.body;

        if (!flagId || !response) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields: response'
            });
        }


        if (flagStatus && !FlaggedQuestionModel.isValidFlagStatus(flagStatus)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid flag status'
            });
        }

        const db = req.app.locals.db;
        if (!db) {
            return res.status(503).json({
                success: false,
                message: 'Database connection not available'
            });
        }

        const flag = await loadFlagAndAssertCourseAccess(req, res, flagId);
        if (!flag) return;
        const user = req.user;

        // Update the instructor response with authenticated user info
        // Use appropriate field name based on role (instructorId for both instructors and TAs)
        const result = await FlaggedQuestionModel.updateInstructorResponse(db, flagId, {
            response,
            instructorId: user.userId,
            instructorName: user.displayName || user.username,
            flagStatus
        });
        
        if (!result.success) {
            return res.status(400).json({
                success: false,
                message: result.error || 'Failed to update instructor response'
            });
        }
        
        const roleLabel = user.role === 'ta' ? 'TA' : 'Instructor';
        console.log(`${roleLabel} response updated for flag: ${flagId} by ${user.userId}`);
        
        res.json({
            success: true,
            message: 'Instructor response updated successfully!',
            data: {
                flagId,
                updatedAt: new Date().toISOString()
            }
        });
        
    } catch (error) {
        console.error('Error updating instructor response:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error while updating instructor response'
        });
    }
});

/**
 * PUT /api/flags/:flagId/status
 * Update flag status
 */
router.put('/:flagId/status', async (req, res) => {
    try {
        const { flagId } = req.params;
        const { status } = req.body;

        if (!flagId || !status) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields: status'
            });
        }


        if (!FlaggedQuestionModel.isValidFlagStatus(status)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid flag status'
            });
        }

        const db = req.app.locals.db;
        if (!db) {
            return res.status(503).json({
                success: false,
                message: 'Database connection not available'
            });
        }

        const flag = await loadFlagAndAssertCourseAccess(req, res, flagId);
        if (!flag) return;
        const user = req.user;

        // Update the flag status with authenticated user info
        const result = await FlaggedQuestionModel.updateFlagStatus(db, flagId, status, user.userId);
        
        if (!result.success) {
            return res.status(400).json({
                success: false,
                message: result.error || 'Failed to update flag status'
            });
        }
        
        const roleLabel = user.role === 'ta' ? 'TA' : 'Instructor';
        console.log(`Flag status updated to ${status} for flag: ${flagId} by ${roleLabel} ${user.userId}`);
        
        res.json({
            success: true,
            message: 'Flag status updated successfully!',
            data: {
                flagId,
                status,
                updatedAt: new Date().toISOString()
            }
        });
        
    } catch (error) {
        console.error('Error updating flag status:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error while updating flag status'
        });
    }
});

/**
 * GET /api/flags/stats/:courseId
 * Get flag statistics for a course
 */
router.get('/stats/:courseId', async (req, res) => {
    try {
        const { courseId } = req.params;
        
        if (!courseId) {
            return res.status(400).json({
                success: false,
                message: 'Missing required parameter: courseId'
            });
        }
        
        // Get database instance from app.locals
        const db = req.app.locals.db;
        if (!db) {
            return res.status(503).json({
                success: false,
                message: 'Database connection not available'
            });
        }
        
        const user = req.user;
        const hasAccess = await canReadCourseFlags(db, user, courseId);
        if (!hasAccess) {
            return res.status(403).json({
                success: false,
                message: 'No access to flagged content for this course'
            });
        }

        // Get flag statistics
        const stats = await FlaggedQuestionModel.getFlagStatistics(db, courseId);
        
        console.log(`Retrieved flag statistics for course ${courseId}:`, stats);
        
        res.json({
            success: true,
            data: {
                courseId,
                statistics: stats
            }
        });
        
    } catch (error) {
        console.error('Error retrieving flag statistics:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error while retrieving flag statistics'
        });
    }
});

/**
 * DELETE /api/flags/:flagId
 * Delete a flagged question (for cleanup purposes)
 */
router.delete('/:flagId', async (req, res) => {
    try {
        const { flagId } = req.params;

        if (!flagId) {
            return res.status(400).json({
                success: false,
                message: 'Missing required parameter: flagId'
            });
        }

        const db = req.app.locals.db;
        if (!db) {
            return res.status(503).json({
                success: false,
                message: 'Database connection not available'
            });
        }

        const flag = await loadFlagAndAssertCourseAccess(req, res, flagId);
        if (!flag) return;

        // Delete the flagged question
        const result = await FlaggedQuestionModel.deleteFlaggedQuestion(db, flagId);
        
        if (!result.success) {
            return res.status(400).json({
                success: false,
                message: result.error || 'Failed to delete flagged question'
            });
        }
        
        console.log(`Flagged question deleted: ${flagId}`);
        
        res.json({
            success: true,
            message: 'Flagged question deleted successfully!',
            data: {
                flagId,
                deletedCount: result.deletedCount
            }
        });
        
    } catch (error) {
        console.error('Error deleting flagged question:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error while deleting flagged question'
        });
    }
});

module.exports = router;
