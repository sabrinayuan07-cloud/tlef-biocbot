const { createId } = require('../services/id');

const DECKS_COLLECTION = 'flashcardDecks';
const PROGRESS_COLLECTION = 'flashcardProgress';
const MIN_CARD_COUNT = 1;
const MAX_CARD_COUNT = 20;

function getDecksCollection(db) {
    return db.collection(DECKS_COLLECTION);
}

function getProgressCollection(db) {
    return db.collection(PROGRESS_COLLECTION);
}

function normalizeText(value, maxLength) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function normalizeSource(source) {
    if (!source || typeof source !== 'object') return null;
    const documentId = normalizeText(source.documentId, 160);
    const fileName = normalizeText(source.fileName, 240);
    const chunkIndex = Number.isInteger(source.chunkIndex) ? source.chunkIndex : null;
    const pageNumber = Number.isInteger(source.pageNumber) ? source.pageNumber : null;
    const slideNumber = Number.isInteger(source.slideNumber) ? source.slideNumber : null;

    if (!documentId && !fileName) return null;
    return { documentId: documentId || null, fileName: fileName || 'Course material', chunkIndex, pageNumber, slideNumber };
}

function normalizeFront(value) {
    return normalizeText(value, 300).toLowerCase();
}

function prepareCards(cards, previousCards = []) {
    if (!Array.isArray(cards)) {
        throw new Error('Cards must be an array');
    }
    if (cards.length < MIN_CARD_COUNT || cards.length > MAX_CARD_COUNT) {
        throw new Error(`A deck must contain between ${MIN_CARD_COUNT} and ${MAX_CARD_COUNT} cards`);
    }

    const previousById = new Map(previousCards.filter(Boolean).map(card => [card.cardId, card]));
    const previousByFront = new Map(
        previousCards
            .filter(card => card && card.front)
            .map(card => [normalizeFront(card.front), card])
    );
    const seenFronts = new Set();

    return cards.map((card) => {
        const front = normalizeText(card && card.front, 300);
        const back = normalizeText(card && card.back, 1200);
        if (!front || !back) {
            throw new Error('Every flashcard needs a front and back');
        }

        const normalizedFront = front.toLowerCase();
        if (seenFronts.has(normalizedFront)) {
            throw new Error('Flashcard fronts must be unique within a deck');
        }
        seenFronts.add(normalizedFront);

        const matchingPrevious = previousById.get(card.cardId) || previousByFront.get(normalizedFront);
        return {
            cardId: matchingPrevious?.cardId || createId('fc'),
            front,
            back,
            source: normalizeSource(card.source)
        };
    });
}

async function ensureIndexes(db) {
    const decks = getDecksCollection(db);
    const progress = getProgressCollection(db);
    await decks.createIndex({ deckId: 1 }, { unique: true });
    await decks.createIndex({ courseId: 1, lectureName: 1 }, { unique: true });
    await decks.createIndex({ courseId: 1, isPublished: 1 });
    await progress.createIndex({ studentId: 1, deckId: 1 }, { unique: true });
}

async function getDeckById(db, deckId) {
    return getDecksCollection(db).findOne({ deckId });
}

async function getDeckForUnit(db, courseId, lectureName) {
    return getDecksCollection(db).findOne({ courseId, lectureName });
}

async function listDecksForCourse(db, courseId) {
    return getDecksCollection(db)
        .find({ courseId })
        .sort({ lectureName: 1 })
        .toArray();
}

async function listPublishedDecks(db, courseId, lectureNames = []) {
    const query = { courseId, isPublished: true };
    if (Array.isArray(lectureNames) && lectureNames.length > 0) {
        query.lectureName = { $in: lectureNames };
    }
    return getDecksCollection(db).find(query).sort({ lectureName: 1 }).toArray();
}

async function saveGeneratedDraft(db, data) {
    const collection = getDecksCollection(db);
    const existing = await getDeckForUnit(db, data.courseId, data.lectureName);
    const previousCards = existing?.draftCards?.length
        ? existing.draftCards
        : (existing?.publishedCards || []);
    const draftCards = prepareCards(data.cards, previousCards);
    const now = new Date();

    const deck = await collection.findOneAndUpdate(
        { courseId: data.courseId, lectureName: data.lectureName },
        {
            $set: {
                title: normalizeText(data.title, 160) || `${data.lectureName} Flashcards`,
                draftCards,
                draftSourceDocumentIds: [...new Set((data.sourceDocumentIds || []).filter(Boolean))],
                draftGeneratedAt: now,
                draftGeneratedBy: data.generatedBy,
                hasDraft: true,
                isStale: false,
                updatedAt: now
            },
            $setOnInsert: {
                deckId: createId('deck'),
                publishedCards: [],
                publishedSourceDocumentIds: [],
                publishedVersion: 0,
                isPublished: false,
                createdAt: now
            }
        },
        { upsert: true, returnDocument: 'after' }
    );

    return deck;
}

