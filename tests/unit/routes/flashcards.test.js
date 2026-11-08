jest.mock('../../../src/routes/llmKeyMiddleware', () => ({
    resolveCourseAi: jest.fn(async () => ({ llm: {} })),
    sendLlmKeyError: jest.fn(() => false)
}));
jest.mock('../../../src/services/flashcardService', () => ({
    DEFAULT_CARD_COUNT: 10,
    generateDeck: jest.fn()
}));

const { memoryDb } = require('../helpers/memory-db');
const { makeRouteApp, request } = require('../helpers/route-app');
const FlashcardDeck = require('../../../src/models/FlashcardDeck');
const flashcardService = require('../../../src/services/flashcardService');
const router = require('../../../src/routes/flashcards');

const instructor = { userId: 'i1', role: 'instructor' };
const student = { userId: 's1', role: 'student' };
const app = (options) => makeRouteApp(router, options);

function courseDb() {
    return memoryDb({
        courses: [{
            courseId: 'C1',
            courseName: 'BIOC 301',
            instructorId: 'i1',
            instructors: ['i1'],
            studentEnrollment: { s1: { enrolled: true } },
            prompts: {
                flashcards: 'Custom flashcard instructions',
                flashcardSourceTokenBudget: 24000
            },
            lectures: [
                { name: 'Unit 1', displayName: 'Enzymes', isPublished: true },
                { name: 'Unit 2', displayName: 'Hidden', isPublished: false }
            ]
        }]
    });
}

async function seedPublishedDeck(db, lectureName = 'Unit 1') {
    const draft = await FlashcardDeck.saveGeneratedDraft(db, {
        courseId: 'C1',
        lectureName,
        cards: [{ front: 'Front', back: 'Back', source: { documentId: 'd1', fileName: 'Lecture.pdf' } }],
        generatedBy: 'i1'
    });
    return FlashcardDeck.publishDraft(db, draft.deckId, 'i1');
}

