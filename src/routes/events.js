/**
 * POST /api/events/:courseId: events the student page reports on its browser
 * bus (public/student/scripts/student-events.js), published on BiocBot's own
 * (src/services/events.js).
 *
 * The page sends only `{ type, data, page }`, and may send `session`. The
 * toolkit's handler refuses anything else, refuses any type but
 * chat.mode.changed, and takes who and where from the server: the signed-in
 * user, the course in the path once the enrollment guard has checked it, and
 * whether this is a preview tab.
 */
const eventsService = require('../services/events');

/**
 * BiocBot's course guards read the course from the body or the query string
 * before the path. A report is published with the path's course, so that is
 * the one the guards must check: a report that names a course anywhere else
 * is refused before they run.
 */
function onlyThePathsCourse(req, res, next) {
    const named = [];
    if (req.query && req.query.courseId !== undefined) named.push('query.courseId');
    if (req.body && typeof req.body === 'object' && req.body.courseId !== undefined) named.push('courseId');
    if (named.length > 0) {
        return res.status(400).json({
            ok: false,
            problems: named.map(field => ({
                field,
                code: 'field_not_allowed',
                message: 'A report names its course only in its path.'
            }))
        });
    }
    next();
}

/**
 * The route's middleware, in order: student chat's guards, with two more
 * ahead of the course checks. Only a student (a "View as Student" preview is
 * one) has a mode to switch, and requireStudentEnrolled checks nothing for
 * anyone else, so without requireStudent an instructor could report into any
 * course.
 *
 * @param {object} authMiddleware - From src/middleware/auth.js
 * @returns {Function[]}
 */
function createEventReportRoute(authMiddleware) {
    return [
        authMiddleware.requireAuth,
        authMiddleware.populateUser,
        authMiddleware.requireStudent,
        onlyThePathsCourse,
        authMiddleware.requireActiveCourseForNonInstructors,
        authMiddleware.requireStudentEnrolled,
        eventsService.createReportHandler()
    ];
}

module.exports = { createEventReportRoute, onlyThePathsCourse };
