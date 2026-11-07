/**
 * Students API Routes
 * Handles student data and saved chat sessions for instructors
 */

const express = require('express');
const router = express.Router();
const CourseModel = require('../models/Course');
const { hasSystemAdminAccess } = require('../services/authorization');
const previewSession = require('../services/previewSession');

// Middleware to parse JSON bodies
router.use(express.json());

function requireDownloadAdmin(user, res) {
    if (!user) {
        res.status(401).json({
            success: false,
            message: 'Authentication required'
        });
        return false;
    }

    if (user.role !== 'instructor' || !hasSystemAdminAccess(user)) {
        res.status(403).json({
            success: false,
            message: 'Only system admins can access student chat download data'
        });
        return false;
    }

    return true;
}

/**
 * Calculate duration from session data (first user message to last bot response)
 * @param {Object} session - The session object with chatData
 * @returns {string} Duration in human readable format
 */
function calculateDurationFromSessionData(session) {
    if (!session || !session.chatData || !session.chatData.messages || session.chatData.messages.length === 0) {
        return '0s';
    }
    
    const messages = session.chatData.messages;
    
    // Find the first user message (student message)
    const firstUserMessage = messages.find(msg => msg.type === 'user');
    if (!firstUserMessage || !firstUserMessage.timestamp) {
        return '0s';
    }
    
    const isSyntheticBotMessage = (msg) => {
        if (!msg || msg.type !== 'bot') return false;
        if (msg.sourceAttribution?.source === 'System') return true;
        const content = typeof msg.content === 'string' ? msg.content : '';
        return content.includes('Welcome to BiocBot!') &&
            content.includes('I can see you have access to published units');
    };

    // Find the last actual response, excluding startup/system UI that may have
    // been appended during a later visit.
    const lastBotMessage = messages.slice().reverse().find(
        msg => msg.type === 'bot' && !isSyntheticBotMessage(msg)
    );
    if (!lastBotMessage || !lastBotMessage.timestamp) {
        // If no real bot response exists, use the last non-synthetic message.
        const lastMessage = messages.slice().reverse().find(
            msg => !isSyntheticBotMessage(msg)
        );
        if (!lastMessage || !lastMessage.timestamp) {
            return '0s';
        }
        const start = new Date(firstUserMessage.timestamp);
        const end = new Date(lastMessage.timestamp);
        const diffMs = end - start;
        
        const hours = Math.floor(diffMs / (1000 * 60 * 60));
        const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
        const seconds = Math.floor((diffMs % (1000 * 60)) / 1000);
        
        if (hours > 0) {
            return `${hours}h ${minutes}m ${seconds}s`;
        } else if (minutes > 0) {
            return `${minutes}m ${seconds}s`;
        } else {
            return `${seconds}s`;
        }
    }
    
    const start = new Date(firstUserMessage.timestamp);
    const end = new Date(lastBotMessage.timestamp);
    const diffMs = end - start;

    const hours = Math.floor(diffMs / (1000 * 60 * 60));
    const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
    const seconds = Math.floor((diffMs % (1000 * 60)) / 1000);

    if (hours > 0) {
        return `${hours}h ${minutes}m ${seconds}s`;
    } else if (minutes > 0) {
        return `${minutes}m ${seconds}s`;
    } else {
        return `${seconds}s`;
    }
}

// Whether the student ever sent a message in this session, as opposed to a
// session saved from just the auto-welcome bot message landing. This is the
// filter used for the "Chats to show" dropdown (#519) - duration alone isn't
// a reliable stand-in, since a real question with no (or a fast) reply is
// also 0s.
function hasStudentMessage(session) {
    return (session?.chatData?.messages || []).some(msg => msg.type === 'user');
}

/**
 * GET /api/students/:courseId
 * Get all students who have saved chat sessions for a specific course
 */
