const { memoryDb } = require('../helpers/memory-db');
const FlashcardDeck = require('../../../src/models/FlashcardDeck');
const { buildPreviewUserId } = require('../../../src/services/previewSession');

function sampleCards() {
    return [
        {
            front: 'What does ATP synthase produce?',
            back: 'ATP from ADP and inorganic phosphate.',
            source: { documentId: 'doc1', fileName: 'Lecture 1.pdf', chunkIndex: 2 }
        },
        {
            front: 'Where is the proton gradient formed?',
            back: 'Across the inner mitochondrial membrane.',
            source: { documentId: 'doc1', fileName: 'Lecture 1.pdf', chunkIndex: 3 }
        }
    ];
}

describe('FlashcardDeck', () => {
    test('creates a draft, publishes it, and keeps one shared unit deck', async () => {
        const db = memoryDb({});
        const draft = await FlashcardDeck.saveGeneratedDraft(db, {
            courseId: 'C1',
            lectureName: 'Unit 1',
            title: 'Energy',
            cards: sampleCards(),
            sourceDocumentIds: ['doc1'],
            generatedBy: 'i1'
        });

        expect(draft.deckId).toMatch(/^deck_[0-9a-f-]{36}$/i);
        expect(draft.hasDraft).toBe(true);
        expect(draft.draftCards).toHaveLength(2);
        expect(draft.draftCards[0].cardId).toMatch(/^fc_[0-9a-f-]{36}$/i);

        const published = await FlashcardDeck.publishDraft(db, draft.deckId, 'i1');
        expect(published).toMatchObject({
            isPublished: true,
            hasDraft: false,
            publishedVersion: 1,
            publishedBy: 'i1'
        });
        expect(published.publishedCards).toHaveLength(2);

        const visible = await FlashcardDeck.listPublishedDecks(db, 'C1', ['Unit 1']);
        expect(visible).toHaveLength(1);

        const unpublished = await FlashcardDeck.unpublishDeck(db, draft.deckId);
        expect(unpublished).toMatchObject({
            isPublished: false,
            hasDraft: true,
            draftCards: published.publishedCards
        });

        const republished = await FlashcardDeck.publishDraft(db, draft.deckId, 'i1');
        expect(republished).toMatchObject({
            isPublished: true,
            hasDraft: false,
            publishedVersion: 2
        });
    });

    test('preserves card ids when regenerating the same front', async () => {
        const db = memoryDb({});
        const first = await FlashcardDeck.saveGeneratedDraft(db, {
            courseId: 'C1', lectureName: 'Unit 1', cards: sampleCards(), generatedBy: 'i1'
        });
        const originalId = first.draftCards[0].cardId;

        const regenerated = await FlashcardDeck.saveGeneratedDraft(db, {
            courseId: 'C1',
            lectureName: 'Unit 1',
            cards: [{ ...sampleCards()[0], back: 'A revised answer.' }, sampleCards()[1]],
            generatedBy: 'i1'
        });
        expect(regenerated.deckId).toBe(first.deckId);
        expect(regenerated.draftCards[0].cardId).toBe(originalId);
    });

    test('validates blank and duplicate cards', () => {
        expect(() => FlashcardDeck.prepareCards([{ front: '', back: 'answer' }])).toThrow(/front and back/i);
        expect(() => FlashcardDeck.prepareCards([
            { front: 'Same', back: 'one' },
            { front: ' same ', back: 'two' }
        ])).toThrow(/unique/i);
    });

    test('marks a deck stale without removing its published cards', async () => {
        const db = memoryDb({});
        const draft = await FlashcardDeck.saveGeneratedDraft(db, {
            courseId: 'C1', lectureName: 'Unit 1', cards: sampleCards(), generatedBy: 'i1'
        });
        await FlashcardDeck.publishDraft(db, draft.deckId, 'i1');
        await FlashcardDeck.markUnitStale(db, 'C1', 'Unit 1');

        const deck = await FlashcardDeck.getDeckById(db, draft.deckId);
        expect(deck.isStale).toBe(true);
        expect(deck.isPublished).toBe(true);
        expect(deck.publishedCards).toHaveLength(2);
    });

    test('updateCardText edits a published card in place without bumping publishedVersion', async () => {
        const db = memoryDb({});
        const draft = await FlashcardDeck.saveGeneratedDraft(db, {
            courseId: 'C1', lectureName: 'Unit 1', cards: sampleCards(), generatedBy: 'i1'
        });
        const published = await FlashcardDeck.publishDraft(db, draft.deckId, 'i1');
        const cardId = published.publishedCards[0].cardId;

        const updated = await FlashcardDeck.updateCardText(db, draft.deckId, cardId, {
            front: 'What does ATP synthase actually produce?',
            back: 'ATP, from ADP and inorganic phosphate.'
        });

        expect(updated.publishedVersion).toBe(1);
        expect(updated.publishedCards[0]).toMatchObject({
            cardId,
            front: 'What does ATP synthase actually produce?',
            back: 'ATP, from ADP and inorganic phosphate.'
        });
        // Second card, and the card's source, are untouched by the edit.
        expect(updated.publishedCards[1].front).toBe(sampleCards()[1].front);
        expect(updated.publishedCards[0].source).toMatchObject(sampleCards()[0].source);
    });

    test('updateCardText updates draft and published copies together when both contain the card', async () => {
        const db = memoryDb({});
        const draft = await FlashcardDeck.saveGeneratedDraft(db, {
            courseId: 'C1', lectureName: 'Unit 1', cards: sampleCards(), generatedBy: 'i1'
        });
        const published = await FlashcardDeck.publishDraft(db, draft.deckId, 'i1');
        const cardId = published.publishedCards[0].cardId;
        // Simulate an in-progress, unpublished edit sitting in the draft.
        await FlashcardDeck.unpublishDeck(db, draft.deckId);

        const updated = await FlashcardDeck.updateCardText(db, draft.deckId, cardId, {
            front: 'Updated front',
            back: 'Updated back'
        });

        expect(updated.draftCards.find(c => c.cardId === cardId)).toMatchObject({ front: 'Updated front', back: 'Updated back' });
        expect(updated.publishedCards.find(c => c.cardId === cardId)).toMatchObject({ front: 'Updated front', back: 'Updated back' });
    });

    test('updateCardText rejects a blank front/back or a collision with a sibling card', async () => {
        const db = memoryDb({});
        const draft = await FlashcardDeck.saveGeneratedDraft(db, {
            courseId: 'C1', lectureName: 'Unit 1', cards: sampleCards(), generatedBy: 'i1'
        });
        const [cardA, cardB] = draft.draftCards;

        await expect(FlashcardDeck.updateCardText(db, draft.deckId, cardA.cardId, { front: '', back: 'x' }))
            .rejects.toThrow(/front and back/i);
        await expect(FlashcardDeck.updateCardText(db, draft.deckId, cardA.cardId, { front: cardB.front, back: 'x' }))
            .rejects.toThrow(/unique/i);
    });

    test('updateCardText returns null for an unknown deck and throws for an unknown cardId', async () => {
        const db = memoryDb({});
        const draft = await FlashcardDeck.saveGeneratedDraft(db, {
            courseId: 'C1', lectureName: 'Unit 1', cards: sampleCards(), generatedBy: 'i1'
        });

        expect(await FlashcardDeck.updateCardText(db, 'deck_missing', 'anything', { front: 'a', back: 'b' })).toBeNull();
        await expect(FlashcardDeck.updateCardText(db, draft.deckId, 'fc_missing', { front: 'a', back: 'b' }))
            .rejects.toThrow(/not found/i);
    });

    test('stores only per-student mastery and review counts', async () => {
        const db = memoryDb({});
        await FlashcardDeck.saveStudentReview(db, {
            studentId: 's1',
            courseId: 'C1',
            deckId: 'deck1',
            deckVersion: 2,
            cardId: 'card1',
            rating: 'again'
        });
        const progress = await FlashcardDeck.saveStudentReview(db, {
            studentId: 's1',
            courseId: 'C1',
            deckId: 'deck1',
            deckVersion: 2,
            cardId: 'card1',
            rating: 'know'
        });

        expect(progress.cards.card1).toMatchObject({ mastery: 'known', timesReviewed: 2 });
        expect(progress).not.toHaveProperty('publishedCards');
    });

    test('tracks againCount separately from timesReviewed, incrementing only on "again"', async () => {
        const db = memoryDb({});
        await FlashcardDeck.saveStudentReview(db, {
            studentId: 's1', courseId: 'C1', deckId: 'deck1', deckVersion: 1, cardId: 'card1', rating: 'again'
        });
        await FlashcardDeck.saveStudentReview(db, {
            studentId: 's1', courseId: 'C1', deckId: 'deck1', deckVersion: 1, cardId: 'card1', rating: 'again'
        });
        const progress = await FlashcardDeck.saveStudentReview(db, {
            studentId: 's1', courseId: 'C1', deckId: 'deck1', deckVersion: 1, cardId: 'card1', rating: 'know'
        });

        expect(progress.cards.card1).toMatchObject({ mastery: 'known', timesReviewed: 3, againCount: 2 });
    });

    test('skips saving a review for a "View as Student" preview session', async () => {
        const db = memoryDb({});
        const previewStudentId = buildPreviewUserId('instructor1', 'C1');

        const result = await FlashcardDeck.saveStudentReview(db, {
            studentId: previewStudentId, courseId: 'C1', deckId: 'deck1', deckVersion: 1, cardId: 'card1', rating: 'again'
        });

        expect(result).toEqual({ skipped: true, reason: 'preview' });
        const stored = await FlashcardDeck.getStudentProgress(db, previewStudentId, 'deck1');
        expect(stored).toBeNull();
    });

    test('ensures deck and progress indexes', async () => {
        await expect(FlashcardDeck.ensureIndexes(memoryDb({}))).resolves.toBeUndefined();
    });

    describe('getReviewAgainStats', () => {
        async function publishDeck(db, overrides = {}) {
            const draft = await FlashcardDeck.saveGeneratedDraft(db, {
                courseId: 'C1',
                lectureName: 'Unit 1',
                title: 'Energy',
                cards: sampleCards(),
                sourceDocumentIds: ['doc1'],
                generatedBy: 'i1',
                ...overrides
            });
            return FlashcardDeck.publishDraft(db, draft.deckId, 'i1');
        }

        test('counts each student once per card and sums againCount across students', async () => {
            const db = memoryDb({});
            const deck = await publishDeck(db);
            const [cardA, cardB] = deck.publishedCards;

            // s1 presses "again" on cardA twice (still one student), s2 once on cardA,
            // s3 reviews cardB with "know" only (should not appear in results).
            await FlashcardDeck.saveStudentReview(db, { studentId: 's1', courseId: 'C1', deckId: deck.deckId, deckVersion: 1, cardId: cardA.cardId, rating: 'again' });
            await FlashcardDeck.saveStudentReview(db, { studentId: 's1', courseId: 'C1', deckId: deck.deckId, deckVersion: 1, cardId: cardA.cardId, rating: 'again' });
            await FlashcardDeck.saveStudentReview(db, { studentId: 's2', courseId: 'C1', deckId: deck.deckId, deckVersion: 1, cardId: cardA.cardId, rating: 'again' });
            await FlashcardDeck.saveStudentReview(db, { studentId: 's3', courseId: 'C1', deckId: deck.deckId, deckVersion: 1, cardId: cardB.cardId, rating: 'know' });

            const stats = await FlashcardDeck.getReviewAgainStats(db, 'C1');

            expect(stats).toHaveLength(1);
            expect(stats[0]).toMatchObject({
                deckId: deck.deckId,
                cardId: cardA.cardId,
                front: cardA.front,
                studentCount: 2,
                totalAgainCount: 3
            });
        });

        test('sorts by distinct student count, then total again count, descending', async () => {
            const db = memoryDb({});
            const deck = await publishDeck(db);
            const [cardA, cardB] = deck.publishedCards;

            // cardB: 1 student, 5 presses. cardA: 2 students, 2 presses - should rank first.
            await FlashcardDeck.saveStudentReview(db, { studentId: 's1', courseId: 'C1', deckId: deck.deckId, deckVersion: 1, cardId: cardB.cardId, rating: 'again' });
            for (let i = 0; i < 4; i++) {
                await FlashcardDeck.saveStudentReview(db, { studentId: 's1', courseId: 'C1', deckId: deck.deckId, deckVersion: 1, cardId: cardB.cardId, rating: 'again' });
            }
            await FlashcardDeck.saveStudentReview(db, { studentId: 's2', courseId: 'C1', deckId: deck.deckId, deckVersion: 1, cardId: cardA.cardId, rating: 'again' });
            await FlashcardDeck.saveStudentReview(db, { studentId: 's3', courseId: 'C1', deckId: deck.deckId, deckVersion: 1, cardId: cardA.cardId, rating: 'again' });

            const stats = await FlashcardDeck.getReviewAgainStats(db, 'C1');

            expect(stats.map(s => s.cardId)).toEqual([cardA.cardId, cardB.cardId]);
        });

        test('excludes preview-session reviews and cards removed since review', async () => {
            const db = memoryDb({});
            const deck = await publishDeck(db);
            const [cardA] = deck.publishedCards;
            const previewStudentId = buildPreviewUserId('instructor1', 'C1');

            await FlashcardDeck.saveStudentReview(db, { studentId: previewStudentId, courseId: 'C1', deckId: deck.deckId, deckVersion: 1, cardId: cardA.cardId, rating: 'again' });
            expect(await FlashcardDeck.getReviewAgainStats(db, 'C1')).toEqual([]);

            // A real review on a card that then gets edited out of the deck entirely.
            await FlashcardDeck.saveStudentReview(db, { studentId: 's1', courseId: 'C1', deckId: deck.deckId, deckVersion: 1, cardId: cardA.cardId, rating: 'again' });
            await FlashcardDeck.updateDraft(db, deck.deckId, { cards: [sampleCards()[1]] });
            await FlashcardDeck.publishDraft(db, deck.deckId, 'i1');

            expect(await FlashcardDeck.getReviewAgainStats(db, 'C1')).toEqual([]);
        });

        test('scopes results to the requested course only', async () => {
            const db = memoryDb({});
            const deck = await publishDeck(db);
            const otherDeck = await publishDeck(db, { courseId: 'C2' });

            await FlashcardDeck.saveStudentReview(db, { studentId: 's1', courseId: 'C1', deckId: deck.deckId, deckVersion: 1, cardId: deck.publishedCards[0].cardId, rating: 'again' });
            await FlashcardDeck.saveStudentReview(db, { studentId: 's1', courseId: 'C2', deckId: otherDeck.deckId, deckVersion: 1, cardId: otherDeck.publishedCards[0].cardId, rating: 'again' });

            const stats = await FlashcardDeck.getReviewAgainStats(db, 'C1');
            expect(stats).toHaveLength(1);
            expect(stats[0].deckId).toBe(deck.deckId);
        });
    });

    test('addManualCard creates a deck on demand when none exists for the unit', async () => {
        const db = memoryDb({});
        const deck = await FlashcardDeck.addManualCard(db, 'C1', 'Unit 1', {
            front: 'What is a question converted to a flashcard?', back: 'This one.'
        }, 'i1');

        expect(deck.deckId).toMatch(/^deck_[0-9a-f-]{36}$/i);
        expect(deck.hasDraft).toBe(true);
        expect(deck.draftCards).toHaveLength(1);
        expect(deck.draftCards[0]).toMatchObject({
            front: 'What is a question converted to a flashcard?',
            back: 'This one.'
        });
    });

    test('addManualCard appends to an existing draft without disturbing other cards', async () => {
        const db = memoryDb({});
        const draft = await FlashcardDeck.saveGeneratedDraft(db, {
            courseId: 'C1', lectureName: 'Unit 1', cards: sampleCards(), generatedBy: 'i1'
        });

        const updated = await FlashcardDeck.addManualCard(db, 'C1', 'Unit 1', {
            front: 'A manually added card', back: 'Its answer'
        }, 'i1');

        expect(updated.deckId).toBe(draft.deckId);
        expect(updated.draftCards).toHaveLength(3);
        expect(updated.draftCards[0].cardId).toBe(draft.draftCards[0].cardId);
        expect(updated.draftCards[2]).toMatchObject({ front: 'A manually added card', back: 'Its answer' });
    });

    test('addManualCard rejects pushing a deck past MAX_CARD_COUNT', async () => {
        const db = memoryDb({});
        const cards = Array.from({ length: FlashcardDeck.MAX_CARD_COUNT }, (_, i) => ({
            front: `Card ${i}`, back: `Answer ${i}`
        }));
        await FlashcardDeck.saveGeneratedDraft(db, { courseId: 'C1', lectureName: 'Unit 1', cards, generatedBy: 'i1' });

        await expect(FlashcardDeck.addManualCard(db, 'C1', 'Unit 1', {
            front: 'One too many', back: 'Nope'
        }, 'i1')).rejects.toThrow(/between/i);
    });
});
