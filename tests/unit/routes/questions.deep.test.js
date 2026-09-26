/**
 * Deepening pass for src/routes/questions.js (supertest), additive to
 * questions.test.js. Targets branches not reached by the base suite:
 * system-admin/TA read+write access, the requireCourseQuestionAccess
 * "course missing on write" passthrough, the auto-link JSON-extraction
 * fallbacks and write-back loop, course-material's non-priority fallback
 * and truncation path, generate-ai's access/unit/content/regenerate
 * branches, and the generic catch blocks across every handler.
 */
jest.mock('../../../src/routes/llmKeyMiddleware', () => ({
    resolveCourseAi: jest.fn(async () => ({ llm: {} })),
    sendLlmKeyError: jest.fn(() => false),
}));

const { memoryDb } = require('../helpers/memory-db');
const { makeRouteApp, request } = require('../helpers/route-app');
const { resolveCourseAi, sendLlmKeyError } = require('../../../src/routes/llmKeyMiddleware');
const questionsRouter = require('../../../src/routes/questions');

const instructor = { userId: 'i1', role: 'instructor' };
const student = { userId: 's1', role: 'student' };
const ta = { userId: 't1', role: 'ta' };
// Not role: 'instructor', so the write-mode instructorId-mismatch guard
// (which only fires for role === 'instructor') never short-circuits this user.
const systemAdmin = { userId: 'admin1', role: 'staff', permissions: { systemAdmin: true } };
const app = (opts) => makeRouteApp(questionsRouter, opts);

// A db whose .collection() throws synchronously, to drive every handler's
// generic catch block without depending on a specific model's internals.
const malformedDb = () => ({ collection: () => { throw new Error('boom'); } });

function courseDb(overrides = {}) {
    return memoryDb({ courses: [{
        courseId: 'C1',
        instructorId: 'i1',
        tas: ['t1'],
        studentEnrollment: { s1: { enrolled: true } },
        lectures: [{
            name: 'Unit 1',
            learningObjectives: [],
            assessmentQuestions: [{
                questionId: 'q1',
                questionType: 'multiple-choice',
                question: 'Existing question?',
                correctAnswer: 'A',
                points: 2,
            }],
        }],
        ...overrides,
    }] });
}

beforeAll(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterAll(() => jest.restoreAllMocks());

describe('access helpers — system admin and TA branches', () => {
    test('a system admin can read embedded questions for a course they do not own', async () => {
        const res = await request(app({ db: courseDb(), user: systemAdmin })).get('/lecture?courseId=C1&lectureName=Unit%201');
        expect(res.status).toBe(200);
        expect(res.body.data.count).toBe(1);
    });

    test('a system admin can mutate questions for a course they do not own', async () => {
        const res = await request(app({ db: courseDb(), user: systemAdmin })).post('/').send({
            courseId: 'C1', lectureName: 'Unit 1', instructorId: 'i1',
            questionType: 'short-answer', question: 'Admin-created?', correctAnswer: 'yes',
        });
        expect(res.status).toBe(200);
        expect(res.body.data.created).toBe(true);
    });

    test('a TA explicitly granted the questions permission can create a question', async () => {
        const db = courseDb({ taPermissions: { t1: { questions: true } } });
        const res = await request(app({ db, user: ta })).post('/').send({
            courseId: 'C1', lectureName: 'Unit 1', instructorId: 'i1',
            questionType: 'short-answer', question: 'TA-created?', correctAnswer: 'yes',
        });
        expect(res.status).toBe(200);
    });

    test('a TA with no permissions record is blocked from mutating (fail-closed default)', async () => {
        const res = await request(app({ db: courseDb(), user: ta })).post('/').send({
            courseId: 'C1', lectureName: 'Unit 1', instructorId: 'i1',
            questionType: 'short-answer', question: 'Blocked?', correctAnswer: 'yes',
        });
        expect(res.status).toBe(403);
    });

    test('a TA whose questions permission is explicitly denied is blocked from mutating', async () => {
        const db = courseDb({ taPermissions: { t1: { questions: false, flags: true } } });
        const res = await request(app({ db, user: ta })).post('/').send({
            courseId: 'C1', lectureName: 'Unit 1', instructorId: 'i1',
            questionType: 'short-answer', question: 'Blocked?', correctAnswer: 'yes',
        });
        expect(res.status).toBe(403);
    });

    test('a write request for a nonexistent course passes the access check and fails at the model with 400', async () => {
        const res = await request(app({ db: memoryDb({ courses: [] }), user: instructor })).post('/').send({
            courseId: 'ghost', lectureName: 'Unit 1', instructorId: 'i1',
            questionType: 'short-answer', question: 'Q?', correctAnswer: 'A',
        });
        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/Course not found/);
    });
});

