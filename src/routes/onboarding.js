/**
 * Onboarding Routes
 * Handles API endpoints for onboarding data management
 */

const express = require('express');
const router = express.Router();
const CourseModel = require('../models/Course');
const {
    buildKeySubdocument,
    credentialSetFields,
    publicKeySummary,
    stripPrivateKeyFields,
    validateApiKey
} = require('../services/llmKeyStore');
const providerKeys = require('../services/providerKeyService');
const scopeModelSettings = require('../services/scopeModelSettings');
const { normalizeProvider, providerCatalog, providerLabel } = require('../services/llmProviders');

const ONBOARDING_UPDATE_FIELDS = new Set([
    'courseName', 'courseDescription', 'learningOutcomes', 'assessmentCriteria',
    'courseMaterials', 'unitFiles', 'courseStructure'
]);

function sanitizeOnboardingUpdates(input = {}) {
    return Object.fromEntries(
        Object.entries(input).filter(([field]) => ONBOARDING_UPDATE_FIELDS.has(field))
    );
}

function hasInstructorAccess(course, userId) {
    return course.instructorId === userId ||
        (Array.isArray(course.instructors) && course.instructors.includes(userId));
}

function hasInstructorOrTAAccess(course, userId) {
    return hasInstructorAccess(course, userId) ||
        (Array.isArray(course.tas) && course.tas.includes(userId));
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

/**
 * GET /api/onboarding/test
 * Test endpoint to verify onboarding routes are working
 */
/**
 * GET /api/onboarding/platforms
 * The platforms an instructor can choose from, with the help text for each.
 * Deliberately carries no model names — instructors never choose models.
 */
router.get('/platforms', (req, res) => {
    res.json({ success: true, providers: providerCatalog() });
});

router.get('/test', (req, res) => {
    res.json({
        success: true,
        message: 'Onboarding routes are working!',
        timestamp: new Date().toISOString()
    });
});

/**
 * POST /api/onboarding
 * Create or update onboarding data for a course
 */
router.post('/', async (req, res) => {
    // Get authenticated user information
    const user = req.user;
    if (!user) {
        return res.status(401).json({
            success: false,
            message: 'Authentication required'
        });
    }
    
    // Only instructors can create courses
    if (user.role !== 'instructor') {
        return res.status(403).json({
            success: false,
            message: 'Only instructors can create courses'
        });
    }
    
    const {
        courseId,
        courseName,
        courseDescription,
        learningOutcomes,
        assessmentCriteria,
        courseMaterials,
        unitFiles,
        courseStructure,
        apiKey
    } = req.body;
    
    // Use authenticated user's ID
    const instructorId = user.userId;
    
    // Validate required fields
    if (!courseId || !courseName) {
        return res.status(400).json({
            success: false,
            message: 'Missing required fields: courseId, courseName'
        });
    }
    
    try {
        // Get database instance from app.locals
        const db = req.app.locals.db;
        if (!db) {
            return res.status(503).json({
                success: false,
                message: 'Database connection not available'
            });
        }

        const existingCourse = await CourseModel.getCourseById(db, courseId);
        if (existingCourse && !hasInstructorAccess(existingCourse, instructorId)) {
            return res.status(403).json({
                success: false,
                message: 'You do not have access to update this course'
            });
        }

        // Step 1 of onboarding: the instructor picks a platform (GPT or
        // Sandbox); step 2 is that platform's key. Both are validated against
        // the models the admin configured for that platform.
        const selectedProvider = normalizeProvider(req.body.llmProvider);
        const validation = await providerKeys.validateForProvider(db, selectedProvider, apiKey);
        if (!validation.ok) {
            return res.status(400).json({
                success: false,
                code: providerKeys.errorCodeForStatus(validation.status),
                message: validation.message
                    || `A valid ${providerLabel(selectedProvider)} API key is required to create a course.`,
                detail: validation.detail,
                llmProvider: selectedProvider
            });
        }
        
        // Prepare onboarding data
        const onboardingData = {
            courseId,
            courseName,
            instructorId,
            courseDescription: courseDescription || '',
            learningOutcomes: learningOutcomes || [],
            assessmentCriteria: assessmentCriteria || '',
            courseMaterials: courseMaterials || [],
            unitFiles: unitFiles || {},
            courseStructure: courseStructure || {}
        };
        
        // Save to database using Course model
        const result = await CourseModel.createCourseFromOnboarding(db, onboardingData);

        let onboardingModifiedCount = result.modifiedCount;
        if (!result.created) {
            const updateData = {
                courseName,
                updatedAt: new Date()
            };
            for (const field of [
                'courseDescription', 'assessmentCriteria', 'courseMaterials', 'courseStructure'
            ]) {
                if (Object.prototype.hasOwnProperty.call(req.body, field)) {
                    updateData[field] = onboardingData[field];
                }
            }

            const updateResult = await db.collection('courses').updateOne(
                { courseId: result.courseId, instructorId },
                { $set: updateData }
            );
            onboardingModifiedCount = updateResult.modifiedCount;

            if (Object.prototype.hasOwnProperty.call(req.body, 'learningOutcomes')) {
                await db.collection('courses').updateOne(
                    { courseId: result.courseId, 'lectures.name': 'Unit 1' },
                    {
                        $set: {
                            'lectures.$.learningObjectives': onboardingData.learningOutcomes,
                            'lectures.$.updatedAt': new Date()
                        }
                    }
                );
            }
        }

        const llmApiKey = buildKeySubdocument(apiKey, user.userId, selectedProvider);
        await db.collection('courses').updateOne(
            { courseId: result.courseId },
            { $set: { ...credentialSetFields(selectedProvider, llmApiKey), updatedAt: new Date() } }
        );
        const courseScope = { type: 'course', id: result.courseId };
        await scopeModelSettings.materialize(db, courseScope, { updatedBy: user.userId });
        if (Array.isArray(validation.models)) {
            await scopeModelSettings.applyCredentialRoster(
                db,
                courseScope,
                selectedProvider,
                validation.models,
                user.userId,
                validation.defaultConfiguration
            );
        }
        const scopedSettings = await scopeModelSettings.getAll(db, courseScope);

        if (req.app.locals.llmRegistry) {
            req.app.locals.llmRegistry.evictCourse(result.courseId);
        }
        
        console.log(`Course ${result.created ? 'created' : 'updated'} from onboarding for course ${courseId}`);
        
        res.json({
            success: true,
            message: `Course ${result.created ? 'created' : 'updated'} successfully from onboarding`,
            data: {
                courseId: result.courseId,
                created: result.created,
                modifiedCount: onboardingModifiedCount,
                totalUnits: result.totalUnits,
                llmKey: publicKeySummary(llmApiKey),
                llmProvider: selectedProvider,
                llmConfigurationStatus: scopedSettings.providers[selectedProvider].configurationStatus,
                aiAvailable: scopedSettings.providers[selectedProvider].configurationStatus === scopeModelSettings.READY,
                timestamp: new Date().toISOString()
            }
        });
        
    } catch (error) {
        console.error('Error saving onboarding data:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error while saving onboarding data'
        });
    }
});

