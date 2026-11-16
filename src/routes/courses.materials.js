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

module.exports = router;
