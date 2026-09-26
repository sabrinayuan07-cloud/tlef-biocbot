jest.mock('../../../src/services/llm', () => jest.fn());
jest.mock('../../../src/services/gridfs', () => ({ openDownloadStream: jest.fn() }));
jest.mock('../../../src/services/tracker', () => jest.fn());
jest.mock('../../../src/models/User', () => ({ updateUserStruggleState: jest.fn() }));
jest.mock('../../../src/models/MentalHealthFlag', () => ({ createMentalHealthFlag: jest.fn() }));
jest.mock('../../../src/models/Course', () => ({
    getCourseById: jest.fn(),
    getStudentEnrollment: jest.fn(),
    userHasCourseAccess: jest.fn(),
    checkTAPermission: jest.fn(),
    getChatSurveySettings: jest.fn(),
    getAssessmentQuestions: jest.fn(),
    normalizeTopicList: jest.fn(value => Array.isArray(value) ? value : []),
    resolveRagSettings: jest.fn(() => ({ student: { topK: 5 } })),
    getLearningObjectives: jest.fn()
}));
jest.mock('../../../src/models/Document', () => ({ getDocumentById: jest.fn() }));
jest.mock('../../../src/models/MessageFeedback', () => ({
    normalizeRating: jest.fn(value => ['up', 'down', null].includes(value) ? value : undefined),
    upsertMessageFeedback: jest.fn(),
    listFeedbackForCourse: jest.fn(),
    getFeedbackStatsForCourse: jest.fn(),
    feedbackToCsv: jest.fn()
}));
jest.mock('../../../src/models/ChatSurveyResponse', () => ({
    buildSettingsFingerprint: jest.fn(() => 'fingerprint'),
    getSurveyResponseForSession: jest.fn(),
    upsertChatSurveyEvent: jest.fn(),
    listSurveyResponsesForCourse: jest.fn(),
    getSurveyStatsForCourse: jest.fn(),
    surveyResponsesToCsv: jest.fn()
}));
jest.mock('../../../src/routes/llmKeyMiddleware', () => ({
    resolveCourseAi: jest.fn(),
    sendLlmKeyError: jest.fn(() => false)
}));

const { Readable, PassThrough } = require('stream');
const { memoryDb } = require('../helpers/memory-db');
const { makeRouteApp, request } = require('../helpers/route-app');
const Course = require('../../../src/models/Course');
const Document = require('../../../src/models/Document');
const Feedback = require('../../../src/models/MessageFeedback');
const Survey = require('../../../src/models/ChatSurveyResponse');
const User = require('../../../src/models/User');
const MentalHealthFlag = require('../../../src/models/MentalHealthFlag');
const Tracker = require('../../../src/services/tracker');
const gridfs = require('../../../src/services/gridfs');
const { resolveCourseAi, sendLlmKeyError } = require('../../../src/routes/llmKeyMiddleware');
const router = require('../../../src/routes/chat');

const student = { userId: 's1', role: 'student', displayName: 'Student' };
const instructor = { userId: 'i1', role: 'instructor' };
const ta = { userId: 'ta1', role: 'ta' };
const course = {
    courseId: 'C1', instructorId: 'i1', lectures: [{ name: 'Unit 1', isPublished: true }],
    approvedStruggleTopics: ['ATP synthesis'], quizSettings: { allowSourceAttributionDownloads: true }
};

function app({ db = memoryDb({}), user = null, locals = {} } = {}) {
    return makeRouteApp(router, { db, user, locals });
}

function ai(results = [], responses = [{ content: 'Answer.', model: 'm', usage: {} }]) {
    const llm = {
        sendMessage: jest.fn(),
        analyzeMentalHealth: jest.fn().mockResolvedValue({ concernLevel: 'no concern' }),
        evaluateStudentAnswer: jest.fn()
    };
    responses.forEach(response => response instanceof Error
        ? llm.sendMessage.mockRejectedValueOnce(response)
        : llm.sendMessage.mockResolvedValueOnce(response));
    const qdrant = { searchDocuments: jest.fn().mockResolvedValue(results) };
    resolveCourseAi.mockResolvedValueOnce({ llm, qdrant });
    return { llm, qdrant };
}

function chatDb(overrides = {}) {
    return memoryDb({ courses: [{ ...course, ...overrides }] });
}

beforeAll(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
});