// Static GET paths must be registered before /:courseId, otherwise Express
// matches them as courseId lookups and the real handlers never run.

/**
 * GET /api/onboarding/stats
 * Get onboarding statistics
 */
router.get('/stats', async (req, res) => {
    try {
        // Get database instance from app.locals
        const db = req.app.locals.db;
        if (!db) {
            return res.status(503).json({
                success: false,
                message: 'Database connection not available'
            });
        }

        // Get course statistics (since we're now using courses instead of onboarding)
        const collection = db.collection('courses');
        const totalCourses = await collection.countDocuments();
        const totalInstructors = await collection.distinct('instructorId');

        const stats = {
            totalCourses,
            totalInstructors: totalInstructors.length,
            lastUpdated: new Date().toISOString()
        };

        res.json({
            success: true,
            data: stats
        });

    } catch (error) {
        console.error('Error fetching course stats:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error while fetching course stats'
        });
    }
});

/**
 * GET /api/onboarding/:courseId
 * Get onboarding data for a specific course
 */
router.get('/:courseId', async (req, res) => {
    const { courseId } = req.params;
    const user = req.user;
    
    if (!courseId) {
        return res.status(400).json({
            success: false,
            message: 'Missing required parameter: courseId'
        });
    }
    
    try {
        // Get database instance from app.locals
        const db = req.app.locals.db;
        if (!db) {
            return res.status(503).json({
                success: false,
                message: 'Database connection not available'
            });
        }
        
        // Fetch course data
        const courseData = await CourseModel.getCourseWithOnboarding(db, courseId);
        
        if (!courseData) {
            return res.status(404).json({
                success: false,
                message: 'Course not found'
            });
        }

        if (!user || !hasInstructorOrTAAccess(courseData, user.userId)) {
            return res.status(403).json({
                success: false,
                message: 'You do not have access to this course'
            });
        }
        
        const data = stripPrivateKeyFields(courseData);
        // The code that joins a course as an instructor is for its
        // instructors only, not for its TAs.
        if (!hasInstructorAccess(courseData, user.userId)) {
            delete data.instructorCourseCode;
        }

        res.json({
            success: true,
            data
        });
        
    } catch (error) {
        console.error('Error fetching onboarding data:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error while fetching onboarding data'
        });
    }
});

