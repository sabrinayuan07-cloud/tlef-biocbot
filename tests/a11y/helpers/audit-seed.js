// @ts-check
/**
 * Seed data for the audit-*.a11y.spec.js files: one realistic course (and a
 * second, plainer one) with enough in every list for the pages to render their
 * populated states: at least two students, flags, topics, notes, sessions.
 *
 * Everything written here carries the BIOC-A11Y-AUD / a11y_aud prefix and is
 * removed by cleanupAuditData(). Shared documents that other suites also use
 * (the settings collection, the instructor's admin flag) are read first and put
 * back as they were.
 */
const { TEST_USERS } = require('../../e2e/helpers/users');
const { withDb, getUserIdByUsername } = require('../../e2e/helpers/courses-test');
const { createValidLlmApiKey } = require('../../e2e/helpers/llm-keys');

const MAIN = 'BIOC-A11Y-AUD-MAIN';
const MAIN_NAME = 'Audit Biochemistry 201';
const SECOND = 'BIOC-A11Y-AUD-SECOND';
const SECOND_NAME = 'Audit Cell Biology 110';
const JOINABLE = 'BIOC-A11Y-AUD-JOINABLE';
const BUCKET_A = 'A11Y-AUD-BUCKET-A';
const BUCKET_B = 'A11Y-AUD-BUCKET-B';
const COURSE_IDS = [MAIN, SECOND, JOINABLE];
const BUCKET_IDS = [BUCKET_A, BUCKET_B];

const STUDENT_1 = { userId: 'user_a11y_aud_student_1', username: 'a11y_aud_student_1', email: 'a11y-aud-s1@test.local', role: 'student', displayName: 'Audit Ada' };
const STUDENT_2 = { userId: 'user_a11y_aud_student_2', username: 'a11y_aud_student_2', email: 'a11y-aud-s2@test.local', role: 'student', displayName: 'Audit Blair' };
const TA_2 = { userId: 'user_a11y_aud_ta_2', username: 'a11y_aud_ta_2', email: 'a11y-aud-ta2@test.local', role: 'ta', displayName: 'Audit TA Two' };
const OTHER_AUTHOR = { userId: 'user_a11y_aud_instructor_2', username: 'a11y_aud_instructor_2', email: 'a11y-aud-i2@test.local', role: 'instructor', displayName: 'Audit Other Instructor' };
const SYNTHETIC_USER_IDS = [STUDENT_1.userId, STUDENT_2.userId, TA_2.userId, OTHER_AUTHOR.userId];

const SUPER_SETTINGS_ID = 'superCourseChat';
const NOTES_LLM_SETTINGS_ID = 'notesLlm';

const iso = (minutesAgo) => new Date(Date.now() - minutesAgo * 60_000);

function lecture(n, { published, complete, questions = true }) {
    const now = new Date();
    return {
        name: `Unit ${n}`,
        displayName: ['Cell Structure', 'Enzymes', 'Metabolism'][n - 1] || `Unit ${n}`,
        isPublished: published,
        learningObjectives: complete ? [`Describe topic ${n}a`, `Explain topic ${n}b`] : [],
        passThreshold: 1,
        createdAt: now,
        updatedAt: now,
        documents: complete ? [
            { documentId: `a11y-aud-doc-${n}-notes`, filename: `unit-${n}-notes.txt`, originalName: `unit-${n}-notes.txt`, mimeType: 'text/plain', size: 80, status: 'parsed', documentType: 'lecture-notes' },
            { documentId: `a11y-aud-doc-${n}-quiz`, filename: `unit-${n}-practice.txt`, originalName: `unit-${n}-practice.txt`, mimeType: 'text/plain', size: 80, status: 'parsed', documentType: 'practice-quiz' },
        ] : [],
        assessmentQuestions: questions ? [
            {
                questionId: `a11y-aud-q-${n}-mc`, questionType: 'multiple-choice', question: `Which statement about unit ${n} is correct?`,
                options: { A: 'The first option', B: 'The second option', C: 'The third option', D: 'The fourth option' },
                correctAnswer: 'B', difficulty: 'easy', tags: [], points: 1, isActive: true,
            },
            {
                questionId: `a11y-aud-q-${n}-tf`, questionType: 'true-false', question: `Unit ${n}: water is a polar molecule.`,
                correctAnswer: 'true', difficulty: 'easy', tags: [], points: 1, isActive: true,
            },
            {
                questionId: `a11y-aud-q-${n}-sa`, questionType: 'short-answer', question: `Unit ${n}: name the bond between two amino acids.`,
                correctAnswer: 'A peptide bond.', difficulty: 'medium', tags: [], points: 2, isActive: true,
            },
        ] : [],
    };
}