describe('catch blocks — generic 500s via a db that throws', () => {
    test('POST / 500s when the db throws', async () => {
        const res = await request(app({ db: malformedDb(), user: instructor })).post('/').send({
            courseId: 'C1', lectureName: 'Unit 1', instructorId: 'i1',
            questionType: 'short-answer', question: 'Q?', correctAnswer: 'A',
        });
        expect(res.status).toBe(500);
        expect(res.body.message).toMatch(/creating question/);
    });

    test('GET /lecture 500s when the db throws', async () => {
        const res = await request(app({ db: malformedDb(), user: instructor })).get('/lecture?courseId=C1&lectureName=Unit%201');
        expect(res.status).toBe(500);
    });

    test('GET /stats 500s when the db throws', async () => {
        const res = await request(app({ db: malformedDb(), user: instructor })).get('/stats?courseId=C1');
        expect(res.status).toBe(500);
    });

    test('GET /course-material 500s when the db throws', async () => {
        const res = await request(app({ db: malformedDb() })).get('/course-material?courseId=C1&lectureName=Unit%201&instructorId=i1');
        expect(res.status).toBe(500);
    });

    test('GET /:questionId 500s when the db throws', async () => {
        const res = await request(app({ db: malformedDb(), user: instructor })).get('/q1');
        expect(res.status).toBe(500);
    });

    test('PUT /:questionId 500s when the db throws', async () => {
        const res = await request(app({ db: malformedDb(), user: instructor })).put('/q1').send({
            courseId: 'C1', lectureName: 'Unit 1', instructorId: 'i1', question: 'X',
        });
        expect(res.status).toBe(500);
    });

    test('DELETE /:questionId 500s when the db throws', async () => {
        const res = await request(app({ db: malformedDb(), user: instructor })).delete('/q1').send({
            courseId: 'C1', lectureName: 'Unit 1', instructorId: 'i1',
        });
        expect(res.status).toBe(500);
    });

    test('POST /bulk 500s when the db throws', async () => {
        const res = await request(app({ db: malformedDb(), user: instructor })).post('/bulk').send({
            courseId: 'C1', lectureName: 'Unit 1', instructorId: 'i1', questions: [{ question: 'Q?' }],
        });
        expect(res.status).toBe(500);
    });

    test('POST /generate-ai 500s when the db throws', async () => {
        const res = await request(app({ db: malformedDb(), user: instructor })).post('/generate-ai').send({
            courseId: 'C1', lectureName: 'Unit 1', instructorId: 'i1', questionType: 'multiple-choice',
        });
        expect(res.status).toBe(500);
        expect(res.body.error).toBe('boom');
    });
});

describe('GET /:questionId — db unavailable', () => {
    test('503 when db is missing', async () => {
        const res = await request(app({ db: null, user: instructor })).get('/q1');
        expect(res.status).toBe(503);
    });
});

describe('POST /auto-link-learning-objectives — validation and db-unavailable branches', () => {
    test('400 when courseId or lectureName is missing', async () => {
        const res = await request(app({ db: courseDb(), user: instructor })).post('/auto-link-learning-objectives').send({ instructorId: 'i1' });
        expect(res.status).toBe(400);
    });

    test('503 when db is missing', async () => {
        const res = await request(app({ db: null, user: instructor })).post('/auto-link-learning-objectives').send({
            courseId: 'C1', lectureName: 'Unit 1', instructorId: 'i1',
        });
        expect(res.status).toBe(503);
    });
});