/**
 * GET /api/onboarding/instructor/:instructorId
 * Get all onboarding data for an instructor
 */
router.get('/instructor/:instructorId', async (req, res) => {
    const { instructorId } = req.params;
    const user = req.user;
    
    if (!instructorId) {
        return res.status(400).json({
            success: false,
            message: 'Missing required parameter: instructorId'
        });
    }

    if (!user || user.role !== 'instructor' || user.userId !== instructorId) {
        return res.status(403).json({
            success: false,
            message: 'You do not have access to this instructor course list'
        });
    }
    
    try {
        // Get database instance from app.locals
        const db = req.app.locals.db;
        if (!db) {
            return res.status(503).json({
                success: false,
                message: 'Database connection not available'
            });
        }
        
        // Fetch courses for instructor (check both primary instructorId and instructors array)
        const collection = db.collection('courses');
        const courses = await collection.find({
            status: { $ne: 'deleted' },
            $or: [
                { instructorId: instructorId },
                { instructors: { $in: [instructorId] } }
            ]
        }).toArray();

        const sortedCourses = sortCoursesWithInactiveLast(courses).map(stripPrivateKeyFields);
        
        res.json({
            success: true,
            data: {
                courses: sortedCourses,
                count: sortedCourses.length
            }
        });
        
    } catch (error) {
        console.error('Error fetching instructor onboarding data:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error while fetching instructor onboarding data'
        });
    }
});

/**
 * PUT /api/onboarding/:courseId/unit-files
 * Update unit files for a specific unit
 */