router.get('/:courseId', async (req, res) => {
    try {
        const { courseId } = req.params;
        // Default excludes chats where the student never sent a message
        // (#519) - a session gets saved as soon as the auto-welcome bot
        // message lands, so without this every login would count as "a
        // chat" even though nothing was actually asked.
        const includeEmptyChats = req.query.includeEmptyChats === 'true';

        // Get authenticated user information
        const user = req.user;
        if (!user) {
            return res.status(401).json({
                success: false,
                message: 'Authentication required'
            });
        }
        
        // Get database instance from app.locals
        const db = req.app.locals.db;
        if (!db) {
            return res.status(503).json({
                success: false,
                message: 'Database connection not available'
            });
        }

        if (!requireDownloadAdmin(user, res)) {
            return;
        }
        
        // System admins can download from any course.
        const coursesCollection = db.collection('courses');
        const course = await coursesCollection.findOne({ courseId });
        
        if (!course) {
            return res.status(404).json({
                success: false,
                message: 'Course not found or access denied'
            });
        }
        
        // Get saved chat sessions for this course (excluding soft deleted)
        const chatSessionsCollection = db.collection('chat_sessions');
        const chatSessions = await chatSessionsCollection.find({
            courseId: courseId,
            // Keep "View as Student" sandbox transcripts out of the roster —
            // they belong to an instructor testing the bot, not a student.
            ...previewSession.excludePreviewFilter('studentId'),
            $or: [
                { isDeleted: { $exists: false } }, // Legacy sessions without isDeleted field
                { isDeleted: false } // Non-deleted sessions
            ]
        }).sort({ savedAt: -1 }).toArray();

        // Recalculate duration from actual message timestamps, then drop
        // sessions where the student never sent a message, unless explicitly
        // included (#519) - a student who only ever got the auto-welcome
        // message shouldn't count as "a student with saved chats" by
        // default. Some kept sessions may still display as 0s (e.g. a
        // question with no reply, or one answered within a second) - that's
        // accurate, not a bug.
        const sessionsWithDuration = chatSessions
            .map(session => ({ session, duration: calculateDurationFromSessionData(session) }))
            .filter(({ session }) => includeEmptyChats || hasStudentMessage(session));

        // Group chat sessions by student
        const studentsMap = new Map();

        sessionsWithDuration.forEach(({ session, duration }) => {

            const studentId = session.studentId;
            let studentName = session.studentName || 'Unknown Student';

            // If studentName is an object, try to extract the actual name
            if (typeof studentName === 'object' && studentName !== null) {
                studentName = studentName.displayName ||
                             studentName.name ||
                             studentName.studentName ||
                             'Unknown Student';
            }

            // Ensure studentName is a string
            if (typeof studentName !== 'string') {
                studentName = 'Unknown Student';
            }

            if (!studentsMap.has(studentId)) {
                studentsMap.set(studentId, {
                    studentId: studentId,
                    studentName: studentName,
                    courseId: courseId,
                    courseName: course.courseName,
                    totalSessions: 0,
                    lastActivity: null,
                    sessions: []
                });
            }

            const student = studentsMap.get(studentId);
            student.totalSessions++;

            student.sessions.push({
                sessionId: session.sessionId,
                title: session.title || `Chat Session ${student.totalSessions}`,
                unitName: session.unitName,
                savedAt: session.savedAt,
                messageCount: session.messageCount || 0,
                duration: duration
            });

            // Update last activity
            if (!student.lastActivity || new Date(session.savedAt) > new Date(student.lastActivity)) {
                student.lastActivity = session.savedAt;
            }
        });

        // Convert map to array and sort by last activity
        const students = Array.from(studentsMap.values()).sort((a, b) =>
            new Date(b.lastActivity) - new Date(a.lastActivity)
        );

        console.log(`Retrieved ${students.length} students with saved chats for course ${courseId}`);

        res.json({
            success: true,
            data: {
                courseId: courseId,
                courseName: course.courseName,
                students: students,
                totalStudents: students.length,
                totalSessions: sessionsWithDuration.length
            }
        });
        
    } catch (error) {
        console.error('Error fetching students:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error while fetching students'
        });
    }
});

