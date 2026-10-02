/**
 * Courses API Routes — course discovery, joining, and instructor co-ownership
 */

const express = require('express');
const router = express.Router();
const CourseModel = require('../models/Course');
const UserModel = require('../models/User');
const { hasSystemAdminAccess } = require('../services/authorization');
const previewSession = require('../services/previewSession');
const { publicProviderKeyState } = require('../services/llmKeyStore');
const { getAcademicApiClient, isAcademicApiEnabled } = require('../services/academicApi');
const { hasInstructorAccess } = require('./courses.shared');

/**
 * True when the UBC academic record lists this user as an instructor of record
 * for at least one section linked to the course. Such an instructor can join
 * the BiocBot course directly, without an instructor course code — they're
 * already a verified co-instructor of the underlying section (e.g. a colleague
 * joining a pre-made, co-taught course).
 *
 * Fails closed: any missing data or academic-API error returns false, so the
 * normal code-based join still applies.
 */
async function isVerifiedInstructorOfRecord(req, course, user) {
    // Gated off by default: with no academic API, instructor-of-record can't be
    // verified, so the normal instructor-code join applies (pre-feature behavior).
    if (!await isAcademicApiEnabled(req.app.locals.db)) {
        return false;
    }

    const sync = course && course.academicSync;
    const linkedSectionIds = Array.isArray(sync && sync.sectionIds)
        ? sync.sectionIds.filter(Boolean)
        : [];
    const academicPeriod = sync && sync.academicPeriod;

    if (!user || !user.puid || !academicPeriod || linkedSectionIds.length === 0) {
        return false;
    }

    try {
        const api = req.app.locals.academicApi || getAcademicApiClient();
        const sections = await api.getInstructorSections(user.puid, academicPeriod);
        const taughtSectionIds = new Set(
            (sections || [])
                .map((s) => s.courseSectionId || s.id || s.sectionId)
                .filter(Boolean)
        );
        return linkedSectionIds.some((id) => taughtSectionIds.has(id));
    } catch (error) {
        console.error('Instructor-of-record verification failed:', error.message);
        return false;
    }
}

function isInactiveCourse(course = {}) {
    return (course.status || 'active') === 'inactive';
}

function sortCoursesWithInactiveLast(courses = []) {
    return [...courses].sort((a, b) => {
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
    });
}

function normalizeCourseCode(code) {
    if (typeof code !== 'string') {
        return '';
    }

    return code.trim().toUpperCase();
}

async function userCanBypassCourseCodes(db, user) {
    if (!user) {
        return false;
    }

    if (hasSystemAdminAccess(user)) {
        return true;
    }

    let hydratedUser = user;

    if (!hydratedUser.email && hydratedUser.userId && db) {
        hydratedUser = await UserModel.getUserById(db, hydratedUser.userId);
    }

    if (!hydratedUser) {
        return false;
    }

    if (hasSystemAdminAccess(hydratedUser)) {
        return true;
    }

    return false;
}

/**
 * GET /api/courses/available/all
 * Get courses available in the current user's normal selector
 */