beforeEach(() => {
    resolveCourseAi.mockReset();
    sendLlmKeyError.mockReset();
    Course.getCourseById.mockReset();
    Course.getStudentEnrollment.mockReset();
    Course.userHasCourseAccess.mockReset();
    Course.checkTAPermission.mockReset();
    Course.getChatSurveySettings.mockReset();
    Course.getAssessmentQuestions.mockReset();
    Feedback.upsertMessageFeedback.mockReset();
    Survey.upsertChatSurveyEvent.mockReset();
    Tracker.mockReset();
    User.updateUserStruggleState.mockReset();
    MentalHealthFlag.createMentalHealthFlag.mockReset();
    Course.getCourseById.mockResolvedValue(course);
    Course.getStudentEnrollment.mockResolvedValue({ success: true, enrolled: true });
    Course.userHasCourseAccess.mockResolvedValue(true);
    Course.checkTAPermission.mockResolvedValue(true);
    Course.getChatSurveySettings.mockResolvedValue({ success: true, settings: { enabled: true }, defaults: {} });
    Course.getAssessmentQuestions.mockResolvedValue([]);
    Feedback.upsertMessageFeedback.mockResolvedValue({ success: true, feedback: { isActive: true } });
    Feedback.listFeedbackForCourse.mockResolvedValue([]);
    Feedback.getFeedbackStatsForCourse.mockResolvedValue({ total: 0 });
    Feedback.feedbackToCsv.mockReturnValue('csv');
    Survey.getSurveyResponseForSession.mockResolvedValue(null);
    Survey.upsertChatSurveyEvent.mockResolvedValue({ success: true, response: {} });
    Survey.listSurveyResponsesForCourse.mockResolvedValue([]);
    Survey.getSurveyStatsForCourse.mockResolvedValue({ total: 0 });
    Survey.surveyResponsesToCsv.mockReturnValue('csv');
    sendLlmKeyError.mockReturnValue(false);
    Tracker.mockImplementation(() => ({ analyzeMessage: jest.fn().mockResolvedValue({ isStruggling: false }) }));
    User.updateUserStruggleState.mockResolvedValue({ success: true, state: { isActive: false } });
    MentalHealthFlag.createMentalHealthFlag.mockResolvedValue({ success: true });
});

afterAll(() => jest.restoreAllMocks());

