/**
 * Courses API Routes — instructor course statistics
 */

const express = require('express');
const router = express.Router();
const previewSession = require('../services/previewSession');

/**
 * Calculate the measured duration of a saved student chat. Newer sessions
 * persist an elapsedTime (milliseconds since the preceding message) on every
 * message; summing those values preserves the timing captured by the client.
 * Older sessions fall back to their message timestamps.
 *
 * @param {Object} session - Saved chat session
 * @returns {number} Measured duration in milliseconds
 */
function calculateMeasuredSessionDurationMs(session) {
    const messages = Array.isArray(session?.chatData?.messages)
        ? session.chatData.messages
        : [];
    const firstUserIndex = messages.findIndex(message => message?.type === 'user');
    if (firstUserIndex === -1) return 0;

    const isSyntheticBotMessage = (message) => {
        if (!message || message.type !== 'bot') return false;
        if (message.sourceAttribution?.source === 'System') return true;
        const content = typeof message.content === 'string' ? message.content : '';
        return content.includes('Welcome to BiocBot!') &&
            content.includes('I can see you have access to published units');
    };

    let endIndex = -1;
    for (let index = messages.length - 1; index >= firstUserIndex; index--) {
        if (messages[index]?.type === 'bot' && !isSyntheticBotMessage(messages[index])) {
            endIndex = index;
            break;
        }
    }
    if (endIndex === -1) {
        for (let index = messages.length - 1; index >= firstUserIndex; index--) {
            if (!isSyntheticBotMessage(messages[index])) {
                endIndex = index;
                break;
            }
        }
    }
    if (endIndex <= firstUserIndex) return 0;

    const elapsedIntervals = messages
        .slice(firstUserIndex + 1, endIndex + 1)
        .map(message => message?.elapsedTime !== null
            && message?.elapsedTime !== undefined
            && message?.elapsedTime !== ''
            ? Number(message.elapsedTime)
            : NaN);
    if (elapsedIntervals.every(value => Number.isFinite(value) && value >= 0)) {
        return elapsedIntervals.reduce((total, value) => total + value, 0);
    }

    const startMs = new Date(messages[firstUserIndex]?.timestamp).getTime();
    const endMs = new Date(messages[endIndex]?.timestamp).getTime();
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
        return 0;
    }
    return endMs - startMs;
}

/**
 * GET /api/courses/statistics
 * Get aggregated statistics for all instructor/TA courses
 * NOTE: This route must come before /:courseId to avoid route matching issues
 */
router.get('/statistics', async (req, res) => {
    try {
        // Get authenticated user information
        const user = req.user;
        if (!user) {
            return res.status(401).json({
                success: false,
                message: 'Authentication required'
            });
        }
        
        // Only instructors and assigned TAs can access statistics
        if (user.role !== 'instructor' && user.role !== 'ta') {
            return res.status(403).json({
                success: false,
                message: 'Only instructors and TAs can access statistics'
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
        
        // Get courseId from query params if provided
        const { courseId: requestedCourseId } = req.query;
        
        // Get all courses for this instructor or TA
        const coursesCollection = db.collection('courses');
        let coursesQuery = { status: { $ne: 'deleted' } };

        if (user.role === 'instructor') {
            coursesQuery.$or = [
                { instructorId: user.userId },
                { instructors: user.userId }
            ];
        } else {
            coursesQuery.tas = user.userId;
        }
        
        // If a specific courseId is requested, filter to that course
        if (requestedCourseId) {
            coursesQuery.courseId = requestedCourseId;
        }
        
        const courses = await coursesCollection.find(coursesQuery).toArray();
        
        if (courses.length === 0) {
            return res.json({
                success: true,
                data: {
                    totalStudents: 0,
                    totalSessions: 0,
                    modeDistribution: { tutor: 0, protege: 0 },
                    averageSessionLength: 0,
                    averageMessagesPerSession: 0,
                    averageMessageLength: 0
                }
            });
        }
        
        const courseIds = courses.map(c => c.courseId);
        
        // Get all chat sessions for these courses
        const chatSessionsCollection = db.collection('chat_sessions');
        const allSessions = await chatSessionsCollection.find({
            courseId: { $in: courseIds },
            // Sandbox transcripts from "View as Student" would inflate student
            // counts and skew every average below.
            ...previewSession.excludePreviewFilter('studentId'),
            $or: [
                { isDeleted: { $exists: false } },
                { isDeleted: false }
            ]
        }).toArray();
        
        // Calculate statistics
        const uniqueStudents = new Set();
        let totalMessages = 0;
        let totalMessageLength = 0;
        let messageCount = 0;
        let modeDistribution = { tutor: 0, protege: 0 };
        let totalSessionDurationMs = 0;
        let sessionsWithDuration = 0;
        
        allSessions.forEach(session => {
            const durationMs = calculateMeasuredSessionDurationMs(session);

            // Empty/instantaneous autosaves are not real dashboard sessions.
            // Exclude them from the count and every per-session aggregation so
            // totals, mode distribution, and averages stay internally aligned.
            if (durationMs <= 0) return;

            totalSessionDurationMs += durationMs;
            sessionsWithDuration++;

            // Count unique students
            if (session.studentId) {
                uniqueStudents.add(session.studentId);
            }
            
            // Get mode from chatData
            if (session.chatData && session.chatData.metadata) {
                const mode = session.chatData.metadata.currentMode || 'tutor';
                if (mode === 'protege' || mode === 'protégé') {
                    modeDistribution.protege++;
                } else {
                    modeDistribution.tutor++;
                }
            } else {
                // Default to tutor if mode not found
                modeDistribution.tutor++;
            }
            
            // Calculate message statistics
            if (session.chatData && session.chatData.messages && Array.isArray(session.chatData.messages)) {
                const messages = session.chatData.messages;
                totalMessages += messages.length;
                
                messages.forEach(msg => {
                    if (msg.content && typeof msg.content === 'string') {
                        totalMessageLength += msg.content.length;
                        messageCount++;
                    }
                });
            }
            
        });
        
        // Calculate averages
        const totalSessions = sessionsWithDuration;
        const averageSessionLength = sessionsWithDuration > 0 
            ? Math.round(totalSessionDurationMs / sessionsWithDuration / 1000) // in seconds
            : 0;
        const averageMessagesPerSession = totalSessions > 0 
            ? Math.round((totalMessages / totalSessions) * 10) / 10 
            : 0;
        const averageMessageLength = messageCount > 0 
            ? Math.round(totalMessageLength / messageCount) 
            : 0;
        
        // Format average session length
        const formatDuration = (seconds) => {
            if (seconds < 60) {
                return `${seconds}s`;
            } else if (seconds < 3600) {
                const minutes = Math.floor(seconds / 60);
                const secs = seconds % 60;
                return `${minutes}m ${secs}s`;
            } else {
                const hours = Math.floor(seconds / 3600);
                const minutes = Math.floor((seconds % 3600) / 60);
                return `${hours}h ${minutes}m`;
            }
        };
        
        res.json({
            success: true,
            data: {
                totalStudents: uniqueStudents.size,
                totalSessions: totalSessions,
                modeDistribution: modeDistribution,
                averageSessionLength: formatDuration(averageSessionLength),
                averageSessionLengthSeconds: averageSessionLength,
                averageMessagesPerSession: averageMessagesPerSession,
                averageMessageLength: averageMessageLength
            }
        });
        
    } catch (error) {
        console.error('Error fetching statistics:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error while fetching statistics'
        });
    }
});

module.exports = router;
