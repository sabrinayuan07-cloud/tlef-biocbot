/**
 * Courses API Routes — student enrollment management
 */

const express = require('express');
const router = express.Router();
const CourseModel = require('../models/Course');
const { hasSystemAdminAccess } = require('../services/authorization');
const previewSession = require('../services/previewSession');

/**
 * GET /api/courses/:courseId/students
 * List students associated with a course with enrollment status
 */
router.get('/:courseId/students', async (req, res) => {
    try {
        const { courseId } = req.params;

        // Auth
        const user = req.user;
        if (!user) {
            return res.status(401).json({ success: false, message: 'Authentication required' });
        }
        if (user.role !== 'instructor' && user.role !== 'ta') {
            return res.status(403).json({ success: false, message: 'Only instructors and TAs can view students' });
        }

        // DB
        const db = req.app.locals.db;
        if (!db) {
            return res.status(503).json({ success: false, message: 'Database connection not available' });
        }

        // Check course access. TAs may access inactive courses as long as they remain assigned.
        const accessRole = user.role === 'ta' ? 'ta' : 'instructor';
        const hasAccess = hasSystemAdminAccess(user)
            || await CourseModel.userHasCourseAccess(db, courseId, user.userId, accessRole);
        if (!hasAccess) {
            return res.status(403).json({ success: false, message: 'Access denied. You can only view courses you have access to.' });
        }

        if (user.role === 'ta') {
            const canAccessFlags = await CourseModel.checkTAPermission(db, courseId, user.userId, 'flags');
            if (!canAccessFlags) {
                return res.status(403).json({ success: false, message: 'Access denied. You do not have permission to view student flags for this course.' });
            }
        }

        // Gather students by union of:
        // 1) Users with role student whose preferences.courseId == courseId
        // 2) Students who have chat sessions in this course
        // 3) Students appearing in course.studentEnrollment overrides
        const usersCol = db.collection('users');
        const chatCol = db.collection('chat_sessions');
        const coursesCol = db.collection('courses');

        const [prefStudents, chatStudents, courseDoc] = await Promise.all([
            // The "View as Student" sandbox has a real user record (parts of the
            // student UI read from it), so it must be filtered out explicitly or
            // it appears in this course's student list as a phantom student.
            usersCol.find({ role: 'student', 'preferences.courseId': courseId, isActive: true, isPreview: { $ne: true } })
                .project({ userId: 1, username: 1, email: 1, displayName: 1, role: 1, invitedCourses: 1, createdAt: 1, lastLogin: 1, struggleState: 1 })
                .toArray(),
            chatCol.distinct('studentId', { courseId, ...previewSession.excludePreviewFilter('studentId') }),
            coursesCol.findOne({ courseId }, { projection: { studentEnrollment: 1, courseName: 1 } })
        ]);

        // Strip preview sandboxes out of the enrollment overrides before they
        // reach the merge below. The fallback branch there renders any unknown
        // enrollment key as a student row using the raw id as a display name,
        // so a stray preview entry shows up as a student named after its
        // internal id. Preview writes are blocked at the join route now; this
        // also hides entries left over from before that guard existed.
        const rawEnrollmentMap = (courseDoc && courseDoc.studentEnrollment) || {};
        const enrollmentMap = Object.fromEntries(
            Object.entries(rawEnrollmentMap)
                .filter(([studentId]) => !previewSession.isPreviewUserId(studentId))
        );

        const chatStudentUsers = chatStudents.length > 0
            ? await usersCol.find({ userId: { $in: chatStudents }, role: 'student', isActive: true, isPreview: { $ne: true } })
                .project({ userId: 1, username: 1, email: 1, displayName: 1, role: 1, invitedCourses: 1, createdAt: 1, lastLogin: 1, struggleState: 1 })
                .toArray()
            : [];

        // Merge and unique by userId
        const byId = new Map();
        [...prefStudents, ...chatStudentUsers].forEach(s => {
            byId.set(s.userId, s);
        });

        // Also include any students present only in enrollmentMap (no profile fetched yet)
        const missingIds = Object.keys(enrollmentMap).filter(id => !byId.has(id));
        
        // Track which enrollmentMap IDs correspond to known-inactive accounts so
        // we can skip the synthetic fallback below and avoid resurrecting them.
        const inactiveIds = new Set();

        if (missingIds.length > 0) {
            // Fetch details for these users regardless of role
            const additionalUsers = await usersCol.find({ userId: { $in: missingIds } })
                .project({ userId: 1, username: 1, email: 1, displayName: 1, role: 1, invitedCourses: 1, createdAt: 1, lastLogin: 1, struggleState: 1, isActive: 1 })
                .toArray();

            additionalUsers.forEach(s => {
                if (s.isActive === false) {
                    inactiveIds.add(s.userId);
                    return;
                }
                byId.set(s.userId, s);
            });
        }

        // Fallback for truly missing users (still not found in DB)
        for (const studentId of Object.keys(enrollmentMap)) {
            if (inactiveIds.has(studentId)) continue;
            if (!byId.has(studentId)) {
                byId.set(studentId, {
                    userId: studentId,
                    username: studentId,
                    email: null,
                    displayName: studentId,
                    createdAt: null,
                    lastLogin: null
                });
            }
        }

        const students = Array.from(byId.values()).map(s => ({
            userId: s.userId,
            username: s.username,
            email: s.email,
            displayName: s.displayName,
            role: s.role,
            invitedCourses: s.invitedCourses || [],
            lastLogin: s.lastLogin,
            createdAt: s.createdAt,
            // Default enrolled=true if no override exists
            enrolled: enrollmentMap[s.userId] ? !!enrollmentMap[s.userId].enrolled : true,
            struggleState: s.struggleState || { topics: [] }
        }));

        // Sort by displayName
        students.sort((a, b) => (a.displayName || '').localeCompare(b.displayName || ''));

        return res.json({
            success: true,
            data: {
                courseId,
                courseName: courseDoc?.courseName || courseId,
                students,
                totalStudents: students.length
            }
        });
    } catch (error) {
        console.error('Error listing course students:', error);
        return res.status(500).json({ success: false, message: 'Internal server error while listing students' });
    }
});

