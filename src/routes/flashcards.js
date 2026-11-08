const express = require('express');
const router = express.Router();
const CourseModel = require('../models/Course');
const FlashcardDeck = require('../models/FlashcardDeck');
const flashcardService = require('../services/flashcardService');
const { hasSystemAdminAccess } = require('../services/authorization');
const { resolveCourseAi, sendLlmKeyError } = require('./llmKeyMiddleware');

router.use(express.json());

const generationLocks = new Set();

async function requireInstructorCourse(db, req, res, courseId) {
    if (!req.user) {
        res.status(401).json({ success: false, message: 'Authentication required' });
        return null;
    }
    if (req.user.role !== 'instructor' && !hasSystemAdminAccess(req.user)) {
        res.status(403).json({ success: false, message: 'Only instructors can manage flashcard decks' });
        return null;
    }

    const course = await CourseModel.getCourseById(db, courseId);
    if (!course) {
        res.status(404).json({ success: false, message: 'Course not found' });
        return null;
    }
    const hasAccess = hasSystemAdminAccess(req.user)
        || await CourseModel.userHasCourseAccess(db, courseId, req.user.userId, 'instructor');
    if (!hasAccess) {
        res.status(403).json({ success: false, message: 'You do not have access to manage this course' });
        return null;
    }
    return course;
}

async function requireStudentCourse(db, req, res, courseId) {
    if (!req.user) {
        res.status(401).json({ success: false, message: 'Authentication required' });
        return null;
    }
    if (req.user.role !== 'student') {
        res.status(403).json({ success: false, message: 'This endpoint is only available to students' });
        return null;
    }

    const course = await CourseModel.getCourseById(db, courseId);
    if (!course) {
        res.status(404).json({ success: false, message: 'Course not found' });
        return null;
    }
    const enrollment = await CourseModel.getStudentEnrollment(db, courseId, req.user.userId);
    if (!enrollment.success || enrollment.enrolled === false) {
        res.status(403).json({ success: false, message: 'You are not enrolled in this course' });
        return null;
    }
    return course;
}

function instructorDeckSummary(deck) {
    return {
        deckId: deck.deckId,
        courseId: deck.courseId,
        lectureName: deck.lectureName,
        title: deck.title,
        draftCards: deck.draftCards || [],
        publishedCards: deck.publishedCards || [],
        hasDraft: deck.hasDraft === true,
        isPublished: deck.isPublished === true,
        isStale: deck.isStale === true,
        publishedVersion: deck.publishedVersion || 0,
        draftGeneratedAt: deck.draftGeneratedAt || null,
        publishedAt: deck.publishedAt || null,
        sourceChangedAt: deck.sourceChangedAt || null
    };
}

function publicDeckSummary(deck, progress) {
    const cards = deck.publishedCards || [];
    const progressCards = progress?.cards || {};
    return {
        deckId: deck.deckId,
        courseId: deck.courseId,
        lectureName: deck.lectureName,
        title: deck.title,
        version: deck.publishedVersion || 1,
        cardCount: cards.length,
        knownCount: cards.filter(card => progressCards[card.cardId]?.mastery === 'known').length,
        publishedAt: deck.publishedAt || null
    };
}

router.get('/instructor', async (req, res) => {
    try {
        const { courseId } = req.query;
        if (!courseId) return res.status(400).json({ success: false, message: 'courseId is required' });
        const db = req.app.locals.db;
        const course = await requireInstructorCourse(db, req, res, courseId);
        if (!course) return;

        const decks = await FlashcardDeck.listDecksForCourse(db, courseId);
        return res.json({
            success: true,
            data: {
                units: (course.lectures || []).map(unit => ({
                    name: unit.name,
                    displayName: unit.displayName || unit.name,
                    isPublished: unit.isPublished === true
                })),
                decks: decks.map(instructorDeckSummary)
            }
        });
    } catch (error) {
        console.error('Error listing instructor flashcard decks:', error);
        return res.status(500).json({ success: false, message: 'Unable to load flashcard decks' });
    }
});

