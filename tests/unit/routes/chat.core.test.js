jest.mock('../../../src/services/llm', () => jest.fn());
jest.mock('../../../src/services/gridfs', () => ({ openDownloadStream: jest.fn() }));
jest.mock('../../../src/services/tracker', () => jest.fn());
jest.mock('../../../src/models/User', () => ({}));
jest.mock('../../../src/models/MentalHealthFlag', () => ({}));
jest.mock('../../../src/models/Course', () => ({
    getCourseById: jest.fn(),
    getStudentEnrollment: jest.fn(),
    userHasCourseAccess: jest.fn(),
    checkTAPermission: jest.fn(),
    getChatSurveySettings: jest.fn(),
    getAssessmentQuestions: jest.fn(),
    normalizeTopicList: jest.fn(value => Array.isArray(value) ? value : []),
    resolveRagSettings: jest.fn(() => ({ student: { topK: 5 } })),
}));
jest.mock('../../../src/models/Document', () => ({ getDocumentById: jest.fn() }));
jest.mock('../../../src/models/MessageFeedback', () => ({
    normalizeRating: jest.fn(value => ['up', 'down', null].includes(value) ? value : undefined),
    upsertMessageFeedback: jest.fn(),
    listFeedbackForCourse: jest.fn(),
    getFeedbackStatsForCourse: jest.fn(),
    feedbackToCsv: jest.fn(),
}));
jest.mock('../../../src/models/ChatSurveyResponse', () => ({
    buildSettingsFingerprint: jest.fn(() => 'fingerprint'),
    getSurveyResponseForSession: jest.fn(),
    upsertChatSurveyEvent: jest.fn(),
    listSurveyResponsesForCourse: jest.fn(),
    getSurveyStatsForCourse: jest.fn(),
    surveyResponsesToCsv: jest.fn(),
}));
jest.mock('../../../src/routes/llmKeyMiddleware', () => ({
    resolveCourseAi: jest.fn(),
    sendLlmKeyError: jest.fn(() => false),
}));

const { memoryDb } = require('../helpers/memory-db');
const { makeRouteApp, request } = require('../helpers/route-app');
const Course = require('../../../src/models/Course');
const Document = require('../../../src/models/Document');
const gridfs = require('../../../src/services/gridfs');
const MessageFeedback = require('../../../src/models/MessageFeedback');
const Survey = require('../../../src/models/ChatSurveyResponse');
const { resolveCourseAi } = require('../../../src/routes/llmKeyMiddleware');
const router = require('../../../src/routes/chat');

const student = { userId: 's1', role: 'student', displayName: 'Student One' };
const instructor = { userId: 'i1', role: 'instructor' };
const app = options => makeRouteApp(router, options);
const course = { courseId: 'C1', lectures: [{ name: 'Unit 1', isPublished: true }] };

beforeAll(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
});

beforeEach(() => {
    Course.getCourseById.mockResolvedValue(course);
    Course.getStudentEnrollment.mockResolvedValue({ success: true, enrolled: true });
    Course.userHasCourseAccess.mockResolvedValue(true);
    Course.checkTAPermission.mockResolvedValue(true);
    Course.getChatSurveySettings.mockResolvedValue({ success: true, settings: { enabled: true }, defaults: {} });
    MessageFeedback.upsertMessageFeedback.mockResolvedValue({ success: true, feedback: { isActive: true, rating: 'up' } });
    MessageFeedback.listFeedbackForCourse.mockResolvedValue([{ messageId: 'm1' }]);
    MessageFeedback.getFeedbackStatsForCourse.mockResolvedValue({ total: 1 });
    MessageFeedback.feedbackToCsv.mockReturnValue('rating\nup');
    Survey.getSurveyResponseForSession.mockResolvedValue({ status: 'submitted' });
    Survey.upsertChatSurveyEvent.mockResolvedValue({ success: true, response: { status: 'submitted' } });
    Survey.listSurveyResponsesForCourse.mockResolvedValue([{ conversationId: 'v1' }]);
    Survey.getSurveyStatsForCourse.mockResolvedValue({ total: 1 });
    Survey.surveyResponsesToCsv.mockReturnValue('status\nsubmitted');
});

