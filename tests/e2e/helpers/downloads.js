// @ts-check
/**
 * Shared seed data for instructor chat-download e2e tests.
 */

const { withDb, getUserIdByUsername } = require('./quiz');

const DOWNLOAD_COURSE_ID = 'BIOC-E2E-DOWNLOADS';
const DOWNLOAD_COURSE_NAME = 'BIOC E2E Downloads';
const DOWNLOAD_OTHER_COURSE_ID = 'BIOC-E2E-DOWNLOADS-OTHER';
const DOWNLOAD_OTHER_COURSE_NAME = 'BIOC E2E Downloads Other';
const DOWNLOAD_UNRELATED_COURSE_ID = 'BIOC-E2E-DOWNLOADS-UNRELATED';
const DOWNLOAD_UNRELATED_INSTRUCTOR_ID = 'user_e2e_downloads_unrelated_instructor';
const DOWNLOAD_EMPTY_COURSE_ID = 'BIOC-E2E-DOWNLOADS-EMPTY';
const DOWNLOAD_EMPTY_COURSE_NAME = 'BIOC E2E Downloads Empty';
const DOWNLOAD_LARGE_COURSE_ID = 'BIOC-E2E-DOWNLOADS-LARGE';
const DOWNLOAD_LARGE_COURSE_NAME = 'BIOC E2E Downloads Large';

const DOWNLOAD_STUDENT_ID = 'user_e2e_downloads_student_a';
const DOWNLOAD_STUDENT_NAME = 'Casey Download';
const DOWNLOAD_SECOND_STUDENT_ID = 'user_e2e_downloads_student_b';
const DOWNLOAD_SECOND_STUDENT_NAME = 'Riley Reports';
const DOWNLOAD_LARGE_STUDENT_ID = 'user_e2e_downloads_student_c';
const DOWNLOAD_LARGE_STUDENT_NAME = 'Sam Sessionful';
const DOWNLOAD_WELCOME_ONLY_STUDENT_ID = 'user_e2e_downloads_student_d';
const DOWNLOAD_WELCOME_ONLY_STUDENT_NAME = 'Morgan Welcome';

const SESSION_VISIBLE_ID = 'e2e_downloads_visible_session';
const SESSION_STUDENT_DELETED_ID = 'e2e_downloads_student_deleted_session';
const SESSION_LEGACY_ID = 'e2e_downloads_legacy_session';
const SESSION_SOFT_DELETED_ID = 'e2e_downloads_soft_deleted_session';
const SESSION_OTHER_COURSE_ID = 'e2e_downloads_other_course_session';
const SESSION_UNRELATED_ID = 'e2e_downloads_unrelated_session';
const SESSION_LARGE_ID = 'e2e_downloads_large_session';
const SESSION_LARGE_MESSAGE_COUNT = 25;
const SESSION_WELCOME_ONLY_ID = 'e2e_downloads_welcome_only_session';

const DOWNLOAD_COURSE_IDS = [
    DOWNLOAD_COURSE_ID,
    DOWNLOAD_OTHER_COURSE_ID,
    DOWNLOAD_UNRELATED_COURSE_ID,
    DOWNLOAD_EMPTY_COURSE_ID,
    DOWNLOAD_LARGE_COURSE_ID,
];

function buildCourseDoc({ courseId, courseName, instructorId, status = 'active' }) {
    const now = new Date();
    return {
        courseId,
        courseName,
        courseCode: `${courseId}-S`,
        instructorCourseCode: `${courseId}-I`,
        instructorId,
        instructors: [instructorId],
        tas: [],
        courseDescription: '',
        assessmentCriteria: '',
        courseMaterials: [],
        approvedStruggleTopics: [],
        courseStructure: { weeks: 1, lecturesPerWeek: 1, totalUnits: 1 },
        isOnboardingComplete: true,
        status,
        lectures: [
            {
                name: 'Unit 1',
                displayName: 'Unit 1',
                isPublished: true,
                learningObjectives: [],
                passThreshold: 0,
                createdAt: now,
                updatedAt: now,
                documents: [],
                assessmentQuestions: [],
            },
        ],
        createdAt: now,
        updatedAt: now,
    };
}

