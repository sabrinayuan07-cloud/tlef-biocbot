/**
 * Single enforcement point for the six granular TA permissions
 * (materials/questions/flags/roster/transcripts/settings). Replaces the
 * ~9 duplicated per-route-file helpers that each hand-rolled the same
 * "admin OK, instructor with course access OK, TA needs checkTAPermission"
 * pattern.
 *
 * This is a plain function, not Express middleware, because most call
 * sites need it from mid-handler (after a flag/document has already been
 * loaded and its courseId read off it, or before a route-specific branch
 * like a legacy empty-200-on-missing-course response) rather than as a
 * pure gate-before-handler. src/middleware/auth.js's requirePermission()
 * wraps this for the few routes that are clean entry gates.
 */

const CourseModel = require('../models/Course');
const { hasSystemAdminAccess } = require('./authorization');

const PERMISSION_KEYS = CourseModel.TA_PERMISSION_KEYS;

/**
 * Named presets a TA can be assigned in one action from the TA hub UI.
 * Purely a UI convenience for applying a flag set - storage stays
 * flag-based, so a preset can be customized per-TA afterward without the
 * server needing to know a "role" was ever chosen. Not persisted; see
 * deriveRoleLabel for how a TA's current preset is displayed.
 */
const ROLE_PRESETS = {
    grader: {
        materials: false, questions: false, flags: true,
        roster: true, transcripts: false, settings: false
    },
    contentTA: {
        materials: true, questions: true, flags: false,
        roster: false, transcripts: false, settings: false
    },
    fullTA: {
        materials: true, questions: true, flags: true,
        roster: true, transcripts: true, settings: true
    }
};

/**
 * Does `user` have `permission` on `courseId`?
 *
 * Hardcodes the 'instructor'/'ta' role checks rather than forwarding
 * user.role into CourseModel.userHasCourseAccess for an arbitrary role -
 * that function resolves 'student' via a different, enrollment-based path,
 * so passing a role through blindly would risk admitting enrolled students
 * on staff-only routes.
 * @param {Object} db - MongoDB database instance
 * @param {Object} user - req.user
 * @param {string} courseId - Course identifier
 * @param {string} permission - One of PERMISSION_KEYS
 * @returns {Promise<boolean>}
 */
async function hasPermission(db, user, courseId, permission) {
    if (!user || !courseId) return false;
    if (hasSystemAdminAccess(user)) return true;
    if (user.role === 'instructor') {
        return CourseModel.userHasCourseAccess(db, courseId, user.userId, 'instructor');
    }
    if (user.role === 'ta') {
        return CourseModel.checkTAPermission(db, courseId, user.userId, permission);
    }
    return false;
}

/**
 * Does `user` have at least one of `permissions` on `courseId`? For gates
 * that cover a page with several independently-toggleable sections (e.g.
 * /instructor/documents hosts materials, questions, and settings) - a TA
 * needs only one of them to have a reason to load the page at all, but an
 * unassigned/fully-revoked TA (who has none) still shouldn't reach it.
 * @param {Object} db - MongoDB database instance
 * @param {Object} user - req.user
 * @param {string} courseId - Course identifier
 * @param {string[]} permissions - Any of PERMISSION_KEYS
 * @returns {Promise<boolean>}
 */
async function hasAnyPermission(db, user, courseId, permissions) {
    for (const permission of permissions) {
        if (await hasPermission(db, user, courseId, permission)) return true;
    }
    return false;
}

/**
 * Label a TA's current permission set for display: the name of the role
 * preset it exactly matches, or 'custom' if it's been individually
 * adjusted away from every preset.
 * @param {Object} permissions - Six-flag permission object
 * @returns {string}
 */
function deriveRoleLabel(permissions) {
    if (!permissions) return 'custom';
    for (const [name, preset] of Object.entries(ROLE_PRESETS)) {
        if (PERMISSION_KEYS.every(key => !!permissions[key] === !!preset[key])) {
            return name;
        }
    }
    return 'custom';
}

module.exports = {
    PERMISSION_KEYS,
    ROLE_PRESETS,
    hasPermission,
    hasAnyPermission,
    deriveRoleLabel
};