afterAll(() => jest.restoreAllMocks());

describe('chat feedback and surveys', () => {
    test('feedback enforces authentication, student role, rating, and required identifiers', async () => {
        expect((await request(app({ db: memoryDb({}) })).post('/feedback').send({})).status).toBe(401);
        expect((await request(app({ db: memoryDb({}), user: instructor })).post('/feedback').send({ rating: 'up' })).status).toBe(403);
        expect((await request(app({ db: memoryDb({}), user: student })).post('/feedback').send({})).status).toBe(400);
        expect((await request(app({ db: memoryDb({}), user: student })).post('/feedback').send({ rating: 'sideways' })).status).toBe(400);
        expect((await request(app({ db: memoryDb({}), user: student })).post('/feedback').send({ rating: 'up' })).status).toBe(400);
    });

    test('feedback checks course enrollment and saves or clears a rating', async () => {
        const body = { courseId: 'C1', conversationId: 'v1', messageId: 'm1', rating: 'up' };
        let res = await request(app({ db: memoryDb({}), user: student })).post('/feedback').send(body);
        expect(res.status).toBe(200);
        expect(res.body.message).toBe('Feedback saved');
        Course.getStudentEnrollment.mockResolvedValueOnce({ success: true, enrolled: false });
        res = await request(app({ db: memoryDb({}), user: student })).post('/feedback').send(body);
        expect(res.status).toBe(403);
        Course.getCourseById.mockResolvedValueOnce(null);
        expect((await request(app({ db: memoryDb({}), user: student })).post('/feedback').send(body)).status).toBe(404);
        MessageFeedback.upsertMessageFeedback.mockResolvedValueOnce({ success: false, error: 'bad feedback' });
        expect((await request(app({ db: memoryDb({}), user: student })).post('/feedback').send(body)).body.message).toBe('bad feedback');
    });

    test('survey settings returns settings, fingerprint, and an existing response', async () => {
        const res = await request(app({ db: memoryDb({}), user: student })).get('/survey-settings?courseId=C1&conversationId=v1');
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({ courseId: 'C1', settingsFingerprint: 'fingerprint', response: { status: 'submitted' } });
        expect(Survey.getSurveyResponseForSession).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ studentId: 's1', conversationId: 'v1' }));
    });

    test('survey settings handles missing course, unavailable DB, course miss, and denied enrollment', async () => {
        expect((await request(app({ db: memoryDb({}), user: student })).get('/survey-settings')).status).toBe(400);
        expect((await request(app({ db: null, user: student })).get('/survey-settings?courseId=C1')).status).toBe(503);
        Course.getChatSurveySettings.mockResolvedValueOnce({ success: false, error: 'missing' });
        expect((await request(app({ db: memoryDb({}), user: student })).get('/survey-settings?courseId=C1')).status).toBe(404);
        Course.getStudentEnrollment.mockResolvedValueOnce({ success: false });
        expect((await request(app({ db: memoryDb({}), user: student })).get('/survey-settings?courseId=C1')).status).toBe(403);
    });

    test('survey validates settings and persists a submitted event', async () => {
        const payload = { courseId: 'C1', conversationId: 'v1', eventType: 'submitted', settingsFingerprint: 'fingerprint', ratingAccuracy: 5 };
        let res = await request(app({ db: memoryDb({}), user: student })).post('/survey').send(payload);
        expect(res.status).toBe(200);
        expect(Survey.upsertChatSurveyEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ studentId: 's1', ratingAccuracy: 5 }));
        Course.getChatSurveySettings.mockResolvedValueOnce({ success: true, settings: { enabled: false }, defaults: {} });
        expect((await request(app({ db: memoryDb({}), user: student })).post('/survey').send(payload)).status).toBe(400);
        expect((await request(app({ db: memoryDb({}), user: student })).post('/survey').send({ ...payload, settingsFingerprint: 'old' })).status).toBe(409);
        Survey.upsertChatSurveyEvent.mockResolvedValueOnce({ success: false, error: 'invalid event' });
        expect((await request(app({ db: memoryDb({}), user: student })).post('/survey').send(payload)).body.message).toBe('invalid event');
    });

    test('survey rejects unauthenticated, non-student, and incomplete requests', async () => {
        expect((await request(app({ db: memoryDb({}) })).post('/survey').send({})).status).toBe(401);
        expect((await request(app({ db: memoryDb({}), user: instructor })).post('/survey').send({})).status).toBe(403);
        expect((await request(app({ db: memoryDb({}), user: student })).post('/survey').send({ courseId: 'C1' })).status).toBe(400);
    });
});

