/**
 * Courses API Routes — LLM provider/key management
 */

const express = require('express');
const router = express.Router();
const CourseModel = require('../models/Course');
const { hasSystemAdminAccess } = require('../services/authorization');
const providerKeys = require('../services/providerKeyService');
const { normalizeProvider, providerCatalog } = require('../services/llmProviders');
const { hasInstructorAccess } = require('./courses.shared');

async function requireCourseKeyAccess(req, res, db, courseId) {
    const user = req.user;
    if (!user) {
        res.status(401).json({ success: false, message: 'Authentication required' });
        return null;
    }

    const course = await CourseModel.getCourseById(db, courseId);
    if (!course) {
        res.status(404).json({ success: false, message: 'Course not found' });
        return null;
    }

    if (hasSystemAdminAccess(user) || hasInstructorAccess(course, user.userId)) {
        return course;
    }

    res.status(403).json({ success: false, message: 'Only course instructors or system admins can manage this API key' });
    return null;
}

/**
 * GET /api/courses/:courseId/llm-key
 * Platform selection, key status per platform, and any in-flight migration.
 * Never returns key material.
 */
router.get('/:courseId/llm-key', async (req, res) => {
    try {
        const db = req.app.locals.db;
        if (!db) {
            return res.status(503).json({ success: false, message: 'Database connection not available' });
        }

        const course = await requireCourseKeyAccess(req, res, db, req.params.courseId);
        if (!course) return;

        const state = await providerKeys.surfaceKeyState(db, { type: 'course', id: course.courseId });
        res.json({ success: true, providers: providerCatalog(), ...state });
    } catch (error) {
        console.error('Error fetching course API key status:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch course API key status' });
    }
});

router.put('/:courseId/llm-key', async (req, res) => {
    try {
        const db = req.app.locals.db;
        if (!db) {
            return res.status(503).json({ success: false, message: 'Database connection not available' });
        }

        const course = await requireCourseKeyAccess(req, res, db, req.params.courseId);
        if (!course) return;

        const result = await providerKeys.saveSurfaceKey(db, {
            scope: { type: 'course', id: course.courseId },
            provider: normalizeProvider(req.body && req.body.llmProvider),
            apiKey: req.body && req.body.apiKey,
            updatedBy: req.user.userId,
            registry: req.app.locals.llmRegistry
        });

        if (result.ok && result.httpStatus === 200) {
            result.body.message = 'Course API key saved';
        }

        res.status(result.httpStatus).json(result.body);
    } catch (error) {
        console.error('Error saving course API key:', error);
        res.status(500).json({ success: false, message: 'Failed to save course API key' });
    }
});

/**
 * POST /api/courses/:courseId/llm-provider
 * Switch back to a platform whose key is already stored, without re-entering it.
 */
router.post('/:courseId/llm-provider', async (req, res) => {
    try {
        const db = req.app.locals.db;
        if (!db) {
            return res.status(503).json({ success: false, message: 'Database connection not available' });
        }

        const course = await requireCourseKeyAccess(req, res, db, req.params.courseId);
        if (!course) return;

        const result = await providerKeys.switchToStoredProvider(db, {
            scope: { type: 'course', id: course.courseId },
            provider: normalizeProvider(req.body && req.body.llmProvider),
            requestedBy: req.user.userId,
            registry: req.app.locals.llmRegistry
        });

        res.status(result.httpStatus).json(result.body);
    } catch (error) {
        console.error('Error switching course platform:', error);
        res.status(500).json({ success: false, message: 'Failed to switch platform' });
    }
});

/** POST /api/courses/:courseId/llm-provider/prepare */
router.post('/:courseId/llm-provider/prepare', async (req, res) => {
    try {
        const db = req.app.locals.db;
        if (!db) return res.status(503).json({ success: false, message: 'Database connection not available' });
        const course = await requireCourseKeyAccess(req, res, db, req.params.courseId);
        if (!course) return;

        const result = await providerKeys.prepareStoredProvider(db, {
            scope: { type: 'course', id: course.courseId },
            provider: normalizeProvider(req.body && req.body.llmProvider),
            requestedBy: req.user.userId,
            registry: req.app.locals.llmRegistry
        });
        res.status(result.httpStatus).json(result.body);
    } catch (error) {
        console.error('Error preparing course material:', error);
        res.status(500).json({ success: false, message: 'Failed to prepare course material' });
    }
});

router.post('/:courseId/llm-key/test', async (req, res) => {
    try {
        const db = req.app.locals.db;
        if (!db) {
            return res.status(503).json({ success: false, message: 'Database connection not available' });
        }

        const course = await requireCourseKeyAccess(req, res, db, req.params.courseId);
        if (!course) return;

        const result = await providerKeys.testSurfaceKey(db, {
            scope: { type: 'course', id: course.courseId },
            provider: req.body && req.body.llmProvider,
            registry: req.app.locals.llmRegistry
        });

        if (result.body.code === 'LLM_KEY_MISSING') {
            result.body.message = 'No API key is saved for this course.';
        } else if (result.ok) {
            result.body.message = 'Course API key is valid';
        }

        res.status(result.httpStatus).json(result.body);
    } catch (error) {
        console.error('Error testing course API key:', error);
        res.status(500).json({ success: false, message: 'Failed to test course API key' });
    }
});

module.exports = router;