beforeAll(() => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterAll(() => jest.restoreAllMocks());

describe('flashcard instructor routes', () => {
    test('rejects students from instructor deck management', async () => {
        const response = await request(app({ db: courseDb(), user: student })).get('/instructor?courseId=C1');
        expect(response.status).toBe(403);
    });

    test('lists course decks and publishes an edited draft', async () => {
        const db = courseDb();
        const draft = await FlashcardDeck.saveGeneratedDraft(db, {
            courseId: 'C1',
            lectureName: 'Unit 1',
            cards: [{ front: 'Front', back: 'Back' }],
            generatedBy: 'i1'
        });

        const list = await request(app({ db, user: instructor })).get('/instructor?courseId=C1');
        expect(list.status).toBe(200);
        expect(list.body.data.decks[0]).toMatchObject({ deckId: draft.deckId, hasDraft: true });

        const published = await request(app({ db, user: instructor }))
            .post(`/instructor/${draft.deckId}/publish`);
        expect(published.status).toBe(200);
        expect(published.body.data).toMatchObject({ isPublished: true, publishedVersion: 1 });

        const unpublished = await request(app({ db, user: instructor }))
            .post(`/instructor/${draft.deckId}/unpublish`);
        expect(unpublished.status).toBe(200);
        expect(unpublished.body.data).toMatchObject({
            isPublished: false,
            hasDraft: true,
            draftCards: expect.any(Array)
        });

        const republished = await request(app({ db, user: instructor }))
            .post(`/instructor/${draft.deckId}/publish`);
        expect(republished.status).toBe(200);
        expect(republished.body.data).toMatchObject({ isPublished: true, publishedVersion: 2 });
    });

    test('returns the generated service draft', async () => {
        const db = courseDb();
        flashcardService.generateDeck.mockResolvedValueOnce({
            deckId: 'deck-generated',
            courseId: 'C1',
            lectureName: 'Unit 1',
            draftCards: [{ cardId: 'fc1', front: 'F', back: 'B' }],
            publishedCards: [],
            hasDraft: true
        });
        const response = await request(app({ db, user: instructor }))
            .post('/instructor/generate')
            .send({ courseId: 'C1', lectureName: 'Unit 1', cardCount: 5 });
        expect(response.status).toBe(200);
        expect(response.body.data.deckId).toBe('deck-generated');
        expect(flashcardService.generateDeck).toHaveBeenCalledWith(
            expect.objectContaining({
                promptTemplate: 'Custom flashcard instructions',
                sourceTokenBudget: 24000
            })
        );
    });

    test('rejects a question-to-flashcard conversion missing required fields', async () => {
        const response = await request(app({ db: courseDb(), user: instructor }))
            .post('/instructor/from-question')
            .send({ courseId: 'C1', lectureName: 'Unit 1' });
        expect(response.status).toBe(400);
    });

    test('rejects students from converting a question to a flashcard', async () => {
        const response = await request(app({ db: courseDb(), user: student }))
            .post('/instructor/from-question')
            .send({ courseId: 'C1', lectureName: 'Unit 1', front: 'Q', back: 'A' });
        expect(response.status).toBe(403);
    });

    test('creates a deck on demand from a converted question', async () => {
        const db = courseDb();
        const response = await request(app({ db, user: instructor }))
            .post('/instructor/from-question')
            .send({ courseId: 'C1', lectureName: 'Unit 1', front: 'What is a question?', back: 'A flashcard now.' });

        expect(response.status).toBe(200);
        expect(response.body.data.hasDraft).toBe(true);
        expect(response.body.data.draftCards).toHaveLength(1);
        expect(response.body.data.draftCards[0]).toMatchObject({ front: 'What is a question?', back: 'A flashcard now.' });
    });

    test('appends a converted question onto an existing draft', async () => {
        const db = courseDb();
        await FlashcardDeck.saveGeneratedDraft(db, {
            courseId: 'C1', lectureName: 'Unit 1', cards: [{ front: 'Existing', back: 'Card' }], generatedBy: 'i1'
        });

        const response = await request(app({ db, user: instructor }))
            .post('/instructor/from-question')
            .send({ courseId: 'C1', lectureName: 'Unit 1', front: 'New card from a question', back: 'Its answer' });

        expect(response.status).toBe(200);
        expect(response.body.data.draftCards).toHaveLength(2);
    });
});

describe('flashcard student routes', () => {
    test('lists only published decks in published units', async () => {
        const db = courseDb();
        await seedPublishedDeck(db, 'Unit 1');
        await seedPublishedDeck(db, 'Unit 2');

        const response = await request(app({ db, user: student })).get('/student?courseId=C1');
        expect(response.status).toBe(200);
        expect(response.body.data).toHaveLength(1);
        expect(response.body.data[0].lectureName).toBe('Unit 1');
    });

    test('loads cards without draft data and saves private review progress', async () => {
        const db = courseDb();
        const deck = await seedPublishedDeck(db);
        const loaded = await request(app({ db, user: student }))
            .get(`/student/${deck.deckId}?courseId=C1`);
        expect(loaded.status).toBe(200);
        expect(loaded.body.data.cards).toHaveLength(1);
        expect(loaded.body.data).not.toHaveProperty('draftCards');

        const cardId = loaded.body.data.cards[0].cardId;
        const reviewed = await request(app({ db, user: student }))
            .post(`/student/${deck.deckId}/review`)
            .send({ courseId: 'C1', cardId, rating: 'know' });
        expect(reviewed.status).toBe(200);
        expect(reviewed.body.data).toMatchObject({ mastery: 'known', timesReviewed: 1 });
    });

    test('does not expose unpublished unit decks by id', async () => {
        const db = courseDb();
        const deck = await seedPublishedDeck(db, 'Unit 2');
        const response = await request(app({ db, user: student }))
            .get(`/student/${deck.deckId}?courseId=C1`);
        expect(response.status).toBe(404);
    });
});