describe('GET /course-material — remaining validation branches', () => {
    test('503 when db is missing', async () => {
        const res = await request(app({ db: null })).get('/course-material?courseId=C1&lectureName=Unit%201&instructorId=i1');
        expect(res.status).toBe(503);
    });

    test('404s when every document is present but blank', async () => {
        const db = courseDb({ lectures: [{ name: 'Unit 1', documents: [
            { type: 'lecture_notes', originalName: 'Lecture Notes', content: '   ' },
        ] }] });
        const res = await request(app({ db })).get('/course-material?courseId=C1&lectureName=Unit%201&instructorId=i1');
        expect(res.status).toBe(404);
        expect(res.body.message).toMatch(/No content found in documents/);
    });
});

describe('PUT /:questionId — remaining branches', () => {
    test('400 when required fields are missing', async () => {
        const res = await request(app({ db: courseDb(), user: instructor })).put('/q1').send({ courseId: 'C1' });
        expect(res.status).toBe(400);
    });

    test('503 when db is missing', async () => {
        const res = await request(app({ db: null, user: instructor })).put('/q1').send({
            courseId: 'C1', lectureName: 'Unit 1', instructorId: 'i1', question: 'X',
        });
        expect(res.status).toBe(503);
    });

    test('updates an existing question and reports the modified count', async () => {
        const res = await request(app({ db: courseDb(), user: instructor })).put('/q1').send({
            courseId: 'C1', lectureName: 'Unit 1', instructorId: 'i1',
            question: 'Updated question text', points: 5,
        });
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({ questionId: 'q1', updatedCount: 1 });
    });

    test('400s when the course/lecture lookup falls through to a model failure', async () => {
        // questionId "q1" doesn't exist on a lecture that doesn't exist either, so
        // the route's own existence check no-ops and the model reports the real error.
        const res = await request(app({ db: courseDb(), user: instructor })).put('/q1').send({
            courseId: 'C1', lectureName: 'No Such Unit', instructorId: 'i1', question: 'X',
        });
        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/Lecture not found/);
    });
});

describe('DELETE /:questionId — remaining branches', () => {
    test('400 when required fields are missing', async () => {
        const res = await request(app({ db: courseDb(), user: instructor })).delete('/q1').send({ courseId: 'C1' });
        expect(res.status).toBe(400);
    });

    test('503 when db is missing', async () => {
        const res = await request(app({ db: null, user: instructor })).delete('/q1').send({
            courseId: 'C1', lectureName: 'Unit 1', instructorId: 'i1',
        });
        expect(res.status).toBe(503);
    });

    test('400 when the model reports the lecture is missing', async () => {
        const res = await request(app({ db: courseDb(), user: instructor })).delete('/q1').send({
            courseId: 'C1', lectureName: 'No Such Unit', instructorId: 'i1',
        });
        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/Lecture not found/);
    });

    test('deletes an existing question with deletedCount 1', async () => {
        const res = await request(app({ db: courseDb(), user: instructor })).delete('/q1').send({
            courseId: 'C1', lectureName: 'Unit 1', instructorId: 'i1',
        });
        expect(res.status).toBe(200);
        expect(res.body.data).toEqual({ questionId: 'q1', deletedCount: 1 });
    });
});

describe('GET /lecture and GET /stats — db unavailable / empty-course branches', () => {
    test('GET /lecture 503s when db is missing', async () => {
        const res = await request(app({ db: null })).get('/lecture?courseId=C1&lectureName=Unit%201');
        expect(res.status).toBe(503);
    });

    test('GET /stats 503s when db is missing', async () => {
        const res = await request(app({ db: null, user: instructor })).get('/stats?courseId=C1');
        expect(res.status).toBe(503);
    });

    test('GET /stats returns a zeroed payload (not nested under "stats") for an unknown course', async () => {
        const res = await request(app({ db: memoryDb({ courses: [] }), user: instructor })).get('/stats?courseId=ghost');
        expect(res.status).toBe(200);
        expect(res.body.data).toEqual({ courseId: 'ghost', stats: { totalQuestions: 0, totalPoints: 0, typeBreakdown: [] } });
    });

    test('GET /stats returns the same zeroed payload for a course with no lectures field', async () => {
        const db = memoryDb({ courses: [{ courseId: 'C1', instructorId: 'i1' }] });
        const res = await request(app({ db, user: instructor })).get('/stats?courseId=C1');
        expect(res.status).toBe(200);
        expect(res.body.data.stats.totalQuestions).toBe(0);
    });
});