function chatSession({ sessionId, courseId, studentId, studentName, title, mode = 'tutor', minutesAgo = 60 }) {
    const start = iso(minutesAgo);
    const end = iso(minutesAgo - 4);
    const messages = [
        { type: 'user', content: 'How does the Calvin cycle fix carbon?', timestamp: start.toISOString(), messageType: 'regular-chat', messageId: `${sessionId}-1` },
        { type: 'bot', content: 'It fixes carbon in the stroma using RuBisCO, then reduces it with ATP and NADPH.', timestamp: iso(minutesAgo - 1).toISOString(), messageType: 'regular-chat', messageId: `${sessionId}-2` },
        { type: 'user', content: 'What limits the rate?', timestamp: iso(minutesAgo - 2).toISOString(), messageType: 'regular-chat', messageId: `${sessionId}-3` },
        { type: 'bot', content: 'RuBisCO turnover and the supply of ATP and NADPH from the light reactions.', timestamp: end.toISOString(), messageType: 'regular-chat', messageId: `${sessionId}-4` },
    ];
    return {
        sessionId, courseId, studentId, studentName, unitName: 'Unit 1', title,
        messageCount: messages.length, duration: '4m', savedAt: end.toISOString(),
        chatData: {
            metadata: { exportDate: end.toISOString(), courseId, courseName: MAIN_NAME, studentId, studentName, unitName: 'Unit 1', currentMode: mode, totalMessages: messages.length, version: '1.0' },
            messages, practiceTests: null, studentAnswers: { answers: [] },
            sessionInfo: { sessionId, startTime: start.toISOString(), endTime: end.toISOString(), duration: '4m' },
            lastActivityTimestamp: end.toISOString(),
        },
        isDeleted: false, createdAt: start, updatedAt: end,
    };
}

async function getIds() {
    const [instructorId, taId, studentId] = await Promise.all([
        getUserIdByUsername(TEST_USERS.instructor.username),
        getUserIdByUsername(TEST_USERS.ta.username),
        getUserIdByUsername(TEST_USERS.student.username),
    ]);
    return { instructorId, taId, studentId };
}

async function removeAuditRows(db, ids) {
    await db.collection('courses').deleteMany({ courseId: { $in: COURSE_IDS } });
    await db.collection('chat_sessions').deleteMany({ courseId: { $in: COURSE_IDS } });
    await db.collection('documents').deleteMany({ courseId: { $in: COURSE_IDS } });
    await db.collection('quizAttempts').deleteMany({ courseId: { $in: COURSE_IDS } });
    await db.collection('users').deleteMany({ userId: { $in: SYNTHETIC_USER_IDS } });
    await db.collection('struggleActivity').deleteMany({ courseId: { $in: COURSE_IDS } });
    await db.collection('persistenceTopics').deleteMany({ courseId: { $in: COURSE_IDS } });
    await db.collection('flaggedQuestions').deleteMany({ flagId: /^a11y-aud-/ });
    await db.collection('mentalHealthFlags').deleteMany({ courseId: { $in: COURSE_IDS } });
    await db.collection('flashcardDecks').deleteMany({ courseId: { $in: COURSE_IDS } });
    await db.collection('flashcardProgress').deleteMany({ courseId: { $in: COURSE_IDS } });
    await db.collection('chatSurveyResponses').deleteMany({ courseId: { $in: COURSE_IDS } });
    await db.collection('superchats').deleteMany({ superchatId: { $in: BUCKET_IDS } });
    await db.collection('superchat_notes').deleteMany({ noteId: /^a11y-aud-/ });
    await db.collection('instructor_chat_sessions').deleteMany({ sessionId: /^a11y-aud-/ });
    await db.collection('student_super_course_chat_sessions').deleteMany({ sessionId: /^a11y-aud-/ });
    // Rows the audit creates by using the pages (flagging a reply, rating one, saving a super-course chat).
    await db.collection('flaggedQuestions').deleteMany({ courseId: { $in: COURSE_IDS } });
    await db.collection('messageFeedback').deleteMany({ courseId: { $in: COURSE_IDS } });
    await db.collection('student_super_course_chat_sessions').deleteMany({ superchatId: { $in: BUCKET_IDS } });
    if (ids) {
        await db.collection('users').updateOne({ userId: ids.studentId }, { $unset: { struggleState: '' } });
    }
}

