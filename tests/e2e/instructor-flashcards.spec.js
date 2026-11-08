// @ts-check
const { test, expect } = require('./fixtures/monocart');

const SCRIPT_PATH = 'public/instructor/scripts/instructor-flashcards.js';
const ICONS_SCRIPT_PATH = 'public/common/scripts/icons.js';

/** @param {string} id @param {string} front */
function card(id, front) {
    return {
        cardId: id,
        front,
        back: `${front} answer`,
        source: { documentId: 'doc1', fileName: 'Lecture.pdf', chunkIndex: 0 }
    };
}

/** @param {import('@playwright/test').Page} page @param {any} initialDeck */
async function loadHarness(page, initialDeck) {
    await page.setContent(`
        <section class="flashcards-section" data-flashcard-unit="Unit 1">
            <span id="flashcard-status-unit-1">Not generated</span>
            <p id="flashcard-message-unit-1"></p>
            <div id="flashcard-editor-unit-1"></div>
        </section>
    `);
    await page.evaluate((/** @type {any} */ deck) => {
        const testWindow = /** @type {any} */ (window);
        testWindow.testFlashcardState = { deck, putBodies: [], notifications: [] };
        testWindow.getCurrentCourseId = async () => 'C1';
        testWindow.showNotification = (/** @type {string} */ message, /** @type {string} */ type) => {
            testWindow.testFlashcardState.notifications.push({ message, type });
        };
        testWindow.fetch = async (/** @type {any} */ url, /** @type {any} */ options = {}) => {
            const method = options.method || 'GET';
            const state = testWindow.testFlashcardState;
            if (method === 'GET') {
                return {
                    ok: true,
                    json: async () => ({
                        success: true,
                        data: { units: [], decks: [state.deck] }
                    })
                };
            }
            if (method === 'PUT') {
                const body = JSON.parse(String(options.body || '{}'));
                state.putBodies.push(body);
                state.deck = { ...state.deck, hasDraft: true, draftCards: body.cards };
                return { ok: true, json: async () => ({ success: true, data: state.deck }) };
            }
            if (String(url).endsWith('/unpublish')) {
                state.deck = {
                    ...state.deck,
                    isPublished: false,
                    hasDraft: true,
                    draftCards: [...state.deck.publishedCards]
                };
                return { ok: true, json: async () => ({ success: true, data: state.deck }) };
            }
            if (String(url).endsWith('/publish')) {
                state.deck = {
                    ...state.deck,
                    isPublished: true,
                    hasDraft: false,
                    publishedVersion: state.deck.publishedVersion + 1,
                    publishedCards: [...state.deck.draftCards],
                    draftCards: []
                };
                return { ok: true, json: async () => ({ success: true, data: state.deck }) };
            }
            throw new Error(`Unexpected request: ${method} ${url}`);
        };
    }, initialDeck);
    // Real icons.js, not a stub - renderFlashcardEditorRow() uses Icons.trash
    // for the remove button, same as production load order.
    await page.addScriptTag({ path: ICONS_SCRIPT_PATH });
    await page.addScriptTag({ path: SCRIPT_PATH });
    await page.evaluate(() => /** @type {any} */ (window).loadFlashcardDecks());
}

