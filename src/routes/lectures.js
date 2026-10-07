const express = require('express');
const router = express.Router();

// Import the Course model
const CourseModel = require('../models/Course');
const {
    publicProviderKeyState,
    structuredKeyErrorForProvider
} = require('../services/llmKeyStore');
const { hasPermission } = require('../services/permissions');

// Middleware for JSON parsing
router.use(express.json());

/**
 * POST /api/lectures/publish
 * Update the publish status of a lecture/week
 */
router.post('/publish', async (req, res) => {
    const { lectureName, isPublished, courseId } = req.body;
    
    // Validate required fields
    if (!lectureName || typeof isPublished !== 'boolean' || !courseId) {
        return res.status(400).json({
            success: false,
            message: 'Missing required fields: lectureName, isPublished, courseId'
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
        
        // Authorize: instructors and TAs with course access can toggle publish
        const user = req.user;
        if (!user) {
            return res.status(401).json({ success: false, message: 'Authentication required' });
        }
        const hasAccess = await hasPermission(db, user, courseId, 'materials');
        if (!hasAccess) {
            return res.status(403).json({ success: false, message: 'No access to this course' });
        }

        if (isPublished) {
            const course = await CourseModel.getCourseById(db, courseId);
            const providerState = publicProviderKeyState(course);
            if (providerState.aiPreparationRequired) {
                return res.status(409).json({
                    success: false,
                    code: 'LLM_PROVIDER_PREPARING',
                    provider: providerState.llmProvider,
                    message: `${providerState.llmProviderLabel} course material is still being prepared. `
                        + 'Wait for preparation to finish before publishing content to students.'
                });
            }
            if (!providerState.aiAvailable) {
                const keyStatus = providerState.llmKey?.status || 'missing';
                return res.status(400).json({
                    ...structuredKeyErrorForProvider(keyStatus, providerState.llmProvider),
                    message: `Add a valid course ${providerState.llmProviderLabel} API key before publishing content to students.`
                });
            }
        }

        // Update the publish status in MongoDB (track who updated without overwriting instructorId)
        const result = await CourseModel.updateLecturePublishStatus(
            db,
            courseId,
            lectureName,
            isPublished,
            user.userId
        );

        if (!result.success) {
            const status = /not found/i.test(result.error || '') ? 404 : 400;
            return res.status(status).json({
                success: false,
                message: result.error || 'Failed to update publish status'
            });
        }
        
        console.log(`Publish status updated for ${lectureName} by ${user.userId}: ${isPublished}`);
        
        res.json({
            success: true,
            message: `${lectureName} ${isPublished ? 'published' : 'unpublished'} successfully`,
            data: {
                lectureName,
                isPublished,
                courseId,
                updatedAt: new Date().toISOString(),
                lastUpdatedById: user.userId,
                created: result.created
            }
        });
        
    } catch (error) {
        console.error('Error updating publish status:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error while updating publish status'
        });
    }
});

/**
 * GET /api/lectures/publish-status
 * Get the publish status of all lectures for an instructor
 */
router.get('/publish-status', async (req, res) => {
    const { instructorId, courseId } = req.query;

    if (!instructorId || !courseId) {
        return res.status(400).json({
            success: false,
            message: 'Missing required parameters: instructorId, courseId'
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

        // Authorize from the session, not the body — the instructorId query
        // param is informational only. Mirrors POST /publish above.
        const user = req.user;
        if (!user) {
            return res.status(401).json({ success: false, message: 'Authentication required' });
        }

        // Distinguish "course doesn't exist" (return empty map — matches the
        // legacy contract that course-model-branch-coverage relies on) from
        // "course exists but caller has no access" (403). Without this split,
        // an instructor querying a nonexistent course id would get a
        // misleading 403.
        const course = await CourseModel.getCourseById(db, courseId);
        if (!course) {
            return res.json({
                success: true,
                data: {
                    instructorId,
                    courseId,
                    publishStatus: {},
                    lastUpdated: new Date().toISOString()
                }
            });
        }

        // The map names every unit including the unpublished ones, so it stays
        // on the staff side of the fence.
        const hasAccess = await hasPermission(db, user, courseId, 'materials');
        if (!hasAccess) {
            return res.status(403).json({ success: false, message: 'No access to this course' });
        }

        // Fetch publish status from MongoDB
        const publishStatus = await CourseModel.getLecturePublishStatus(db, courseId);

        res.json({
            success: true,
            data: {
                instructorId,
                courseId,
                publishStatus,
                lastUpdated: new Date().toISOString()
            }
        });
        
    } catch (error) {
        console.error('Error fetching publish status:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error while fetching publish status'
        });
    }
});

/**
 * GET /api/lectures/student-visible
 * Get all published lectures for student access
 */
router.get('/student-visible', async (req, res) => {
    const { courseId } = req.query;
    
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
        
        // Fetch published lectures from MongoDB
        const publishedLectures = await CourseModel.getPublishedLectures(db, courseId);
        
        res.json({
            success: true,
            data: {
                courseId,
                publishedLectures,
                count: publishedLectures.length,
                lastUpdated: new Date().toISOString()
            }
        });
        
    } catch (error) {
        console.error('Error fetching published lectures:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error while fetching published lectures'
        });
    }
});