function buildSessionDoc({
    sessionId,
    courseId = DOWNLOAD_COURSE_ID,
    studentId = DOWNLOAD_STUDENT_ID,
    studentName = DOWNLOAD_STUDENT_NAME,
    title = 'Seeded Download Session',
    savedAt,
    messages,
    isDeleted = false,
    studentDeleted = false,
    omitIsDeleted = false,
}) {
    const doc = {
        sessionId,
        courseId,
        studentId,
        studentName,
        unitName: 'Unit 1',
        title,
        messageCount: messages.length,
        savedAt,
        chatData: { messages },
        studentDeleted,
        createdAt: new Date(savedAt),
        updatedAt: new Date(savedAt),
    };

    if (!omitIsDeleted) {
        doc.isDeleted = isDeleted;
    }

    return doc;
}

async function setSystemAdmin(userId, isAdmin) {
    await withDb(async (db) => {
        if (isAdmin) {
            await db.collection('users').updateOne(
                { userId },
                { $set: { 'permissions.systemAdmin': true, updatedAt: new Date() } }
            );
            return;
        }

        await db.collection('users').updateOne(
            { userId },
            { $unset: { 'permissions.systemAdmin': '' }, $set: { updatedAt: new Date() } }
        );
    });
}

async function resetDownloadData({ instructorId }) {
    const visibleMessages = [
        {
            type: 'user',
            content: 'Hello <strong>Casey</strong>',
            timestamp: '2026-01-15T10:00:00.000Z',
        },
        {
            type: 'bot',
            content: '<p>Here is a safe response with ATP.</p>',
            timestamp: '2026-01-15T10:00:09.000Z',
        },
    ];

    await withDb(async (db) => {
        await db.collection('courses').deleteMany({ courseId: { $in: DOWNLOAD_COURSE_IDS } });
        await db.collection('chat_sessions').deleteMany({ courseId: { $in: DOWNLOAD_COURSE_IDS } });

        await db.collection('courses').insertMany([
            buildCourseDoc({
                courseId: DOWNLOAD_COURSE_ID,
                courseName: DOWNLOAD_COURSE_NAME,
                instructorId,
            }),
            buildCourseDoc({
                courseId: DOWNLOAD_OTHER_COURSE_ID,
                courseName: DOWNLOAD_OTHER_COURSE_NAME,
                instructorId,
            }),
            buildCourseDoc({
                courseId: DOWNLOAD_UNRELATED_COURSE_ID,
                courseName: 'BIOC E2E Downloads Unrelated',
                instructorId: DOWNLOAD_UNRELATED_INSTRUCTOR_ID,
            }),
            buildCourseDoc({
                courseId: DOWNLOAD_EMPTY_COURSE_ID,
                courseName: DOWNLOAD_EMPTY_COURSE_NAME,
                instructorId,
            }),
            buildCourseDoc({
                courseId: DOWNLOAD_LARGE_COURSE_ID,
                courseName: DOWNLOAD_LARGE_COURSE_NAME,
                instructorId,
            }),
        ]);

        const largeMessages = [];
        const largeBase = Date.UTC(2026, 0, 21, 10, 0, 0);
        for (let i = 0; i < SESSION_LARGE_MESSAGE_COUNT; i++) {
            const isUser = i % 2 === 0;
            largeMessages.push({
                type: isUser ? 'user' : 'bot',
                content: isUser ? `Student message ${i + 1}` : `Bot reply ${i + 1}`,
                timestamp: new Date(largeBase + i * 1000).toISOString(),
            });
        }

        await db.collection('chat_sessions').insertMany([
            buildSessionDoc({
                sessionId: SESSION_VISIBLE_ID,
                title: 'Visible Download Chat',
                savedAt: '2026-01-15T10:00:00.000Z',
                messages: visibleMessages,
            }),
            buildSessionDoc({
                sessionId: SESSION_STUDENT_DELETED_ID,
                title: 'Student Deleted But Instructor Visible',
                savedAt: '2026-01-16T10:00:00.000Z',
                messages: [
                    {
                        type: 'user',
                        content: 'I deleted this from my history.',
                        timestamp: '2026-01-16T10:00:00.000Z',
                    },
                    {
                        type: 'bot',
                        content: 'Instructor downloads should still include it.',
                        timestamp: '2026-01-16T10:00:03.000Z',
                    },
                ],
                studentDeleted: true,
            }),
            buildSessionDoc({
                sessionId: SESSION_LEGACY_ID,
                studentId: DOWNLOAD_SECOND_STUDENT_ID,
                studentName: DOWNLOAD_SECOND_STUDENT_NAME,
                title: 'Legacy Session Without Delete Flag',
                savedAt: '2026-01-17T10:00:00.000Z',
                messages: [
                    {
                        type: 'user',
                        content: 'Legacy session should stay visible.',
                        timestamp: '2026-01-17T10:00:00.000Z',
                    },
                ],
                omitIsDeleted: true,
            }),
            buildSessionDoc({
                sessionId: SESSION_SOFT_DELETED_ID,
                title: 'Soft Deleted Download Chat',
                savedAt: '2026-01-18T10:00:00.000Z',
                messages: [
                    {
                        type: 'user',
                        content: 'Globally deleted session.',
                        timestamp: '2026-01-18T10:00:00.000Z',
                    },
                ],
                isDeleted: true,
            }),
            buildSessionDoc({
                sessionId: SESSION_OTHER_COURSE_ID,
                courseId: DOWNLOAD_OTHER_COURSE_ID,
                title: 'Other Course Chat',
                savedAt: '2026-01-19T10:00:00.000Z',
                messages: [
                    {
                        type: 'user',
                        content: 'Other course content.',
                        timestamp: '2026-01-19T10:00:00.000Z',
                    },
                ],
            }),
            buildSessionDoc({
                sessionId: SESSION_UNRELATED_ID,
                courseId: DOWNLOAD_UNRELATED_COURSE_ID,
                title: 'Unrelated Instructor Chat',
                savedAt: '2026-01-20T10:00:00.000Z',
                messages: [
                    {
                        type: 'user',
                        content: 'Unrelated instructor content.',
                        timestamp: '2026-01-20T10:00:00.000Z',
                    },
                ],
            }),
            buildSessionDoc({
                sessionId: SESSION_LARGE_ID,
                courseId: DOWNLOAD_LARGE_COURSE_ID,
                studentId: DOWNLOAD_LARGE_STUDENT_ID,
                studentName: DOWNLOAD_LARGE_STUDENT_NAME,
                title: 'Large Session With Many Messages',
                savedAt: '2026-01-21T10:00:00.000Z',
                messages: largeMessages,
            }),
            buildSessionDoc({
                sessionId: SESSION_WELCOME_ONLY_ID,
                studentId: DOWNLOAD_WELCOME_ONLY_STUDENT_ID,
                studentName: DOWNLOAD_WELCOME_ONLY_STUDENT_NAME,
                title: 'Welcome Message Only',
                savedAt: '2026-01-22T10:00:00.000Z',
                // No user message ever sent - just the auto-welcome bot
                // message landing. Excluded from the list by default (#519).
                messages: [
                    {
                        type: 'bot',
                        content: 'Welcome to BiocBot! I can see you have access to published units.',
                        timestamp: '2026-01-22T10:00:00.000Z',
                    },
                ],
            }),
        ]);
    });
}