describe('feedback, survey, and summary error/edge contracts', () => {
    test('feedback covers missing database/identifiers, model failure fallback, and exceptions', async () => {
        const payload = { courseId: 'C1', conversationId: 'v1', messageId: 'm1', rating: 'up' };
        expect((await request(app({ db: null, user: student })).post('/feedback').send(payload)).status).toBe(503);
        expect((await request(app({ user: student })).post('/feedback').send({ rating: 'up' })).status).toBe(400);
        Feedback.upsertMessageFeedback.mockResolvedValueOnce({ success: false });
        expect((await request(app({ user: student })).post('/feedback').send(payload)).body.message).toBe('Failed to save feedback');
        Course.getCourseById.mockRejectedValueOnce(new Error('db'));
        expect((await request(app({ user: student })).post('/feedback').send(payload)).status).toBe(500);
    });

    test('feedback uses username then user id as student-name fallbacks', async () => {
        const payload = { courseId: 'C1', conversationId: 'v1', messageId: 'm1', rating: 'up' };
        await request(app({ user: { userId: 's2', username: 'name', role: 'student' } })).post('/feedback').send(payload);
        expect(Feedback.upsertMessageFeedback).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ studentName: 'name' }));
        await request(app({ user: { userId: 's3', role: 'student' } })).post('/feedback').send(payload);
        expect(Feedback.upsertMessageFeedback).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ studentName: 's3' }));
    });

    test('summary covers role, DB, missing course, AI short-circuit, defaults, bounds, and exceptions', async () => {
        const body = { courseId: 'C1', unitName: 'Unit 1', messages: [{ role: 'user', text: 'me' }, { role: 'assistant', message: 'bot' }] };
        expect((await request(app()).post('/summary').send(body)).status).toBe(401);
        expect((await request(app({ user: instructor })).post('/summary').send(body)).status).toBe(403);
        expect((await request(app({ db: null, user: student })).post('/summary').send(body)).status).toBe(503);
        expect((await request(app({ db: memoryDb({ courses: [] }), user: student })).post('/summary').send(body)).status).toBe(404);
        resolveCourseAi.mockImplementationOnce(async (req, res) => {
            res.status(409).json({ success: false });
            return null;
        });
        expect((await request(app({ db: chatDb(), user: student })).post('/summary').send(body)).status).toBe(409);

        const noisy = [null, 'x', { isSummarySeed: true, content: 'skip' }, { messageType: 'other', content: 'skip' },
            { type: 'system', content: 'skip' }, ...Array.from({ length: 40 }, (_, i) => ({
                type: i % 2 ? 'bot' : 'student', content: `<style>x</style>${'z'.repeat(2100)}`
            }))];
        resolveCourseAi.mockResolvedValueOnce({ llm: { sendMessage: jest.fn().mockResolvedValue({ content: ' summary ' }) } });
        const res = await request(app({ db: chatDb({ prompts: { chatSummary: ' ' } }), user: student }))
            .post('/summary').send({ ...body, mode: 'anything', messages: noisy });
        expect(res.status).toBe(200);
        expect(res.body.mode).toBe('tutor');

        const broken = { collection: () => ({ findOne: jest.fn().mockRejectedValue(new Error('db')) }) };
        expect((await request(app({ db: broken, user: student })).post('/summary').send(body)).status).toBe(500);
    });

    test('survey settings covers missing values, course/access failures, no conversation, and exceptions', async () => {
        expect((await request(app({ user: student })).get('/survey-settings')).status).toBe(400);
        expect((await request(app({ db: null, user: student })).get('/survey-settings?courseId=C1')).status).toBe(503);
        Course.getChatSurveySettings.mockResolvedValueOnce({ success: false });
        expect((await request(app({ user: student })).get('/survey-settings?courseId=C1')).status).toBe(404);
        Course.getStudentEnrollment.mockResolvedValueOnce({ success: false });
        expect((await request(app({ user: student })).get('/survey-settings?courseId=C1')).status).toBe(403);
        expect((await request(app({ user: student })).get('/survey-settings?courseId=C1')).body.data.response).toBeNull();
        Course.getChatSurveySettings.mockRejectedValueOnce(new Error('db'));
        expect((await request(app({ user: student })).get('/survey-settings?courseId=C1')).status).toBe(500);
    });

    test('survey submit covers DB/course/access/disabled/default failure/name fallbacks/exceptions', async () => {
        const body = { courseId: 'C1', conversationId: 'v1', eventType: 'submitted' };
        expect((await request(app({ db: null, user: student })).post('/survey').send(body)).status).toBe(503);
        Course.getChatSurveySettings.mockResolvedValueOnce({ success: false });
        expect((await request(app({ user: student })).post('/survey').send(body)).status).toBe(404);
        Course.getStudentEnrollment.mockResolvedValueOnce({ success: false });
        expect((await request(app({ user: student })).post('/survey').send(body)).status).toBe(403);
        Course.getChatSurveySettings.mockResolvedValueOnce({ success: true, settings: { enabled: false } });
        expect((await request(app({ user: student })).post('/survey').send(body)).status).toBe(400);
        Survey.upsertChatSurveyEvent.mockResolvedValueOnce({ success: false });
        expect((await request(app({ user: student })).post('/survey').send(body)).body.message).toBe('Failed to save survey response');
        await request(app({ user: { userId: 's2', username: 'user', role: 'student' } })).post('/survey').send(body);
        expect(Survey.upsertChatSurveyEvent).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ studentName: 'user' }));
        Course.getChatSurveySettings.mockRejectedValueOnce(new Error('db'));
        expect((await request(app({ user: student })).post('/survey').send(body)).status).toBe(500);
    });
});

