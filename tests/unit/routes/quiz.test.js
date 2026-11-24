/**
 * In-process route tests for src/routes/quiz.js (supertest).
 * Real: Course + QuizAttempt models over memory-db and provider-aware key
 * summaries. Mocked: gridfs (download only) and llmKeyMiddleware
 * (resolveCourseAi/sendLlmKeyError). Covers status, objective check-answer,
 * attempt recording, and history.
 */
jest.mock('../../../src/services/gridfs', () => ({}));
jest.mock('../../../src/routes/llmKeyMiddleware', () => ({
    resolveCourseAi: jest.fn(async () => ({ llm: {} })),
    sendLlmKeyError: jest.fn(() => false),
}));
const { memoryDb } = require('../helpers/memory-db');
const { makeRouteApp, request } = require('../helpers/route-app');
const quizRouter = require('../../../src/routes/quiz');
const activityEvents = require('../../../src/services/activityEvents');

const student = { userId: 's1', role: 'student' };
const app = (opts) => makeRouteApp(quizRouter, opts);

// A course with quiz enabled, one published unit, and one MC question (answer "B").
function quizDb() {
    return memoryDb({ courses: [{
        courseId: 'C1',
        llmApiKey: { status: 'valid' },
        quizSettings: { enabled: true, testableUnits: 'all', allowLectureMaterialAccess: true },
        lectures: [{
            name: 'Unit 1', isPublished: true,
            assessmentQuestions: [{ questionId: 'q1', questionType: 'multiple-choice', question: 'Pick one', correctAnswer: 'B' }],
        }],
    }] });
}

