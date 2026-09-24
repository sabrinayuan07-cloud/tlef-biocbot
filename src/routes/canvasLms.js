const express = require('express');

const CourseModel = require('../models/Course');
const { hasSystemAdminAccess } = require('../services/authorization');
const {
    MAX_DOCUMENT_BYTES,
    SUPPORTED_DOCUMENT_MIME_TYPES,
    ingestFileBuffer,
    isSupportedDocumentMimeType
} = require('../services/documentIngestion');
const { resolveCourseAi, sendLlmKeyError } = require('./llmKeyMiddleware');
const { createImportProgressStream } = require('./lmsImportProgress');
const { createLmsImportDiagnostics } = require('../services/lmsImportDiagnostics');
const { lmsErrorResponse } = require('../services/lmsErrors');
const { revokeCanvasGrant } = require('../services/lmsIntegration');

const DEFAULT_RETURN_PATH = '/instructor';
const CANVAS_REVOKE_WAIT_MS = 5000;

/**
 * What an instructor is told when the Canvas connection does not complete,
 * keyed by the `error` Canvas sends back to the callback (plus BiocBot's own
 * `state` and `exchange_failed`). Canvas's own wording is logged, not shown.
 */
const CANVAS_CONNECT_ERRORS = Object.freeze({
    access_denied: {
        status: 400,
        message: 'You chose not to authorize BiocBot in Canvas, so nothing was connected. You can connect Canvas whenever you are ready.'
    },
    invalid_scope: {
        status: 502,
        message: 'Canvas refused the permissions BiocBot asked for: BiocBot’s Canvas developer key does not allow them yet. Please contact BiocBot support.'
    },
    unauthorized_client: {
        status: 502,
        message: 'BiocBot’s Canvas developer key is not switched on for this Canvas account yet. Please contact BiocBot support.'
    },
    state: {
        status: 400,
        message: 'This Canvas sign-in could not be matched to your BiocBot session. It may have expired, or it was started in another tab. Please try connecting again.'
    },
    exchange_failed: {
        status: 502,
        message: 'Canvas approved the connection, but BiocBot could not finish it. Please try again, and contact BiocBot support if it keeps happening.'
    }
});
const DEFAULT_CONNECT_ERROR = Object.freeze({
    status: 400,
    message: 'Canvas did not complete the connection. Please try again, and contact BiocBot support if it keeps happening.'
});