router.get('/available/all', async (req, res) => {
    try {
        // Get database instance from app.locals
        const db = req.app.locals.db;
        if (!db) {
            return res.status(503).json({
                success: false,
                message: 'Database connection not available'
            });
        }
        
        const user = req.user;
        
        // Query database for all non-deleted courses, then filter by role below
        const collection = db.collection('courses');
        const courses = await collection.find({ status: { $ne: 'deleted' } }).toArray();

        let availableCourses = courses;

        if (user && user.role === 'instructor' && !hasSystemAdminAccess(user)) {
            availableCourses = availableCourses.filter(course => hasInstructorAccess(course, user.userId));
        }

        if (user && user.role === 'student') {
            availableCourses = availableCourses.filter(course => (course.status || 'active') === 'active');
        }

        // TAs can always see their assigned/invited courses, and can join active courses with a student code.
        if (user && user.role === 'ta') {
            console.log(`Filtering courses for TA ${user.userId}`);

            // Filter from the already-narrowed availableCourses, not the raw
            // `courses` list. Avoids undoing any earlier role-based narrowing.
            availableCourses = availableCourses.filter(course => {
                const isActive = CourseModel.normalizeCourseStatus(course.status) === CourseModel.COURSE_STATUS.ACTIVE;

                return isActive;
            });
            console.log(`TA ${user.userId} sees ${availableCourses.length} courses (from total ${courses.length})`);
        }
        
        // In "View as Student" the selector offers the courses the previewer
        // actually teaches, not every active course on the platform. Picking one
        // re-points the preview grant, so the list has to stay within what they
        // are allowed to preview.
        if (previewSession.isPreviewRequest(req) && req.realUser) {
            const owner = req.realUser;
            const isAdmin = !!(owner.permissions && owner.permissions.systemAdmin === true);

            if (!isAdmin) {
                const ownCourses = await CourseModel.getCoursesForUser(db, owner.userId, owner.role);
                const ownIds = new Set((ownCourses || []).map(course => course.courseId));
                availableCourses = availableCourses.filter(course => ownIds.has(course.courseId));
            }
        }

        availableCourses = sortCoursesWithInactiveLast(availableCourses);
        const canBypassCourseCodes = await userCanBypassCourseCodes(db, user);

        // Transform the data to match expected format for both sides
        // For students, check enrollment status
        const transformedCourses = await Promise.all(availableCourses.map(async (course) => {
            let isEnrolled = false;
            const isTAAssigned = !!(user && user.role === 'ta' && course.tas && course.tas.includes(user.userId));
            const isTAInvited = !!(user && user.role === 'ta' && Array.isArray(user.invitedCourses) && user.invitedCourses.includes(course.courseId));
            
            // If user is student, check explicit enrollment
            if (user && user.role === 'student') {
                const result = await CourseModel.getStudentEnrollment(db, course.courseId, user.userId);
                isEnrolled = result.success && result.enrolled === true;
            }
            
            return {
                courseId: course.courseId,
                courseName: course.courseName || course.courseId,
                instructorId: course.instructorId,
                instructors: course.instructors || [course.instructorId],
                tas: course.tas || [],
                status: course.status || 'active',
                aiAvailable: publicProviderKeyState(course).aiAvailable,
                llmKey: publicProviderKeyState(course).llmKey,
                llmProvider: publicProviderKeyState(course).llmProvider,
                createdAt: course.createdAt?.toISOString() || new Date().toISOString(),
                isEnrolled: isEnrolled,
                isTAAssigned,
                isTAInvited,
                requiresCode: user && user.role === 'ta'
                    ? !isTAAssigned && !isTAInvited && !canBypassCourseCodes
                    : false
            };
        }));

        // With the academic API on, students only get courses they're enrolled in
        // (enrolment comes from the roster sync), so the selector never offers a
        // course they can't enter. With it off (the default), there's no roster to
        // enrol them, so we fall back to the pre-feature behavior: list all active
        // courses and let them join with a course code.
        const academicEnabled = await isAcademicApiEnabled(db);
        const responseCourses = (user && user.role === 'student' && academicEnabled)
            ? transformedCourses.filter(course => course.isEnrolled)
            : transformedCourses;

        console.log(`Retrieved ${responseCourses.length} available courses`);

        res.json({
            success: true,
            data: responseCourses
        });
        
    } catch (error) {
        console.error('Error fetching available courses:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error while fetching available courses'
        });
    }
});

/**
 * GET /api/courses/available/joinable
 * Get courses that an instructor can join with an instructor course code
 */
router.get('/available/joinable', async (req, res) => {
    try {
        const db = req.app.locals.db;
        if (!db) {
            return res.status(503).json({
                success: false,
                message: 'Database connection not available'
            });
        }

        const user = req.user;
        if (!user || user.role !== 'instructor') {
            return res.status(403).json({
                success: false,
                message: 'Only instructors can view joinable courses'
            });
        }

        const collection = db.collection('courses');
        const courses = await collection.find({ status: { $ne: 'deleted' } }).toArray();
        const joinableCourses = sortCoursesWithInactiveLast(
            courses.filter(course => !hasInstructorAccess(course, user.userId))
        );

        const transformedCourses = joinableCourses.map((course) => ({
            courseId: course.courseId,
            courseName: course.courseName || course.courseId,
            instructorId: course.instructorId,
            instructors: course.instructors || [course.instructorId],
            tas: course.tas || [],
            status: course.status || 'active',
            aiAvailable: publicProviderKeyState(course).aiAvailable,
            llmKey: publicProviderKeyState(course).llmKey,
            llmProvider: publicProviderKeyState(course).llmProvider,
            createdAt: course.createdAt?.toISOString() || new Date().toISOString()
        }));

        return res.json({
            success: true,
            data: transformedCourses
        });
    } catch (error) {
        console.error('Error fetching joinable courses:', error);
        return res.status(500).json({
            success: false,
            message: 'Internal server error while fetching joinable courses'
        });
    }
});