describe('instructor feedback and survey review', () => {
    test.each([
        ['/feedback/course/C1?includeCleared=1&rating=down&limit=20', 'feedback', 'stats'],
        ['/survey/course/C1?status=submitted&limit=20', 'responses', 'stats'],
    ])('%s returns records and statistics', async (url, listKey, statsKey) => {
        const res = await request(app({ db: memoryDb({}), user: instructor })).get(url);
        expect(res.status).toBe(200);
        expect(res.body.data[listKey]).toHaveLength(1);
        expect(res.body.data[statsKey]).toEqual({ total: 1 });
    });

    test('TA review requires both course access and flags permission', async () => {
        Course.checkTAPermission.mockResolvedValueOnce(false);
        const res = await request(app({ db: memoryDb({}), user: { userId: 'ta1', role: 'ta' } })).get('/feedback/course/C1');
        expect(res.status).toBe(403);
        Course.userHasCourseAccess.mockResolvedValueOnce(false);
        expect((await request(app({ db: memoryDb({}), user: instructor })).get('/survey/course/C1')).status).toBe(403);
    });

    test('CSV exports sanitize filenames and return generated CSV', async () => {
        let res = await request(app({ db: memoryDb({}), user: instructor })).get('/feedback/course/C%201/export');
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toContain('text/csv');
        expect(res.text).toContain('rating');
        res = await request(app({ db: memoryDb({}), user: instructor })).get('/survey/course/C%201/export');
        expect(res.status).toBe(200);
        expect(res.text).toContain('submitted');
    });
});

describe('summary, service utilities, and saved chats', () => {
    test('summary normalizes transcript and returns the LLM summary', async () => {
        const db = memoryDb({ courses: [{ ...course, prompts: { chatSummary: 'Custom summary instructions' }, studentEnrollment: { s1: { enrolled: true } } }] });
        resolveCourseAi.mockResolvedValueOnce({ llm: { sendMessage: jest.fn(async () => ({ content: '<b>I learned ATP.</b>' })) } });
        const res = await request(app({ db, user: student })).post('/summary').send({
            courseId: 'C1', unitName: 'Unit 1', mode: 'protege',
            messages: [{ type: 'student', content: '<script>x</script> Explain ATP' }, { type: 'bot', content: '<p>ATP stores energy</p>' }],
        });
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ summary: 'I learned ATP.', mode: 'protege', sourceMessageCount: 2 });
    });

    test('summary validates required fields, enrollment, published unit, transcript, and empty LLM output', async () => {
        const db = memoryDb({ courses: [{ ...course }] });
        expect((await request(app({ db, user: student })).post('/summary').send({})).status).toBe(400);
        Course.getStudentEnrollment.mockResolvedValueOnce({ success: false });
        expect((await request(app({ db, user: student })).post('/summary').send({ courseId: 'C1', unitName: 'Unit 1' })).status).toBe(403);
        expect((await request(app({ db, user: student })).post('/summary').send({ courseId: 'C1', unitName: 'Hidden' })).status).toBe(400);
        expect((await request(app({ db, user: student })).post('/summary').send({ courseId: 'C1', unitName: 'Unit 1', messages: [{ type: 'student', content: 'only me' }] })).status).toBe(400);
        resolveCourseAi.mockResolvedValueOnce({ llm: { sendMessage: jest.fn(async () => ({ content: '  ' })) } });
        expect((await request(app({ db, user: student })).post('/summary').send({ courseId: 'C1', unitName: 'Unit 1', messages: [{ type: 'student', content: 'me' }, { type: 'bot', content: 'bot' }] })).status).toBe(502);
    });

    test('status, connection test, and models expose the configured LLM', async () => {
        const llm = { getStatus: jest.fn(() => ({ ready: true })), testConnection: jest.fn(async () => true), getProviderName: jest.fn(() => 'openai'), getAvailableModels: jest.fn(async () => ['gpt-test']) };
        expect((await request(app({ locals: { llm } })).get('/status')).body.data).toEqual({ ready: true });
        expect((await request(app({ locals: { llm } })).post('/test')).status).toBe(200);
        expect((await request(app({ locals: { llm } })).get('/models')).body.data.models).toEqual(['gpt-test']);
        expect((await request(app({})).get('/status')).status).toBe(503);
        expect((await request(app({})).post('/test')).status).toBe(503);
        expect((await request(app({})).get('/models')).status).toBe(503);
    });

    test('save validates identity and upserts a chat session', async () => {
        const db = memoryDb({});
        expect((await request(app({ db, user: student })).post('/save').send({})).status).toBe(400);
        const payload = { sessionId: 'v1', courseId: 'C1', studentId: 'other', studentName: 'Other' };
        expect((await request(app({ db, user: student })).post('/save').send(payload)).status).toBe(403);
        const res = await request(app({ db, user: student })).post('/save').send({ ...payload, studentId: 's1', studentName: 'Student One' });
        expect(res.status).toBe(200);
        expect(await db.collection('chat_sessions').findOne({ sessionId: 'v1' })).toMatchObject({ courseId: 'C1', studentId: 's1', isDeleted: false });
    });
});