/**
 * POST /api/lectures/pass-threshold
 * Update the pass threshold for a specific lecture
 */
router.post('/pass-threshold', async (req, res) => {
    const { courseId, lectureName, passThreshold } = req.body;
    
    // Validate required fields
    if (!courseId || !lectureName || typeof passThreshold !== 'number') {
        return res.status(400).json({
            success: false,
            message: 'Missing required fields: courseId, lectureName, passThreshold (number)'
        });
    }
    
    // Validate threshold value
    if (passThreshold < 0 || passThreshold > 100) {
        return res.status(400).json({
            success: false,
            message: 'Pass threshold must be between 0 and 100'
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

        // Authorize and attribute the update from the session, never from a
        // caller-supplied instructorId. Otherwise an authorized staff member
        // could forge another user's id in the course audit metadata.
        const user = req.user;
        if (!user) {
            return res.status(401).json({ success: false, message: 'Authentication required' });
        }

        const hasAccess = await hasPermission(db, user, courseId, 'materials');
        if (!hasAccess) {
            return res.status(403).json({ success: false, message: 'No access to this course' });
        }

        // Update the pass threshold in MongoDB
        const result = await CourseModel.updatePassThreshold(
            db, 
            courseId, 
            lectureName, 
            passThreshold, 
            user.userId
        );

        if (!result.success) {
            const status = /not found|no longer exists/i.test(result.error || '') ? 404 : 400;
            return res.status(status).json({
                success: false,
                message: result.error || 'Failed to update pass threshold'
            });
        }
        
        console.log(`Pass threshold updated for ${lectureName}: ${passThreshold}`);
        
        res.json({
            success: true,
            message: `Pass threshold updated to ${passThreshold}`,
            data: {
                courseId,
                lectureName,
                passThreshold,
                updatedAt: new Date().toISOString(),
                instructorId: user.userId
            }
        });
        
    } catch (error) {
        console.error('Error updating pass threshold:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error while updating pass threshold'
        });
    }
});

/**
 * GET /api/lectures/pass-threshold
 * Get the pass threshold for a specific lecture
 */
router.get('/pass-threshold', async (req, res) => {
    const { courseId, lectureName } = req.query;
    
    if (!courseId || !lectureName) {
        return res.status(400).json({
            success: false,
            message: 'Missing required parameters: courseId, lectureName'
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
        
        // Staff-only, like the POST above. Students receive the threshold for
        // published units through /published-with-questions, which is scoped to
        // what they are allowed to see.
        const user = req.user;
        if (!user) {
            return res.status(401).json({ success: false, message: 'Authentication required' });
        }

        const hasAccess = await hasPermission(db, user, courseId, 'materials');
        if (!hasAccess) {
            return res.status(403).json({ success: false, message: 'No access to this course' });
        }

        // Fetch pass threshold from MongoDB
        const passThreshold = await CourseModel.getPassThreshold(db, courseId, lectureName);

        res.json({
            success: true,
            data: {
                courseId,
                lectureName,
                passThreshold,
                lastUpdated: new Date().toISOString()
            }
        });
        
    } catch (error) {
        console.error('Error fetching pass threshold:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error while fetching pass threshold'
        });
    }
});

/**
 * GET /api/lectures/published-with-questions
 * Get published lectures with their assessment questions for students
 */
router.get('/published-with-questions', async (req, res) => {
    const { courseId } = req.query;
    
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
        
        // Get the courses collection
        const collection = db.collection('courses');
        
        // Find the course and get only published lectures with their questions
        const course = await collection.findOne(
            { courseId },
            { projection: { lectures: 1, courseName: 1 } }
        );
        
        if (!course || !course.lectures) {
            return res.json({
                success: true,
                data: {
                    courseId,
                    courseName: course?.courseName || 'Unknown Course',
                    publishedLectures: [],
                    count: 0
                }
            });
        }
        
        // Filter for published lectures and include assessment questions
        const publishedLectures = course.lectures
            .filter(lecture => lecture.isPublished === true)
            .map(lecture => ({
                name: lecture.name,
                isPublished: lecture.isPublished,
                learningObjectives: lecture.learningObjectives || [],
                passThreshold: lecture.passThreshold !== undefined && lecture.passThreshold !== null ? lecture.passThreshold : 0,
                assessmentQuestions: lecture.assessmentQuestions || [],
                documents: lecture.documents || [],
                createdAt: lecture.createdAt,
                updatedAt: lecture.updatedAt
            }));
        
        console.log(`Found ${publishedLectures.length} published lectures for course ${courseId}`);
        
        res.json({
            success: true,
            data: {
                courseId,
                courseName: course.courseName,
                publishedLectures,
                count: publishedLectures.length,
                lastUpdated: new Date().toISOString()
            }
        });
        
    } catch (error) {
        console.error('Error fetching published lectures with questions:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error while fetching published lectures'
        });
    }
});

module.exports = router;