describe('review/export and service endpoint branches', () => {
    const reviewPaths = [
        ['get', '/feedback/course/C1'], ['get', '/feedback/course/C1/export'],
        ['get', '/survey/course/C1'], ['get', '/survey/course/C1/export']
    ];

    test.each(reviewPaths)('%s %s handles missing DB, invalid roles, and dependency exceptions', async (method, path) => {
        expect((await request(app({ db: null, user: instructor }))[method](path)).status).toBe(503);
        expect((await request(app({ user: student }))[method](path)).status).toBe(403);
        Course.userHasCourseAccess.mockRejectedValueOnce(new Error('db'));
        expect((await request(app({ user: instructor }))[method](path)).status).toBe(500);
    });

    test('TA access is gated on checkTAPermission alone, and instructor access on userHasCourseAccess', async () => {
        // A TA's course membership is implicit in checkTAPermission itself
        // (it checks course.tas internally) - hasPermission() doesn't call
        // userHasCourseAccess for the TA branch at all, unlike instructors.
        Course.checkTAPermission.mockResolvedValueOnce(false);
        expect((await request(app({ user: ta })).get('/feedback/course/C1')).status).toBe(403);

        Course.userHasCourseAccess.mockResolvedValueOnce(false);
        expect((await request(app({ user: instructor })).get('/feedback/course/C1')).status).toBe(403);

        expect((await request(app({ user: instructor })).get('/survey/course/C1')).status).toBe(200);
    });

    test('query parsing covers false/default values and numeric limits', async () => {
        await request(app({ user: instructor })).get('/feedback/course/C1?includeCleared=false&limit=12');
        expect(Feedback.listFeedbackForCourse).toHaveBeenCalledWith(expect.anything(), 'C1', expect.objectContaining({ includeCleared: false, limit: 12 }));
        await request(app({ user: instructor })).get('/survey/course/C1?limit=7');
        expect(Survey.listSurveyResponsesForCourse).toHaveBeenCalledWith(expect.anything(), 'C1', expect.objectContaining({ limit: 7 }));
    });

    test('status resolves course AI, short-circuits, and catches service errors', async () => {
        resolveCourseAi.mockResolvedValueOnce({ llm: { getStatus: () => ({ ready: true }) } });
        expect((await request(app()).get('/status?courseId=C1')).body.data).toEqual({ ready: true });
        resolveCourseAi.mockImplementationOnce(async (req, res) => {
            res.status(409).json({ success: false });
            return null;
        });
        expect((await request(app()).get('/status?courseId=C1')).status).toBe(409);
        expect((await request(app({ locals: { llm: { getStatus: () => { throw new Error('status'); } } } })).get('/status')).status).toBe(500);
    });

    test('connection test covers course AI, false result, short circuit, and exception', async () => {
        const disconnected = { testConnection: jest.fn().mockResolvedValue(false), getProviderName: () => 'mock' };
        resolveCourseAi.mockResolvedValueOnce({ llm: disconnected });
        expect((await request(app()).post('/test').send({ courseId: 'C1' })).status).toBe(503);
        resolveCourseAi.mockImplementationOnce(async (req, res) => {
            res.status(409).json({ success: false });
            return null;
        });
        expect((await request(app()).post('/test').send({ courseId: 'C1' })).status).toBe(409);
        const broken = { testConnection: jest.fn().mockRejectedValue(new Error('down')) };
        expect((await request(app({ locals: { llm: broken } })).post('/test')).status).toBe(500);
    });

    test('models and save convert dependency failures and save applies defaults', async () => {
        expect((await request(app({ locals: { llm: { getAvailableModels: jest.fn().mockRejectedValue(new Error('models')) } } })).get('/models')).status).toBe(500);
        const broken = { collection: () => ({ replaceOne: jest.fn().mockRejectedValue(new Error('save')) }) };
        const body = { sessionId: 'v1', courseId: 'C1', studentId: 's1', studentName: 'S' };
        expect((await request(app({ db: broken, user: student })).post('/save').send(body)).status).toBe(500);
        expect((await request(app({ db: null, user: student })).post('/save').send(body)).status).toBe(503);
        const db = memoryDb({});
        expect((await request(app({ db, user: instructor })).post('/save').send(body)).status).toBe(200);
        expect(await db.collection('chat_sessions').findOne({ sessionId: 'v1' })).toMatchObject({
            unitName: 'Unknown Unit', messageCount: 0, duration: 'Unknown', chatData: {}
        });
    });
});