describe('POST /bulk — db unavailable and auto-linking branches', () => {
    test('503 when db is missing', async () => {
        const res = await request(app({ db: null, user: instructor })).post('/bulk').send({
            courseId: 'C1', lectureName: 'Unit 1', instructorId: 'i1', questions: [],
        });
        expect(res.status).toBe(503);
    });

    test('auto-links questions that are missing a learning objective using the mocked LLM', async () => {
        const db = courseDb({ lectures: [{ name: 'Unit 1', learningObjectives: ['Explain ATP'], assessmentQuestions: [] }] });
        const sendMessage = jest.fn(async () => ({ content: '{"matches":[{"ref":"question-1","learningObjective":"explain atp"}]}' }));
        resolveCourseAi.mockResolvedValueOnce({ llm: { sendMessage } });
        const res = await request(app({ db, user: instructor })).post('/bulk').send({
            courseId: 'C1', lectureName: 'Unit 1', instructorId: 'i1',
            questions: [{ questionType: 'short-answer', question: 'ATP?', correctAnswer: 'Energy' }],
        });
        expect(res.status).toBe(200);
        expect(sendMessage).toHaveBeenCalled();
        expect(res.body.data.autoLinkedCount).toBe(1);
        expect(res.body.data.insertedCount).toBe(1);
    });

    test('swallows an auto-linking failure and still creates the questions unlinked', async () => {
        const db = courseDb({ lectures: [{ name: 'Unit 1', learningObjectives: ['Explain ATP'], assessmentQuestions: [] }] });
        resolveCourseAi.mockResolvedValueOnce({ llm: { sendMessage: jest.fn(async () => { throw new Error('LLM down'); }) } });
        const res = await request(app({ db, user: instructor })).post('/bulk').send({
            courseId: 'C1', lectureName: 'Unit 1', instructorId: 'i1',
            questions: [{ questionType: 'short-answer', question: 'ATP?', correctAnswer: 'Energy' }],
        });
        expect(res.status).toBe(200);
        expect(res.body.data.autoLinkedCount).toBe(0);
        expect(res.body.data.insertedCount).toBe(1);
    });
});

describe('POST /check-answer — error branches', () => {
    test('500s when the mocked LLM throws', async () => {
        resolveCourseAi.mockResolvedValueOnce({ llm: { evaluateStudentAnswer: jest.fn(async () => { throw new Error('eval failed'); }) } });
        const res = await request(app({})).post('/check-answer').send({
            courseId: 'C1', question: 'Q', studentAnswer: 'A', expectedAnswer: 'A',
        });
        expect(res.status).toBe(500);
        expect(res.body.message).toMatch(/checking answer/);
    });

    test('defers to sendLlmKeyError when the thrown error is an LLM-key error', async () => {
        resolveCourseAi.mockResolvedValueOnce({ llm: { evaluateStudentAnswer: jest.fn(async () => { throw new Error('missing key'); }) } });
        sendLlmKeyError.mockImplementationOnce((res) => {
            res.status(403).json({ success: false, code: 'LLM_KEY_MISSING' });
            return true;
        });
        const res = await request(app({})).post('/check-answer').send({
            courseId: 'C1', question: 'Q', studentAnswer: 'A', expectedAnswer: 'A',
        });
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('LLM_KEY_MISSING');
    });
});