/**
 * PUT /api/courses/:courseId/student-enrollment/:studentId
 * Update a student's enrollment (enrolled=true/false) for a course
 */
router.put('/:courseId/student-enrollment/:studentId', async (req, res) => {
    try {
        const { courseId, studentId } = req.params;
        const { enrolled } = req.body;

        // Validate
        if (typeof enrolled !== 'boolean') {
            return res.status(400).json({ success: false, message: 'enrolled must be a boolean' });
        }

        // Auth
        const user = req.user;
        if (!user) {
            return res.status(401).json({ success: false, message: 'Authentication required' });
        }
        if (user.role !== 'instructor') {
            return res.status(403).json({ success: false, message: 'Only instructors can update enrollment' });
        }

        // DB
        const db = req.app.locals.db;
        if (!db) {
            return res.status(503).json({ success: false, message: 'Database connection not available' });
        }

        // Access check
        const hasAccess = await CourseModel.userHasCourseAccess(db, courseId, user.userId, 'instructor');
        if (!hasAccess) {
            return res.status(403).json({ success: false, message: 'Access denied. You can only manage your own courses.' });
        }

        const result = await CourseModel.updateStudentEnrollment(db, courseId, studentId, enrolled);
        if (!result.success) {
            return res.status(400).json({ success: false, message: result.error || 'Failed to update enrollment' });
        }

        return res.json({
            success: true,
            message: 'Student enrollment updated successfully',
            data: { courseId, studentId, enrolled }
        });
    } catch (error) {
        console.error('Error updating student enrollment:', error);
        return res.status(500).json({ success: false, message: 'Internal server error while updating enrollment' });
    }
});

/**
 * GET /api/courses/:courseId/student-enrollment
 * Get current student's enrollment status for the course
 */
router.get('/:courseId/student-enrollment', async (req, res) => {
    try {
        const { courseId } = req.params;
        const user = req.user;
        if (!user) {
            return res.status(401).json({ success: false, message: 'Authentication required' });
        }
        if (user.role !== 'student') {
            return res.status(403).json({ success: false, message: 'Only students can view their enrollment' });
        }

        const db = req.app.locals.db;
        if (!db) {
            return res.status(503).json({ success: false, message: 'Database connection not available' });
        }

        // Preview sandboxes are handled inside getStudentEnrollment, which
        // reports them enrolled in the one course their id encodes.
        const result = await CourseModel.getStudentEnrollment(db, courseId, user.userId);
        if (!result.success) {
            return res.status(404).json({ success: false, message: 'Course not found' });
        }

        return res.json({ 
            success: true, 
            data: { 
                courseId, 
                enrolled: result.enrolled,
                status: result.status 
            } 
        });
    } catch (error) {
        console.error('Error getting student enrollment:', error);
        return res.status(500).json({ success: false, message: 'Internal server error while getting enrollment' });
    }
});

module.exports = router;