describe('source-attributed document downloads', () => {
    function downloadDb(enabled = true) {
        return memoryDb({ courses: [{ courseId: 'C1', instructorId: 'i1', quizSettings: { allowSourceAttributionDownloads: enabled } }] });
    }

    test('requires course, authentication, DB, course existence, and enabled downloads', async () => {
        expect((await request(app({ user: student, db: downloadDb() })).get('/source-documents/d1/download')).status).toBe(400);
        expect((await request(app({ db: downloadDb() })).get('/source-documents/d1/download?courseId=C1')).status).toBe(401);
        expect((await request(app({ db: null, user: student })).get('/source-documents/d1/download?courseId=C1')).status).toBe(503);
        expect((await request(app({ db: memoryDb({ courses: [] }), user: student })).get('/source-documents/d1/download?courseId=C1')).status).toBe(404);
        expect((await request(app({ db: downloadDb(false), user: student })).get('/source-documents/d1/download?courseId=C1')).status).toBe(403);
    });

    test('denies unenrolled students and mismatched documents', async () => {
        Course.getStudentEnrollment.mockResolvedValueOnce({ success: true, enrolled: false });
        expect((await request(app({ db: downloadDb(), user: student })).get('/source-documents/d1/download?courseId=C1')).status).toBe(403);
        Document.getDocumentById.mockResolvedValueOnce({ documentId: 'd1', courseId: 'OTHER' });
        expect((await request(app({ db: downloadDb(), user: instructor })).get('/source-documents/d1/download?courseId=C1')).status).toBe(404);
    });

    test('downloads text with a safe inferred filename', async () => {
        Document.getDocumentById.mockResolvedValueOnce({ documentId: 'd1', courseId: 'C1', contentType: 'text', originalName: '../Notes', mimeType: 'text/plain', content: 'ATP text' });
        const res = await request(app({ db: downloadDb(), user: instructor })).get('/source-documents/d1/download?courseId=C1');
        expect(res.status).toBe(200);
        expect(res.text).toBe('ATP text');
        expect(res.headers['content-disposition']).toContain('filename="Notes.txt"');
    });

    test('downloads legacy inline files and rejects malformed binary data', async () => {
        Document.getDocumentById.mockResolvedValueOnce({ documentId: 'd1', courseId: 'C1', contentType: 'file', originalName: 'slides.pdf', mimeType: 'application/pdf', fileData: { buffer: [1, 2, 3] } });
        expect((await request(app({ db: downloadDb(), user: instructor })).get('/source-documents/d1/download?courseId=C1')).status).toBe(200);
        Document.getDocumentById.mockResolvedValueOnce({ documentId: 'd1', courseId: 'C1', contentType: 'file', originalName: 'bad.pdf', fileData: {} });
        expect((await request(app({ db: downloadDb(), user: instructor })).get('/source-documents/d1/download?courseId=C1')).status).toBe(500);
    });

    test('streams GridFS-backed files through the mocked storage helper', async () => {
        const { Readable } = require('stream');
        Document.getDocumentById.mockResolvedValueOnce({ documentId: 'd1', courseId: 'C1', contentType: 'file', originalName: 'slides.pdf', mimeType: 'application/pdf', fileId: 'grid-1' });
        gridfs.openDownloadStream.mockReturnValueOnce(Readable.from(Buffer.from('binary')));
        const res = await request(app({ db: downloadDb(), user: instructor })).get('/source-documents/d1/download?courseId=C1');
        expect(res.status).toBe(200);
        expect(gridfs.openDownloadStream).toHaveBeenCalledWith(expect.anything(), 'grid-1');
    });
});