describe('POST /auto-link-learning-objectives — JSON-extraction fallbacks and the write-back loop', () => {
    test('treats a response with no JSON object as zero matches', async () => {
        resolveCourseAi.mockResolvedValueOnce({ llm: { sendMessage: jest.fn(async () => ({ content: 'no json in here at all' })) } });
        const res = await request(app({ db: courseDb(), user: instructor })).post('/auto-link-learning-objectives').send({
            courseId: 'C1', lectureName: 'Unit 1', instructorId: 'i1',
            learningObjectives: ['Explain ATP'],
            questions: [{ questionId: 'q1', question: 'ATP?' }],
        });
        expect(res.status).toBe(200);
        expect(res.body.data.matchedQuestions[0].learningObjective).toBe('');
    });

    test('treats an unparsable braced fragment as zero matches', async () => {
        resolveCourseAi.mockResolvedValueOnce({ llm: { sendMessage: jest.fn(async () => ({ content: 'prefix {not: valid, json} suffix' })) } });
        const res = await request(app({ db: courseDb(), user: instructor })).post('/auto-link-learning-objectives').send({
            courseId: 'C1', lectureName: 'Unit 1', instructorId: 'i1',
            learningObjectives: ['Explain ATP'],
            questions: [{ questionId: 'q1', question: 'ATP?' }],
        });
        expect(res.status).toBe(200);
        expect(res.body.data.matchedQuestions[0].learningObjective).toBe('');
    });

    test('skips match entries without a ref and resolves a ref with no objective to empty', async () => {
        resolveCourseAi.mockResolvedValueOnce({ llm: { sendMessage: jest.fn(async () => ({
            content: '{"matches":[{"learningObjective":"explain atp"},{"ref":"q2"}]}',
        })) } });
        const res = await request(app({ db: courseDb(), user: instructor })).post('/auto-link-learning-objectives').send({
            courseId: 'C1', lectureName: 'Unit 1', instructorId: 'i1',
            learningObjectives: ['Explain ATP'],
            questions: [{ questionId: 'q1', question: 'Q1?' }, { questionId: 'q2', question: 'Q2?' }],
        });
        expect(res.status).toBe(200);
        expect(res.body.data.matchedQuestions.map(q => q.learningObjective)).toEqual(['', '']);
    });

    test('write-back mode (no questions array) updates only newly-matched questions and skips the rest', async () => {
        const db = courseDb({ lectures: [{
            name: 'Unit 1',
            learningObjectives: [],
            assessmentQuestions: [
                { questionId: 'q1', questionType: 'short-answer', question: 'Q1?', correctAnswer: 'A' },
                { questionId: 'q2', questionType: 'short-answer', question: 'Q2?', correctAnswer: 'A', learningObjective: 'Existing' },
                { questionId: 'q3', questionType: 'short-answer', question: 'Q3?', correctAnswer: 'A' },
            ],
        }] });
        const sendMessage = jest.fn(async () => ({ content: '{"matches":[{"ref":"q1","learningObjective":"explain atp"}]}' }));
        resolveCourseAi.mockResolvedValueOnce({ llm: { sendMessage } });
        const res = await request(app({ db, user: instructor })).post('/auto-link-learning-objectives').send({
            courseId: 'C1', lectureName: 'Unit 1', instructorId: 'i1', learningObjectives: ['Explain ATP'],
        });
        expect(res.status).toBe(200);
        expect(res.body.data.updatedCount).toBe(1);
        expect(res.body.data.totalQuestions).toBe(3);
        expect(res.body.data.matchedQuestions).toEqual(expect.arrayContaining([
            expect.objectContaining({ questionId: 'q1', learningObjective: 'Explain ATP' }),
            expect.objectContaining({ questionId: 'q2', learningObjective: 'Existing' }),
            expect.objectContaining({ questionId: 'q3', learningObjective: '' }),
        ]));
    });

    test('500s when the mocked LLM call throws', async () => {
        resolveCourseAi.mockResolvedValueOnce({ llm: { sendMessage: jest.fn(async () => { throw new Error('LLM unavailable'); }) } });
        const res = await request(app({ db: courseDb(), user: instructor })).post('/auto-link-learning-objectives').send({
            courseId: 'C1', lectureName: 'Unit 1', instructorId: 'i1',
            learningObjectives: ['Explain ATP'],
            questions: [{ questionId: 'q1', question: 'ATP?' }],
        });
        expect(res.status).toBe(500);
        expect(res.body.message).toMatch(/auto-linking questions/);
    });
});

describe('GET /course-material — non-priority fallback and truncation', () => {
    test('falls back to any document with content when no priority document exists', async () => {
        const db = courseDb({ lectures: [{ name: 'Unit 1', documents: [
            { type: 'additional', originalName: 'Extra', content: 'fallback body text' },
        ] }] });
        const res = await request(app({ db })).get('/course-material?courseId=C1&lectureName=Unit%201&instructorId=i1');
        expect(res.status).toBe(200);
        expect(res.body.data.content).toContain('fallback body text');
    });

    test('truncates combined content over the 16000-char limit and notes the section count', async () => {
        const db = courseDb({ lectures: [{ name: 'Unit 1', documents: [
            { type: 'lecture_notes', originalName: 'Lecture Notes A', content: 'X'.repeat(9000) },
            { type: 'practice_q_tutorials', originalName: 'Practice Questions B', content: 'Y'.repeat(9000) },
        ] }] });
        const res = await request(app({ db })).get('/course-material?courseId=C1&lectureName=Unit%201&instructorId=i1');
        expect(res.status).toBe(200);
        expect(res.body.data.content).toMatch(/\[Content truncated: \d+\/\d+ sections included\]/);
    });
});

