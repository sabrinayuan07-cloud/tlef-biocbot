const express = require('express');
const router = express.Router();

// Import the Course model
const CourseModel = require('../models/Course');
const { hasPermission } = require('../services/permissions');

// Middleware for JSON parsing
router.use(express.json());

/**
 * POST /api/learning-objectives
 * Save learning objectives for a specific lecture/unit
 */
router.post('/', async (req, res) => {
    const { week, lectureName, objectives, courseId } = req.body;
    
    // Use either week or lectureName (for backward compatibility)
    const unitName = lectureName || week;
    
    // Validate required fields
    if (!unitName || !objectives || !Array.isArray(objectives) || !courseId) {
        return res.status(400).json({
            success: false,
            message: 'Missing required fields: unitName/lectureName, objectives (array), courseId'
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

        const user = req.user;
        if (!user) {
            return res.status(401).json({ success: false, message: 'Authentication required' });
        }

        const course = await CourseModel.getCourseById(db, courseId);
        if (!course) {
            return res.status(404).json({ success: false, message: 'Course not found' });
        }

        if (!await hasPermission(db, user, courseId, 'materials')) {
            return res.status(403).json({ success: false, message: 'No access to modify this course' });
        }
        
        // Update the learning objectives in MongoDB
        const result = await CourseModel.updateLearningObjectives(
            db, 
            courseId, 
            unitName, 
            objectives, 
            user.userId
        );

        if (!result.success) {
            const status = /not found/i.test(result.error || '') ? 404 : 400;
            return res.status(status).json({
                success: false,
                message: result.error || 'Failed to update learning objectives'
            });
        }
        
        console.log(`Learning objectives saved for ${unitName} by ${user.userId}`);
        
        res.json({
            success: true,
            message: `Learning objectives for ${unitName} saved successfully!`,
            data: {
                unitName,
                objectives,
                courseId,
                updatedAt: new Date().toISOString(),
                instructorId: user.userId
            }
        });
        
    } catch (error) {
        console.error('Error saving learning objectives:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error while saving learning objectives'
        });
    }
});

/**
 * GET /api/learning-objectives
 * Get learning objectives for a specific lecture/unit
 */
router.get('/', async (req, res) => {
    const { week, lectureName, courseId } = req.query;
    
    // Use either week or lectureName (for backward compatibility)
    const unitName = lectureName || week;
    
    if (!unitName || !courseId) {
        return res.status(400).json({
            success: false,
            message: 'Missing required parameters: unitName/lectureName, courseId'
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
        
        // Fetch learning objectives from MongoDB
        const learningObjectives = await CourseModel.getLearningObjectives(db, courseId, unitName);
        
        res.json({
            success: true,
            data: {
                unitName,
                courseId,
                objectives: learningObjectives,
                lastUpdated: new Date().toISOString()
            }
        });
        
    } catch (error) {
        console.error('Error fetching learning objectives:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error while fetching learning objectives'
        });
    }
});

module.exports = router;