router.put('/:courseId/unit-files', async (req, res) => {
    const { courseId } = req.params;
    const { unitName, files } = req.body;
    const user = req.user;
    
    if (!courseId || !unitName || !Array.isArray(files)) {
        return res.status(400).json({
            success: false,
            message: 'Missing required fields: courseId, unitName, files (array)'
        });
    }
    
    try {
        // Get database instance from app.locals
        const db = req.app.locals.db;
        if (!db) {
            return res.status(503).json({
                success: false,
                message: 'Database connection not available'
            });
        }

        const course = await CourseModel.getCourseById(db, courseId);
        if (!course) {
            return res.status(404).json({
                success: false,
                message: 'Course not found'
            });
        }

        if (!user || user.role !== 'instructor' || !hasInstructorAccess(course, user.userId)) {
            return res.status(403).json({
                success: false,
                message: 'Only instructors with course access can update unit files'
            });
        }

        const unitExists = Array.isArray(course.lectures) &&
            course.lectures.some(lecture => lecture.name === unitName);
        if (!unitExists) {
            return res.status(404).json({
                success: false,
                message: 'Unit not found'
            });
        }
        
        // Update unit files in the course
        const collection = db.collection('courses');
        const result = await collection.updateOne(
            { 
                courseId,
                'lectures.name': unitName 
            },
            {
                $set: {
                    [`lectures.$.unitFiles`]: files,
                    'lectures.$.updatedAt': new Date(),
                    updatedAt: new Date()
                }
            }
        );
        
        console.log(`Unit files updated for ${courseId} - ${unitName}`);
        
        res.json({
            success: true,
            message: `Unit files updated for ${unitName}`,
            data: {
                courseId,
                unitName,
                filesCount: files.length,
                modifiedCount: result.modifiedCount,
                timestamp: new Date().toISOString()
            }
        });
        
    } catch (error) {
        console.error('Error updating unit files:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error while updating unit files'
        });
    }
});

/**
 * PUT /api/onboarding/:courseId
 * Update specific onboarding fields
 */
router.put('/:courseId', async (req, res) => {
    const { courseId } = req.params;
    const updates = sanitizeOnboardingUpdates(req.body);
    const user = req.user;
    
    if (!courseId || Object.keys(updates).length === 0) {
        return res.status(400).json({
            success: false,
            message: 'No supported onboarding fields were provided'
        });
    }
    
    try {
        // Get database instance from app.locals
        const db = req.app.locals.db;
        if (!db) {
            return res.status(503).json({
                success: false,
                message: 'Database connection not available'
            });
        }

        const course = await CourseModel.getCourseById(db, courseId);
        if (!course) {
            return res.status(404).json({
                success: false,
                message: 'Course not found'
            });
        }

        if (!user || user.role !== 'instructor' || !hasInstructorAccess(course, user.userId)) {
            return res.status(403).json({
                success: false,
                message: 'Only instructors with course access can update onboarding fields'
            });
        }
        
        // Update course fields
        const collection = db.collection('courses');
        const result = await collection.updateOne(
            { courseId },
            {
                $set: {
                    ...updates,
                    updatedAt: new Date()
                }
            }
        );
        
        console.log(`Course fields updated for course ${courseId}`);
        
        res.json({
            success: true,
            message: 'Course fields updated successfully',
            data: {
                courseId,
                modifiedCount: result.modifiedCount,
                timestamp: new Date().toISOString()
            }
        });
        
    } catch (error) {
        console.error('Error updating onboarding fields:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error while updating onboarding fields'
        });
    }
});

/**
 * DELETE /api/onboarding/:courseId
 * Delete onboarding data for a course
 */
router.delete('/:courseId', async (req, res) => {
    const { courseId } = req.params;
    const user = req.user;
    
    if (!courseId) {
        return res.status(400).json({
            success: false,
            message: 'Missing required parameter: courseId'
        });
    }
    
    try {
        // Get database instance from app.locals
        const db = req.app.locals.db;
        if (!db) {
            return res.status(503).json({
                success: false,
                message: 'Database connection not available'
            });
        }

        const course = await CourseModel.getCourseById(db, courseId);
        if (!course) {
            return res.status(404).json({
                success: false,
                message: 'Course not found'
            });
        }

        if (!user || user.role !== 'instructor' || !hasInstructorAccess(course, user.userId)) {
            return res.status(403).json({
                success: false,
                message: 'Only instructors with course access can delete onboarding data'
            });
        }
        
        // Delete course data
        const collection = db.collection('courses');
        const result = await collection.deleteOne({ courseId });
        
        console.log(`Course deleted for course ${courseId}`);
        
        res.json({
            success: true,
            message: 'Course deleted successfully',
            data: {
                courseId,
                deletedCount: result.deletedCount,
                timestamp: new Date().toISOString()
            }
        });
        
    } catch (error) {
        console.error('Error deleting onboarding data:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error while deleting onboarding data'
        });
    }
});