/**
 * Append a single manually-provided card (e.g. converted from an assessment
 * question) to a unit's deck, creating the deck if it doesn't exist yet -
 * decks are otherwise only created via AI generation.
 */
async function addManualCard(db, courseId, lectureName, card, userId) {
    const collection = getDecksCollection(db);
    const existing = await getDeckForUnit(db, courseId, lectureName);
    const previousCards = existing?.draftCards?.length
        ? existing.draftCards
        : (existing?.publishedCards || []);
    const draftCards = prepareCards([...previousCards, card], previousCards);
    const now = new Date();

    return collection.findOneAndUpdate(
        { courseId, lectureName },
        {
            $set: {
                draftCards,
                hasDraft: true,
                isStale: false,
                updatedAt: now
            },
            $setOnInsert: {
                deckId: createId('deck'),
                title: `${lectureName} Flashcards`,
                draftSourceDocumentIds: [],
                draftGeneratedBy: userId,
                publishedCards: [],
                publishedSourceDocumentIds: [],
                publishedVersion: 0,
                isPublished: false,
                createdAt: now
            }
        },
        { upsert: true, returnDocument: 'after' }
    );
}

async function updateDraft(db, deckId, updates) {
    const existing = await getDeckById(db, deckId);
    if (!existing) return null;

    const set = { updatedAt: new Date(), hasDraft: true };
    if (updates.title !== undefined) {
        set.title = normalizeText(updates.title, 160) || `${existing.lectureName} Flashcards`;
    }
    if (updates.cards !== undefined) {
        set.draftCards = prepareCards(updates.cards, existing.draftCards || existing.publishedCards || []);
    }

    await getDecksCollection(db).updateOne({ deckId }, { $set: set });
    return getDeckById(db, deckId);
}

async function publishDraft(db, deckId, publishedBy) {
    const existing = await getDeckById(db, deckId);
    if (!existing) return null;
    if (!Array.isArray(existing.draftCards) || existing.draftCards.length === 0) {
        throw new Error('Generate or edit a draft before publishing');
    }

    const now = new Date();
    await getDecksCollection(db).updateOne(
        { deckId },
        {
            $set: {
                publishedCards: existing.draftCards,
                publishedSourceDocumentIds: existing.draftSourceDocumentIds || [],
                publishedVersion: (existing.publishedVersion || 0) + 1,
                publishedAt: now,
                publishedBy,
                isPublished: true,
                hasDraft: false,
                draftCards: [],
                draftSourceDocumentIds: [],
                isStale: false,
                updatedAt: now
            }
        }
    );
    return getDeckById(db, deckId);
}

async function unpublishDeck(db, deckId) {
    const existing = await getDeckById(db, deckId);
    if (!existing) return null;

    const existingDraft = Array.isArray(existing.draftCards) && existing.draftCards.length > 0
        ? existing.draftCards
        : null;
    const draftCards = existingDraft || existing.publishedCards || [];
    const draftSourceDocumentIds = existingDraft
        ? (existing.draftSourceDocumentIds || [])
        : (existing.publishedSourceDocumentIds || []);
    const result = await getDecksCollection(db).updateOne(
        { deckId },
        {
            $set: {
                isPublished: false,
                hasDraft: draftCards.length > 0,
                draftCards,
                draftSourceDocumentIds,
                updatedAt: new Date()
            }
        }
    );
    return result.matchedCount > 0 ? getDeckById(db, deckId) : null;
}

async function markUnitStale(db, courseId, lectureName) {
    await getDecksCollection(db).updateOne(
        { courseId, lectureName },
        { $set: { isStale: true, sourceChangedAt: new Date(), updatedAt: new Date() } }
    );
}

async function getStudentProgress(db, studentId, deckId) {
    return getProgressCollection(db).findOne({ studentId, deckId });
}

async function saveStudentReview(db, data) {
    const now = new Date();
    const mastery = data.rating === 'know' ? 'known' : 'learning';
    const key = `cards.${data.cardId}`;
    return getProgressCollection(db).findOneAndUpdate(
        { studentId: data.studentId, deckId: data.deckId },
        {
            $set: {
                courseId: data.courseId,
                deckVersion: data.deckVersion,
                [`${key}.mastery`]: mastery,
                [`${key}.lastReviewedAt`]: now,
                updatedAt: now
            },
            $inc: { [`${key}.timesReviewed`]: 1 },
            $setOnInsert: { createdAt: now }
        },
        { upsert: true, returnDocument: 'after' }
    );
}

module.exports = {
    DECKS_COLLECTION,
    PROGRESS_COLLECTION,
    MIN_CARD_COUNT,
    MAX_CARD_COUNT,
    ensureIndexes,
    prepareCards,
    getDeckById,
    getDeckForUnit,
    listDecksForCourse,
    listPublishedDecks,
    saveGeneratedDraft,
    addManualCard,
    updateDraft,
    publishDraft,
    unpublishDeck,
    markUnitStale,
    getStudentProgress,
    saveStudentReview
};
