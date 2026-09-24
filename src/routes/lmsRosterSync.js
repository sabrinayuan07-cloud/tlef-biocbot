const crypto = require('crypto');
const express = require('express');

const { getGradeSource } = require('../services/lmsGradeImport');
const { confirmLeftCanvasCourse, syncCourseRoster } = require('../services/lmsRosterMatch');
const {
    requireManagedCourseMiddleware,
    requireSelectedProviderAuth
} = require('./lmsGrades');
const { lmsErrorResponse } = require('../services/lmsErrors');

const DEFAULT_PRUNE_MIN_INTEGRATION_COVERAGE = 0.8;

function pruneCoverageThreshold(env = process.env) {
    const configured = Number(env.LMS_ROSTER_PRUNE_MIN_INTEGRATION_COVERAGE);
    return Number.isFinite(configured) && configured >= 0 && configured <= 1
        ? configured
        : DEFAULT_PRUNE_MIN_INTEGRATION_COVERAGE;
}

function effectiveRosterSource(course = {}) {
    if (course.rosterSource) return course.rosterSource;
    // Legacy academic-linked courses predate rosterSource. Treating them as
    // manual would let Canvas claim them before the migration field is written.
    if (Array.isArray(course.academicSync?.sectionIds) && course.academicSync.sectionIds.length) {
        return 'academicSync';
    }
    return 'manual';
}

function buildPruneSafety(coverage = {}, provider = 'canvas', env = process.env) {
    const total = Number(coverage.total) || 0;
    const integrationId = Number(coverage.integrationId) || 0;
    const integrationIdRatio = total ? integrationId / total : 0;
    const threshold = pruneCoverageThreshold(env);
    const allowed = provider === 'canvas' && total > 0 && integrationIdRatio >= threshold;

    return {
        allowed,
        threshold,
        integrationIdRatio,
        reason: allowed
            ? null
            : (total === 0
                ? 'empty-roster'
                : (provider !== 'canvas' ? 'provider-not-supported' : 'insufficient-integration-id-coverage'))
    };
}

async function claimCanvasRosterOwnership(db, course) {
    const result = await db.collection('courses').updateOne(
        { courseId: course.courseId },
        { $set: { rosterSource: 'canvas', updatedAt: new Date() } }
    );
    return result.matchedCount > 0;
}

/**
 * Whether a BiocBot student might have left the linked Canvas course, judged
 * from this sync alone. Only students this Canvas course put on the roster
 * qualify — never someone who joined with a course code, came from Academic
 * Sync, or was never matched — and only when their Canvas user id is gone
 * from the roster the sync read. That read is filtered to the reader's
 * sections, so a student who passes still has to be confirmed with Canvas
 * (confirmLeftCanvasCourse) before being offered for soft-drop.
 */
function isDropCandidate(enrollment, { externalCourseId, rosterExternalUserIds }) {
    if (!enrollment || enrollment.source !== 'canvas' || enrollment.enrolled === false) return false;
    if (String(enrollment.externalCourseId || '') !== String(externalCourseId)) return false;
    return Boolean(enrollment.externalUserId) && !rosterExternalUserIds.has(String(enrollment.externalUserId));
}