router.post('/instructor/generate', async (req, res) => {
    const { courseId, lectureName } = req.body;
    const cardCount = Number(req.body.cardCount || flashcardService.DEFAULT_CARD_COUNT);
    // Absent means on: the instructor UI always sends the flag, and an older
    // client should keep the behaviour it had before the checkbox existed.
    const chemistryNotation = req.body.chemistryNotation !== false;
    if (!courseId || !lectureName) {
        return res.status(400).json({ success: false, message: 'courseId and lectureName are required' });
    }

    const lockKey = `${courseId}:${lectureName}`;
    if (generationLocks.has(lockKey)) {
        return res.status(409).json({ success: false, message: 'A flashcard draft is already being generated for this unit' });
    }

    generationLocks.add(lockKey);
    try {
        const db = req.app.locals.db;
        const course = await requireInstructorCourse(db, req, res, courseId);
        if (!course) return;

        const existing = await FlashcardDeck.getDeckForUnit(db, courseId, lectureName);
        if (existing?.draftGeneratedAt && Date.now() - new Date(existing.draftGeneratedAt).getTime() < 15000) {
            return res.status(429).json({ success: false, message: 'Please wait before generating this deck again' });
        }

        const ai = await resolveCourseAi(req, res, courseId);
        if (!ai) return;
        const deck = await flashcardService.generateDeck({
            db,
            llmService: ai.llm,
            qdrantService: ai.qdrant,
            course,
            lectureName,
            cardCount,
            generatedBy: req.user.userId,
            promptTemplate: course.prompts?.flashcards,
            sourceTokenBudget: course.prompts?.flashcardSourceTokenBudget,
            chemistryNotation
        });
        return res.json({
            success: true,
            message: `Generated ${deck.draftCards.length} draft flashcards`,
            data: instructorDeckSummary(deck)
        });
    } catch (error) {
        if (sendLlmKeyError(res, error)) return;
        console.error('Error generating flashcard deck:', error);
        const isInputError = /card count|unit not found|no parsed|enough text/i.test(error.message);
        return res.status(isInputError ? 400 : 500).json({
            success: false,
            message: error.message || 'Unable to generate flashcards'
        });
    } finally {
        generationLocks.delete(lockKey);
    }
});

router.post('/instructor/from-question', async (req, res) => {
    try {
        const { courseId, lectureName, front, back } = req.body;
        if (!courseId || !lectureName || !front || !back) {
            return res.status(400).json({ success: false, message: 'courseId, lectureName, front, and back are required' });
        }

        const db = req.app.locals.db;
        const course = await requireInstructorCourse(db, req, res, courseId);
        if (!course) return;

        const deck = await FlashcardDeck.addManualCard(db, courseId, lectureName, { front, back, source: null }, req.user.userId);
        return res.json({ success: true, message: 'Added flashcard from question', data: instructorDeckSummary(deck) });
    } catch (error) {
        console.error('Error converting question to flashcard:', error);
        return res.status(400).json({ success: false, message: error.message || 'Unable to add flashcard' });
    }
});

router.put('/instructor/:deckId', async (req, res) => {
    try {
        const db = req.app.locals.db;
        const deck = await FlashcardDeck.getDeckById(db, req.params.deckId);
        if (!deck) return res.status(404).json({ success: false, message: 'Flashcard deck not found' });
        const course = await requireInstructorCourse(db, req, res, deck.courseId);
        if (!course) return;

        const updated = await FlashcardDeck.updateDraft(db, deck.deckId, {
            title: req.body.title,
            cards: req.body.cards
        });
        return res.json({ success: true, message: 'Draft saved', data: instructorDeckSummary(updated) });
    } catch (error) {
        console.error('Error updating flashcard draft:', error);
        return res.status(400).json({ success: false, message: error.message || 'Unable to save draft' });
    }
});

router.post('/instructor/:deckId/publish', async (req, res) => {
    try {
        const db = req.app.locals.db;
        const deck = await FlashcardDeck.getDeckById(db, req.params.deckId);
        if (!deck) return res.status(404).json({ success: false, message: 'Flashcard deck not found' });
        const course = await requireInstructorCourse(db, req, res, deck.courseId);
        if (!course) return;

        const published = await FlashcardDeck.publishDraft(db, deck.deckId, req.user.userId);
        return res.json({ success: true, message: 'Flashcard deck published', data: instructorDeckSummary(published) });
    } catch (error) {
        console.error('Error publishing flashcard deck:', error);
        return res.status(400).json({ success: false, message: error.message || 'Unable to publish deck' });
    }
});

