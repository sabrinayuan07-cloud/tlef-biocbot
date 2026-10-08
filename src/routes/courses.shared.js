/**
 * Shared helpers used across multiple courses.* route files.
 */

const CourseModel = require('../models/Course');
const { createId } = require('../services/id');

function hasInstructorAccess(course, userId) {
    return course.instructorId === userId ||
        (Array.isArray(course.instructors) && course.instructors.includes(userId));
}

// Gates approved-topics and unit management (delete/rename) - content
// curation, hence the 'materials' permission rather than 'settings'.
async function hasCourseManagementAccess(db, course, user) {
    if (!course || !user) {
        return false;
    }

    if (hasInstructorAccess(course, user.userId)) {
        return true;
    }

    if (user.role === 'ta' && Array.isArray(course.tas) && course.tas.includes(user.userId)) {
        return CourseModel.checkTAPermission(db, course.courseId, user.userId, 'materials');
    }

    return false;
}

function generateCourseId(courseName = '') {
    return createId('course');
}

module.exports = { hasInstructorAccess, hasCourseManagementAccess, generateCourseId };