describe('download filename, storage, and error branches', () => {
    function db() { return chatDb(); }

    test.each([
        ['original.doc', 'application/pdf', 'original.doc'],
        ['', 'application/pdf', 'source-d1.pdf'],
        ['', 'text/markdown', 'source-d1.md'],
        ['', 'application/msword', 'source-d1.doc'],
        ['', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'source-d1.docx'],
        ['', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'source-d1.pptx'],
        ['', 'application/rtf', 'source-d1.rtf'],
        ['', 'application/x-unknown', 'source-d1']
    ])('download resolves filename %s / %s', async (filename, mimeType, expected) => {
        Document.getDocumentById.mockResolvedValueOnce({
            documentId: 'd1', courseId: 'C1', contentType: 'text', filename, mimeType, content: ''
        });
        const res = await request(app({ db: db(), user: instructor })).get('/source-documents/d1/download?courseId=C1');
        expect(res.headers['content-disposition']).toContain(encodeURIComponent(expected));
    });

    test('download prefers an extension-bearing stored filename when the original has none', async () => {
        Document.getDocumentById.mockResolvedValueOnce({
            documentId: 'd1', courseId: 'C1', contentType: 'text',
            originalName: 'Friendly name', filename: '../stored.pdf', mimeType: 'application/pdf', content: 'x'
        });
        const res = await request(app({ db: db(), user: instructor })).get('/source-documents/d1/download?courseId=C1');
        expect(res.headers['content-disposition']).toContain('stored.pdf');
    });

    test('download checks TA/instructor access and handles direct Buffers', async () => {
        Course.userHasCourseAccess.mockResolvedValueOnce(false);
        expect((await request(app({ db: db(), user: ta })).get('/source-documents/d1/download?courseId=C1')).status).toBe(403);
        Document.getDocumentById.mockResolvedValueOnce({ documentId: 'd1', courseId: 'C1', contentType: 'file', fileData: Buffer.from('x') });
        expect((await request(app({ db: db(), user: instructor })).get('/source-documents/d1/download?courseId=C1')).status).toBe(200);
    });

    test('download catches model errors and handles GridFS errors before headers', async () => {
        Document.getDocumentById.mockRejectedValueOnce(new Error('read'));
        expect((await request(app({ db: db(), user: instructor })).get('/source-documents/d1/download?courseId=C1')).status).toBe(500);

        Document.getDocumentById.mockResolvedValueOnce({ documentId: 'd1', courseId: 'C1', contentType: 'file', fileId: 'f1' });
        const stream = {
            on: jest.fn(),
            pipe: jest.fn()
        };
        stream.on.mockImplementation((event, callback) => {
            if (event === 'error') setImmediate(() => callback(new Error('grid')));
            return stream;
        });
        stream.pipe.mockImplementation(() => stream);
        gridfs.openDownloadStream.mockReturnValueOnce(stream);
        expect((await request(app({ db: db(), user: instructor })).get('/source-documents/d1/download?courseId=C1')).status).toBe(500);
    });

    test('GridFS stream errors end responses after download headers have already been sent', async () => {
        Document.getDocumentById.mockResolvedValueOnce({
            documentId: 'd1', courseId: 'C1', contentType: 'file', fileId: 'f1'
        });
        let onError;
        const stream = {
            on: jest.fn((event, callback) => {
                if (event === 'error') onError = callback;
                return stream;
            }),
            pipe: jest.fn((res) => {
                res.write('partial');
                setImmediate(() => onError(new Error('late failure')));
                return stream;
            })
        };
        gridfs.openDownloadStream.mockReturnValueOnce(stream);
        const res = await request(app({ db: db(), user: instructor })).get('/source-documents/d1/download?courseId=C1');
        expect(res.status).toBe(200);
        expect(stream.pipe).toHaveBeenCalled();
    });
});