/**
 * GET /api/courses/:courseId/instructor-join-status
 * Report whether the current instructor needs a course code to join.
 *
 * This is a UX hint only. The POST join route repeats every check before
 * granting access.
 */
router.get('/:courseId/instructor-join-status', async (req, res) => {
    try {
        const db = req.app.locals.db;
        if (!db) {
            return res.status(503).json({
                success: false,
                message: 'Database connection not available'
            });
        }

        const user = req.user;
        if (!user || user.role !== 'instructor') {
            return res.status(403).json({
                success: false,
                message: 'Only instructors can check instructor join status'
            });
        }

        const course = await db.collection('courses').findOne({
            courseId: req.params.courseId,
            status: { $ne: 'deleted' }
        });
        if (!course) {
            return res.status(404).json({
                success: false,
                message: 'Course not found'
            });
        }

        const alreadyHasAccess = hasInstructorAccess(course, user.userId);
        const canBypassCourseCodes = await userCanBypassCourseCodes(db, user);
        const instructorOfRecord = !alreadyHasAccess && !canBypassCourseCodes
            ? await isVerifiedInstructorOfRecord(req, course, user)
            : false;

        let reason = 'courseCode';
        if (alreadyHasAccess) reason = 'alreadyInstructor';
        else if (canBypassCourseCodes) reason = 'admin';
        else if (instructorOfRecord) reason = 'instructorOfRecord';

        return res.json({
            success: true,
            data: {
                courseId: course.courseId,
                requiresCode: !(alreadyHasAccess || canBypassCourseCodes || instructorOfRecord),
                reason
            }
        });
    } catch (error) {
        console.error('Error checking instructor join status:', error);
        return res.status(500).json({
            success: false,
            message: 'Internal server error while checking instructor join status'
        });
    }
});

/**
 * POST /api/courses/:courseId/join
 * Join a course (Student via code, TA direct join)
 */