describe('POST /generate-ai — remaining access, content, and regenerate branches', () => {
    function generationDb(overrides = {}) {
        return memoryDb({
            courses: [{
                courseId: 'C1', instructorId: 'i1', approvedStruggleTopics: [],
                lectures: [{ name: 'Unit 1', displayName: 'Energy', documents: [{ documentId: 'd1', documentType: 'lecture-notes' }] }],
                ...overrides,
            }],
            documents: [{ documentId: 'd1', courseId: 'C1', originalName: 'Lecture Notes', content: 'ATP synthesis uses a proton gradient.' }],
        });
    }
    const basePayload = { courseId: 'C1', lectureName: 'Unit 1', instructorId: 'i1', questionType: 'multiple-choice' };

    test('404s when the course does not exist', async () => {
        const res = await request(app({ db: memoryDb({ courses: [] }), user: instructor })).post('/generate-ai').send(basePayload);
        expect(res.status).toBe(404);
    });

    test('grants access to a TA with the questions permission for this course', async () => {
        const db = generationDb({
            instructorId: 'someone-else',
            tas: ['t1'],
            taPermissions: { t1: { questions: true } },
        });
        resolveCourseAi.mockResolvedValueOnce({ llm: { generateAssessmentQuestion: jest.fn(async () => ({ question: 'Q?', answer: 'A' })) } });
        const res = await request(app({ db, user: ta })).post('/generate-ai').send(basePayload);
        expect(res.status).toBe(200);
    });

    test('blocks a TA listed in course.tas who lacks the questions permission', async () => {
        const db = generationDb({ instructorId: 'someone-else', tas: ['t1'], taPermissions: { t1: { questions: false } } });
        const res = await request(app({ db, user: ta })).post('/generate-ai').send(basePayload);
        expect(res.status).toBe(403);
    });

    test('404s when the unit does not exist in the course', async () => {
        const res = await request(app({ db: generationDb(), user: instructor })).post('/generate-ai').send({ ...basePayload, lectureName: 'Missing Unit' });
        expect(res.status).toBe(404);
    });

    test('400s when the unit has no documents at all', async () => {
        const db = generationDb({ lectures: [{ name: 'Unit 1', documents: [] }] });
        const res = await request(app({ db, user: instructor })).post('/generate-ai').send(basePayload);
        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/No course materials found/);
    });

    test('400s when the referenced document has no usable content', async () => {
        const db = memoryDb({
            courses: [{ courseId: 'C1', instructorId: 'i1', approvedStruggleTopics: [],
                lectures: [{ name: 'Unit 1', documents: [{ documentId: 'ghost', documentType: 'lecture-notes' }] }] }],
            documents: [],
        });
        const res = await request(app({ db, user: instructor })).post('/generate-ai').send(basePayload);
        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/No content found in documents/);
    });

    test('truncates combined content over the 6000-char limit before calling the mocked LLM', async () => {
        const db = memoryDb({
            courses: [{ courseId: 'C1', instructorId: 'i1', approvedStruggleTopics: [],
                lectures: [{ name: 'Unit 1', documents: [
                    { documentId: 'd1', documentType: 'lecture-notes' },
                    { documentId: 'd2', documentType: 'practice-quiz' },
                ] }] }],
            documents: [
                { documentId: 'd1', courseId: 'C1', originalName: 'Lecture Notes', content: 'X'.repeat(4000) },
                { documentId: 'd2', courseId: 'C1', originalName: 'Practice Questions', content: 'Y'.repeat(4000) },
            ],
        });
        const generateAssessmentQuestion = jest.fn(async () => ({ question: 'Q?', answer: 'A' }));
        resolveCourseAi.mockResolvedValueOnce({ llm: { generateAssessmentQuestion } });
        const res = await request(app({ db, user: instructor })).post('/generate-ai').send(basePayload);
        expect(res.status).toBe(200);
        expect(generateAssessmentQuestion.mock.calls[0][1]).toMatch(/\[Content truncated: \d+\/\d+ included\]/);
    });

    test('uses course-specific question prompts when present', async () => {
        const db = generationDb({ questionPrompts: { systemPrompt: 'Be concise' } });
        const generateAssessmentQuestion = jest.fn(async () => ({ question: 'Q?', answer: 'A' }));
        resolveCourseAi.mockResolvedValueOnce({ llm: { generateAssessmentQuestion } });
        const res = await request(app({ db, user: instructor })).post('/generate-ai').send(basePayload);
        expect(res.status).toBe(200);
        expect(generateAssessmentQuestion.mock.calls[0][4]).toEqual({ systemPrompt: 'Be concise' });
    });

    test('regenerates with full objective context and re-links the result via the mocked LLM', async () => {
        const regenerateAssessmentQuestion = jest.fn(async () => ({ question: 'Regenerated Q?', answer: 'B', options: { A: 'x', B: 'y' } }));
        const sendMessage = jest.fn(async () => ({ content: '{"matches":[{"ref":"regenerated-question","learningObjective":"explain atp"}]}' }));
        resolveCourseAi.mockResolvedValueOnce({ llm: { regenerateAssessmentQuestion, sendMessage } });
        const res = await request(app({ db: generationDb(), user: instructor })).post('/generate-ai').send({
            ...basePayload, regenerate: true, feedback: 'Make it harder', previousQuestion: 'Old Q?',
            learningObjectives: ['Explain ATP', 'Explain ADP'],
        });
        expect(res.status).toBe(200);
        expect(res.body.data.wasRegenerated).toBe(true);
        expect(res.body.data.selectedLearningObjective).toBe('Explain ATP');
        const formattedObjectives = regenerateAssessmentQuestion.mock.calls[0][3];
        expect(formattedObjectives).toContain('1. Explain ATP');
        expect(formattedObjectives).toContain('2. Explain ADP');
        expect(regenerateAssessmentQuestion.mock.calls[0][4]).toBe('Old Q?');
        expect(regenerateAssessmentQuestion.mock.calls[0][5]).toBe('Make it harder');
    });

    test('swallows a failed re-link after regeneration and reports an empty selected objective', async () => {
        const regenerateAssessmentQuestion = jest.fn(async () => ({ question: 'Regenerated Q?', answer: 'B' }));
        const sendMessage = jest.fn(async () => { throw new Error('relink failed'); });
        resolveCourseAi.mockResolvedValueOnce({ llm: { regenerateAssessmentQuestion, sendMessage } });
        const res = await request(app({ db: generationDb(), user: instructor })).post('/generate-ai').send({
            ...basePayload, regenerate: true, feedback: 'Make it harder', previousQuestion: 'Old Q?',
            learningObjectives: ['Explain ATP'],
        });
        expect(res.status).toBe(200);
        expect(res.body.data.selectedLearningObjective).toBe('');
    });
});

describe('coverage: missing-user access arms and the post-match race 404', () => {
    test('unauthenticated reads and writes get the wrapper\'s 401 (helpers\' !user arms are dead)', async () => {
        // requireCourseQuestionAccess 401s before canRead/canMutateCourseQuestions
        // ever run, so those helpers' own missing-user arms are unreachable.
        expect((await request(app({ db: courseDb() })).get('/q1')).status).toBe(401);
        const body = { courseId: 'C1', lectureName: 'Unit 1', instructorId: 'i1', question: 'Updated?' };
        expect((await request(app({ db: courseDb() })).put('/q1').send(body)).status).toBe(401);
    });

    test('GET /:questionId returns 404 when the question disappears between match and scan', async () => {
        // Simulates a concurrent edit: the course-level dotted query matches, but
        // the returned document no longer contains the question.
        const racingDb = { collection: () => ({
            findOne: async () => ({ courseId: 'C1', lectures: [{ name: 'Unit 1', assessmentQuestions: [{ questionId: 'other' }] }] }),
        }) };
        const res = await request(app({ db: racingDb, user: systemAdmin })).get('/q1');
        expect(res.status).toBe(404);
        expect(res.body.message).toBe('Question not found');
    });
});