describe('main chat source, mode, tracking, safety, and continuation branches', () => {
    test('source attribution covers low relevance and every document type/dedupe path', async () => {
        const results = [
            { score: 0.9, type: 'lecture_notes', lectureName: '', documentId: '', chunkText: 'a' },
            { score: 0.8, documentType: 'practice-quiz', lectureName: 'Unit 1', documentId: 'd2', chunkText: 'b' },
            { score: 0.7, type: 'practice_q_tutorials', lectureName: 'Unit 1', documentId: 'd3', chunkText: 'c' },
            { score: 0.6, type: 'additional', lectureName: 'Unit 1', documentId: 'd4', chunkText: 'd' },
            { score: 0.5, type: 'odd', lectureName: 'Unit 1', documentId: 'd5', chunkText: 'e' },
            { score: 0.4, type: 'lecture_notes', lectureName: 'Unit 1', documentId: 'later', chunkText: 'f' }
        ];
        ai(results);
        let res = await request(app({ db: chatDb() })).post('/').send({ message: 'hi', courseId: 'C1', unitName: 'Unit 1', mode: 'protege' });
        expect(res.status).toBe(200);
        expect(res.body.sourceAttribution.documents.length).toBeGreaterThan(0);

        ai([{ score: 0.01, chunkText: 'weak' }]);
        res = await request(app({ db: chatDb() })).post('/').send({ message: 'hi', courseId: 'C1', unitName: 'Unit 1' });
        expect(res.body.sourceAttribution.source).toBe('GPT');
    });

    test('source attribution deduplicates chunks by document while preserving multiple files of the same type', async () => {
        ai([
            { score: 0.4, type: 'lecture_notes', lectureName: 'Unit 1', documentId: 'lecture-1', fileName: 'Metabolism.pdf', chunkText: 'old' },
            { score: 0.9, type: 'lecture_notes', lectureName: 'Unit 1', documentId: 'lecture-1', fileName: 'Metabolism.pdf', chunkText: 'new' },
            { score: 0.8, type: 'lecture_notes', lectureName: 'Unit 1', documentId: 'lecture-2', fileName: 'Glycolysis.pdf', chunkText: 'other' }
        ]);
        const res = await request(app({ db: chatDb() })).post('/').send({ message: 'hi', courseId: 'C1', unitName: 'Unit 1' });
        expect(res.body.sourceAttribution.documents).toEqual([
            expect.objectContaining({
                documentId: 'lecture-1',
                fileName: 'Metabolism.pdf',
                documentType: 'Lecture Notes'
            }),
            expect.objectContaining({
                documentId: 'lecture-2',
                fileName: 'Glycolysis.pdf',
                documentType: 'Lecture Notes'
            })
        ]);
        expect(res.body.sourceAttribution.description).toContain('Metabolism.pdf — Lecture Notes (Unit 1)');
        expect(res.body.sourceAttribution.description).toContain('Glycolysis.pdf — Lecture Notes (Unit 1)');
    });

    test('source attribution handles relevance changing between score and filter reads', async () => {
        let attributionReads = 0;
        const result = {
            get score() {
                if (new Error().stack.includes('determineSourceAttribution')) {
                    attributionReads += 1;
                    return attributionReads === 1 ? 0.2 : 0.05;
                }
                return 0.5;
            },
            lectureName: 'Unit 1', fileName: 'x', chunkText: 'x'
        };
        ai([result]);
        const res = await request(app({ db: chatDb() })).post('/').send({ message: 'hi', courseId: 'C1', unitName: 'Unit 1' });
        expect(res.status).toBe(200);
        expect(res.body.sourceAttribution.source).toBe('GPT');
    });

    test('source attribution catches malformed result access', async () => {
        const result = {
            get score() {
                if (new Error().stack.includes('determineSourceAttribution')) throw new Error('malformed score');
                return 0.5;
            },
            lectureName: 'Unit 1', fileName: 'x', chunkText: 'x'
        };
        ai([result]);
        const res = await request(app({ db: chatDb() })).post('/').send({ message: 'hi', courseId: 'C1', unitName: 'Unit 1' });
        expect(res.status).toBe(200);
        expect(res.body.sourceAttribution.description).toContain('error determining source');
    });

    test('explanation mode, custom prompts, approved topic, directive state, and mental health flag', async () => {
        Tracker.mockImplementationOnce(() => ({ analyzeMessage: jest.fn() }));
        User.updateUserStruggleState.mockResolvedValueOnce({ success: true, skipped: false, state: { isActive: true } });
        const { llm } = ai([]);
        llm.analyzeMentalHealth.mockResolvedValueOnce({ concernLevel: 'high', reason: 'reason' });
        const db = chatDb({ prompts: { base: 'B', protege: 'P', tutor: 'T', explain: 'E', directive: 'D' } });
        const res = await request(app({ db, user: student })).post('/').send({
            message: 'explain', courseId: 'C1', unitName: 'Unit 1', isExplanationRequest: true, topic: 'atp SYNTHESIS'
        });
        expect(res.status).toBe(200);
        expect(User.updateUserStruggleState).toHaveBeenCalled();
        await new Promise(resolve => setTimeout(resolve, 10));
        expect(MentalHealthFlag.createMentalHealthFlag).toHaveBeenCalled();
        expect(llm.sendMessage.mock.calls.at(-1)[1].systemPrompt).toBe('BE');
    });

    test.each([
        [{ isStruggling: true, isMapped: true }, { success: true, skipped: false, state: { isActive: false } }],
        [{ isStruggling: true, isMapped: false }, null],
        [{ isStruggling: false, isMapped: false }, null]
    ])('normal tracker analysis branch %#', async (analysis, update) => {
        Tracker.mockImplementationOnce(() => ({ analyzeMessage: jest.fn().mockResolvedValue(analysis) }));
        if (update) User.updateUserStruggleState.mockResolvedValueOnce(update);
        ai();
        expect((await request(app({ db: chatDb(), user: student })).post('/').send({ message: 'hi', courseId: 'C1', unitName: 'Unit 1' })).status).toBe(200);
    });

    test('normal mapped struggle activates directive mode', async () => {
        Tracker.mockImplementationOnce(() => ({
            analyzeMessage: jest.fn().mockResolvedValue({ isStruggling: true, isMapped: true, topic: 'ATP synthesis' })
        }));
        User.updateUserStruggleState.mockResolvedValueOnce({ success: true, skipped: false, state: { isActive: true } });
        const { llm } = ai();
        const res = await request(app({ db: chatDb(), user: student })).post('/').send({ message: 'hi', courseId: 'C1', unitName: 'Unit 1' });
        expect(res.status).toBe(200);
        expect(llm.sendMessage.mock.calls.at(-1)[1].systemPrompt).toContain('DIRECTIVE MODE');
    });

    test('tracking, mental-health, and summary classifier failures are non-blocking', async () => {
        Tracker.mockImplementationOnce(() => ({ analyzeMessage: jest.fn().mockRejectedValue(new Error('track')) }));
        const { llm } = ai([], [new Error('classify'), { content: 'answer.', model: 'm', usage: {} }]);
        llm.analyzeMentalHealth.mockRejectedValueOnce(new Error('safety'));
        const res = await request(app({ db: chatDb(), user: student })).post('/').send({
            message: 'hi', courseId: 'C1', unitName: 'Unit 1', checkSummaryAttempt: true
        });
        expect(res.status).toBe(200);
    });

    test('summary YES, explanation topic rejection, and clean/truncation finish-reason variants', async () => {
        ai([], [{ content: 'YES' }, { content: 'answer.', finish_reason: 'stop', model: 'm' }]);
        let res = await request(app({ db: chatDb(), user: student })).post('/').send({
            message: 'summary', courseId: 'C1', unitName: 'Unit 1', checkSummaryAttempt: true
        });
        expect(res.body.message).not.toContain('summarize our chat again');

        ai([], [{ content: 'answer.', usage: { finish_reason: 'end_turn' }, model: 'm' }]);
        res = await request(app({ db: chatDb(), user: student })).post('/').send({
            message: 'explain', courseId: 'C1', unitName: 'Unit 1', isExplanationRequest: true, topic: 'unapproved'
        });
        expect(res.status).toBe(200);
    });

    test('empty and twice-truncated continuation responses cover termination bounds', async () => {
        ai([], [
            { content: 'x'.repeat(900), stopReason: 'max_tokens' },
            { content: '', stop_reason: 'length' },
            { content: 'z'.repeat(900), finishReason: 'length', model: 'm' }
        ]);
        const res = await request(app({ db: chatDb() })).post('/').send({ message: 'hi', courseId: 'C1', unitName: 'Unit 1' });
        expect(res.status).toBe(200);
    });

    test('malformed LLM metadata is tolerated by finish-reason extraction', async () => {
        const response = new Proxy({ content: 'answer.', model: 'm', usage: {} }, {
            get(target, property) {
                if (property === 'finishReason') throw new Error('bad metadata');
                return target[property];
            }
        });
        ai([], [response]);
        const res = await request(app({ db: chatDb() })).post('/').send({ message: 'hi', courseId: 'C1', unitName: 'Unit 1' });
        expect(res.status).toBe(200);
    });

    test('empty string messages use the explicit validation response', async () => {
        const res = await request(app({ db: chatDb() })).post('/').send({ message: '', courseId: 'C1', unitName: 'Unit 1' });
        expect(res.status).toBe(400);
    });

    test('treats a non-array Qdrant result as an empty result set', async () => {
        const { qdrant } = ai();
        qdrant.searchDocuments.mockResolvedValueOnce(null);
        const res = await request(app({ db: chatDb() })).post('/').send({
            message: 'shit', courseId: 'C1', unitName: 'Unit 1', isExplanationRequest: true
        });
        expect(res.status).toBe(200);
        expect(res.body.debug.searchResultsCount).toBe(0);
    });
});