async function persistCanvasSync({ db, course, externalCourseId, report, confirmLeft = async () => new Set(), syncedBy }) {
    const mappings = await db.collection('lms_identity_mappings').find({
        courseId: course.courseId,
        provider: 'canvas',
        externalCourseId: String(externalCourseId)
    }).toArray();
    const freshCourse = await db.collection('courses').findOne({ courseId: course.courseId });
    const existingEnrollment = freshCourse?.studentEnrollment || {};
    const now = new Date();
    const syncToken = crypto.randomUUID();
    const prune = buildPruneSafety(report.coverage, 'canvas');
    // Anyone the roster read returned is still on the course, whether or not
    // BiocBot could match them.
    const rosterExternalUserIds = new Set([
        ...mappings.map((mapping) => String(mapping.externalUserId)),
        ...(report.unmatchedLmsStudents || []).map((student) => String(student.externalUserId))
    ]);
    const enrollmentOf = (student) => existingEnrollment[String(student.localUserId)];
    const unmatchedBiocBotStudents = (report.unmatchedBiocBotStudents || []).map((student) => ({
        ...student,
        accessDisabled: enrollmentOf(student)?.enrolled === false
    }));
    const absent = unmatchedBiocBotStudents.filter((student) => isDropCandidate(
        enrollmentOf(student),
        { externalCourseId, rosterExternalUserIds }
    ));
    const confirmedLeft = absent.length
        ? await confirmLeft(absent.map((student) => String(enrollmentOf(student).externalUserId)))
        : new Set();
    const dropCandidates = absent.filter((student) => confirmedLeft.has(String(enrollmentOf(student).externalUserId)));
    const set = {
        rosterSource: 'canvas',
        lmsRosterSync: {
            provider: 'canvas',
            externalCourseId: String(externalCourseId),
            lastSyncAt: now,
            syncedBy: String(syncedBy),
            syncToken,
            coverage: report.coverage,
            prune,
            dropCandidateIds: dropCandidates.map((student) => String(student.localUserId))
        },
        updatedAt: now
    };

    for (const mapping of mappings) {
        const localUserId = String(mapping.localUserId);
        set[`studentEnrollment.${localUserId}`] = {
            ...(existingEnrollment[localUserId] || {}),
            enrolled: true,
            source: 'canvas',
            externalUserId: String(mapping.externalUserId),
            externalCourseId: String(externalCourseId),
            syncedAt: now,
            updatedAt: now
        };
        delete set[`studentEnrollment.${localUserId}`].droppedAt;
    }

    await db.collection('courses').updateOne(
        { courseId: course.courseId, rosterSource: 'canvas' },
        { $set: set }
    );

    return { syncToken, prune, dropCandidates, unmatchedBiocBotStudents };
}

