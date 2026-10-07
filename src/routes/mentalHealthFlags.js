/**
 * Mental Health Flags API Routes
 * Handles CRUD operations for AI-detected mental health concern flags.
 * Regular instructors see anonymized flags; system admins see student names.
 */

const express = require('express');
const router = express.Router();
const MentalHealthFlag = require('../models/MentalHealthFlag');
const { hasSystemAdminAccess } = require('../services/authorization');
const { hasPermission } = require('../services/permissions');

/**
 * Check if the current user is a system admin
 */
function isAdmin(user) {
    return hasSystemAdminAccess(user);
}

/**
 * Strip student identity from flags for non-admin users
 */
function anonymizeFlags(flags) {
    return flags.map(flag => ({
        ...flag,
        studentId: undefined,
        studentName: 'Anonymous Student'
    }));
}

async function requireCourseStaff(req, res, db, courseId) {
    const user = req.user;
    if (!user) {
        res.status(401).json({ success: false, message: 'Authentication required' });
        return false;
    }
    // Gated on 'transcripts', not 'materials'/'courses' - this is raw
    // flagged-conversation content (anonymizeFlags only strips identity
    // fields, not conversationContext), so a TA with document/question
    // access shouldn't automatically get it too.
    if (await hasPermission(db, user, courseId, 'transcripts')) return true;
    res.status(403).json({ success: false, message: 'Access denied' });
    return false;
}

async function requireFlagStaff(req, res, db, flagId) {
    const flag = await db.collection('mentalHealthFlags').findOne({ flagId });
    if (!flag) {
        res.status(404).json({ success: false, message: 'Flag not found' });
        return false;
    }
    return requireCourseStaff(req, res, db, flag.courseId);
}

/**
 * GET /api/mental-health-flags/course/:courseId
 * Get mental health flags for a course.
 * Non-admins see anonymized data. Admins see full data including student names.
 */
router.get('/course/:courseId', async (req, res) => {
    try {
        const db = req.app.locals.db;
        if (!db) {
            return res.status(503).json({ success: false, message: 'Database connection not available' });
        }

        const { courseId } = req.params;
        const status = req.query.status || null;

        if (!(await requireCourseStaff(req, res, db, courseId))) return;

        let flags = await MentalHealthFlag.getMentalHealthFlagsForCourse(db, courseId, status);

        // Anonymize for non-admin users
        const userIsAdmin = isAdmin(req.user);
        if (!userIsAdmin) {
            flags = anonymizeFlags(flags);
        }

        const stats = await MentalHealthFlag.getMentalHealthFlagStats(db, courseId);

        res.json({
            success: true,
            flags,
            stats,
            isAdmin: userIsAdmin
        });
    } catch (error) {
        console.error('Error fetching mental health flags:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch mental health flags' });
    }
});

/**
 * PUT /api/mental-health-flags/:flagId/escalate
 * Instructor escalates a flag (makes it visible with student name to admins)
 */
router.put('/:flagId/escalate', async (req, res) => {
    try {
        const db = req.app.locals.db;
        if (!db) {
            return res.status(503).json({ success: false, message: 'Database connection not available' });
        }

        const { flagId } = req.params;
        const userId = req.user?.userId;

        if (!(await requireFlagStaff(req, res, db, flagId))) return;

        const result = await MentalHealthFlag.updateFlagStatus(db, flagId, 'escalated', userId);
        res.status(result.success ? 200 : 404).json(result);
    } catch (error) {
        console.error('Error escalating mental health flag:', error);
        res.status(500).json({ success: false, message: 'Failed to escalate flag' });
    }
});

/**
 * PUT /api/mental-health-flags/:flagId/dismiss
 * Instructor dismisses a flag (false positive)
 */
router.put('/:flagId/dismiss', async (req, res) => {
    try {
        const db = req.app.locals.db;
        if (!db) {
            return res.status(503).json({ success: false, message: 'Database connection not available' });
        }

        const { flagId } = req.params;
        const userId = req.user?.userId;

        if (!(await requireFlagStaff(req, res, db, flagId))) return;

        const result = await MentalHealthFlag.updateFlagStatus(db, flagId, 'dismissed', userId);
        res.status(result.success ? 200 : 404).json(result);
    } catch (error) {
        console.error('Error dismissing mental health flag:', error);
        res.status(500).json({ success: false, message: 'Failed to dismiss flag' });
    }
});

/**
 * PUT /api/mental-health-flags/:flagId/resolve
 * Admin resolves an escalated flag. Requires system admin access.
 */
router.put('/:flagId/resolve', async (req, res) => {
    try {
        const db = req.app.locals.db;
        if (!db) {
            return res.status(503).json({ success: false, message: 'Database connection not available' });
        }

        if (!isAdmin(req.user)) {
            return res.status(403).json({ success: false, message: 'Access denied' });
        }

        const { flagId } = req.params;
        const userId = req.user?.userId;

        const result = await MentalHealthFlag.updateFlagStatus(db, flagId, 'resolved', userId);
        res.status(result.success ? 200 : 404).json(result);
    } catch (error) {
        console.error('Error resolving mental health flag:', error);
        res.status(500).json({ success: false, message: 'Failed to resolve flag' });
    }
});

/**
 * PUT /api/mental-health-flags/:flagId/disregard
 * Admin disregards an escalated flag. Requires system admin access.
 */
router.put('/:flagId/disregard', async (req, res) => {
    try {
        const db = req.app.locals.db;
        if (!db) {
            return res.status(503).json({ success: false, message: 'Database connection not available' });
        }

        if (!isAdmin(req.user)) {
            return res.status(403).json({ success: false, message: 'Access denied' });
        }

        const { flagId } = req.params;
        const userId = req.user?.userId;

        const result = await MentalHealthFlag.updateFlagStatus(db, flagId, 'disregarded', userId);
        res.status(result.success ? 200 : 404).json(result);
    } catch (error) {
        console.error('Error disregarding mental health flag:', error);
        res.status(500).json({ success: false, message: 'Failed to disregard flag' });
    }
});

module.exports = router;