describe('practice question branches', () => {
    test('validates required fields and incomplete generated output', async () => {
        expect((await request(app()).post('/practice-question').send({})).status).toBe(400);
        Course.getAssessmentQuestions.mockResolvedValueOnce([{ questionType: 'short-answer', question: 'Q', correctAnswer: 'A', explanation: 'E' }]);
        ai([], [{ content: '{"questionType":"short-answer"}' }]);
        expect((await request(app()).post('/practice-question').send({ courseId: 'C1', unitName: 'Unit 1' })).status).toBe(500);
    });

    test('short answer uses LLM evaluation and student name default', async () => {
        Course.getAssessmentQuestions.mockResolvedValueOnce([{ questionType: 'short-answer', question: 'Seed', correctAnswer: 'seed' }]);
        const generatedAi = ai([], [{ content: '{"questionType":"short-answer","question":"New?","correctAnswer":"answer"}' }]);
        const generated = await request(app()).post('/practice-question').send({ courseId: 'C1', unitName: 'Unit 1', topic: 'ATP' });
        resolveCourseAi.mockResolvedValueOnce({ llm: { evaluateStudentAnswer: jest.fn().mockResolvedValue({ correct: true, feedback: 'yes' }) } });
        const checked = await request(app()).post('/check-practice-answer').send({ practiceId: generated.body.data.practiceId, studentAnswer: 'response' });
        expect(checked.body.data).toMatchObject({ correct: true, feedback: 'yes', explanation: '' });
        expect(generatedAi.llm.sendMessage).toHaveBeenCalled();
    });

    test('incorrect objective answer includes explanation', async () => {
        Course.getAssessmentQuestions.mockResolvedValueOnce([{ questionType: 'true-false', question: 'Seed', correctAnswer: 'true' }]);
        ai([], [{ content: '{"questionType":"true-false","question":"New?","correctAnswer":"true","explanation":"Why"}' }]);
        const generated = await request(app()).post('/practice-question').send({ courseId: 'C1', unitName: 'Unit 1' });
        const checked = await request(app()).post('/check-practice-answer').send({ practiceId: generated.body.data.practiceId, studentAnswer: 'false' });
        expect(checked.body.data).toMatchObject({ correct: false, feedback: 'Incorrect. The correct answer is true. Why' });
    });

    test('LLM key errors short-circuit both practice handlers and ordinary errors return 500', async () => {
        Course.getAssessmentQuestions.mockRejectedValueOnce(new Error('key'));
        sendLlmKeyError.mockImplementationOnce((res) => {
            res.status(409).json({ success: false });
            return true;
        });
        expect((await request(app()).post('/practice-question').send({ courseId: 'C1', unitName: 'Unit 1' })).status).toBe(409);
        Course.getAssessmentQuestions.mockRejectedValueOnce(new Error('other'));
        expect((await request(app()).post('/practice-question').send({ courseId: 'C1', unitName: 'Unit 1' })).status).toBe(500);
    });

    test('answer evaluation errors and LLM-key failures use their stable contracts', async () => {
        Course.getAssessmentQuestions.mockResolvedValueOnce([{ questionType: 'short-answer', question: 'Seed', correctAnswer: 'seed' }]);
        ai([], [{ content: '{"questionType":"short-answer","question":"New?","correctAnswer":"answer"}' }]);
        const generated = await request(app()).post('/practice-question').send({ courseId: 'C1', unitName: 'Unit 1' });

        resolveCourseAi.mockResolvedValueOnce({ llm: { evaluateStudentAnswer: jest.fn().mockRejectedValue(new Error('grade')) } });
        expect((await request(app()).post('/check-practice-answer').send({ practiceId: generated.body.data.practiceId, studentAnswer: 'x' })).status).toBe(500);

        resolveCourseAi.mockImplementationOnce(async (req, res) => {
            res.status(409).json({ success: false });
            return null;
        });
        expect((await request(app()).post('/check-practice-answer').send({ practiceId: generated.body.data.practiceId, studentAnswer: 'x' })).status).toBe(409);
    });
});