test.describe('instructor flashcard editor', () => {
    test('removing a draft card persists immediately and survives a reload', async ({ page }) => {
        await loadHarness(page, {
            deckId: 'deck1',
            courseId: 'C1',
            lectureName: 'Unit 1',
            title: 'Unit 1 Flashcards',
            hasDraft: true,
            isPublished: false,
            isStale: false,
            publishedVersion: 0,
            draftCards: [card('fc1', 'First card'), card('fc2', 'Second card')],
            publishedCards: []
        });

        await page.getByRole('button', { name: 'Remove this card' }).first().click();
        await expect.poll(() => page.evaluate(() => /** @type {any} */ (window).testFlashcardState.putBodies.length)).toBe(1);
        await expect(page.locator('.flashcard-editor-row')).toHaveCount(1);
        await expect(page.locator('.flashcard-front-input')).toHaveValue('Second card');

        await page.evaluate(() => /** @type {any} */ (window).loadFlashcardDecks());
        await expect(page.locator('.flashcard-editor-row')).toHaveCount(1);
        await expect(page.locator('.flashcard-front-input')).toHaveValue('Second card');
    });

    test('unpublishing creates an editable draft that can be republished', async ({ page }) => {
        await loadHarness(page, {
            deckId: 'deck1',
            courseId: 'C1',
            lectureName: 'Unit 1',
            title: 'Unit 1 Flashcards',
            hasDraft: false,
            isPublished: true,
            isStale: false,
            publishedVersion: 1,
            draftCards: [],
            publishedCards: [card('fc1', 'Published card')]
        });

        await page.getByRole('button', { name: 'Unpublish' }).click();
        await expect(page.getByRole('button', { name: 'Publish to Students' })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Remove this card' })).toBeVisible();

        await page.getByRole('button', { name: 'Publish to Students' }).click();
        await expect(page.getByRole('button', { name: 'Unpublish' })).toBeVisible();
        await expect(page.locator('#flashcard-status-unit-1')).toHaveText('Published v2');
    });

    test('dragging a card reorders it, renumbers headings, and persists the new order on save', async ({ page }) => {
        await loadHarness(page, {
            deckId: 'deck1',
            courseId: 'C1',
            lectureName: 'Unit 1',
            title: 'Unit 1 Flashcards',
            hasDraft: true,
            isPublished: false,
            isStale: false,
            publishedVersion: 0,
            draftCards: [card('fc1', 'Card one'), card('fc2', 'Card two'), card('fc3', 'Card three')],
            publishedCards: []
        });

        const frontValues = () => page.evaluate(() =>
            Array.from(document.querySelectorAll('.flashcard-front-input')).map(el => (/** @type {HTMLTextAreaElement} */ (el)).value));

        expect(await frontValues()).toEqual(['Card one', 'Card two', 'Card three']);

        // Native HTML5 drag-and-drop doesn't reliably fire from raw mouse
        // down/move/up in Chromium headless - dispatch the DragEvents the
        // handlers actually listen for instead. Drags card 1 past card 3's
        // midpoint, which should drop it after card 3.
        await page.evaluate(() => {
            const rows = document.querySelectorAll('.flashcard-editor-row');
            const dragged = rows[0];
            const target = rows[2];
            const dt = new DataTransfer();
            const fire = (/** @type {Element} */ el, /** @type {string} */ type, /** @type {number} */ clientY) =>
                el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, clientY }));

            const targetRect = target.getBoundingClientRect();
            fire(dragged, 'dragstart', dragged.getBoundingClientRect().top + 5);
            fire(target, 'dragover', targetRect.bottom - 5); // past the midpoint -> drop after
            fire(target, 'drop', targetRect.bottom - 5);
            fire(dragged, 'dragend', targetRect.bottom - 5);
        });

        expect(await frontValues()).toEqual(['Card two', 'Card three', 'Card one']);
        await expect(page.locator('.flashcard-editor-row-heading strong')).toHaveText(['Card 1', 'Card 2', 'Card 3']);

        await page.getByRole('button', { name: 'Save Draft' }).click();
        await expect.poll(() => page.evaluate(() => /** @type {any} */ (window).testFlashcardState.putBodies.length)).toBe(1);
        const savedOrder = await page.evaluate(() =>
            /** @type {any} */ (window).testFlashcardState.putBodies[0].cards.map((/** @type {any} */ c) => c.front));
        expect(savedOrder).toEqual(['Card two', 'Card three', 'Card one']);
    });

    test('recovers a deck left unpublished without a draft by the previous behavior', async ({ page }) => {
        await loadHarness(page, {
            deckId: 'deck1',
            courseId: 'C1',
            lectureName: 'Unit 1',
            title: 'Unit 1 Flashcards',
            hasDraft: false,
            isPublished: false,
            isStale: false,
            publishedVersion: 1,
            draftCards: [],
            publishedCards: [card('fc1', 'Recoverable card')]
        });

        await expect(page.locator('#flashcard-status-unit-1')).toHaveText('Unpublished draft');
        await expect(page.getByRole('button', { name: 'Remove this card' })).toBeVisible();
        await page.getByRole('button', { name: 'Publish to Students' }).click();
        await expect(page.locator('#flashcard-status-unit-1')).toHaveText('Published v2');
    });
});