describe('main chat pipeline', () => {
    function chatDb(overrides = {}) {
        return memoryDb({ courses: [{
            ...course,
            approvedStruggleTopics: ['ATP synthesis'],
            quizSettings: { allowSourceAttributionDownloads: true },
            ...overrides,
        }] });
    }

    function aiWith({ results = [], responses = [{ content: 'A grounded answer.', model: 'model', usage: { tokens: 9 } }] } = {}) {
        const qdrant = {
            searchDocuments: jest.fn(async () => results),
            // Fan-out path (searchScope.length > 1): defaults to no hits for
            // any lecture unless a test overrides it with mockResolvedValueOnce.
            searchDocumentsByLecture: jest.fn(async () => new Map()),
        };
        const llm = {
            sendMessage: jest.fn(),
            analyzeMentalHealth: jest.fn(async () => ({ concernLevel: 'no concern', reason: '' })),
        };
        for (const response of responses) llm.sendMessage.mockResolvedValueOnce(response);
        resolveCourseAi.mockResolvedValueOnce({ llm, qdrant });
        return { llm, qdrant };
    }

    test('validates DB, message, course context, and published unit', async () => {
        expect((await request(app({ db: null })).post('/').send({ message: 'hi' })).status).toBe(503);
        // Current logging calls .substring() before type validation, so numeric input reaches the catch handler.
        expect((await request(app({ db: memoryDb({}) })).post('/').send({ message: 4 })).status).toBe(500);
        expect((await request(app({ db: memoryDb({}) })).post('/').send({ message: 'hi' })).status).toBe(400);
        expect((await request(app({ db: memoryDb({ courses: [] }) })).post('/').send({ message: 'hi', courseId: 'C1', unitName: 'Unit 1' })).status).toBe(404);
        aiWith();
        expect((await request(app({ db: chatDb(), user: student })).post('/').send({ message: 'hi', courseId: 'C1', unitName: 'Hidden' })).status).toBe(400);
    });

    test('profanity returns a system warning before course or LLM work', async () => {
        const res = await request(app({ db: memoryDb({}) })).post('/').send({ message: 'this is shit', courseId: 'missing', unitName: 'none' });
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ model: 'system', usage: { tokens: 0 }, debug: { profanityFiltered: true } });
    });

    test('retrieves course chunks and returns citations, attribution, and retrieval scope', async () => {
        const results = [
            { score: 0.8, lectureName: 'Unit 1', fileName: 'lecture.pdf', documentId: 'd1', type: 'lecture_notes', chunkText: 'ATP powers cells.' },
            { score: 0.5, lectureName: 'Unit 1', fileName: 'quiz.txt', documentId: 'd2', type: 'practice_q_tutorials', chunkText: 'ATP question.' },
        ];
        const { llm, qdrant } = aiWith({ results });
        const res = await request(app({ db: chatDb(), user: null })).post('/').send({ message: 'Explain ATP', courseId: 'C1', unitName: 'Unit 1' });
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ success: true, message: 'A grounded answer.', retrieval: { mode: 'single', lectureNames: ['Unit 1'] }, debug: { searchResultsCount: 2, maxScore: 0.8 } });
        expect(res.body.citations).toHaveLength(2);
        expect(res.body.sourceAttribution).toMatchObject({ source: 'multiple', downloadsEnabled: true });
        expect(qdrant.searchDocuments).toHaveBeenCalledWith('Explain ATP', { courseId: 'C1', lectureNames: ['Unit 1'] }, 5);
        expect(llm.sendMessage.mock.calls[0][0]).toContain('ATP powers cells');
    });

    test('additive scope with >1 unit fans out per lecture, falls back, and preserves conversation context', async () => {
        const results = [{ score: 0.05, lectureName: 'Unit 2', fileName: 'extra.txt', type: 'additional', chunkText: 'extra' }];
        const { qdrant, llm } = aiWith();
        qdrant.searchDocumentsByLecture
            .mockResolvedValueOnce(new Map()) // main-materials pass: nothing found
            .mockResolvedValueOnce(new Map([['Unit 2', results]])); // additional-materials pass
        const db = chatDb({
            isAdditiveRetrieval: true,
            additionalMaterialSecondarySearch: true,
            lectures: [{ name: 'Unit 1', isPublished: true }, { name: 'Unit 2', isPublished: true }],
        });
        const res = await request(app({ db })).post('/').send({
            message: 'continue', courseId: 'C1', unitName: 'Unit 2', mode: 'protege',
            conversationContext: { conversationMessages: [{ role: 'user', content: 'Earlier' }, { role: 'assistant', content: 'Reply' }] },
        });
        expect(res.status).toBe(200);
        expect(res.body.retrieval).toEqual({ mode: 'additive', lectureNames: ['Unit 1', 'Unit 2'], searchScope: ['Unit 1', 'Unit 2'] });
        // Plain pooled searchDocuments must NOT be used once the scope spans
        // more than one unit - that's exactly the "one unit crowds out the
        // rest" bug (issue #594) this fan-out replaces.
        expect(qdrant.searchDocuments).not.toHaveBeenCalled();
        expect(qdrant.searchDocumentsByLecture.mock.calls[0]).toEqual(['continue', 'C1', ['Unit 1', 'Unit 2'], 5, { excludeAdditionalMaterials: true }]);
        expect(qdrant.searchDocumentsByLecture.mock.calls[1]).toEqual(['continue', 'C1', ['Unit 1', 'Unit 2'], 5, { additionalMaterialsOnly: true }]);
        expect(res.body.sourceAttribution.source).toBe('GPT');
        // Protege mode's own instructions must survive a conversationContext
        // turn instead of being replaced by the tutor-mode wrapper (the
        // "related bug" flagged alongside issue #594's main findings).
        expect(llm.sendMessage.mock.calls[0][0]).toContain('Do not explain the context to the user');
        expect(llm.sendMessage.mock.calls[0][0]).toContain('Previous conversation:');
        expect(llm.sendMessage.mock.calls[0][0]).toContain('Student: continue');
    });

    test('an explicit multi-unit request narrows the search scope and guarantees each named unit a slot', async () => {
        const unit5 = [{ id: '5a', score: 0.6, lectureName: 'Unit 5', fileName: 'u5.pdf', documentId: 'd5', chunkText: 'mutation content' }];
        const unit6 = [{ id: '6a', score: 0.4, lectureName: 'Unit 6', fileName: 'u6.pdf', documentId: 'd6', chunkText: 'population genetics content' }];
        const unit7 = [{ id: '7a', score: 0.9, lectureName: 'Unit 7', fileName: 'u7.pdf', documentId: 'd7', chunkText: 'natural selection content' }];
        const { qdrant, llm } = aiWith();
        qdrant.searchDocumentsByLecture.mockResolvedValueOnce(new Map([
            ['Unit 5', unit5], ['Unit 6', unit6], ['Unit 7', unit7],
        ]));
        const db = chatDb({
            isAdditiveRetrieval: true,
            lectures: ['Unit 1', 'Unit 2', 'Unit 3', 'Unit 4', 'Unit 5', 'Unit 6', 'Unit 7'].map(name => ({ name, isPublished: true })),
        });
        const res = await request(app({ db })).post('/').send({
            message: 'Quiz me on units 5, 6, and 7.', courseId: 'C1', unitName: 'Unit 7',
        });
        expect(res.status).toBe(200);
        // Full allowed scope is still every published unit up to the current
        // one; only the *search* narrows to what was explicitly asked for.
        expect(res.body.retrieval.lectureNames).toHaveLength(7);
        expect(res.body.retrieval.searchScope).toEqual(['Unit 5', 'Unit 6', 'Unit 7']);
        expect(qdrant.searchDocumentsByLecture).toHaveBeenCalledWith(
            'Quiz me on units 5, 6, and 7.', 'C1', ['Unit 5', 'Unit 6', 'Unit 7'], 5, {}
        );
        const lecturesCited = res.body.citations.map(c => c.lectureName).sort();
        expect(lecturesCited).toEqual(['Unit 5', 'Unit 6', 'Unit 7']);
    });

    test('a "through" range narrows to every unit in the range', async () => {
        const { qdrant } = aiWith();
        qdrant.searchDocumentsByLecture.mockResolvedValueOnce(new Map());
        const db = chatDb({
            isAdditiveRetrieval: true,
            lectures: ['Unit 1', 'Unit 2', 'Unit 3', 'Unit 4', 'Unit 5'].map(name => ({ name, isPublished: true })),
        });
        await request(app({ db })).post('/').send({
            message: 'Quiz me on the content of units 1 through 5.', courseId: 'C1', unitName: 'Unit 5',
        });
        expect(qdrant.searchDocumentsByLecture.mock.calls[0][2]).toEqual(['Unit 1', 'Unit 2', 'Unit 3', 'Unit 4', 'Unit 5']);
    });

    test('a vague request with no unit reference searches the full additive scope, not a narrowed one', async () => {
        // This is the real issue #594 incident's condition: additive mode
        // spans many units, and the message carries no topic or unit words
        // at all ("give me a quiz on the content of each unit..."). Fix A
        // can't narrow this (nothing to detect), so fix B's fan-out must
        // still cover every in-scope unit, not just whichever the message
        // happens to mention.
        const { qdrant } = aiWith();
        qdrant.searchDocumentsByLecture.mockResolvedValueOnce(new Map());
        const db = chatDb({
            isAdditiveRetrieval: true,
            lectures: ['Unit 1', 'Unit 2', 'Unit 3'].map(name => ({ name, isPublished: true })),
        });
        const res = await request(app({ db })).post('/').send({
            message: 'give me a quiz on the content of each unit', courseId: 'C1', unitName: 'Unit 3',
        });
        expect(res.body.retrieval.searchScope).toEqual(['Unit 1', 'Unit 2', 'Unit 3']);
        expect(qdrant.searchDocumentsByLecture.mock.calls[0][2]).toEqual(['Unit 1', 'Unit 2', 'Unit 3']);
    });

    test('messageToSend names which units have content and which are missing, and never tells the student to upload material', async () => {
        const results = [{ score: 0.6, lectureName: 'Unit 2', fileName: 'u2.pdf', documentId: 'd2', chunkText: 'covered content' }];
        const { qdrant, llm } = aiWith();
        qdrant.searchDocumentsByLecture.mockResolvedValueOnce(new Map([['Unit 2', results]])); // Unit 4 comes back empty
        const db = chatDb({
            isAdditiveRetrieval: true,
            lectures: [{ name: 'Unit 1', isPublished: true }, { name: 'Unit 2', isPublished: true }, { name: 'Unit 4', isPublished: true }],
        });
        const res = await request(app({ db })).post('/').send({
            message: 'Summarize units 2 and 4.', courseId: 'C1', unitName: 'Unit 4',
        });
        expect(res.status).toBe(200);
        const sentMessage = llm.sendMessage.mock.calls[0][0];
        expect(sentMessage).toContain('only includes material from: Unit 2');
        expect(sentMessage).toContain('No material was retrieved for: Unit 4');
        expect(sentMessage.toLowerCase()).toContain('never ask the student to upload');
    });

    test('explain mode keeps its own instructions across a conversation turn', async () => {
        const { llm } = aiWith();
        const res = await request(app({ db: chatDb() })).post('/').send({
            message: 'go deeper', courseId: 'C1', unitName: 'Unit 1', isExplanationRequest: true,
            conversationContext: { conversationMessages: [{ role: 'user', content: 'what is ATP' }, { role: 'assistant', content: 'ATP is...' }] },
        });
        expect(res.status).toBe(200);
        const sentMessage = llm.sendMessage.mock.calls[0][0];
        expect(sentMessage).toContain('Use the provided course context to help explain the concept if needed');
        expect(sentMessage).toContain('Previous conversation:');
        expect(sentMessage).toContain('Student: go deeper');
    });

    test('summary classification can append a re-prompt and truncated output auto-continues', async () => {
        const long = 'x'.repeat(900);
        const { llm } = aiWith({ responses: [
            { content: 'NO' },
            { content: long, finishReason: 'length', model: 'm', usage: {} },
            { content: 'continued.', finishReason: 'stop', model: 'm', usage: {} },
        ] });
        const res = await request(app({ db: chatDb() })).post('/').send({ message: 'next', courseId: 'C1', unitName: 'Unit 1', checkSummaryAttempt: true });
        expect(res.status).toBe(200);
        expect(llm.sendMessage).toHaveBeenCalledTimes(3);
        expect(res.body.message).toContain('continued.');
        expect(res.body.message).toContain('would you like to summarize');
    });

    test.each([
        ['OLLAMA_ENDPOINT missing', 503],
        ['API key rejected', 401],
        ['service endpoint down', 503],
        ['unexpected', 500],
    ])('maps chat failure %s to status %i', async (message, status) => {
        const qdrant = { searchDocuments: jest.fn(async () => { throw new Error(message); }) };
        resolveCourseAi.mockResolvedValueOnce({ llm: {}, qdrant });
        const res = await request(app({ db: chatDb() })).post('/').send({ message: 'hello', courseId: 'C1', unitName: 'Unit 1' });
        expect(res.status).toBe(status);
    });
});

