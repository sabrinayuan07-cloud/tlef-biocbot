const express = require('express');

const CourseModel = require('../models/Course');
const { hasSystemAdminAccess } = require('../services/authorization');
const {
    getGradeSource,
    getStoredGradeView,
    importProviderGrades,
    listGradeSources,
    normalizeProvider,
    setGradeSource
} = require('../services/lmsGradeImport');
const { syncCourseRoster } = require('../services/lmsRosterMatch');
const { lmsErrorResponse } = require('../services/lmsErrors');

async function requireManagedCourse(req, res) {
    const db = req.app.locals.db;
    const course = await CourseModel.getCourseById(db, req.params.courseId);
    if (!course) {
        res.status(404).json({ success: false, message: 'BiocBot course not found' });
        return null;
    }

    const allowed = hasSystemAdminAccess(req.user)
        || (req.user?.role === 'instructor'
            && await CourseModel.userHasCourseAccess(db, course.courseId, req.user.userId, 'instructor'));
    if (!allowed) {
        res.status(403).json({ success: false, message: 'You can only manage grades for your own courses' });
        return null;
    }
    return course;
}

async function requireManagedCourseMiddleware(req, res, next) {
    try {
        const course = await requireManagedCourse(req, res);
        if (!course) return;
        req.lmsGradeCourse = course;
        next();
    } catch (error) {
        next(error);
    }
}

function requireSelectedProviderAuth(integration) {
    return async function selectedProviderAuth(req, res, next) {
        // GET routes pass the provider as a query param, writes pass it in the body.
        const provider = normalizeProvider(req.body?.provider || req.query?.provider);
        if (!provider) {
            return res.status(400).json({ success: false, message: 'provider must be canvas or moodle' });
        }
        const selected = integration[provider];
        if (!selected) {
            return res.status(404).json({
                success: false,
                provider,
                message: `${provider} integration is not configured for this BiocBot deployment`
            });
        }

        req.lmsGradeProvider = provider;
        req.lmsGradeIntegration = selected;
        return selected.api.requireAuth(selected.config)(req, res, next);
    };
}