/**
 * GET /api/students/:courseId/:studentId/sessions/own
 * Get all saved chat sessions for a specific student in a course (student access)
 */
router.get('/:courseId/:studentId/sessions/own', async (req, res) => {
    try {
        console.log('🔍 [STUDENT_SESSIONS_OWN] Route hit!');
        console.log('🔍 [STUDENT_SESSIONS_OWN] Request path:', req.path);
        console.log('🔍 [STUDENT_SESSIONS_OWN] Request params:', req.params);
        
        const { courseId, studentId } = req.params;
        
        // Get authenticated user information
        const user = req.user;
        if (!user) {
            return res.status(401).json({
                success: false,
                message: 'Authentication required'
            });
        }
        
        // Debug logging
        console.log('🔍 [STUDENT_SESSIONS] User object:', user);
        console.log('🔍 [STUDENT_SESSIONS] User role:', user.role);
        console.log('🔍 [STUDENT_SESSIONS] User ID:', user.userId);
        console.log('🔍 [STUDENT_SESSIONS] Requested student ID:', studentId);
        
        // Students can only access their own chat sessions
        if (user.role === 'student' && user.userId !== studentId) {
            console.log('🔍 [STUDENT_SESSIONS] Access denied - student trying to access different student ID');
            return res.status(403).json({
                success: false,
                message: 'You can only access your own chat sessions'
            });
        }
        
        if (user.role === 'instructor' && !hasSystemAdminAccess(user)) {
            return res.status(403).json({
                success: false,
                message: 'Only system admins can access student chat download data'
            });
        }

        if (user.role !== 'instructor' && user.role !== 'student') {
            return res.status(403).json({
                success: false,
                message: 'Access denied'
            });
        }
        
        // Get database instance from app.locals
        const db = req.app.locals.db;
        if (!db) {
            return res.status(503).json({
                success: false,
                message: 'Database connection not available'
            });
        }
        
        // For students, verify they have access to this course
        if (user.role === 'student') {
            // Check if the student has access to this course
            // This could be enhanced with a proper enrollment check in the future
            const coursesCollection = db.collection('courses');
            const course = await coursesCollection.findOne({ courseId: courseId });
            
            if (!course) {
                return res.status(404).json({
                    success: false,
                    message: 'Course not found'
                });
            }

            if (!(await CourseModel.userHasCourseAccess(db, courseId, user.userId, 'student'))) {
                return res.status(403).json({
                    success: false,
                    message: 'You are not enrolled in this course'
                });
            }
        }
        
        // For instructors, verify they have access to this course
        if (user.role === 'instructor') {
            const coursesCollection = db.collection('courses');
            const courseQuery = hasSystemAdminAccess(user)
                ? { courseId }
                : {
                    courseId,
                    $or: [
                        { instructorId: user.userId },
                        { instructors: { $in: [user.userId] } }
                    ]
                };
            const course = await coursesCollection.findOne(courseQuery);
            
            if (!course) {
                return res.status(404).json({
                    success: false,
                    message: 'Course not found or access denied'
                });
            }
        }
        
        // Get all chat sessions for this student in this course (excluding soft deleted for student)
        const chatSessionsCollection = db.collection('chat_sessions');
        const sessions = await chatSessionsCollection.find({ 
            courseId: courseId,
            studentId: studentId,
            $and: [
                { $or: [{ isDeleted: { $exists: false } }, { isDeleted: false }] }, // Not globally deleted
                { studentDeleted: { $ne: true } } // Not deleted by student
            ]
        }).sort({ savedAt: -1 }).toArray();
        
        console.log(`Retrieved ${sessions.length} sessions for student ${studentId} in course ${courseId}`);
        
        // Recalculate duration for each session
        const sessionsWithCalculatedDuration = sessions.map(session => ({
            ...session,
            duration: calculateDurationFromSessionData(session)
        }));
        
        res.json({
            success: true,
            data: {
                courseId: courseId,
                studentId: studentId,
                studentName: sessions[0]?.studentName || 'Unknown Student',
                sessions: sessionsWithCalculatedDuration
            }
        });
        
    } catch (error) {
        console.error('Error fetching student sessions:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error while fetching student sessions'
        });
    }
});