router.post('/instructor/:deckId/unpublish', async (req, res) => {
    try {
        const db = req.app.locals.db;
        const deck = await FlashcardDeck.getDeckById(db, req.params.deckId);
        if (!deck) return res.status(404).json({ success: false, message: 'Flashcard deck not found' });
        const course = await requireInstructorCourse(db, req, res, deck.courseId);
        if (!course) return;

        const updated = await FlashcardDeck.unpublishDeck(db, deck.deckId);
        return res.json({ success: true, message: 'Flashcard deck unpublished', data: instructorDeckSummary(updated) });
    } catch (error) {
        console.error('Error unpublishing flashcard deck:', error);
        return res.status(500).json({ success: false, message: 'Unable to unpublish deck' });
    }
});

router.get('/student', async (req, res) => {
    try {
        const { courseId } = req.query;
        if (!courseId) return res.status(400).json({ success: false, message: 'courseId is required' });
        const db = req.app.locals.db;
        const course = await requireStudentCourse(db, req, res, courseId);
        if (!course) return;

        const publishedUnits = (course.lectures || []).filter(unit => unit.isPublished).map(unit => unit.name);
        const decks = await FlashcardDeck.listPublishedDecks(db, courseId, publishedUnits);
        const data = await Promise.all(decks.map(async deck => {
            const progress = await FlashcardDeck.getStudentProgress(db, req.user.userId, deck.deckId);
            return publicDeckSummary(deck, progress);
        }));
        return res.json({ success: true, data });
    } catch (error) {
        console.error('Error listing student flashcard decks:', error);
        return res.status(500).json({ success: false, message: 'Unable to load flashcard decks' });
    }
});

router.get('/student/:deckId', async (req, res) => {
    try {
        const { courseId } = req.query;
        if (!courseId) return res.status(400).json({ success: false, message: 'courseId is required' });
        const db = req.app.locals.db;
        const course = await requireStudentCourse(db, req, res, courseId);
        if (!course) return;

        const deck = await FlashcardDeck.getDeckById(db, req.params.deckId);
        const unit = (course.lectures || []).find(item => item.name === deck?.lectureName);
        if (!deck || deck.courseId !== courseId || !deck.isPublished || !unit?.isPublished) {
            return res.status(404).json({ success: false, message: 'Published flashcard deck not found' });
        }

        const progress = await FlashcardDeck.getStudentProgress(db, req.user.userId, deck.deckId);
        return res.json({
            success: true,
            data: {
                ...publicDeckSummary(deck, progress),
                cards: deck.publishedCards || [],
                progress: progress?.cards || {}
            }
        });
    } catch (error) {
        console.error('Error loading student flashcard deck:', error);
        return res.status(500).json({ success: false, message: 'Unable to load flashcard deck' });
    }
});

router.post('/student/:deckId/review', async (req, res) => {
    try {
        const { courseId, cardId, rating } = req.body;
        if (!courseId || !cardId || !['again', 'know'].includes(rating)) {
            return res.status(400).json({ success: false, message: 'courseId, cardId, and a valid rating are required' });
        }
        const db = req.app.locals.db;
        const course = await requireStudentCourse(db, req, res, courseId);
        if (!course) return;

        const deck = await FlashcardDeck.getDeckById(db, req.params.deckId);
        const unit = (course.lectures || []).find(item => item.name === deck?.lectureName);
        const cardExists = deck?.publishedCards?.some(card => card.cardId === cardId);
        if (!deck || deck.courseId !== courseId || !deck.isPublished || !unit?.isPublished || !cardExists) {
            return res.status(404).json({ success: false, message: 'Flashcard is not available' });
        }

        const progress = await FlashcardDeck.saveStudentReview(db, {
            studentId: req.user.userId,
            courseId,
            deckId: deck.deckId,
            deckVersion: deck.publishedVersion,
            cardId,
            rating
        });
        return res.json({ success: true, data: progress.cards?.[cardId] || null });
    } catch (error) {
        console.error('Error saving flashcard review:', error);
        return res.status(500).json({ success: false, message: 'Unable to save review progress' });
    }
});

module.exports = router;