/**
 * Write the audit data set. Idempotent: safe to call from every spec's beforeAll.
 * @returns {Promise<{ instructorId: string, taId: string, studentId: string }>}
 */
async function seedAuditData() {
    const ids = await getIds();
    const { instructorId, taId, studentId } = ids;
    const now = new Date();

    await withDb(async (db) => {
        await removeAuditRows(db, ids);

        await db.collection('users').updateOne({ userId: taId }, { $set: { role: 'ta', isActive: true, invitedCourses: [] } });
        const user = (base, extra = {}) => ({ ...base, authProvider: 'local', isActive: true, preferences: { courseId: MAIN }, createdAt: iso(60 * 24 * 30), updatedAt: now, lastLogin: iso(90), ...extra });
        await db.collection('users').insertMany([
            user(STUDENT_1, {
                struggleState: { topics: [
                    { topic: 'oxidative phosphorylation', count: 3, lastStruggle: iso(60), isActive: true, courseId: MAIN },
                    { topic: 'enzyme kinetics', count: 1, lastStruggle: iso(600), isActive: false, courseId: MAIN },
                ] },
            }),
            user(STUDENT_2, {
                struggleState: { topics: [
                    { topic: 'oxidative phosphorylation', count: 2, lastStruggle: iso(120), isActive: true, courseId: MAIN },
                    { topic: 'membrane transport', count: 4, lastStruggle: iso(30), isActive: true, courseId: MAIN },
                ] },
            }),
            user(TA_2),
            user(OTHER_AUTHOR, { preferences: {} }),
        ]);
        // The signed-in student has topics of their own, for /student/dashboard.html.
        await db.collection('users').updateOne({ userId: studentId }, { $set: { struggleState: { topics: [
            { topic: 'oxidative phosphorylation', count: 3, lastStruggle: iso(45), isActive: true, courseId: MAIN },
            { topic: 'enzyme kinetics', count: 2, lastStruggle: iso(300), isActive: true, courseId: MAIN },
            { topic: 'membrane transport', count: 1, lastStruggle: iso(900), isActive: false, courseId: MAIN },
        ] } } });

        const enrollment = Object.fromEntries([STUDENT_1.userId, STUDENT_2.userId, studentId].map((id) => [id, { enrolled: true, enrolledAt: now }]));
        const fullAccess = { materials: true, questions: true, flags: true, roster: true, transcripts: true, settings: true, updatedAt: now };
        const grader = { materials: false, questions: false, flags: true, roster: true, transcripts: false, settings: false, updatedAt: now };
        const course = (courseId, courseName, extra) => ({
            courseId, courseName, courseCode: `${courseId}-S`.slice(-12), instructorCourseCode: `${courseId}-I`.slice(-12),
            instructorId, instructors: [instructorId], tas: [], taPermissions: {}, taPermissionsMigrated: true,
            courseDescription: '', assessmentCriteria: '', courseMaterials: [], approvedStruggleTopics: [],
            courseStructure: { weeks: 3, lecturesPerWeek: 1, totalUnits: 3 },
            isOnboardingComplete: true, status: 'active', llmApiKey: createValidLlmApiKey(courseId),
            quizSettings: { enabled: true, testableUnits: 'all', allowLectureMaterialAccess: true, allowSourceAttributionDownloads: false },
            anonymizeStudents: { [instructorId]: { enabled: false, updatedAt: now } },
            studentEnrollment: {}, lectures: [lecture(1, { published: true, complete: true })],
            createdAt: now, updatedAt: now, ...extra,
        });
        await db.collection('courses').insertMany([
            course(MAIN, MAIN_NAME, {
                tas: [taId, TA_2.userId],
                taPermissions: { [taId]: fullAccess, [TA_2.userId]: grader },
                approvedStruggleTopics: [
                    { topic: 'oxidative phosphorylation', source: 'manual', unitId: 'Unit 1', createdAt: now },
                    { topic: 'enzyme kinetics', source: 'manual', unitId: 'Unit 2', createdAt: now },
                    { topic: 'membrane transport', source: 'manual', unitId: null, createdAt: now },
                ],
                studentEnrollment: enrollment,
                superchatIds: [BUCKET_A, BUCKET_B], yearLevel: 2,
                lectures: [
                    lecture(1, { published: true, complete: true }),
                    // Published with no questions: the student chat opens straight away for this unit.
                    lecture(2, { published: true, complete: false, questions: false }),
                    lecture(3, { published: false, complete: false, questions: false }),
                ],
            }),
            course(SECOND, SECOND_NAME, {
                tas: [taId], taPermissions: { [taId]: grader },
                studentEnrollment: { [studentId]: { enrolled: true, enrolledAt: now } },
                superchatIds: [BUCKET_A], yearLevel: 1,
            }),
            // Owned by someone else, so it shows up as a course the instructor could join.
            course(JOINABLE, 'Audit Joinable Genetics 300', { instructorId: OTHER_AUTHOR.userId, instructors: [OTHER_AUTHOR.userId] }),
        ]);

        await db.collection('documents').insertOne({
            documentId: 'a11y-aud-doc-1-notes', courseId: MAIN, lectureName: 'Unit 1', instructorId,
            documentType: 'lecture-notes', type: 'lecture_notes', contentType: 'text', filename: 'unit-1-notes.txt',
            originalName: 'Unit 1 Notes.txt', content: 'ATP is the primary energy currency of the cell.', mimeType: 'text/plain',
            size: 80, status: 'parsed', uploadDate: now, lastModified: now, metadata: {},
        });

        await db.collection('chat_sessions').insertMany([
            chatSession({ sessionId: 'a11y-aud-sess-1', courseId: MAIN, studentId: STUDENT_1.userId, studentName: STUDENT_1.displayName, title: 'Calvin cycle questions', minutesAgo: 300 }),
            chatSession({ sessionId: 'a11y-aud-sess-2', courseId: MAIN, studentId: STUDENT_1.userId, studentName: STUDENT_1.displayName, title: 'Enzyme kinetics review', mode: 'protege', minutesAgo: 200 }),
            chatSession({ sessionId: 'a11y-aud-sess-3', courseId: MAIN, studentId: STUDENT_2.userId, studentName: STUDENT_2.displayName, title: 'Membrane transport', minutesAgo: 100 }),
            // The signed-in student's own history.
            chatSession({ sessionId: 'a11y-aud-sess-own-1', courseId: MAIN, studentId, studentName: TEST_USERS.student.displayName, title: 'Photosynthesis questions', minutesAgo: 400 }),
            chatSession({ sessionId: 'a11y-aud-sess-own-2', courseId: MAIN, studentId, studentName: TEST_USERS.student.displayName, title: 'Enzyme kinetics review', minutesAgo: 250 }),
            chatSession({ sessionId: 'a11y-aud-sess-own-3', courseId: MAIN, studentId, studentName: TEST_USERS.student.displayName, title: 'Glycolysis steps', mode: 'protege', minutesAgo: 50 }),
        ]);

        const activity = (student, topic, state, minutesAgo) => ({
            userId: student.userId, studentName: student.displayName, courseId: MAIN, topic, state, source: 'course', superchatId: null,
            timestamp: iso(minutesAgo), createdAt: iso(minutesAgo),
        });
        await db.collection('struggleActivity').insertMany([
            activity(STUDENT_1, 'oxidative phosphorylation', 'Active', 60),
            activity(STUDENT_2, 'oxidative phosphorylation', 'Active', 120),
            activity(STUDENT_2, 'membrane transport', 'Active', 30),
            activity(STUDENT_1, 'enzyme kinetics', 'Inactive', 600),
            activity(STUDENT_1, 'enzyme kinetics', 'Active', 60 * 24 * 8),
        ]);
        await db.collection('persistenceTopics').insertMany([
            { courseId: MAIN, topic: 'oxidative phosphorylation', studentCount: 2, studentIds: [STUDENT_1.userId, STUDENT_2.userId], createdAt: now, lastUpdated: now },
            { courseId: MAIN, topic: 'membrane transport', studentCount: 1, studentIds: [STUDENT_2.userId], createdAt: now, lastUpdated: now },
            { courseId: MAIN, topic: 'enzyme kinetics', studentCount: 1, studentIds: [STUDENT_1.userId], createdAt: now, lastUpdated: now },
        ]);

        const flag = (n, extra = {}) => ({
            flagId: `a11y-aud-flag-${n}`, questionId: 'a11y-aud-q-1-tf', courseId: MAIN, unitName: 'Unit 1',
            studentId, studentName: TEST_USERS.student.displayName, reporterName: TEST_USERS.student.displayName, reporterRole: 'student',
            flagReason: 'unclear', flagDescription: `The explanation in answer ${n} did not make sense to me.`, botMode: 'tutor',
            flagStatus: 'pending', instructorResponse: null, instructorId: null, instructorName: null, priority: 'medium',
            questionContent: { question: `Bot response ${n}: a peptide bond joins two amino acids.`, questionType: 'true-false' },
            createdAt: iso(60 * n), updatedAt: iso(60 * n), ...extra,
        });
        await db.collection('flaggedQuestions').insertMany([
            flag(1),
            flag(2, { flagReason: 'incorrect', priority: 'high', botMode: 'protege' }),
            flag(3, { flagReason: 'inappropriate', priority: 'high' }),
            flag(4, { flagStatus: 'resolved', instructorResponse: 'Thanks for flagging this. The answer has been corrected in the unit notes.', instructorId, instructorName: TEST_USERS.instructor.displayName }),
            flag(5, { flagStatus: 'dismissed', flagReason: 'other' }),
        ]);

        const mh = (n, extra = {}) => ({
            flagId: `a11y-aud-mh-${n}`, studentId: n % 2 ? STUDENT_1.userId : STUDENT_2.userId, studentName: n % 2 ? STUDENT_1.displayName : STUDENT_2.displayName,
            courseId: MAIN, unitName: 'Unit 1', message: 'I feel completely overwhelmed by this course.',
            conversationContext: [
                { role: 'user', content: 'I cannot keep up with the readings.' },
                { role: 'assistant', content: 'That sounds stressful. Which part is hardest?' },
            ],
            concernLevel: n % 2 ? 'high concern' : 'low concern', llmReason: 'The student describes feeling overwhelmed.', status: 'pending',
            escalatedBy: null, escalatedAt: null, resolvedBy: null, resolvedAt: null, createdAt: iso(90 * n), updatedAt: iso(90 * n), ...extra,
        });
        await db.collection('mentalHealthFlags').insertMany([
            mh(1), mh(2), mh(3, { status: 'escalated', escalatedBy: instructorId, escalatedAt: iso(20) }),
        ]);

        const cards = [1, 2, 3].map((n) => ({
            cardId: `a11y-aud-card-${n}`, front: `What is the role of enzyme ${n}?`, back: `Enzyme ${n} lowers the activation energy of step ${n}.`,
            source: { documentId: 'a11y-aud-doc-1-notes', fileName: 'unit-1-notes.txt', chunkIndex: n },
        }));
        await db.collection('flashcardDecks').insertOne({
            deckId: 'a11y-aud-deck-1', courseId: MAIN, lectureName: 'Unit 1', title: 'Unit 1 Flashcards',
            hasDraft: false, isPublished: true, isStale: false, publishedVersion: 1, draftCards: [], publishedCards: cards,
            createdAt: now, updatedAt: now, publishedAt: now, publishedBy: instructorId,
        });
        await db.collection('flashcardProgress').insertMany([
            { studentId: STUDENT_1.userId, courseId: MAIN, deckId: 'a11y-aud-deck-1', cards: { 'a11y-aud-card-1': { againCount: 3 }, 'a11y-aud-card-2': { againCount: 1 } }, updatedAt: now },
            { studentId: STUDENT_2.userId, courseId: MAIN, deckId: 'a11y-aud-deck-1', cards: { 'a11y-aud-card-1': { againCount: 2 }, 'a11y-aud-card-3': { againCount: 1 } }, updatedAt: now },
        ]);

        const survey = (student, n, extra = {}) => ({
            courseId: MAIN, studentId: student.userId, studentName: student.displayName, unitName: 'Unit 1', conversationId: `a11y-aud-sess-${n}`,
            ratingAccuracy: 4, ratingSatisfaction: 5, comment: 'The explanations were clear and the examples helped.', messageCountAtPrompt: 10,
            status: 'submitted', shownAt: iso(100), submittedAt: iso(95), dismissedAt: null, createdAt: iso(100), updatedAt: iso(95), ...extra,
        });
        await db.collection('chatSurveyResponses').insertMany([
            survey(STUDENT_1, 1),
            survey(STUDENT_2, 3, { ratingAccuracy: 2, ratingSatisfaction: 3, comment: 'Some answers were too long.' }),
            survey(STUDENT_1, 2, { status: 'dismissed', ratingAccuracy: null, ratingSatisfaction: null, comment: '', submittedAt: null, dismissedAt: iso(80) }),
        ]);

        const bucket = (superchatId, name, yearLevel) => ({
            superchatId, name, description: 'Audit bucket', yearLevel, showToStudents: true, studentTopK: 5, instructorTopK: 5,
            includeInactiveCourses: false, instructorPrompt: 'Audit instructor prompt', studentPrompt: 'Audit student prompt',
            llmApiKey: createValidLlmApiKey(superchatId), createdBy: instructorId, createdAt: now, updatedAt: now, isDeleted: false,
        });
        await db.collection('superchats').insertMany([bucket(BUCKET_A, 'Audit Second-Year Bucket', 2), bucket(BUCKET_B, 'Audit Foundations Bucket', 1)]);

        const note = (n, author, extra = {}) => ({
            noteId: `a11y-aud-note-${n}`, authorId: author.userId, authorName: author.displayName,
            title: ['Km versus Vmax', 'Proton gradient confusion', 'Chirality of amino acids', 'Common glycolysis mistake'][n - 1],
            content: 'Students often mix these two ideas up. Remind them of the definition first, then work an example together.',
            tags: ['enzyme kinetics', 'common confusion'], usageCount: n, isDeleted: false, createdAt: iso(60 * n), updatedAt: iso(60 * n), ...extra,
        });
        const me = { userId: instructorId, displayName: TEST_USERS.instructor.displayName };
        await db.collection('superchat_notes').insertMany([note(1, me), note(2, me), note(3, OTHER_AUTHOR), note(4, OTHER_AUTHOR)]);

        const instructorChat = (n) => ({
            sessionId: `a11y-aud-ichat-${n}`, instructorId, instructorName: TEST_USERS.instructor.displayName,
            title: ['Comparing unit outlines', 'Prerequisite gaps in second year'][n - 1], messageCount: 2, duration: '2m',
            savedAt: iso(60 * n).toISOString(), updatedAt: iso(60 * n),
            chatData: { messages: [
                { type: 'user', content: 'Which courses cover enzyme kinetics?', timestamp: iso(60 * n + 2).toISOString() },
                { type: 'bot', content: 'Enzyme kinetics is covered in Audit Biochemistry 201, Unit 2.', timestamp: iso(60 * n).toISOString() },
            ] },
            isDeleted: false, createdAt: iso(60 * n + 2),
        });
        await db.collection('instructor_chat_sessions').insertMany([instructorChat(1), instructorChat(2)]);

        const superSession = (n) => ({
            sessionId: `a11y-aud-super-${n}`, studentId, superchatId: BUCKET_A, studentName: TEST_USERS.student.displayName,
            title: ['Linking glycolysis to respiration', 'Second-year revision plan'][n - 1], messageCount: 2, duration: '0s',
            savedAt: iso(60 * n).toISOString(),
            chatData: { messages: [
                { type: 'user', content: 'How do my two courses connect?', timestamp: iso(60 * n + 2).toISOString() },
                { type: 'bot', content: 'Glycolysis in one course feeds the citric acid cycle covered in the other.', timestamp: iso(60 * n).toISOString() },
            ] },
            isDeleted: false, createdAt: iso(60 * n + 2), updatedAt: iso(60 * n),
        });
        await db.collection('student_super_course_chat_sessions').insertMany([superSession(1), superSession(2)]);
    });
    return ids;
}