/**
 * GET /api/students/:courseId/:studentId/sessions
 * Get all saved chat sessions for a specific student in a course
 */
router.get('/:courseId/:studentId/sessions', async (req, res) => {
    try {
        const { courseId, studentId } = req.params;
        // Default excludes chats where the student never sent a message
        // (#519) - see GET /:courseId above.
        const includeEmptyChats = req.query.includeEmptyChats === 'true';

        // Get authenticated user information
        const user = req.user;
        if (!user) {
            return res.status(401).json({
                success: false,
                message: 'Authentication required'
            });
        }
        
        // Get database instance from app.locals
        const db = req.app.locals.db;
        if (!db) {
            return res.status(503).json({
                success: false,
                message: 'Database connection not available'
            });
        }

        if (!requireDownloadAdmin(user, res)) {
            return;
        }
        
        // System admins can download from any course.
        const coursesCollection = db.collection('courses');
        const course = await coursesCollection.findOne({ courseId });
        
        if (!course) {
            return res.status(404).json({
                success: false,
                message: 'Course not found or access denied'
            });
        }
        
        // Get all chat sessions for this student in this course (excluding soft deleted)
        // Instructors should still see sessions deleted by students (studentDeleted: true)
        const chatSessionsCollection = db.collection('chat_sessions');
        const sessions = await chatSessionsCollection.find({ 
            courseId: courseId,
            studentId: studentId,
            $or: [
                { isDeleted: { $exists: false } }, // Legacy sessions without isDeleted field
                { isDeleted: false } // Non-deleted sessions
            ]
        }).sort({ savedAt: -1 }).toArray();

        console.log(`Retrieved ${sessions.length} sessions for student ${studentId} in course ${courseId}`);

        // Recalculate duration for each session, then drop sessions where
        // the student never sent a message, unless explicitly included
        // (#519).
        const sessionsWithCalculatedDuration = sessions
            .map(session => ({
                ...session,
                duration: calculateDurationFromSessionData(session)
            }))
            .filter(session => includeEmptyChats || hasStudentMessage(session));

        res.json({
            success: true,
            data: {
                courseId: courseId,
                studentId: studentId,
                studentName: sessions[0]?.studentName || 'Unknown Student',
                sessions: sessionsWithCalculatedDuration
            }
        });

    } catch (error) {
        console.error('Error fetching student sessions:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error while fetching student sessions'
        });
    }
});

/**
 * GET /api/students/:courseId/:studentId/sessions/:sessionId
 * Get a specific chat session data for download
 */
router.get('/:courseId/:studentId/sessions/:sessionId', async (req, res) => {
    try {
        const { courseId, studentId, sessionId } = req.params;
        
        // Get authenticated user information
        const user = req.user;
        if (!user) {
            return res.status(401).json({
                success: false,
                message: 'Authentication required'
            });
        }
        
        // Get database instance from app.locals
        const db = req.app.locals.db;
        if (!db) {
            return res.status(503).json({
                success: false,
                message: 'Database connection not available'
            });
        }

        if (!requireDownloadAdmin(user, res)) {
            return;
        }
        
        // System admins can download from any course.
        const coursesCollection = db.collection('courses');
        const course = await coursesCollection.findOne({ courseId });
        
        if (!course) {
            return res.status(404).json({
                success: false,
                message: 'Course not found or access denied'
            });
        }
        
        // Get the specific chat session (excluding soft deleted)
        const chatSessionsCollection = db.collection('chat_sessions');
        const session = await chatSessionsCollection.findOne({ 
            courseId: courseId,
            studentId: studentId,
            sessionId: sessionId,
            $or: [
                { isDeleted: { $exists: false } }, // Legacy sessions without isDeleted field
                { isDeleted: false } // Non-deleted sessions
            ]
        });
        
        if (!session) {
            return res.status(404).json({
                success: false,
                message: 'Chat session not found'
            });
        }
        
        console.log(`Retrieved chat session ${sessionId} for student ${studentId}`);

        res.json({
            success: true,
            data: {
                ...session,
                duration: calculateDurationFromSessionData(session)
            }
        });
        
    } catch (error) {
        console.error('Error fetching chat session:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error while fetching chat session'
        });
    }
});