function escapeHtml(value) {
    const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return String(value ?? '').replace(/[&<>"']/g, (character) => entities[character]);
}

/**
 * A path on this site: one leading slash, then no backslash, whitespace, or
 * control character anywhere. Browsers drop tabs and newlines from URLs and
 * read a backslash as a slash, so "/\t/evil.example" would otherwise leave.
 */
function isLocalReturnPath(value) {
    return typeof value === 'string' && /^\/(?![/\\])[^\\\s\x00-\x1f\x7f]*$/.test(value);
}

function localReturnPath(value) {
    return isLocalReturnPath(value) ? value : DEFAULT_RETURN_PATH;
}

function renderCanvasConnectError(res, reason, returnTo) {
    const { status, message } = CANVAS_CONNECT_ERRORS[reason] || DEFAULT_CONNECT_ERROR;
    res.status(status).type('html').send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Canvas not connected - BiocBot</title>
</head>
<body style="font-family: system-ui, sans-serif; line-height: 1.5; color: #1f2937;">
    <main style="max-width: 36rem; margin: 4rem auto; padding: 0 1rem;">
        <h1 style="font-size: 1.5rem;">Canvas was not connected</h1>
        <p>${escapeHtml(message)}</p>
        <p style="color: #6b7280; font-size: 0.875rem;">Canvas response: ${escapeHtml(reason)}</p>
        <p><a href="${escapeHtml(localReturnPath(returnTo))}">Return to BiocBot</a></p>
    </main>
</body>
</html>`);
}

/**
 * Runs ahead of the toolkit's callback so every way a connection can fail ends
 * on a page an instructor can act on, instead of the toolkit's bare-text 400
 * or a JSON error. Only a callback whose state matches the session and that
 * carries a code reaches the toolkit's token exchange.
 */
function handleCanvasCallbackErrors(req, res, next) {
    const session = req.session || {};
    const expectedState = session.canvasOAuthState;
    const { code, error, state } = req.query;
    // The toolkit clears this before exchanging the code; keep it so a failed
    // exchange can still send the instructor back where they started.
    req.canvasOAuthReturnTo = session.canvasOAuthReturnTo;

    if (expectedState && state === expectedState && !error && typeof code === 'string') {
        return next();
    }

    delete session.canvasOAuthState;
    delete session.canvasOAuthReturnTo;
    const reason = !expectedState || state !== expectedState
        ? 'state'
        : (typeof error === 'string' && error ? error : 'missing_code');
    console.warn('[Canvas OAuth] Connection not completed:', {
        reason,
        description: typeof req.query.error_description === 'string' ? req.query.error_description : null
    });
    return renderCanvasConnectError(res, reason, req.canvasOAuthReturnTo);
}

function normalizeCanvasFile(file = {}) {
    const mimeType = file.mimeType || '';
    return {
        id: String(file.id ?? ''),
        name: file.name || file.filename || `Canvas file ${file.id ?? ''}`,
        filename: file.filename || file.name || '',
        mimeType,
        size: Number(file.size) || 0,
        createdAt: file.createdAt || null,
        updatedAt: file.updatedAt || null,
        supported: isSupportedDocumentMimeType(mimeType)
            && Number(file.size || 0) <= MAX_DOCUMENT_BYTES
    };
}

async function requireManagedCourse(req, res, courseId) {
    const db = req.app.locals.db;
    const user = req.user;
    const course = await CourseModel.getCourseById(db, courseId);

    if (!course) {
        res.status(404).json({ success: false, message: 'BiocBot course not found' });
        return null;
    }

    const hasAccess = hasSystemAdminAccess(user)
        || (user?.role === 'instructor'
            && await CourseModel.userHasCourseAccess(db, courseId, user.userId, 'instructor'));
    if (!hasAccess) {
        res.status(403).json({ success: false, message: 'You can only manage LMS imports for your own courses' });
        return null;
    }

    return course;
}

function getCanvasFileSource(course = {}) {
    return course.lmsFileSources?.canvas
        || (course.lmsSync?.provider === 'canvas' ? course.lmsSync : null);
}

function createCanvasLmsRouter(
    integration,
    {
        ingestFile = ingestFileBuffer,
        resolveAi = resolveCourseAi
    } = {}
) {
    const router = express.Router();
    const { api: canvas, config } = integration;
    const requireCanvasAuth = canvas.requireAuth(config);

    router.use(express.json());
    router.use('/auth', (req, res, next) => {
        const returnTo = req.query?.returnTo;
        if (returnTo !== undefined && !isLocalReturnPath(returnTo)) {
            return res.status(400).send('Canvas OAuth returnTo must be a local application path.');
        }
        next();
    });
    router.get('/auth/callback', handleCanvasCallbackErrors);
    // Replaces the toolkit's /logout, which looks tokens up through the scope
    // stamp — so a token issued under an older scope list would be neither
    // revoked nor deleted — and revokes with a stored access token that has
    // usually expired.
    router.post('/auth/logout', async (req, res, next) => {
        try {
            const userKey = await config.getUserKey(req);
            const tokens = await (config.tokenStore.peek || config.tokenStore.get)(userKey);
            if (tokens) {
                // Forget the grant locally first; revoking it in Canvas is best
                // effort and must not keep the instructor waiting for long.
                await config.tokenStore.delete(userKey);
                await Promise.race([
                    revokeCanvasGrant(canvas, config, tokens),
                    new Promise((resolve) => { setTimeout(resolve, CANVAS_REVOKE_WAIT_MS).unref?.(); })
                ]).catch((error) => {
                    console.warn('Could not revoke the Canvas grant on disconnect:', error.message);
                });
            }
            res.status(204).end();
        } catch (error) {
            next(error);
        }
    });
    router.use('/auth', canvas.createAuthRouter(config));

    router.get('/status', requireCanvasAuth, (req, res) => {
        res.json({ success: true, connected: true, provider: 'canvas' });
    });

    router.get('/courses', requireCanvasAuth, async (req, res, next) => {
        try {
            const courses = await canvas.getCourses(req.canvasApi, { enrollment_type: 'teacher' });
            res.json({ success: true, data: courses });
        } catch (error) {
            next(error);
        }
    });

    router.get('/courses/:canvasCourseId/sections', requireCanvasAuth, async (req, res, next) => {
        try {
            const sections = await canvas.getCourseSections(req.canvasApi, req.params.canvasCourseId);
            res.json({ success: true, data: sections });
        } catch (error) {
            next(error);
        }
    });

    router.get('/courses/:canvasCourseId/files', requireCanvasAuth, async (req, res, next) => {
        try {
            const files = await canvas.getCourseFiles(req.canvasApi, req.params.canvasCourseId, {
                contentTypes: SUPPORTED_DOCUMENT_MIME_TYPES,
                sort: 'updated_at',
                order: 'desc'
            });
            res.json({
                success: true,
                data: (files || []).map(normalizeCanvasFile)
            });
        } catch (error) {
            next(error);
        }
    });

    router.get('/courses/:biocbotCourseId/link', requireCanvasAuth, async (req, res, next) => {
        try {
            const course = await requireManagedCourse(req, res, req.params.biocbotCourseId);
            if (!course) return;
            res.json({
                success: true,
                data: {
                    courseId: course.courseId,
                    lmsSync: getCanvasFileSource(course)
                }
            });
        } catch (error) {
            next(error);
        }
    });

    router.put('/courses/:biocbotCourseId/link', requireCanvasAuth, async (req, res, next) => {
        try {
            const course = await requireManagedCourse(req, res, req.params.biocbotCourseId);
            if (!course) return;

            const canvasCourseId = String(req.body.canvasCourseId || '').trim();
            if (!canvasCourseId) {
                return res.status(400).json({ success: false, message: 'canvasCourseId is required' });
            }

            const teachingCourses = await canvas.getCourses(req.canvasApi, { enrollment_type: 'teacher' });
            const canvasCourse = teachingCourses.find((candidate) => String(candidate.id) === canvasCourseId);
            if (!canvasCourse) {
                return res.status(403).json({
                    success: false,
                    message: 'The connected Canvas account is not a teacher for that course'
                });
            }
            const now = new Date();
            const lmsSync = {
                provider: 'canvas',
                courseId: String(canvasCourse.id),
                name: canvasCourse.name || '',
                code: canvasCourse.code || '',
                linkedAt: now,
                linkedBy: req.user.userId
            };
            await req.app.locals.db.collection('courses').updateOne(
                { courseId: course.courseId },
                { $set: { lmsSync, 'lmsFileSources.canvas': lmsSync, updatedAt: now } }
            );
            res.json({ success: true, data: { courseId: course.courseId, lmsSync } });
        } catch (error) {
            next(error);
        }
    });

    router.post('/courses/:biocbotCourseId/import-file', requireCanvasAuth, async (req, res, next) => {
        let progress = null;
        let diagnostics = null;
        try {
            const db = req.app.locals.db;
            const course = await requireManagedCourse(req, res, req.params.biocbotCourseId);
            if (!course) return;
            const canvasSource = getCanvasFileSource(course);
            if (!canvasSource?.courseId) {
                return res.status(400).json({ success: false, message: 'This BiocBot course is not linked to Canvas' });
            }

            const canvasFileId = String(req.body.canvasFileId || '').trim();
            const lectureName = String(req.body.lectureName || '').trim();
            const documentType = String(req.body.documentType || 'lecture-notes').trim();
            if (!canvasFileId || !lectureName) {
                return res.status(400).json({
                    success: false,
                    message: 'canvasFileId and lectureName are required'
                });
            }
            if (!course.lectures?.some((lecture) => lecture.name === lectureName)) {
                return res.status(400).json({ success: false, message: 'Selected BiocBot unit does not exist' });
            }

            const canvasCourseId = String(canvasSource.courseId);
            const files = await canvas.getCourseFiles(req.canvasApi, canvasCourseId, {
                contentTypes: SUPPORTED_DOCUMENT_MIME_TYPES
            });
            const file = files.find((candidate) => String(candidate.id) === canvasFileId);
            if (!file) {
                return res.status(404).json({ success: false, message: 'Canvas course file not found' });
            }
            const normalized = normalizeCanvasFile(file);
            if (!isSupportedDocumentMimeType(normalized.mimeType)) {
                return res.status(400).json({ success: false, message: 'Canvas file type is not supported by BiocBot' });
            }
            if (normalized.size > MAX_DOCUMENT_BYTES) {
                return res.status(400).json({ success: false, message: 'Canvas file exceeds the 50 MB limit' });
            }

            const existing = await db.collection('documents').findOne({
                courseId: course.courseId,
                'metadata.lms.provider': 'canvas',
                'metadata.lms.externalCourseId': canvasCourseId,
                'metadata.lms.externalFileId': String(file.id)
            });
            if (existing) {
                return res.status(409).json({
                    success: false,
                    code: 'CANVAS_FILE_ALREADY_IMPORTED',
                    message: 'This Canvas file has already been imported',
                    data: { documentId: existing.documentId }
                });
            }

            const ai = await resolveAi(req, res, course.courseId);
            if (!ai) return;

            // Everything that can still fail with a meaningful HTTP status has
            // now passed, so it is safe to commit the response to 200 + stream.
            diagnostics = createLmsImportDiagnostics({
                req,
                provider: 'canvas',
                biocbotCourseId: course.courseId,
                externalCourseId: canvasCourseId,
                externalFileId: canvasFileId,
                fileUrl: file.raw?.url || file.url,
                lmsDomain: config.canvasDomain,
                allowedDownloadHostSuffixes: config.allowedDownloadHostSuffixes
            });
            progress = createImportProgressStream(req, res, { diagnostics });
            if (progress) progress.step('download', `${normalized.name} from Canvas`);
            else diagnostics.step('download', { detail: `${normalized.name} from Canvas` });
            const download = await canvas.downloadFile(
                req.canvasApi,
                canvasCourseId,
                canvasFileId,
                { maxBytes: MAX_DOCUMENT_BYTES }
            );
            const buffer = Buffer.from(download.data);
            const { result, courseResult, qdrantResult } = await ingestFile({
                db,
                ai,
                buffer,
                onProgress: progress?.onIngestionProgress || diagnostics.onIngestionProgress,
                originalName: normalized.filename || normalized.name,
                mimeType: normalized.mimeType,
                size: normalized.size || buffer.length,
                courseId: course.courseId,
                lectureName,
                documentType,
                instructorId: req.user.userId,
                title: req.body.title || normalized.name,
                metadata: {
                    description: req.body.description || '',
                    lms: {
                        provider: 'canvas',
                        externalCourseId: canvasCourseId,
                        externalFileId: String(file.id),
                        externalUpdatedAt: normalized.updatedAt,
                        importedAt: new Date()
                    }
                }
            });

            const data = {
                documentId: result.documentId,
                filename: result.filename,
                lectureName,
                linkedToCourse: courseResult.success,
                qdrantProcessed: qdrantResult?.success === true,
                chunksStored: qdrantResult?.chunksStored || 0
            };
            if (progress) return progress.done(data);
            diagnostics.done(data);
            res.status(201).json({
                success: true,
                message: 'Canvas file imported into BiocBot',
                data
            });
        } catch (error) {
            if (progress) return progress.fail(error);
            diagnostics?.fail(error);
            if (sendLlmKeyError(res, error)) return;
            next(error);
        }
    });

    router.use(async (error, req, res, next) => {
        if (res.headersSent) return next(error);
        console.error('Canvas LMS route error:', error);
        if (req.path === '/auth/callback') {
            return renderCanvasConnectError(res, 'exchange_failed', req.canvasOAuthReturnTo);
        }
        if (error.code === 'DOCUMENT_TOO_LARGE' || error.code === 'UNSUPPORTED_DOCUMENT_TYPE') {
            return res.status(400).json({ success: false, provider: 'canvas', message: error.message });
        }
        try {
            const { status, body } = await lmsErrorResponse(error, {
                provider: 'canvas',
                config,
                req,
                fallbackMessage: 'Canvas integration failed'
            });
            return res.status(status).json(body);
        } catch (responseError) {
            return next(responseError);
        }
    });

    return router;
}

module.exports = {
    CANVAS_CONNECT_ERRORS,
    createCanvasLmsRouter,
    getCanvasFileSource,
    normalizeCanvasFile,
    requireManagedCourse
};
