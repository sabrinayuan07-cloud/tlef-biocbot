/**
 * Courses API Routes — TA assignment and per-TA permissions
 */

const express = require('express');
const router = express.Router();
const CourseModel = require('../models/Course');
const { publicProviderKeyState } = require('../services/llmKeyStore');
const { PERMISSION_KEYS, ROLE_PRESETS, deriveRoleLabel } = require('../services/permissions');
const { hasInstructorAccess } = require('./courses.shared');

/**
 * POST /api/courses/:courseId/tas
 * Add a TA to a course
 */
router.post('/:courseId/tas', async (req, res) => {
    try {
        const { courseId } = req.params;
        const { taId } = req.body;
        
        // Get authenticated user information
        const user = req.user;
        if (!user) {
            return res.status(401).json({
                success: false,
                message: 'Authentication required'
            });
        }
        
        // Only instructors can add TAs
        if (user.role !== 'instructor') {
            return res.status(403).json({
                success: false,
                message: 'Only instructors can add TAs to courses'
            });
        }
        
        if (!taId) {
            return res.status(400).json({
                success: false,
                message: 'taId is required'
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
        
        // Add TA to course using Course model
        const result = await CourseModel.addTAToCourse(db, courseId, taId);
        
        if (!result.success) {
            return res.status(400).json({
                success: false,
                message: result.error || 'Failed to add TA to course'
            });
        }
        
        console.log(`Added TA ${taId} to course ${courseId}`);
        
        res.json({
            success: true,
            message: 'TA added to course successfully',
            data: {
                courseId,
                taId,
                modifiedCount: result.modifiedCount
            }
        });
        
    } catch (error) {
        console.error('Error adding TA to course:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error while adding TA to course'
        });
    }
});

/**
 * DELETE /api/courses/:courseId/tas/:taId
 * Remove a TA from one course only
 */
router.delete('/:courseId/tas/:taId', async (req, res) => {
    try {
        const { courseId, taId } = req.params;

        const user = req.user;
        if (!user) {
            return res.status(401).json({
                success: false,
                message: 'Authentication required'
            });
        }

        if (user.role !== 'instructor') {
            return res.status(403).json({
                success: false,
                message: 'Only instructors can remove TAs from courses'
            });
        }

        const db = req.app.locals.db;
        if (!db) {
            return res.status(503).json({
                success: false,
                message: 'Database connection not available'
            });
        }

        const coursesCollection = db.collection('courses');
        const course = await coursesCollection.findOne({ courseId });

        if (!course || course.status === 'deleted') {
            return res.status(404).json({
                success: false,
                message: 'Course not found'
            });
        }

        if (!hasInstructorAccess(course, user.userId)) {
            return res.status(403).json({
                success: false,
                message: 'Access denied. You can only remove TAs from your own courses.'
            });
        }

        const result = await coursesCollection.updateOne(
            { courseId },
            {
                $pull: { tas: taId },
                $unset: { [`taPermissions.${taId}`]: '' },
                $set: { updatedAt: new Date() }
            }
        );

        const usersCollection = db.collection('users');
        await usersCollection.updateOne(
            { userId: taId },
            {
                $pull: { invitedCourses: courseId },
                $set: { updatedAt: new Date() }
            }
        );

        const [remainingCourseCount, refreshedTA] = await Promise.all([
            coursesCollection.countDocuments({
                tas: taId,
                status: { $ne: 'deleted' }
            }),
            usersCollection.findOne(
                { userId: taId },
                { projection: { invitedCourses: 1, role: 1 } }
            )
        ]);

        const hasPendingInvites = Array.isArray(refreshedTA?.invitedCourses) && refreshedTA.invitedCourses.length > 0;
        const shouldRemainTA = remainingCourseCount > 0 || hasPendingInvites;

        if (refreshedTA && shouldRemainTA && refreshedTA.role !== 'ta') {
            await usersCollection.updateOne(
                { userId: taId },
                {
                    $set: {
                        role: 'ta',
                        updatedAt: new Date()
                    }
                }
            );
        } else if (refreshedTA && refreshedTA.role === 'ta' && !shouldRemainTA) {
            await usersCollection.updateOne(
                { userId: taId },
                {
                    $set: {
                        role: 'student',
                        updatedAt: new Date()
                    }
                }
            );
        }

        console.log(`Removed TA ${taId} from course ${courseId}`);

        return res.json({
            success: true,
            message: 'TA removed from course successfully',
            data: {
                courseId,
                taId,
                modifiedCount: result.modifiedCount,
                remainingCourseCount,
                role: shouldRemainTA ? 'ta' : 'student'
            }
        });
    } catch (error) {
        console.error('Error removing TA from course:', error);
        return res.status(500).json({
            success: false,
            message: 'Internal server error while removing TA from course'
        });
    }
});

/**
 * GET /api/courses/ta/:taId
 * Get all courses for a specific TA
 */
router.get('/ta/:taId', async (req, res) => {
    try {
        const { taId } = req.params;
        
        // Get authenticated user information
        const user = req.user;
        if (!user) {
            return res.status(401).json({
                success: false,
                message: 'Authentication required'
            });
        }
        
        // Only TAs can access their own courses
        if (user.role !== 'ta' || user.userId !== taId) {
            return res.status(403).json({
                success: false,
                message: 'Access denied. You can only view your own courses.'
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
        
        // Get courses for TA using Course model
        const courses = await CourseModel.getCoursesForUser(db, taId, 'ta');
        
        // Transform the data to match expected format
        const transformedCourses = courses.map(course => ({
            courseId: course.courseId,
            courseName: course.courseName,
            instructorId: course.instructorId,
            instructors: course.instructors || [course.instructorId],
            tas: course.tas || [],
            status: course.status || 'active',
            aiAvailable: publicProviderKeyState(course).aiAvailable,
            llmKey: publicProviderKeyState(course).llmKey,
            llmProvider: publicProviderKeyState(course).llmProvider,
            createdAt: course.createdAt?.toISOString() || new Date().toISOString(),
            updatedAt: course.updatedAt?.toISOString() || new Date().toISOString(),
            totalUnits: course.courseStructure?.totalUnits || 0
        }));
        
        console.log(`Retrieved ${transformedCourses.length} courses for TA ${taId}`);
        
        res.json({
            success: true,
            data: transformedCourses
        });
        
    } catch (error) {
        console.error('Error fetching TA courses:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error while fetching TA courses'
        });
    }
});

/**
 * PUT /api/courses/:courseId/ta-permissions/:taId
 * Update TA permissions for a specific course.
 *
 * Accepts a partial body - only keys from PERMISSION_KEYS present in
 * req.body are validated and written, so the client can toggle one
 * permission (or apply a role preset's full set) without a read-modify-write
 * round trip. `role` is an optional convenience: when present and it names a
 * known preset, its full flag set is applied (individual keys in the same
 * body, if any, are layered on top and win).
 */
router.put('/:courseId/ta-permissions/:taId', async (req, res) => {
    try {
        const { courseId, taId } = req.params;
        const { role } = req.body;

        // Get authenticated user information
        const user = req.user;
        if (!user) {
            return res.status(401).json({
                success: false,
                message: 'Authentication required'
            });
        }

        // Only instructors can manage TA permissions
        if (user.role !== 'instructor') {
            return res.status(403).json({
                success: false,
                message: 'Only instructors can manage TA permissions'
            });
        }

        const permissions = {};
        if (role !== undefined) {
            if (!Object.prototype.hasOwnProperty.call(ROLE_PRESETS, role)) {
                return res.status(400).json({
                    success: false,
                    message: `Unknown role preset '${role}'`
                });
            }
            Object.assign(permissions, ROLE_PRESETS[role]);
        }
        for (const key of PERMISSION_KEYS) {
            if (Object.prototype.hasOwnProperty.call(req.body, key)) {
                permissions[key] = req.body[key];
            }
        }

        if (Object.keys(permissions).length === 0) {
            return res.status(400).json({
                success: false,
                message: `Provide at least one of: ${PERMISSION_KEYS.join(', ')}, or a 'role' preset`
            });
        }

        const invalidKey = Object.keys(permissions).find(key => typeof permissions[key] !== 'boolean');
        if (invalidKey) {
            return res.status(400).json({
                success: false,
                message: `'${invalidKey}' must be a boolean value`
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

        // Check if instructor has access to this course
        const hasAccess = await CourseModel.userHasCourseAccess(db, courseId, user.userId, 'instructor');
        if (!hasAccess) {
            return res.status(403).json({
                success: false,
                message: 'Access denied. You can only manage permissions for your own courses.'
            });
        }

        // Update TA permissions
        const result = await CourseModel.updateTAPermissions(db, courseId, taId, permissions);

        if (!result.success) {
            return res.status(400).json({
                success: false,
                message: result.error || 'Failed to update TA permissions'
            });
        }

        const updated = await CourseModel.getTAPermissions(db, courseId, taId);

        console.log(`Updated TA permissions for ${taId} in course ${courseId}`);

        res.json({
            success: true,
            message: 'TA permissions updated successfully',
            data: {
                courseId,
                taId,
                permissions: updated.permissions,
                roleLabel: deriveRoleLabel(updated.permissions),
                modifiedCount: result.modifiedCount
            }
        });

    } catch (error) {
        console.error('Error updating TA permissions:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error while updating TA permissions'
        });
    }
});

/**
 * GET /api/courses/:courseId/ta-permissions/:taId
 * Get TA permissions for a specific course
 */
router.get('/:courseId/ta-permissions/:taId', async (req, res) => {
    try {
        const { courseId, taId } = req.params;
        
        // Get authenticated user information
        const user = req.user;
        if (!user) {
            return res.status(401).json({
                success: false,
                message: 'Authentication required'
            });
        }
        
        // Allow instructors to view any TA's permissions, or TAs to view their own permissions
        if (user.role !== 'instructor' && (user.role !== 'ta' || user.userId !== taId)) {
            return res.status(403).json({
                success: false,
                message: 'Access denied. You can only view your own permissions or instructors can view any TA permissions.'
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
        
        // Check if user has access to this course
        // For instructors: check instructor access
        // For TAs: check TA access
        const userRole = user.role === 'instructor' ? 'instructor' : 'ta';
        const hasAccess = await CourseModel.userHasCourseAccess(db, courseId, user.userId, userRole);
        if (!hasAccess) {
            return res.status(403).json({
                success: false,
                message: 'Access denied. You can only view permissions for courses you have access to.'
            });
        }
        
        // Get TA permissions
        const result = await CourseModel.getTAPermissions(db, courseId, taId);
        
        if (!result.success) {
            return res.status(400).json({
                success: false,
                message: result.error || 'Failed to get TA permissions'
            });
        }
        
        res.json({
            success: true,
            data: {
                courseId,
                taId,
                permissions: result.permissions,
                roleLabel: deriveRoleLabel(result.permissions)
            }
        });

    } catch (error) {
        console.error('Error getting TA permissions:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error while getting TA permissions'
        });
    }
});

/**
 * GET /api/courses/:courseId/ta-permissions
 * Get all TA permissions for a specific course
 */
router.get('/:courseId/ta-permissions', async (req, res) => {
    try {
        const { courseId } = req.params;
        
        // Get authenticated user information
        const user = req.user;
        if (!user) {
            return res.status(401).json({
                success: false,
                message: 'Authentication required'
            });
        }
        
        // Only instructors can view TA permissions
        if (user.role !== 'instructor') {
            return res.status(403).json({
                success: false,
                message: 'Only instructors can view TA permissions'
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
        
        // Check if instructor has access to this course
        const hasAccess = await CourseModel.userHasCourseAccess(db, courseId, user.userId, 'instructor');
        if (!hasAccess) {
            return res.status(403).json({
                success: false,
                message: 'Access denied. You can only view permissions for your own courses.'
            });
        }
        
        // Get course details
        const course = await CourseModel.getCourseById(db, courseId);
        if (!course) {
            return res.status(404).json({
                success: false,
                message: 'Course not found'
            });
        }
        
        // Get permissions for all TAs in the course
        const taPermissions = {};
        if (course.tas && course.tas.length > 0) {
            for (const taId of course.tas) {
                const result = await CourseModel.getTAPermissions(db, courseId, taId);
                if (result.success) {
                    taPermissions[taId] = {
                        ...result.permissions,
                        roleLabel: deriveRoleLabel(result.permissions)
                    };
                }
            }
        }
        
        res.json({
            success: true,
            data: {
                courseId,
                taPermissions
            }
        });
        
    } catch (error) {
        console.error('Error getting all TA permissions:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error while getting TA permissions'
        });
    }
});

/**
 * GET /api/courses/permissions/presets
 * The named role presets ("Grader", "Content TA", "Full TA") a TA can be
 * assigned in one action, so the TA hub UI's dropdown doesn't hardcode its
 * own copy of the flag sets - the frontend never needs to know what a
 * preset expands to beyond what the server returns here.
 */
router.get('/permissions/presets', async (req, res) => {
    const user = req.user;
    if (!user) {
        return res.status(401).json({ success: false, message: 'Authentication required' });
    }
    if (user.role !== 'instructor') {
        return res.status(403).json({ success: false, message: 'Only instructors can view role presets' });
    }
    res.json({ success: true, data: { permissionKeys: PERMISSION_KEYS, presets: ROLE_PRESETS } });
});

module.exports = router;