/**
 * DELETE /api/students/:courseId/:studentId/sessions/:sessionId/own
 * Delete a specific chat session for a student (student access)
 */
router.delete('/:courseId/:studentId/sessions/:sessionId/own', async (req, res) => {
    try {
        const { courseId, studentId, sessionId } = req.params;
        
        // Get authenticated user information
        const user = req.user;
        if (!user) {
            return res.status(401).json({
                success: false,
                error: 'Authentication required'
            });
        }

        // Students can only delete their own chat sessions
        if (user.role === 'student' && user.userId !== studentId) {
            return res.status(403).json({
                success: false,
                error: 'You can only delete your own chat sessions'
            });
        }

        // Instructors can delete any student's sessions
        if (user.role !== 'instructor' && user.role !== 'student') {
            return res.status(403).json({
                success: false,
                error: 'Access denied'
            });
        }

        const db = req.app.locals.db;
        if (!db) {
            return res.status(500).json({
                success: false,
                error: 'Database connection not available'
            });
        }

        const chatSessionsCollection = db.collection('chat_sessions');
        
        // Find the session to ensure it belongs to the student and is not already deleted
        const session = await chatSessionsCollection.findOne({
            sessionId: sessionId,
            courseId: courseId,
            studentId: studentId,
            $or: [
                { isDeleted: { $exists: false } }, // Legacy sessions without isDeleted field
                { isDeleted: false } // Non-deleted sessions
            ]
        });

        if (!session) {
            return res.status(404).json({
                success: false,
                error: 'Chat session not found or does not belong to this student'
            });
        }

        // Soft delete the session for STUDENT ONLY by setting studentDeleted to true
        // This keeps it visible for instructors (who filter by isDeleted)
        const result = await chatSessionsCollection.updateOne({
            sessionId: sessionId,
            courseId: courseId,
            studentId: studentId
        }, {
            $set: {
                studentDeleted: true,
                studentDeletedAt: new Date()
            }
        });

        if (result.matchedCount === 0) {
            return res.status(404).json({
                success: false,
                error: 'Chat session not found'
            });
        }

        console.log(`Soft deleted (student-only) chat session ${sessionId} for student ${studentId} in course ${courseId}`);

        res.json({
            success: true,
            message: 'Chat session deleted successfully',
            data: { sessionId, courseId, studentId }
        });

    } catch (error) {
        console.error('Error deleting chat session:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to delete chat session'
        });
    }
});

/**
 * DELETE /api/students/:courseId/:studentId/sessions/:sessionId
 * Delete a specific chat session for a student (instructor access)
 */