describe('practice questions', () => {
    test('reports when no seed questions exist', async () => {
        Course.getAssessmentQuestions.mockResolvedValueOnce([]);
        const res = await request(app({ db: memoryDb({}), user: student })).post('/practice-question').send({ courseId: 'C1', unitName: 'Unit 1' });
        expect(res.body).toMatchObject({ success: true, noQuestions: true });
    });

    test('generates a question without revealing its answer and checks MCQ answers', async () => {
        Course.getAssessmentQuestions.mockResolvedValueOnce([{ questionType: 'multiple-choice', question: 'Seed?', options: { A: 'x' }, correctAnswer: 'A' }]);
        resolveCourseAi.mockResolvedValueOnce({ llm: { sendMessage: jest.fn(async () => ({ content: 'prefix {"questionType":"multiple-choice","question":"New?","options":{"A":"yes","B":"no"},"correctAnswer":"A","explanation":"Because."} suffix' })) } });
        const generated = await request(app({ db: memoryDb({}), user: student })).post('/practice-question').send({ courseId: 'C1', unitName: 'Unit 1' });
        expect(generated.status).toBe(200);
        expect(generated.body.data.correctAnswer).toBeUndefined();
        const checked = await request(app({ user: student })).post('/check-practice-answer').send({ practiceId: generated.body.data.practiceId, studentAnswer: ' a ' });
        expect(checked.body.data).toMatchObject({ correct: true, correctAnswer: 'A' });
    });

    test('rejects malformed generated questions and unknown practice IDs', async () => {
        Course.getAssessmentQuestions.mockResolvedValue([{ questionType: 'true-false', question: 'Seed?', correctAnswer: 'true' }]);
        resolveCourseAi.mockResolvedValueOnce({ llm: { sendMessage: jest.fn(async () => ({ content: 'not json' })) } });
        expect((await request(app({ db: memoryDb({}) })).post('/practice-question').send({ courseId: 'C1', unitName: 'Unit 1' })).status).toBe(500);
        expect((await request(app({})).post('/check-practice-answer').send({ practiceId: 'missing', studentAnswer: 'x' })).status).toBe(404);
        expect((await request(app({})).post('/check-practice-answer').send({})).status).toBe(400);
    });
});
