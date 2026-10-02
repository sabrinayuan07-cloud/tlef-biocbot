/**
 * Courses API Routes — document removal and course-materials confirmation
 */

const express = require('express');
const router = express.Router();
const CourseModel = require('../models/Course');

/**
 * POST /api/courses/:courseId/remove-document
 * Remove a specific document from the course structure
 */
router.post('/:courseId/remove-document', async (req, res) => {
    try {
        const { courseId } = req.params;
        const { documentId, instructorId } = req.body;
        
        if (!documentId || !instructorId) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields: documentId, instructorId'
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
        
        // Check if instructor has access to the course
        const hasAccess = await CourseModel.userHasCourseAccess(db, courseId, instructorId, 'instructor');
        if (!hasAccess) {
            return res.status(403).json({
                success: false,
                message: 'You do not have permission to remove documents from this course'
            });
        }
        
        // Remove document from any unit in the course using Course model
        const result = await CourseModel.removeDocumentFromAnyUnit(db, courseId, documentId, instructorId);
        
        if (!result.success) {
            return res.status(404).json({
                success: false,
                message: result.error || 'Document not found in course structure'
            });
        }
        
        console.log(`Document ${documentId} removed from course ${courseId} structure`);
        
        res.json({
            success: true,
            message: 'Document removed from course structure successfully!',
            data: {
                documentId,
                courseId,
                removedCount: result.removedCount
            }
        });
        
    } catch (error) {
        console.error('Error removing document from course:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error while removing document from course'
        });
    }
});

/**
 * POST /api/courses/course-materials/confirm
 * Confirm course materials for a specific unit/week
 * This marks the unit as having all required materials confirmed
 */
router.post('/course-materials/confirm', async (req, res) => {
    console.log('🔧 [BACKEND] Course materials confirm endpoint hit!');
    console.log('🔧 [BACKEND] Request body:', req.body);
    
    try {
        const { week, instructorId } = req.body;
        
        console.log('🔧 [BACKEND] Extracted data:', { week, instructorId });
        
        // Validate required fields
        if (!week || !instructorId) {
            console.log('❌ [BACKEND] Missing required fields');
            return res.status(400).json({
                success: false,
                message: 'Missing required fields: week, instructorId'
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
        
        // Get the courses collection
        const coursesCollection = db.collection('courses');
        
        // Find the course that contains this unit/week
        const course = await coursesCollection.findOne({
            instructorId: instructorId,
            'lectures.name': week
        });
        
        if (!course) {
            return res.status(404).json({
                success: false,
                message: `Course not found for instructor ${instructorId} with unit ${week}`
            });
        }
        
        // Update the unit to mark materials as confirmed
        const result = await coursesCollection.updateOne(
            { 
                courseId: course.courseId,
                'lectures.name': week 
            },
            { 
                $set: { 
                    'lectures.$.materialsConfirmed': true,
                    'lectures.$.materialsConfirmedAt': new Date(),
                    'lectures.$.updatedAt': new Date(),
                    updatedAt: new Date()
                }
            }
        );
        
        if (result.modifiedCount === 0) {
            return res.status(404).json({
                success: false,
                message: `Unit ${week} not found in course ${course.courseId}`
            });
        }
        
        console.log(`Course materials confirmed for unit ${week} in course ${course.courseId}`);
        
        res.json({
            success: true,
            message: `Course materials for ${week} confirmed successfully!`,
            data: {
                week,
                courseId: course.courseId,
                materialsConfirmed: true,
                confirmedAt: new Date().toISOString()
            }
        });
        
    } catch (error) {
        console.error('Error confirming course materials:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error while confirming course materials'
        });
    }
});

module.exports = router;
