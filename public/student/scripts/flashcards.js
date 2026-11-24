document.addEventListener('DOMContentLoaded', async () => {
    await waitForFlashcardAuth();

    let courseId = getCurrentCourseId();
    if (courseId && typeof courseId.then === 'function') {
        courseId = await courseId;
    }
    const loading = document.getElementById('flashcard-loading');
    const errorState = document.getElementById('flashcard-error');
    const emptyState = document.getElementById('flashcard-empty');
    const library = document.getElementById('deck-library');
    const deckList = document.getElementById('deck-list');
    const studyArea = document.getElementById('study-area');
    const studyCard = document.getElementById('study-card');
    const reviewActions = document.getElementById('review-actions');
    const complete = document.getElementById('study-complete');

    let decks = [];
    let activeDeck = null;
    let cards = [];
    let currentIndex = 0;
    let flipped = false;

    if (!courseId) {
        showError('No course is selected. Choose a course from the Chat page first.');
        return;
    }

    document.getElementById('back-to-decks').addEventListener('click', showLibrary);
    document.getElementById('shuffle-cards').addEventListener('click', () => {
        shuffle(cards);
        currentIndex = 0;
        showCurrentCard();
    });
    studyCard.addEventListener('click', flipCard);
    document.getElementById('review-again').addEventListener('click', () => reviewCard('again'));
    document.getElementById('review-know').addEventListener('click', () => reviewCard('know'));
    document.getElementById('restart-deck').addEventListener('click', () => {
        currentIndex = 0;
        shuffle(cards);
        complete.style.display = 'none';
        studyCard.style.display = '';
        showCurrentCard();
    });

    document.addEventListener('keydown', (event) => {
        if (studyArea.style.display === 'none' || complete.style.display !== 'none') return;
        if (event.target.closest('input, textarea, select')) return;
        if (event.target.closest('button, a') && event.target !== studyCard) return;
        if (event.key === ' ' || event.key === 'Enter') {
            event.preventDefault();
            flipCard();
        } else if (flipped && event.key === 'ArrowLeft') {
            event.preventDefault();
            reviewCard('again');
        } else if (flipped && event.key === 'ArrowRight') {
            event.preventDefault();
            reviewCard('know');
        }
    });

    try {
        const response = await fetch(`/api/flashcards/student?courseId=${encodeURIComponent(courseId)}`);
        const result = await response.json();
        if (!response.ok || !result.success) throw new Error(result.message || 'Unable to load flashcard decks');
        decks = result.data || [];
        loading.style.display = 'none';

        if (decks.length === 0) {
            emptyState.style.display = '';
            return;
        }
        renderDecks();
        library.style.display = '';
    } catch (error) {
        showError(error.message);
    }

    function showError(message) {
        loading.style.display = 'none';
        errorState.textContent = message;
        errorState.style.display = '';
    }

    function renderDecks() {
        deckList.innerHTML = '';
        decks.forEach(deck => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'deck-card';
            button.innerHTML = `
                <span class="deck-unit">${escapeFlashcardHtml(deck.lectureName)}</span>
                <strong>${escapeFlashcardHtml(deck.title)}</strong>
                <span>${deck.cardCount} cards</span>
                <span class="deck-mastery">${deck.knownCount} known</span>
                <span class="deck-progress-track"><span style="width: ${deck.cardCount ? Math.round((deck.knownCount / deck.cardCount) * 100) : 0}%"></span></span>
            `;
            button.addEventListener('click', () => openDeck(deck.deckId));
            deckList.appendChild(button);
        });
    }

    async function openDeck(deckId) {
        loading.textContent = 'Opening deck…';
        loading.style.display = '';
        library.style.display = 'none';
        try {
            const response = await fetch(`/api/flashcards/student/${encodeURIComponent(deckId)}?courseId=${encodeURIComponent(courseId)}`);
            const result = await response.json();
            if (!response.ok || !result.success) throw new Error(result.message || 'Unable to open deck');

            activeDeck = result.data;
            cards = [...(activeDeck.cards || [])];
            currentIndex = 0;
            document.getElementById('study-title').textContent = activeDeck.title;
            document.getElementById('study-unit').textContent = activeDeck.lectureName;
            loading.style.display = 'none';
            studyArea.style.display = '';
            complete.style.display = 'none';
            studyCard.style.display = '';
            showCurrentCard();
        } catch (error) {
            showError(error.message);
            library.style.display = '';
        }
    }

    function showLibrary() {
        studyArea.style.display = 'none';
        complete.style.display = 'none';
        library.style.display = '';
        activeDeck = null;
    }

    function showCurrentCard() {
        if (!activeDeck || currentIndex >= cards.length) {
            finishDeck();
            return;
        }

        flipped = false;
        const card = cards[currentIndex];
        document.getElementById('card-side-label').textContent = 'Front';
        renderCardText(document.getElementById('card-content'), card.front);
        document.getElementById('card-source').style.display = 'none';
        document.getElementById('flip-hint').textContent = 'Press to reveal the answer';
        studyCard.setAttribute('aria-pressed', 'false');
        studyCard.classList.remove('is-flipped');
        reviewActions.style.display = 'none';

        const progressText = `Card ${currentIndex + 1} of ${cards.length}`;
        document.getElementById('study-progress-text').textContent = progressText;
        const progress = Math.round((currentIndex / cards.length) * 100);
        document.getElementById('flashcard-progress-fill').style.width = `${progress}%`;
        const bar = document.querySelector('.flashcard-progress');
        bar.setAttribute('aria-valuenow', String(currentIndex));
        bar.setAttribute('aria-valuemax', String(cards.length));
        studyCard.focus();
    }

    function flipCard() {
        if (flipped || !cards[currentIndex]) return;
        flipped = true;
        const card = cards[currentIndex];
        document.getElementById('card-side-label').textContent = 'Back';
        renderCardText(document.getElementById('card-content'), card.back);
        const source = document.getElementById('card-source');
        source.textContent = `Source: ${sourceLabel(card.source)}`;
        source.style.display = '';
        document.getElementById('flip-hint').textContent = 'Choose how well you knew this card';
        studyCard.setAttribute('aria-pressed', 'true');
        studyCard.classList.add('is-flipped');
        reviewActions.style.display = '';
    }

    async function reviewCard(rating) {
        if (!flipped || !cards[currentIndex]) return;
        const card = cards[currentIndex];
        reviewActions.querySelectorAll('button').forEach(button => { button.disabled = true; });
        try {
            const response = await fetch(`/api/flashcards/student/${encodeURIComponent(activeDeck.deckId)}/review`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ courseId, cardId: card.cardId, rating })
            });
            const result = await response.json();
            if (!response.ok || !result.success) throw new Error(result.message || 'Unable to save progress');
            currentIndex += 1;
            showCurrentCard();
        } catch (error) {
            showError(error.message);
        } finally {
            reviewActions.querySelectorAll('button').forEach(button => { button.disabled = false; });
        }
    }

    function finishDeck() {
        studyCard.style.display = 'none';
        reviewActions.style.display = 'none';
        complete.style.display = '';
        document.getElementById('study-progress-text').textContent = `${cards.length} of ${cards.length} cards`;
        document.getElementById('flashcard-progress-fill').style.width = '100%';
    }

    function sourceLabel(source) {
        if (!source) return 'Instructor-created card';
        if (source.slideNumber) return `${source.fileName || 'Course material'}, slide ${source.slideNumber}`;
        if (source.pageNumber) return `${source.fileName || 'Course material'}, page ${source.pageNumber}`;
        return `${source.fileName || 'Course material'}${Number.isInteger(source.chunkIndex) ? `, section ${source.chunkIndex + 1}` : ''}`;
    }

    function shuffle(items) {
        for (let index = items.length - 1; index > 0; index -= 1) {
            const other = Math.floor(Math.random() * (index + 1));
            [items[index], items[other]] = [items[other], items[index]];
        }
    }

    /**
     * Show one side of a card, typesetting any formulas and drawing any
     * molecules the generator put in it.
     *
     * Falls back to plain text if rich-text.js did not load, so a missing
     * script costs the typesetting rather than the card.
     *
     * @param {Element} element The card body element
     * @param {string} text Front or back text as written by the generator
     * @returns {void}
     */
    function renderCardText(element, text) {
        if (!element) return;
        if (typeof RichText === 'undefined') {
            element.textContent = String(text || '');
            return;
        }
        RichText.render(element, text);
    }

    function escapeFlashcardHtml(value) {
        const div = document.createElement('div');
        div.textContent = String(value || '');
        return div.innerHTML;
    }
});

function waitForFlashcardAuth() {
    return new Promise((resolve) => {
        if (typeof currentUser !== 'undefined' && currentUser) {
            resolve();
            return;
        }
        BiocbotEvents.subscribe('auth.ready', () => resolve(), { once: true });
        setTimeout(resolve, 3000);
    });
}