async function cleanupAuditData() {
    const ids = await getIds().catch(() => null);
    await withDb((db) => removeAuditRows(db, ids));
}

/**
 * Remove what the audit created through the UI under the test accounts since
 * `since`, where no audit course id marks the row: autosaved instructor Super
 * Chat sessions and flags raised from a Super Chat reply.
 * @param {Date} since
 */
async function cleanupUiRowsSince(since) {
    const ids = await getIds();
    await withDb(async (db) => {
        await db.collection('instructor_chat_sessions').deleteMany({ instructorId: ids.instructorId, sessionId: /^autosave_/, createdAt: { $gte: since } });
        await db.collection('flaggedQuestions').deleteMany({
            courseId: 'SUPER_COURSE', studentId: { $in: [ids.instructorId, ids.studentId] }, createdAt: { $gte: since },
        });
    });
}

/** Read a settings document so it can be put back afterwards. */
async function readSetting(id) {
    return withDb((db) => db.collection('settings').findOne({ _id: id }));
}

async function restoreSetting(id, original) {
    await withDb(async (db) => {
        if (original) await db.collection('settings').replaceOne({ _id: id }, original, { upsert: true });
        else await db.collection('settings').deleteOne({ _id: id });
    });
}

/** Give the instructor Super Chat a key so its course pool loads (it returns 403 without one). */
async function enableInstructorSuperChat() {
    await withDb((db) => db.collection('settings').updateOne(
        { _id: SUPER_SETTINGS_ID },
        { $set: { llmApiKey: createValidLlmApiKey('a11y-audit-superchat'), updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
        { upsert: true }
    ));
}

/** @returns {Promise<boolean>} whether the user was a system admin before */
async function setSystemAdmin(userId, on) {
    return withDb(async (db) => {
        const before = await db.collection('users').findOne({ userId }, { projection: { permissions: 1 } });
        const was = !!(before && before.permissions && before.permissions.systemAdmin === true);
        await db.collection('users').updateOne({ userId }, on
            ? { $set: { 'permissions.systemAdmin': true } }
            : { $unset: { 'permissions.systemAdmin': '' } });
        return was;
    });
}

/** Set (or, with null values, unset) fields on the main audit course. */
async function patchMainCourse(fields) {
    const set = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== null));
    const unset = Object.fromEntries(Object.entries(fields).filter(([, v]) => v === null).map(([k]) => [k, '']));
    await withDb((db) => db.collection('courses').updateOne({ courseId: MAIN }, {
        ...(Object.keys(set).length ? { $set: set } : {}),
        ...(Object.keys(unset).length ? { $unset: unset } : {}),
    }));
}

module.exports = {
    MAIN, MAIN_NAME, SECOND, SECOND_NAME, JOINABLE, BUCKET_A, BUCKET_B,
    STUDENT_1, STUDENT_2, TA_2, OTHER_AUTHOR,
    SUPER_SETTINGS_ID, NOTES_LLM_SETTINGS_ID,
    seedAuditData, cleanupAuditData, cleanupUiRowsSince, readSetting, restoreSetting, enableInstructorSuperChat, setSystemAdmin, patchMainCourse,
};