router.post('/:courseId/join', async (req, res) => {
    try {
        const { courseId } = req.params;
        const { code } = req.body;
        
        // Get authenticated user information
        const user = req.user;
        if (!user) {
            return res.status(401).json({
                success: false,
                message: 'Authentication required'
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

        const canBypassCourseCodes = await userCanBypassCourseCodes(db, user);
        
        // Handle Student Join
        if (user.role === 'student') {
            if (!canBypassCourseCodes && !code) {
                return res.status(400).json({
                    success: false,
                    message: 'Course code is required'
                });
            }
            
            const result = await CourseModel.joinCourse(db, courseId, user.userId, code, {
                skipCodeValidation: canBypassCourseCodes
            });
            
            if (!result.success) {
                // Return 403 for revoked access or invalid code
                return res.status(403).json({
                    success: false,
                    message: result.error || 'Failed to join course'
                });
            }
            
            console.log(`Student ${user.userId} joined course ${courseId}`);
            
            return res.json({
                success: true,
                message: 'Successfully joined course',
                data: {
                    courseId,
                    enrolled: true
                }
            });
        }
        // Handle TA Join
        else if (user.role === 'ta') {
            // Check if course exists first to provide better error message
            const course = await CourseModel.getCourseById(db, courseId);
            if (!course) {
                return res.status(404).json({
                    success: false,
                    message: 'Course not found'
                });
            }

            const invitedCourses = Array.isArray(user.invitedCourses) ? user.invitedCourses : [];
            const isInvited = invitedCourses.includes(courseId);
            const isAssigned = Array.isArray(course.tas) && course.tas.includes(user.userId);
            const canJoinWithoutCode = isInvited || isAssigned || canBypassCourseCodes;

            if (!canJoinWithoutCode) {
                if (!code) {
                    return res.status(400).json({
                        success: false,
                        message: 'Course code is required'
                    });
                }

                if (course.status === 'inactive' || course.status === 'deleted') {
                    return res.status(403).json({
                        success: false,
                        message: 'Course is deactivated by the instructor'
                    });
                }

                if (normalizeCourseCode(course.courseCode) !== normalizeCourseCode(code)) {
                    return res.status(403).json({
                        success: false,
                        message: 'Invalid course code'
                    });
                }
            } else if (code && !canBypassCourseCodes && normalizeCourseCode(course.courseCode) !== normalizeCourseCode(code)) {
                return res.status(403).json({
                    success: false,
                    message: 'Invalid course code'
                });
            }

            // Add TA to course using Course model
            const result = await CourseModel.addTAToCourse(db, courseId, user.userId);
            
            if (!result.success) {
                return res.status(400).json({
                    success: false,
                    message: result.error || 'Failed to join course'
                });
            }

            await db.collection('users').updateOne(
                { userId: user.userId },
                {
                    $pull: { invitedCourses: courseId },
                    $set: { updatedAt: new Date() }
                }
            );
            
            console.log(`TA ${user.userId} joined course ${courseId}`);
            
            return res.json({
                success: true,
                message: 'Successfully joined course',
                data: {
                    courseId,
                    taId: user.userId,
                    courseName: course.courseName,
                    modifiedCount: result.modifiedCount
                }
            });
        }
        // Invalid Role
        else {
            return res.status(403).json({
                success: false,
                message: 'Only students and TAs can join courses'
            });
        }
        
    } catch (error) {
        console.error('Error joining course:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error while joining course'
        });
    }
});

/**
 * POST /api/courses/:courseId/instructors
 * Join a course as an instructor using an instructor course code
 */
router.post('/:courseId/instructors', async (req, res) => {
    try {
        const { courseId } = req.params;
        const { instructorId, code } = req.body;
        
        // Get authenticated user information
        const user = req.user;
        if (!user) {
            return res.status(401).json({
                success: false,
                message: 'Authentication required'
            });
        }
        
        // Only instructors can join as instructors
        if (user.role !== 'instructor') {
            return res.status(403).json({
                success: false,
                message: 'Only instructors can join courses as instructors'
            });
        }
        
        if (!instructorId) {
            return res.status(400).json({
                success: false,
                message: 'instructorId is required'
            });
        }

        if (user.userId !== instructorId) {
            return res.status(403).json({
                success: false,
                message: 'You can only join courses for your own instructor account'
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

        const canBypassCourseCodes = await userCanBypassCourseCodes(db, user);
        const existingCourse = await db.collection('courses').findOne({ courseId });

        if (!existingCourse) {
            return res.status(404).json({
                success: false,
                message: 'Course not found'
            });
        }

        const alreadyHasAccess = hasInstructorAccess(existingCourse, instructorId);
        const instructorOfRecord = !canBypassCourseCodes && !alreadyHasAccess
            ? await isVerifiedInstructorOfRecord(req, existingCourse, user)
            : false;
        const canJoinWithoutCode = canBypassCourseCodes || alreadyHasAccess || instructorOfRecord;

        if (!canJoinWithoutCode && !code) {
            return res.status(400).json({
                success: false,
                message: 'Instructor course code is required'
            });
        }

        const result = await CourseModel.joinCourseAsInstructor(db, courseId, instructorId, code, {
            skipCodeValidation: canJoinWithoutCode
        });
        
        if (!result.success) {
            return res.status(403).json({
                success: false,
                message: result.error || 'Failed to join course as instructor'
            });
        }
        
        console.log(`Instructor ${instructorId} joined course ${courseId}`);
        
        res.json({
            success: true,
            message: result.message || 'Instructor added to course successfully',
            data: {
                courseId,
                instructorId,
                modifiedCount: result.alreadyJoined ? 0 : 1,
                alreadyJoined: !!result.alreadyJoined
            }
        });
        
    } catch (error) {
        console.error('Error adding instructor to course:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error while adding instructor to course'
        });
    }
});

module.exports = router;
