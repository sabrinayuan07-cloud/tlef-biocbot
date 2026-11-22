/**
 * Preview Routes ("View as Student")
 *
 * Control plane for the student preview sandbox. These endpoints always act on
 * the *real* user (req.realUser when the calling tab is itself in preview),
 * never on the sandboxed student identity — otherwise a preview tab could not
 * turn its own preview off.
 *
 * - POST /api/preview/start     issue a grant for a course, return entry URL
 * - POST /api/preview/stop      revoke the grant and destroy the sandbox
 * - GET  /api/preview/state     grant + first-run status
 * - POST /api/preview/first-run mark first-run seen, or queue a replay
 * - POST /api/preview/reset     wipe all sandbox data for this course
 */

const express = require('express');
const router = express.Router();
const previewSession = require('../services/previewSession');
const PreviewState = require('../models/PreviewState');
const CourseModel = require('../models/Course');
const UserAgreement = require('../models/UserAgreement');

/**
 * Resolve the human behind the request, looking past any active preview swap.
 * @param {Object} req - Express request
 * @returns {Object|null} The real authenticated user
 */
function getRealUser(req) {
    return req.realUser || req.user || null;
}

/**
 * Confirm the user is allowed to preview the given course.
 *
 * Grants are pinned to a course, so this is the only place course access is
 * checked — every later preview request trusts the grant.
 *
 * @param {Object} db - MongoDB database instance
 * @param {Object} user - Real authenticated user
 * @param {string} courseId - Course to preview
 * @returns {Promise<{allowed: boolean, message?: string}>} Result
 */
async function canPreviewCourse(db, user, courseId) {
    if (!previewSession.canPreview(user)) {
        return { allowed: false, message: 'Only instructors, TAs, and system admins can preview a course.' };
    }

    const course = await CourseModel.getCourseById(db, courseId);
    if (!course) {
        return { allowed: false, message: 'Course not found' };
    }

    // System admins support every course, so course membership is not required.
    if (user.permissions && user.permissions.systemAdmin === true) {
        return { allowed: true };
    }

    // Same check the rest of the instructor surface uses, so a course they can
    // manage is always a course they can preview.
    const hasAccess = await CourseModel.userHasCourseAccess(db, courseId, user.userId, user.role);

    if (!hasAccess) {
        return { allowed: false, message: 'You do not have access to this course.' };
    }

    return { allowed: true };
}

/**
 * POST /api/preview/start
 * Issue a preview grant for a course and return the entry URL.
 * Body: { courseId: string, skipTutorial?: boolean, skipTermsAgreement?: boolean }
 */
router.post('/start', async (req, res) => {
    try {
        const db = req.app.locals.db;
        const user = getRealUser(req);
        const { courseId } = req.body || {};
        const skipTutorial = req.body && req.body.skipTutorial === true;
        const skipTermsAgreement = req.body && req.body.skipTermsAgreement === true;

        if (!user) {
            return res.status(401).json({ success: false, message: 'Not authenticated' });
        }

        if (!courseId) {
            return res.status(400).json({ success: false, message: 'courseId is required' });
        }

        const access = await canPreviewCourse(db, user, courseId);
        if (!access.allowed) {
            return res.status(403).json({ success: false, message: access.message });
        }

        const grant = previewSession.createGrant(user, courseId);

        // Opening a preview always opens a new one. Exiting already destroys the
        // sandbox, but nothing guarantees the previewer exited: closing the tab,
        // a browser crash, or a request still in flight when /stop ran can all
        // leave data behind. Clearing it here is what actually makes the promise
        // hold — no chat history from a previous visit is ever reachable.
        await PreviewState.destroySandbox(db, grant.previewUserId);

        await PreviewState.ensurePreviewUser(db, user, grant);
        const state = await PreviewState.ensureState(db, grant);

        // This only mutates the disposable preview student created above. The
        // instructor's preference must never advance onboarding for a real
        // student account.
        if (skipTutorial) {
            await PreviewState.setFirstRunCompleted(db, grant.previewUserId, true);
            await db.collection('users').updateOne(
                { userId: grant.previewUserId, isPreview: true },
                { $set: { studentOnboardingComplete: true, updatedAt: new Date() } }
            );
            state.firstRunCompleted = true;
        }

        if (skipTermsAgreement) {
            await UserAgreement.createOrUpdateUserAgreement(db, grant.previewUserId, 'student', {
                hasAgreed: true
            });
        }

        req.session.preview = grant;

        req.session.save(error => {
            if (error) {
                console.error('[PREVIEW] Failed to save grant:', error);
                return res.status(500).json({ success: false, message: 'Could not start preview' });
            }

            res.json({
                success: true,
                grant: {
                    courseId: grant.courseId,
                    previewUserId: grant.previewUserId,
                    startedAt: grant.startedAt
                },
                firstRunCompleted: state.firstRunCompleted,
                // The entry navigation carries the marker in the query string
                // because a top-level page load cannot set a header.
                entryUrl: `/student?preview=1&courseId=${encodeURIComponent(courseId)}`
            });
        });
    } catch (error) {
        console.error('[PREVIEW] start failed:', error);
        res.status(500).json({ success: false, message: 'Could not start preview' });
    }
});

