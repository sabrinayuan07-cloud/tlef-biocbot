/**
 * Unit tests for the preview sandbox's persistence: the user record that backs
 * it, and the reset that has to leave no trace in the instructor's real course.
 */
const { memoryDb } = require('../helpers/memory-db');
const PreviewState = require('../../../src/models/PreviewState');
const previewSession = require('../../../src/services/previewSession');

const instructor = { userId: 'inst-1', role: 'instructor', permissions: { systemAdmin: false } };
const COURSE_ID = 'BIOC-302';
const PREVIEW_ID = previewSession.buildPreviewUserId('inst-1', COURSE_ID);

beforeAll(() => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterAll(() => {
    jest.restoreAllMocks();
});

/**
 * Build a grant for the test instructor.
 * @returns {Object} Preview grant
 */
function grant() {
    return previewSession.createGrant(instructor, COURSE_ID);
}

describe('ensurePreviewUser', () => {
    test('creates a marked, un-onboarded student record', async () => {
        const db = memoryDb({ users: [] });

        await PreviewState.ensurePreviewUser(db, instructor, grant());

        const user = await db.collection('users').findOne({ userId: PREVIEW_ID });
        expect(user.role).toBe('student');
        expect(user.isPreview).toBe(true);
        expect(user.isActive).toBe(true);
        expect(user.studentOnboardingComplete).toBe(false);
        expect(user.previewOwnerId).toBe('inst-1');
        expect(user.preferences.courseId).toBe(COURSE_ID);
    });

    test('reopening a preview keeps accumulated sandbox state', async () => {
        const db = memoryDb({ users: [] });

        await PreviewState.ensurePreviewUser(db, instructor, grant());
        await db.collection('users').updateOne(
            { userId: PREVIEW_ID },
            { $set: { studentOnboardingComplete: true, struggleState: { topics: ['glycolysis'] } } }
        );

        await PreviewState.ensurePreviewUser(db, instructor, grant());

        const user = await db.collection('users').findOne({ userId: PREVIEW_ID });
        // Reopening must not replay the welcome flow or wipe progress.
        expect(user.studentOnboardingComplete).toBe(true);
        expect(user.struggleState.topics).toEqual(['glycolysis']);
    });
});

describe('resetPreviewData', () => {
    test('removes sandbox rows and leaves real student rows alone', async () => {
        const db = memoryDb({
            chat_sessions: [
                { sessionId: 'a', studentId: PREVIEW_ID, courseId: COURSE_ID },
                { sessionId: 'b', studentId: 'real-student', courseId: COURSE_ID }
            ],
            quizAttempts: [{ studentId: PREVIEW_ID }, { studentId: 'real-student' }],
            struggleActivity: [{ userId: PREVIEW_ID }, { userId: 'real-student' }],
            users: [],
            previewStates: [],
            courses: []
        });

        await PreviewState.resetPreviewData(db, PREVIEW_ID);

        const sessions = await db.collection('chat_sessions').find({}).toArray();
        const attempts = await db.collection('quizAttempts').find({}).toArray();
        const struggles = await db.collection('struggleActivity').find({}).toArray();

        expect(sessions.map(s => s.studentId)).toEqual(['real-student']);
        expect(attempts.map(a => a.studentId)).toEqual(['real-student']);
        expect(struggles.map(s => s.userId)).toEqual(['real-student']);
    });

    test('clears a stale enrollment entry without touching real enrollments', async () => {
        const db = memoryDb({
            courses: [{
                courseId: COURSE_ID,
                studentEnrollment: {
                    [PREVIEW_ID]: { enrolled: true },
                    'real-student': { enrolled: true }
                }
            }],
            users: [],
            previewStates: []
        });

        await PreviewState.resetPreviewData(db, PREVIEW_ID);

        const course = await db.collection('courses').findOne({ courseId: COURSE_ID });
        expect(course.studentEnrollment[PREVIEW_ID]).toBeUndefined();
        expect(course.studentEnrollment['real-student']).toEqual({ enrolled: true });
    });

    test('resets the sandbox back to a first visit', async () => {
        const db = memoryDb({
            users: [{
                userId: PREVIEW_ID,
                isPreview: true,
                studentOnboardingComplete: true,
                struggleState: { topics: ['glycolysis'] }
            }],
            previewStates: [],
            courses: []
        });

        await PreviewState.resetPreviewData(db, PREVIEW_ID);

        const user = await db.collection('users').findOne({ userId: PREVIEW_ID });
        expect(user.studentOnboardingComplete).toBe(false);
        expect(user.struggleState).toEqual({ topics: [] });
    });
});

describe('preview state', () => {
    test('an unknown sandbox reads as a first visit, not an error', async () => {
        const db = memoryDb({ previewStates: [] });

        const state = await PreviewState.getState(db, '__preview__nobody::X');
        expect(state.firstRunCompleted).toBe(false);
    });

    test('records first-run completion so a later visit skips the walkthrough', async () => {
        const db = memoryDb({ previewStates: [] });

        await PreviewState.setFirstRunCompleted(db, PREVIEW_ID, true);

        const state = await PreviewState.getState(db, PREVIEW_ID);
        expect(state.firstRunCompleted).toBe(true);
    });
});

describe('destroySandbox', () => {
    test('leaves nothing behind for the next preview to find', async () => {
        const db = memoryDb({
            chat_sessions: [
                { sessionId: 'c1', studentId: PREVIEW_ID, courseId: COURSE_ID },
                { sessionId: 'c2', studentId: 'real-student', courseId: COURSE_ID }
            ],
            quizAttempts: [{ studentId: PREVIEW_ID }],
            // Which chats the sandbox started (src/models/ChatSessionStart.js).
            chatSessionStarts: [
                { userId: PREVIEW_ID, sessionId: 'c1', courseId: COURSE_ID },
                { userId: 'real-student', sessionId: 'c2', courseId: COURSE_ID }
            ],
            users: [
                { userId: PREVIEW_ID, isPreview: true, studentOnboardingComplete: true },
                { userId: 'real-student', role: 'student' }
            ],
            previewStates: [{ previewUserId: PREVIEW_ID, firstRunCompleted: true }],
            courses: []
        });

        await PreviewState.destroySandbox(db, PREVIEW_ID);

        expect(await db.collection('chat_sessions').findOne({ studentId: PREVIEW_ID })).toBeNull();
        expect(await db.collection('quizAttempts').findOne({ studentId: PREVIEW_ID })).toBeNull();
        expect(await db.collection('chatSessionStarts').findOne({ userId: PREVIEW_ID })).toBeNull();
        expect(await db.collection('chatSessionStarts').findOne({ userId: 'real-student' })).not.toBeNull();
        expect(await db.collection('users').findOne({ userId: PREVIEW_ID })).toBeNull();
        expect(await db.collection('previewStates').findOne({ previewUserId: PREVIEW_ID })).toBeNull();

        // A re-entered preview therefore starts as a first visit again.
        const state = await PreviewState.getState(db, PREVIEW_ID);
        expect(state.firstRunCompleted).toBe(false);
    });

    test('never touches a real student alongside the sandbox', async () => {
        const db = memoryDb({
            chat_sessions: [{ sessionId: 'c2', studentId: 'real-student', courseId: COURSE_ID }],
            users: [{ userId: 'real-student', role: 'student' }],
            previewStates: [],
            courses: []
        });

        await PreviewState.destroySandbox(db, PREVIEW_ID);

        expect(await db.collection('chat_sessions').findOne({ studentId: 'real-student' })).not.toBeNull();
        expect(await db.collection('users').findOne({ userId: 'real-student' })).not.toBeNull();
    });
});
