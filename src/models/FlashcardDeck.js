const { createId } = require('../services/id');
const { isPreviewUserId } = require('../services/previewSession');

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
    // Supports the instructor-facing "review again" aggregation, which scans
    // every student's progress for a course's decks rather than one student's.
    await progress.createIndex({ courseId: 1, deckId: 1 });
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

/**
 * Edit a single card's text in place, by cardId, wherever it currently
 * lives - draftCards, publishedCards, or both. Used by the instructor
 * "Review again" view, where the card an instructor is correcting is
 * typically already published (students are actively reviewing it), so
 * this intentionally skips the normal draft -> publish flow and the
 * publishedVersion bump that would come with it: it's a text correction,
 * not a new release.
 * @param {Object} db - MongoDB database instance
 * @param {string} deckId - Deck containing the card
 * @param {string} cardId - Card to edit
 * @param {{front: string, back: string}} updates - New front/back text
 * @returns {Promise<Object|null>} The updated deck, or null if the deck doesn't exist
 */
async function updateCardText(db, deckId, cardId, updates) {
    const existing = await getDeckById(db, deckId);
    if (!existing) return null;

    const front = normalizeText(updates.front, 300);
    const back = normalizeText(updates.back, 1200);
    if (!front || !back) {
        throw new Error('Every flashcard needs a front and back');
    }
    const normalizedFront = normalizeFront(front);

    const applyToList = (cards) => {
        if (!Array.isArray(cards)) return null;
        const index = cards.findIndex(card => card.cardId === cardId);
        if (index === -1) return null;
        const collides = cards.some((card, i) => i !== index && normalizeFront(card.front) === normalizedFront);
        if (collides) {
            throw new Error('Flashcard fronts must be unique within a deck');
        }
        const updated = [...cards];
        updated[index] = { ...updated[index], front, back };
        return updated;
    };

    const updatedDraft = applyToList(existing.draftCards);
    const updatedPublished = applyToList(existing.publishedCards);
    if (!updatedDraft && !updatedPublished) {
        throw new Error('Flashcard not found');
    }

    const set = { updatedAt: new Date() };
    if (updatedDraft) set.draftCards = updatedDraft;
    if (updatedPublished) set.publishedCards = updatedPublished;

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
    // Progress is read back cross-student for the instructor "review again"
    // aggregation, so a "View as Student" sandbox session must not write here -
    // same reasoning as PersistenceTopic.incrementStudentCount.
    if (isPreviewUserId(data.studentId)) {
        return { skipped: true, reason: 'preview' };
    }

    const now = new Date();
    const mastery = data.rating === 'know' ? 'known' : 'learning';
    const key = `cards.${data.cardId}`;
    const inc = { [`${key}.timesReviewed`]: 1 };
    // Tracked separately from timesReviewed, which mixes "again" and "know"
    // presses together - this is what lets the instructor view distinguish
    // "missed once" from "missed five times" instead of collapsing both into
    // the same 'learning' mastery state.
    if (data.rating === 'again') {
        inc[`${key}.againCount`] = 1;
    }
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
            $inc: inc,
            $setOnInsert: { createdAt: now }
        },
        { upsert: true, returnDocument: 'after' }
    );
}

/**
 * Aggregate "review again" presses across every student in a course, at the
 * card level (cards carry no topic label today, so this doesn't attempt to
 * map them to approved topics). Each flashcardProgress document is already
 * exactly one per student per deck, so counting documents with
 * cards.<cardId>.againCount > 0 naturally counts each student once per card -
 * no separate studentIds set needed, unlike PersistenceTopic.
 * @param {Object} db - MongoDB database instance
 * @param {string} courseId - Course identifier
 * @returns {Promise<Array>} Cards sorted by distinct-student count descending,
 *   each with { deckId, cardId, lectureName, deckTitle, front, back, source,
 *   studentCount, totalAgainCount }
 */
async function getReviewAgainStats(db, courseId) {
    // Plain find + in-process grouping rather than an aggregation pipeline -
    // a course's flashcardProgress set is small enough (one doc per student
    // per deck) that this is simpler to read than $objectToArray/$unwind,
    // matching PersistenceTopic's own "fine for a class of <1000" reasoning.
    const progressDocs = await getProgressCollection(db).find({ courseId }).toArray();

    const statsByKey = new Map();
    for (const doc of progressDocs) {
        for (const [cardId, cardProgress] of Object.entries(doc.cards || {})) {
            if (!cardProgress || !(cardProgress.againCount > 0)) continue;
            const key = `${doc.deckId}::${cardId}`;
            const existing = statsByKey.get(key) || { deckId: doc.deckId, cardId, studentCount: 0, totalAgainCount: 0 };
            existing.studentCount += 1;
            existing.totalAgainCount += cardProgress.againCount;
            statsByKey.set(key, existing);
        }
    }

    const rows = [...statsByKey.values()];
    if (rows.length === 0) return [];

    const deckIds = [...new Set(rows.map(row => row.deckId))];
    const decks = await getDecksCollection(db).find({ deckId: { $in: deckIds } }).toArray();
    const deckById = new Map(decks.map(deck => [deck.deckId, deck]));

    return rows
        .map(row => {
            const deck = deckById.get(row.deckId);
            // A card can be mid-edit (in draftCards, not yet republished) -
            // check both so a recently-tweaked card doesn't vanish from stats.
            const card = deck?.publishedCards?.find(c => c.cardId === row.cardId)
                || deck?.draftCards?.find(c => c.cardId === row.cardId);
            if (!deck || !card) return null;
            return {
                deckId: row.deckId,
                cardId: row.cardId,
                lectureName: deck.lectureName,
                deckTitle: deck.title,
                front: card.front,
                back: card.back,
                source: card.source,
                studentCount: row.studentCount,
                totalAgainCount: row.totalAgainCount
            };
        })
        // Drop cards that no longer exist (deck edited/card removed since).
        .filter(Boolean)
        .sort((a, b) => b.studentCount - a.studentCount || b.totalAgainCount - a.totalAgainCount);
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
    updateCardText,
    publishDraft,
    unpublishDeck,
    markUnitStale,
    getStudentProgress,
    saveStudentReview,
    getReviewAgainStats
};