router.delete('/:courseId/:studentId/sessions/:sessionId', async (req, res) => {
    try {
        const { courseId, studentId, sessionId } = req.params;
        
        const user = req.user;
        if (!user) {
            return res.status(401).json({
                success: false,
                error: 'Authentication required'
            });
        }

        if (user.role !== 'instructor') {
            return res.status(403).json({
                success: false,
                error: 'Only instructors can delete student chat sessions'
            });
        }

        const db = req.app.locals.db;
        if (!db) {
            return res.status(500).json({
                success: false,
                error: 'Database connection not available'
            });
        }

        if (!(await CourseModel.userHasCourseAccess(db, courseId, user.userId, 'instructor'))) {
            return res.status(403).json({
                success: false,
                error: 'You do not have access to this course'
            });
        }

        const chatSessionsCollection = db.collection('chat_sessions');
        
        // Find the session to ensure it belongs to the student and is not already deleted
        const session = await chatSessionsCollection.findOne({
            sessionId: sessionId,
            courseId: courseId,
            studentId: studentId,
            $or: [
                { isDeleted: { $exists: false } }, // Legacy sessions without isDeleted field
                { isDeleted: false } // Non-deleted sessions
            ]
        });

        if (!session) {
            return res.status(404).json({
                success: false,
                error: 'Chat session not found or does not belong to this student'
            });
        }

        // Soft delete the session by setting isDeleted to true
        const result = await chatSessionsCollection.updateOne({
            sessionId: sessionId,
            courseId: courseId,
            studentId: studentId
        }, {
            $set: {
                isDeleted: true,
                deletedAt: new Date()
            }
        });

        if (result.matchedCount === 0) {
            return res.status(404).json({
                success: false,
                error: 'Chat session not found'
            });
        }

        console.log(`Soft deleted chat session ${sessionId} for student ${studentId} in course ${courseId}`);

        res.json({
            success: true,
            message: 'Chat session deleted successfully',
            data: { sessionId, courseId, studentId }
        });

    } catch (error) {
        console.error('Error deleting chat session:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to delete chat session'
        });
    }
});

/**
 * PUT /api/students/:courseId/:studentId/sessions/:sessionId/title
 * Update the title of a specific chat session
 */
router.put('/:courseId/:studentId/sessions/:sessionId/title', async (req, res) => {
    try {
        const { courseId, studentId, sessionId } = req.params;
        const { title } = req.body;

        if (!title) {
            return res.status(400).json({
                success: false,
                error: 'Course ID, Student ID, Session ID, and Title are required'
            });
        }

        // Get authenticated user information
        const user = req.user;
        if (!user) {
            return res.status(401).json({
                success: false,
                error: 'Authentication required'
            });
        }

        // Students can only update their own chat sessions
        if (user.role === 'student' && user.userId !== studentId) {
            return res.status(403).json({
                success: false,
                error: 'You can only update your own chat sessions'
            });
        }

        // Instructors can update any student's sessions (though UI might not expose this yet)
        if (user.role !== 'instructor' && user.role !== 'student') {
            return res.status(403).json({
                success: false,
                error: 'Access denied'
            });
        }

        const db = req.app.locals.db;
        if (!db) {
            return res.status(500).json({
                success: false,
                error: 'Database connection not available'
            });
        }

        if (user.role === 'instructor' &&
            !(await CourseModel.userHasCourseAccess(db, courseId, user.userId, 'instructor'))) {
            return res.status(403).json({
                success: false,
                error: 'You do not have access to this course'
            });
        }

        const chatSessionsCollection = db.collection('chat_sessions');

        // Check if session exists and belongs to the user
        const session = await chatSessionsCollection.findOne({
            sessionId: sessionId,
            courseId: courseId,
            studentId: studentId,
            $or: [
                { isDeleted: { $exists: false } },
                { isDeleted: false }
            ]
        });

        if (!session) {
            return res.status(404).json({
                success: false,
                error: 'Chat session not found'
            });
        }

        // Update the title
        const result = await chatSessionsCollection.updateOne({
            sessionId: sessionId,
            courseId: courseId,
            studentId: studentId
        }, {
            $set: {
                title: title,
                lastModified: new Date()
            }
        });

        if (result.matchedCount === 0) {
            return res.status(404).json({
                success: false,
                error: 'Chat session not found'
            });
        }

        console.log(`Updated title for chat session ${sessionId}: "${title}"`);

        res.json({
            success: true,
            message: 'Chat session title updated successfully',
            data: { 
                sessionId, 
                title 
            }
        });

    } catch (error) {
        console.error('Error updating chat session title:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to update chat session title'
        });
    }
});

module.exports = router;