function createLmsGradesRouter(integration, dependencies = {}) {
    const router = express.Router();
    const importGrades = dependencies.importGrades || importProviderGrades;
    const loadStoredGrades = dependencies.loadStoredGrades || getStoredGradeView;
    const matchRoster = dependencies.matchRoster || syncCourseRoster;
    const saveGradeSource = dependencies.saveGradeSource || setGradeSource;

    router.use(express.json());

    /**
     * The courses the connected LMS account can pull grades from. Canvas is
     * restricted to courses the account teaches; Moodle has no equivalent
     * teacher filter, so it lists enrolments and the link step re-checks.
     */
    function listProviderCourses(req) {
        const { api } = req.lmsGradeIntegration;
        const client = req.lmsGradeProvider === 'canvas' ? req.canvasApi : req.moodleApi;
        return api.getCourses(client, ...(req.lmsGradeProvider === 'canvas' ? [{ enrollment_type: 'teacher' }] : []));
    }

    router.get('/courses/:courseId', async (req, res, next) => {
        try {
            const course = await requireManagedCourse(req, res);
            if (!course) return;

            const requested = normalizeProvider(req.query.provider);
            const sources = listGradeSources(course, integration);
            const provider = requested
                || sources.find((source) => source.linked && source.configured)?.provider
                || 'canvas';
            const view = await loadStoredGrades({ db: req.app.locals.db, course, provider });
            res.json({ success: true, data: { sources, ...view } });
        } catch (error) {
            next(error);
        }
    });

    // Lets the Student Hub offer a course to pull grades from, rather than
    // silently using whichever course was linked for file import.
    router.get(
        '/courses/:courseId/available-courses',
        requireManagedCourseMiddleware,
        requireSelectedProviderAuth(integration),
        async (req, res, next) => {
            try {
                const courses = await listProviderCourses(req);
                res.json({
                    success: true,
                    data: {
                        provider: req.lmsGradeProvider,
                        current: getGradeSource(req.lmsGradeCourse, req.lmsGradeProvider),
                        courses: courses.map((course) => ({
                            id: String(course.id),
                            name: course.name || '',
                            code: course.code || ''
                        }))
                    }
                });
            } catch (error) {
                next(error);
            }
        }
    );

    router.put(
        '/courses/:courseId/source',
        requireManagedCourseMiddleware,
        requireSelectedProviderAuth(integration),
        async (req, res, next) => {
            try {
                const externalCourseId = String(req.body.externalCourseId || '').trim();
                if (!externalCourseId) {
                    return res.status(400).json({ success: false, message: 'externalCourseId is required' });
                }

                // A stored token is not proof the account may read this course's
                // grades, so confirm the id against what the LMS reports first.
                const courses = await listProviderCourses(req);
                const externalCourse = courses.find((course) => String(course.id) === externalCourseId);
                if (!externalCourse) {
                    return res.status(403).json({
                        success: false,
                        provider: req.lmsGradeProvider,
                        message: `The connected ${req.lmsGradeProvider} account cannot read grades for that course`
                    });
                }

                const source = await saveGradeSource({
                    db: req.app.locals.db,
                    course: req.lmsGradeCourse,
                    provider: req.lmsGradeProvider,
                    externalCourse,
                    linkedBy: req.user.userId
                });
                // Re-read so the response reflects the newly pinned source.
                const course = await CourseModel.getCourseById(req.app.locals.db, req.params.courseId);
                const view = await loadStoredGrades({
                    db: req.app.locals.db,
                    course,
                    provider: req.lmsGradeProvider
                });
                res.json({
                    success: true,
                    message: 'LMS grade source linked',
                    data: { sources: listGradeSources(course, integration), source, ...view }
                });
            } catch (error) {
                next(error);
            }
        }
    );

    // Grades are stored against BiocBot user ids, so a course has to be matched
    // before an import has anywhere to put the scores. This is deliberately a
    // separate call: matching is the step instructors need to inspect and redo
    // when the roster changes, independently of pulling fresh grades.
    router.post(
        '/courses/:courseId/match-students',
        requireManagedCourseMiddleware,
        requireSelectedProviderAuth(integration),
        async (req, res, next) => {
            try {
                const course = req.lmsGradeCourse;
                const provider = req.lmsGradeProvider;
                const source = getGradeSource(course, provider);
                if (!source) {
                    return res.status(400).json({
                        success: false,
                        provider,
                        message: `Link this BiocBot course to a ${provider} course before matching students`
                    });
                }

                const summary = await matchRoster({
                    db: req.app.locals.db,
                    course,
                    provider,
                    client: provider === 'canvas' ? req.canvasApi : req.moodleApi,
                    externalCourseId: source.courseId,
                    matchedBy: req.user.userId
                });
                const view = await loadStoredGrades({ db: req.app.locals.db, course, provider });
                res.json({ success: true, message: 'LMS roster matched', data: { match: summary, ...view } });
            } catch (error) {
                next(error);
            }
        }
    );

    router.post(
        '/courses/:courseId/import',
        requireManagedCourseMiddleware,
        requireSelectedProviderAuth(integration),
        async (req, res, next) => {
            try {
                const course = req.lmsGradeCourse;

                const provider = req.lmsGradeProvider;
                const selected = req.lmsGradeIntegration;
                const client = provider === 'canvas' ? req.canvasApi : req.moodleApi;
                const summary = await importGrades({
                    db: req.app.locals.db,
                    course,
                    provider,
                    api: selected.api,
                    client,
                    importedBy: req.user.userId
                });
                const view = await loadStoredGrades({
                    db: req.app.locals.db,
                    course,
                    provider
                });
                res.json({ success: true, message: 'LMS grades imported', data: { summary, ...view } });
            } catch (error) {
                next(error);
            }
        }
    );

    router.use(async (error, req, res, next) => {
        if (res.headersSent) return next(error);
        console.error('LMS grade route error:', error);
        try {
            const { status, body } = await lmsErrorResponse(error, {
                provider: req.lmsGradeProvider || null,
                config: req.lmsGradeIntegration?.config,
                req,
                fallbackMessage: 'LMS grade import failed'
            });
            return res.status(status).json(body);
        } catch (responseError) {
            return next(responseError);
        }
    });

    return router;
}

module.exports = {
    createLmsGradesRouter,
    requireManagedCourse,
    requireManagedCourseMiddleware,
    requireSelectedProviderAuth
};