/**
 * POST /api/preview/stop
 *
 * Revoke the grant and destroy the sandbox. Leaving the preview is a full
 * teardown, not a pause: the next "View as Student" must open on a genuinely
 * empty student account, with no chat history, quiz attempts, or flashcard
 * progress carried over from the previous visit.
 *
 * The grant is dropped even if the teardown fails, so a database problem can
 * never strand someone inside a preview they asked to leave.
 */
router.post('/stop', async (req, res) => {
    const grant = previewSession.getGrant(req);
    let deleted = null;

    try {
        const db = req.app.locals.db;
        const user = getRealUser(req);

        // Only tear down a sandbox belonging to the caller. The grant comes off
        // their own session so this should always hold, but the check is cheap
        // next to a delete that spans ten collections.
        if (db && user && grant && grant.previewUserId && grant.ownerUserId === user.userId) {
            deleted = await PreviewState.destroySandbox(db, grant.previewUserId);
        }
    } catch (error) {
        console.error('[PREVIEW] Could not destroy the sandbox on stop:', error);
    }

    try {
        if (!req.session) {
            return res.json({ success: true, deleted });
        }

        delete req.session.preview;

        req.session.save(error => {
            if (error) {
                console.error('[PREVIEW] Failed to clear grant:', error);
                return res.status(500).json({ success: false, message: 'Could not stop preview' });
            }
            res.json({ success: true, deleted });
        });
    } catch (error) {
        console.error('[PREVIEW] stop failed:', error);
        res.status(500).json({ success: false, message: 'Could not stop preview' });
    }
});

/**
 * GET /api/preview/state
 * Report whether a grant exists and how far through first-run the sandbox is.
 */
router.get('/state', async (req, res) => {
    try {
        const db = req.app.locals.db;
        const user = getRealUser(req);
        const grant = previewSession.getGrant(req);

        if (!user || !grant || grant.ownerUserId !== user.userId) {
            return res.json({ success: true, active: false });
        }

        // Runs once per preview page load and repairs a sandbox whose user
        // record is missing — a grant can outlive it (server restart mid-preview,
        // or a grant issued before this record existed), and without it the
        // student pages fail on lookups like struggle state.
        await PreviewState.ensurePreviewUser(db, user, grant);

        const state = await PreviewState.getState(db, grant.previewUserId);
        const course = await CourseModel.getCourseById(db, grant.courseId);

        res.json({
            success: true,
            active: true,
            courseId: grant.courseId,
            courseName: course ? (course.courseName || course.courseId) : grant.courseId,
            previewUserId: grant.previewUserId,
            startedAt: grant.startedAt,
            firstRunCompleted: state.firstRunCompleted
        });
    } catch (error) {
        console.error('[PREVIEW] state failed:', error);
        res.status(500).json({ success: false, message: 'Could not read preview state' });
    }
});

/**
 * POST /api/preview/first-run
 * Mark the student first-run flow as seen, or set it up to replay.
 * Body: { completed: boolean }
 */
router.post('/first-run', async (req, res) => {
    try {
        const db = req.app.locals.db;
        const user = getRealUser(req);
        const grant = previewSession.getGrant(req);

        if (!user || !grant || grant.ownerUserId !== user.userId) {
            return res.status(403).json({ success: false, message: 'No active preview session' });
        }

        const completed = req.body && req.body.completed === true;
        await PreviewState.setFirstRunCompleted(db, grant.previewUserId, completed);

        // The welcome flow — calibration plus the blurred guided tour — is gated
        // by studentOnboardingComplete being strictly false on the user record,
        // so replaying means putting that back rather than clearing a flag of
        // our own. The stored agreement is dropped too, since the modal is part
        // of what a new student sees.
        await db.collection('users').updateOne(
            { userId: grant.previewUserId, isPreview: true },
            { $set: { studentOnboardingComplete: !completed ? false : true, updatedAt: new Date() } }
        );

        if (!completed) {
            await db.collection('userAgreements').deleteMany({ userId: grant.previewUserId });
        }

        res.json({ success: true, firstRunCompleted: completed });
    } catch (error) {
        console.error('[PREVIEW] first-run update failed:', error);
        res.status(500).json({ success: false, message: 'Could not update first-run state' });
    }
});

/**
 * POST /api/preview/reset
 * Delete all sandbox data for this preview and start over.
 */
router.post('/reset', async (req, res) => {
    try {
        const db = req.app.locals.db;
        const user = getRealUser(req);
        const grant = previewSession.getGrant(req);

        if (!user || !grant || grant.ownerUserId !== user.userId) {
            return res.status(403).json({ success: false, message: 'No active preview session' });
        }

        const deleted = await PreviewState.resetPreviewData(db, grant.previewUserId);

        res.json({ success: true, deleted });
    } catch (error) {
        console.error('[PREVIEW] reset failed:', error);
        res.status(500).json({ success: false, message: 'Could not reset preview data' });
    }
});

module.exports = router;