function createLmsRosterSyncRouter(integration, dependencies = {}) {
    const router = express.Router();
    const matchRoster = dependencies.matchRoster || syncCourseRoster;
    const confirmLeft = dependencies.confirmLeft || confirmLeftCanvasCourse;

    router.use(express.json());

    router.post(
        '/courses/:courseId/sync',
        requireManagedCourseMiddleware,
        requireSelectedProviderAuth(integration),
        async (req, res, next) => {
            try {
                const course = req.lmsGradeCourse;
                const provider = req.lmsGradeProvider;
                if (provider !== 'canvas') {
                    return res.status(400).json({
                        success: false,
                        provider,
                        code: 'ROSTER_PROVIDER_NOT_SUPPORTED',
                        message: 'Enrollment roster sync currently requires Canvas integration_id coverage'
                    });
                }
                const source = getGradeSource(course, provider);
                if (!source) {
                    return res.status(400).json({
                        success: false,
                        provider,
                        message: 'Link this BiocBot course to a Canvas course before syncing its roster'
                    });
                }

                if (!await claimCanvasRosterOwnership(req.app.locals.db, course)) {
                    return res.status(404).json({
                        success: false,
                        provider,
                        message: 'Course not found while claiming Canvas roster ownership'
                    });
                }

                const report = await matchRoster({
                    db: req.app.locals.db,
                    course: { ...course, rosterSource: 'canvas' },
                    provider,
                    client: req.canvasApi,
                    externalCourseId: source.courseId,
                    matchedBy: req.user.userId
                });
                const safety = await persistCanvasSync({
                    db: req.app.locals.db,
                    course,
                    externalCourseId: source.courseId,
                    report,
                    confirmLeft: (externalUserIds) => confirmLeft(req.canvasApi, source.courseId, externalUserIds),
                    syncedBy: req.user.userId
                });

                return res.json({
                    success: true,
                    message: 'Canvas roster synced',
                    data: { ...report, rosterSource: 'canvas', ...safety }
                });
            } catch (error) {
                return next(error);
            }
        }
    );

    router.post(
        '/courses/:courseId/drop-unmatched',
        requireManagedCourseMiddleware,
        async (req, res, next) => {
            try {
                const db = req.app.locals.db;
                const course = await db.collection('courses').findOne({ courseId: req.params.courseId });
                const sync = course?.lmsRosterSync;
                const safety = buildPruneSafety(sync?.coverage, sync?.provider);

                if (effectiveRosterSource(course) !== 'canvas') {
                    return res.status(409).json({ success: false, code: 'ROSTER_SOURCE_CONFLICT', message: 'Canvas does not own this course roster' });
                }
                if (!safety.allowed) {
                    return res.status(409).json({
                        success: false,
                        code: 'ROSTER_PRUNE_UNSAFE',
                        message: 'Drop is disabled because the latest Canvas roster was empty or lacked sufficient integration_id coverage',
                        data: { prune: safety }
                    });
                }
                if (!req.body.syncToken || req.body.syncToken !== sync.syncToken) {
                    return res.status(409).json({ success: false, code: 'ROSTER_SYNC_STALE', message: 'The roster changed; sync again before dropping students' });
                }
                if (sync.prunedSyncToken === sync.syncToken) {
                    return res.status(409).json({ success: false, code: 'ROSTER_PRUNE_ALREADY_APPLIED', message: 'This roster sync was already applied' });
                }

                // Syncs stored before drops were limited to this Canvas course
                // carry no candidate list; they have to be re-run, not guessed at.
                if (!Array.isArray(sync.dropCandidateIds)) {
                    return res.status(409).json({ success: false, code: 'ROSTER_SYNC_STALE', message: 'Sync the Canvas roster again before dropping students' });
                }
                // An instructor who changed a student's access by hand since the
                // sync has taken that student out of Canvas's hands.
                const candidateIds = [...new Set(sync.dropCandidateIds.map(String))].filter((localUserId) => {
                    const enrollment = course.studentEnrollment?.[localUserId];
                    return enrollment?.source === 'canvas' && enrollment.enrolled !== false;
                });
                const now = new Date();
                const set = {
                    'lmsRosterSync.lastPrunedAt': now,
                    'lmsRosterSync.lastPrunedBy': String(req.user.userId),
                    'lmsRosterSync.lastPrunedCount': candidateIds.length,
                    'lmsRosterSync.prunedSyncToken': sync.syncToken,
                    updatedAt: now
                };
                for (const localUserId of candidateIds) {
                    set[`studentEnrollment.${localUserId}`] = {
                        ...(course.studentEnrollment?.[localUserId] || {}),
                        enrolled: false,
                        source: 'canvas',
                        droppedAt: now,
                        syncedAt: now,
                        updatedAt: now
                    };
                }

                const update = await db.collection('courses').updateOne(
                    { courseId: course.courseId, rosterSource: 'canvas', 'lmsRosterSync.syncToken': sync.syncToken },
                    { $set: set }
                );
                if (!update.matchedCount) {
                    return res.status(409).json({
                        success: false,
                        code: 'ROSTER_SYNC_STALE',
                        message: 'The roster changed while applying drops; sync again before retrying'
                    });
                }

                return res.json({
                    success: true,
                    message: `${candidateIds.length} student${candidateIds.length === 1 ? '' : 's'} marked as dropped`,
                    data: { droppedCount: candidateIds.length, droppedAt: now }
                });
            } catch (error) {
                return next(error);
            }
        }
    );

    router.use(async (error, req, res, next) => {
        if (res.headersSent) return next(error);
        console.error('LMS roster sync route error:', error);
        try {
            const { status, body } = await lmsErrorResponse(error, {
                provider: req.lmsGradeProvider || null,
                config: req.lmsGradeIntegration?.config,
                req,
                fallbackMessage: 'LMS roster sync failed'
            });
            return res.status(status).json(body);
        } catch (responseError) {
            return next(responseError);
        }
    });

    return router;
}

module.exports = {
    DEFAULT_PRUNE_MIN_INTEGRATION_COVERAGE,
    buildPruneSafety,
    createLmsRosterSyncRouter,
    effectiveRosterSource,
    isDropCandidate,
    persistCanvasSync,
    pruneCoverageThreshold
};