async function cleanupDownloadData(instructorId) {
    await withDb(async (db) => {
        await db.collection('courses').deleteMany({ courseId: { $in: DOWNLOAD_COURSE_IDS } });
        await db.collection('chat_sessions').deleteMany({ courseId: { $in: DOWNLOAD_COURSE_IDS } });
        if (instructorId) {
            await db.collection('users').updateOne(
                { userId: instructorId },
                { $unset: { 'permissions.systemAdmin': '' }, $set: { updatedAt: new Date() } }
            );
        }
    });
}

async function getInstructorId() {
    return getUserIdByUsername('e2e_instructor');
}

module.exports = {
    DOWNLOAD_COURSE_ID,
    DOWNLOAD_COURSE_NAME,
    DOWNLOAD_OTHER_COURSE_ID,
    DOWNLOAD_EMPTY_COURSE_ID,
    DOWNLOAD_EMPTY_COURSE_NAME,
    DOWNLOAD_LARGE_COURSE_ID,
    DOWNLOAD_LARGE_COURSE_NAME,
    DOWNLOAD_STUDENT_ID,
    DOWNLOAD_STUDENT_NAME,
    DOWNLOAD_SECOND_STUDENT_ID,
    DOWNLOAD_SECOND_STUDENT_NAME,
    DOWNLOAD_LARGE_STUDENT_ID,
    DOWNLOAD_LARGE_STUDENT_NAME,
    DOWNLOAD_WELCOME_ONLY_STUDENT_ID,
    DOWNLOAD_WELCOME_ONLY_STUDENT_NAME,
    SESSION_VISIBLE_ID,
    SESSION_STUDENT_DELETED_ID,
    SESSION_LEGACY_ID,
    SESSION_SOFT_DELETED_ID,
    SESSION_OTHER_COURSE_ID,
    SESSION_UNRELATED_ID,
    SESSION_LARGE_ID,
    SESSION_LARGE_MESSAGE_COUNT,
    SESSION_WELCOME_ONLY_ID,
    getInstructorId,
    setSystemAdmin,
    resetDownloadData,
    cleanupDownloadData,
};
