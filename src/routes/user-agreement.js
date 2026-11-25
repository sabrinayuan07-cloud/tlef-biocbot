const express = require('express');
const router = express.Router();
const { getUserAgreement, createOrUpdateUserAgreement } = require('../models/UserAgreement');
const activityEvents = require('../services/activityEvents');

/**
 * GET /api/user-agreement/status
 * Check if user has agreed to terms
 */
router.get('/status', async (req, res) => {
    try {
        if (!req.user) {
            return res.status(401).json({ success: false, message: 'Authentication required' });
        }
        const { userId, role } = req.user;
        const db = req.app.locals.db;
        
        if (!db) {
            console.error('❌ [AGREEMENT] Database not available in req.app.locals');
            return res.status(503).json({
                success: false,
                message: 'Database connection not available'
            });
        }
        
        const agreement = await getUserAgreement(db, userId, role);
        
        res.json({
            success: true,
            data: {
                hasAgreed: agreement.hasAgreed,
                agreementVersion: agreement.agreementVersion,
                agreedAt: agreement.agreedAt
            }
        });
    } catch (error) {
        console.error('Error checking user agreement status:', error);
        console.error('Error stack:', error.stack);
        res.status(500).json({
            success: false,
            message: 'Failed to check agreement status',
            error: error.message
        });
    }
});

/**
 * POST /api/user-agreement/agree
 * Record user agreement to terms
 */
router.post('/agree', async (req, res) => {
    try {
        if (!req.user) {
            return res.status(401).json({ success: false, message: 'Authentication required' });
        }
        const { userId, role } = req.user;
        const { agreementVersion = '1.0' } = req.body || {};
        const db = req.app.locals.db;

        if (!db) {
            return res.status(503).json({
                success: false,
                message: 'Database connection not available'
            });
        }

        // Get client IP and user agent
        const ipAddress = req.ip || req.connection.remoteAddress;
        const userAgent = req.get('User-Agent');

        // Whether this version was already accepted, so a repeat isn't announced.
        const before = await getUserAgreement(db, userId, role);
        const alreadyAccepted = !!(before && before.hasAgreed && before.agreementVersion === agreementVersion);

        // Create or update agreement record
        const agreement = await createOrUpdateUserAgreement(db, userId, role, {
            hasAgreed: true,
            agreementVersion: agreementVersion,
            ipAddress: ipAddress,
            userAgent: userAgent
        });

        if (!alreadyAccepted && agreement && agreement.hasAgreed) {
            activityEvents.publishAgreementAccepted(req.user, agreement.agreementVersion);
        }

        res.json({
            success: true,
            message: 'Agreement recorded successfully',
            data: {
                hasAgreed: agreement.hasAgreed,
                agreementVersion: agreement.agreementVersion,
                agreedAt: agreement.agreedAt
            }
        });
    } catch (error) {
        console.error('Error recording user agreement:', error);
        console.error('Error stack:', error.stack);
        res.status(500).json({
            success: false,
            message: 'Failed to record agreement',
            error: error.message
        });
    }
});

module.exports = router;