beforeAll(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterAll(() => jest.restoreAllMocks());

describe('GET /status', () => {
    test('400 without courseId, 503 without db', async () => {
        expect((await request(app({ db: memoryDb({}) })).get('/status')).status).toBe(400);
        expect((await request(app({ db: null })).get('/status?courseId=C1')).status).toBe(503);
    });

    test('enabled only when quiz is on AND a valid key is present', async () => {
        const on = await request(app({ db: quizDb() })).get('/status?courseId=C1');
        expect(on.body).toMatchObject({ success: true, enabled: true, aiAvailable: true });

        const noKey = memoryDb({ courses: [{ courseId: 'C1', quizSettings: { enabled: true } }] });
        const off = await request(app({ db: noKey })).get('/status?courseId=C1');
        expect(off.body).toMatchObject({ enabled: false, aiAvailable: false });
    });

    test('uses the active Sandbox credential instead of the legacy OpenAI field', async () => {
        const db = memoryDb({ courses: [{
            courseId: 'C1',
            activeLlmProvider: 'ubc-llm-sandbox',
            llmCredentials: { 'ubc-llm-sandbox': { status: 'valid' } },
            quizSettings: { enabled: true }
        }] });

        const res = await request(app({ db })).get('/status?courseId=C1');

        expect(res.body).toMatchObject({
            success: true,
            enabled: true,
            aiAvailable: true,
            llmProvider: 'ubc-llm-sandbox',
            llmKey: { status: 'valid' },
            aiPreparationRequired: false
        });
    });

    test('keeps Sandbox quiz AI disabled while copied materials are being prepared', async () => {
        const db = memoryDb({ courses: [{
            courseId: 'C1',
            activeLlmProvider: 'ubc-llm-sandbox',
            llmCredentials: { 'ubc-llm-sandbox': { status: 'valid' } },
            aiPreparationRequired: true,
            quizSettings: { enabled: true }
        }] });

        const res = await request(app({ db })).get('/status?courseId=C1');

        expect(res.body).toMatchObject({
            enabled: false,
            aiAvailable: false,
            llmProvider: 'ubc-llm-sandbox',
            aiPreparationRequired: true
        });
    });
});

describe('POST /check-answer', () => {
    test('400 when required fields are missing', async () => {
        const res = await request(app({ db: quizDb() })).post('/check-answer').send({ courseId: 'C1' });
        expect(res.status).toBe(400);
    });

    test('grades a correct multiple-choice answer server-side', async () => {
        const res = await request(app({ db: quizDb() })).post('/check-answer')
            .send({ courseId: 'C1', questionId: 'q1', lectureName: 'Unit 1', studentAnswer: 'b' }); // case-insensitive
        expect(res.status).toBe(200);
        expect(res.body.data).toEqual({ correct: true, feedback: 'Correct! Well done.', correctAnswer: 'B' });
    });

    test('grades an incorrect answer and reveals the correct one in feedback', async () => {
        const res = await request(app({ db: quizDb() })).post('/check-answer')
            .send({ courseId: 'C1', questionId: 'q1', lectureName: 'Unit 1', studentAnswer: 'A' });
        expect(res.body.data).toMatchObject({ correct: false, correctAnswer: 'B' });
        expect(res.body.data.feedback).toMatch(/correct answer is B/);
    });

    test('403 when the quiz is disabled, 404 for an unknown question', async () => {
        const disabled = memoryDb({ courses: [{ courseId: 'C1', quizSettings: { enabled: false } }] });
        expect((await request(app({ db: disabled })).post('/check-answer')
            .send({ courseId: 'C1', questionId: 'q1', lectureName: 'Unit 1', studentAnswer: 'B' })).status).toBe(403);

        expect((await request(app({ db: quizDb() })).post('/check-answer')
            .send({ courseId: 'C1', questionId: 'nope', lectureName: 'Unit 1', studentAnswer: 'B' })).status).toBe(404);
    });
});

describe('POST /attempt', () => {
    test('401 when there is no authenticated student', async () => {
        const res = await request(app({ db: quizDb() })).post('/attempt')
            .send({ courseId: 'C1', questionId: 'q1', lectureName: 'Unit 1', questionType: 'multiple-choice', studentAnswer: 'B', correct: true });
        expect(res.status).toBe(401);
    });

    test('409 when submitted correctness disagrees with the stored answer', async () => {
        const res = await request(app({ db: quizDb(), user: student })).post('/attempt')
            .send({ courseId: 'C1', questionId: 'q1', lectureName: 'Unit 1', questionType: 'multiple-choice', studentAnswer: 'B', correct: false });
        expect(res.status).toBe(409);
    });

    test('records a valid attempt and returns an attemptId', async () => {
        const db = quizDb();
        const res = await request(app({ db, user: student })).post('/attempt')
            .send({ courseId: 'C1', questionId: 'q1', lectureName: 'Unit 1', questionType: 'multiple-choice', studentAnswer: 'B', correct: true });
        expect(res.status).toBe(200);
        expect(res.body.attemptId).toMatch(/^qa_[0-9a-f-]{36}$/i);
        expect(await db.collection('quizAttempts').findOne({ studentId: 's1' })).toBeTruthy();
    });

    test('announces a saved answer as practice activity, and nothing for a refused one', async () => {
        const announce = jest.spyOn(activityEvents, 'publishQuestionAnswered');
        try {
            const body = { courseId: 'C1', questionId: 'q1', lectureName: 'Unit 1', questionType: 'multiple-choice', studentAnswer: 'B' };
            await request(app({ db: quizDb(), user: student })).post('/attempt').send({ ...body, correct: false });
            await request(app({ db: quizDb() })).post('/attempt').send({ ...body, correct: true });
            expect(announce).not.toHaveBeenCalled();

            const res = await request(app({ db: quizDb(), user: student })).post('/attempt').send({ ...body, correct: true });
            expect(res.status).toBe(200);
            expect(announce).toHaveBeenCalledTimes(1);
            expect(announce).toHaveBeenCalledWith(student, { courseId: 'C1', unit: 'Unit 1', correct: true });
        } finally {
            announce.mockRestore();
        }
    });
});

describe('GET /history', () => {
    test('401 without a user, 400 without courseId', async () => {
        expect((await request(app({ db: memoryDb({}), user: student })).get('/history')).status).toBe(400);
        expect((await request(app({ db: memoryDb({}) })).get('/history?courseId=C1')).status).toBe(401);
    });

    test('returns aggregated stats for the student', async () => {
        const db = memoryDb({ quizAttempts: [
            { studentId: 's1', courseId: 'C1', lectureName: 'Unit 1', correct: true },
            { studentId: 's1', courseId: 'C1', lectureName: 'Unit 1', correct: false },
        ] });
        const res = await request(app({ db, user: student })).get('/history?courseId=C1');
        expect(res.status).toBe(200);
        expect(res.body.stats).toMatchObject({ totalAttempts: 2, correctCount: 1, accuracy: 50 });
    });
});