/**
 * DELETE /api/onboarding/:courseId/unit/:unitName
 * Delete a unit from a course
 */
router.delete('/:courseId/unit/:unitName', async (req, res) => {
    const { courseId, unitName } = req.params;
    const user = req.user;
    
    if (!courseId || !unitName) {
        return res.status(400).json({
            success: false,
            message: 'Missing required parameters: courseId, unitName'
        });
    }
    
    try {
        // Get database instance from app.locals
        const db = req.app.locals.db;
        if (!db) {
            return res.status(503).json({
                success: false,
                message: 'Database connection not available'
            });
        }

        const course = await CourseModel.getCourseById(db, courseId);
        if (!course) {
            return res.status(404).json({
                success: false,
                message: 'Course not found'
            });
        }

        if (!user || user.role !== 'instructor' || !hasInstructorAccess(course, user.userId)) {
            return res.status(403).json({
                success: false,
                message: 'Only instructors with course access can delete units'
            });
        }

        if ((course.lectures || []).length <= 1) {
            return res.status(409).json({
                success: false,
                message: 'A course must have at least one unit'
            });
        }
        
        // Delete the unit
        const result = await CourseModel.deleteUnit(db, courseId, unitName);
        
        res.json({
            success: true,
            message: `Unit ${unitName} deleted successfully`,
            data: result
        });
        
    } catch (error) {
        console.error('Error deleting unit:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error while deleting unit'
        });
    }
});

/**
 * POST /api/onboarding/complete
 * Mark instructor's onboarding as complete
 */
router.post('/complete', async (req, res) => {
    try {
        const { courseId, instructorId } = req.body;
        
        // Get authenticated user information
        const user = req.user;
        if (!user) {
            return res.status(401).json({
                success: false,
                message: 'Authentication required'
            });
        }
        
        // Only instructors can mark onboarding as complete
        if (user.role !== 'instructor') {
            return res.status(403).json({
                success: false,
                message: 'Only instructors can mark onboarding as complete'
            });
        }
        
        // Validate required fields
        if (!courseId || !instructorId) {
            return res.status(400).json({
                success: false,
                message: 'Course ID and instructor ID are required'
            });
        }
        
        // Verify the instructor ID matches the authenticated user
        if (user.userId !== instructorId) {
            return res.status(403).json({
                success: false,
                message: 'Instructor ID does not match authenticated user'
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

        const course = await CourseModel.getCourseById(db, courseId);
        if (!course) {
            return res.status(404).json({
                success: false,
                message: 'Course not found'
            });
        }

        if (!hasInstructorAccess(course, user.userId)) {
            return res.status(403).json({
                success: false,
                message: 'You do not have access to this course'
            });
        }
        
        // Update the course to mark onboarding as complete
        const coursesCollection = db.collection('courses');
        const result = await coursesCollection.updateOne(
            { courseId: courseId },
            { 
                $set: { 
                    isOnboardingComplete: true,
                    lastModified: new Date()
                }
            }
        );
        console.log(`✅ [ONBOARDING] Marked onboarding as complete for course ${courseId} by instructor ${instructorId}`);
        
        res.json({
            success: true,
            message: 'Onboarding marked as complete',
            data: {
                courseId,
                instructorId,
                modifiedCount: result.modifiedCount
            }
        });
        
    } catch (error) {
        console.error('Error marking onboarding as complete:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error while marking onboarding as complete'
        });
    }
});

module.exports = router;
