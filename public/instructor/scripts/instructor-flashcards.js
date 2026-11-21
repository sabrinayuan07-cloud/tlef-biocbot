/**
 * Instructor-owned shared flashcard draft/publish workflow.
 */

let flashcardDecksByUnit = new Map();

function flashcardUnitId(unitName) {
    return String(unitName || '').toLowerCase().replace(/\s+/g, '-');
}

function flashcardEscapeHtml(value) {
    const div = document.createElement('div');
    div.textContent = String(value || '');
    return div.innerHTML;
}

function flashcardSourceLabel(source) {
    if (!source) return 'Manual card';
    const location = source.slideNumber
        ? `slide ${source.slideNumber}`
        : (source.pageNumber ? `page ${source.pageNumber}` : (Number.isInteger(source.chunkIndex) ? `section ${source.chunkIndex + 1}` : ''));
    return `${source.fileName || 'Course material'}${location ? ` · ${location}` : ''}`;
}

function setFlashcardSectionMessage(unitName, message, tone = '') {
    const element = document.getElementById(`flashcard-message-${flashcardUnitId(unitName)}`);
    if (!element) return;
    element.textContent = message;
    element.className = `flashcard-section-message ${tone}`.trim();
}

async function loadFlashcardDecks() {
    try {
        if (typeof isTA === 'function' && isTA()) {
            document.querySelectorAll('.flashcards-section').forEach(section => {
                section.style.display = 'none';
            });
            return;
        }

        const courseId = await getCurrentCourseId();
        if (!courseId) return;
        const response = await fetch(`/api/flashcards/instructor?courseId=${encodeURIComponent(courseId)}`);
        const result = await response.json();
        if (!response.ok || !result.success) {
            throw new Error(result.message || 'Unable to load flashcard decks');
        }

        flashcardDecksByUnit = new Map((result.data.decks || []).map(deck => [deck.lectureName, deck]));
        document.querySelectorAll('.flashcards-section').forEach(section => {
            renderInstructorFlashcardSection(section.dataset.flashcardUnit);
        });
    } catch (error) {
        console.error('Error loading flashcard decks:', error);
        document.querySelectorAll('.flashcards-section').forEach(section => {
            setFlashcardSectionMessage(section.dataset.flashcardUnit, error.message, 'error');
        });
    }
}

/**
 * Visually hidden text that finishes a repeated control's name with the unit
 * it belongs to ("Save Draft" + " for 1. Cell Structure"), so no two controls
 * on the page share a name. See unitContext() in instructor-units.js.
 * @param {string} unitName - Internal unit name (e.g. "Unit 1")
 * @param {string} [lead] - Words between the control's text and the unit title
 * @returns {string} HTML for the hidden span
 */
function flashcardContext(unitName, lead) {
    const label = typeof getUnitLabel === 'function' ? getUnitLabel(unitName) : unitName;
    return typeof unitContext === 'function'
        ? unitContext(flashcardEscapeHtml(label), lead)
        : `<span class="visually-hidden"> for ${flashcardEscapeHtml(label)}</span>`;
}

/**
 * Describe the focused control inside a deck editor so focus can be put back
 * after the editor's markup is rebuilt.
 * @param {Element} editor - The deck editor container
 * @returns {{id: string, rowIndex: number, className: string}|null}
 */
function captureFlashcardFocus(editor) {
    const active = document.activeElement;
    if (!active || !editor.contains(active)) return null;
    const row = active.closest('.flashcard-editor-row');
    const rows = Array.from(editor.querySelectorAll('.flashcard-editor-row'));
    return { id: active.id, rowIndex: row ? rows.indexOf(row) : -1, className: active.classList[0] || '' };
}

/**
 * Put focus back after a deck editor re-render: on the same control if it
 * still exists, otherwise on the equivalent control of the card now in that
 * position (or the last card), otherwise on the first action button.
 * @param {Element} editor - The deck editor container
 * @param {{id: string, rowIndex: number, className: string}|null} focus - From captureFlashcardFocus
 */
function restoreFlashcardFocus(editor, focus) {
    if (!focus) return;
    const usable = element => element && !element.disabled && element.getClientRects().length > 0;
    let target = focus.id ? document.getElementById(focus.id) : null;
    if (!usable(target) && focus.rowIndex >= 0 && focus.className) {
        const rows = Array.from(editor.querySelectorAll('.flashcard-editor-row'));
        const row = rows[Math.min(focus.rowIndex, rows.length - 1)];
        target = row ? row.querySelector(`.${focus.className}`) : null;
    }
    if (!usable(target)) {
        target = Array.from(editor.querySelectorAll('.flashcard-editor-actions button')).find(usable)
            || document.getElementById(`flashcard-generate-${editor.id.replace('flashcard-editor-', '')}`);
    }
    if (usable(target)) target.focus({ preventScroll: true });
}

function renderInstructorFlashcardSection(unitName) {
    const unitId = flashcardUnitId(unitName);
    const deck = flashcardDecksByUnit.get(unitName);
    const status = document.getElementById(`flashcard-status-${unitId}`);
    const editor = document.getElementById(`flashcard-editor-${unitId}`);
    if (!status || !editor) return;
    // Everything in the editor is about to be replaced, including whichever
    // button the instructor just pressed.
    const focusBefore = captureFlashcardFocus(editor);

    if (!deck) {
        status.textContent = 'Not generated';
        status.className = 'flashcard-status-badge';
        editor.style.display = 'none';
        editor.innerHTML = '';
        setFlashcardSectionMessage(unitName, 'Generate a draft after uploading material for this unit.');
        restoreFlashcardFocus(editor, focusBefore);
        return;
    }

    const hasRecoverablePublishedCards = !deck.isPublished
        && !deck.hasDraft
        && Array.isArray(deck.publishedCards)
        && deck.publishedCards.length > 0;
    const isEditableDraft = deck.hasDraft || hasRecoverablePublishedCards;

    if (deck.isStale) {
        status.textContent = 'Materials changed';
        status.className = 'flashcard-status-badge stale';
        setFlashcardSectionMessage(unitName, 'The uploaded materials changed. Generate a fresh draft before republishing.', 'warning');
    } else if (deck.hasDraft) {
        status.textContent = deck.isPublished ? 'Draft changes' : 'Draft';
        status.className = 'flashcard-status-badge draft';
        setFlashcardSectionMessage(unitName, 'Review and edit the draft before publishing.');
    } else if (deck.isPublished) {
        status.textContent = `Published v${deck.publishedVersion}`;
        status.className = 'flashcard-status-badge published';
        setFlashcardSectionMessage(unitName, `${deck.publishedCards.length} cards are available to students.`, 'success');
    } else if (hasRecoverablePublishedCards) {
        status.textContent = 'Unpublished draft';
        status.className = 'flashcard-status-badge draft';
        setFlashcardSectionMessage(unitName, 'This deck is unpublished. Edit it or publish it again.');
    }

    const cards = deck.hasDraft ? deck.draftCards : deck.publishedCards;
    editor.style.display = '';
    editor.innerHTML = `
        <div class="flashcard-editor-heading">
            <h5 id="flashcard-list-heading-${unitId}" tabindex="-1">${isEditableDraft ? 'Draft cards' : 'Published cards'}</h5>
            <span>${cards.length} card${cards.length === 1 ? '' : 's'}</span>
        </div>
        <ul class="flashcard-editor-list">
            ${cards.map((card, index) => renderFlashcardEditorRow(card, index, !isEditableDraft, unitName)).join('')}
        </ul>
        <div class="flashcard-editor-actions">
            ${isEditableDraft ? `
                <button type="button" class="secondary-button flashcard-add-btn" id="flashcard-add-${unitId}" onclick="addManualFlashcard('${unitName}')">Add Card${flashcardContext(unitName, ' to ')}</button>
                <button type="button" class="secondary-button flashcard-save-btn" id="flashcard-save-${unitId}" onclick="saveFlashcardDraft('${unitName}')">Save Draft${flashcardContext(unitName)}</button>
                <button type="button" class="flashcard-publish-btn" id="flashcard-publish-${unitId}" onclick="publishFlashcardDeck('${unitName}', this)">Publish to Students<span class="visually-hidden">: the deck</span>${flashcardContext(unitName)}</button>
            ` : ''}
            ${deck.isPublished ? `<button type="button" class="flashcard-unpublish-btn" id="flashcard-unpublish-${unitId}" onclick="unpublishFlashcardDeck('${unitName}', this)">Unpublish<span class="visually-hidden"> the deck</span>${flashcardContext(unitName)}</button>` : ''}
        </div>
    `;
    initializeInstructorFlashcardPreviews(editor);
    restoreFlashcardFocus(editor, focusBefore);
}

function renderFlashcardEditorRow(card, index, readOnly, unitName) {
    const sourceData = encodeURIComponent(JSON.stringify(card.source || null));
    // Ids are positional ("card 2 of this unit"), which is exactly what the
    // heading says, so they stay right after a card is added or removed and
    // the list is re-rendered.
    const key = `${flashcardUnitId(unitName)}-${index + 1}`;
    const which = `<span class="visually-hidden"> of card ${index + 1}${flashcardContext(unitName, ', ')}</span>`;
    return `
        <li class="flashcard-editor-row" data-card-id="${flashcardEscapeHtml(card.cardId || '')}" data-source="${sourceData}">
            <div class="flashcard-editor-row-heading">
                <h6 class="flashcard-card-title" id="flashcard-title-${key}" tabindex="-1">Card ${index + 1}</h6>
                ${readOnly ? '' : `<button type="button" class="flashcard-remove-btn" id="flashcard-remove-${key}" onclick="removeFlashcardEditorRow(this)">Remove<span class="visually-hidden"> card ${index + 1}${flashcardContext(unitName, ', ')}</span></button>`}
            </div>
            <label for="flashcard-front-${key}">Front${which}</label>
            <textarea class="flashcard-front-input" id="flashcard-front-${key}" rows="2" maxlength="300" ${readOnly ? 'readonly' : ''}>${flashcardEscapeHtml(card.front)}</textarea>
            <div class="flashcard-preview-group">
                <span class="flashcard-preview-label">Student preview · Front</span>
                <div class="flashcard-rendered-preview" data-flashcard-preview="front"></div>
            </div>
            <label for="flashcard-back-${key}">Back${which}</label>
            <textarea class="flashcard-back-input" id="flashcard-back-${key}" rows="3" maxlength="1200" ${readOnly ? 'readonly' : ''}>${flashcardEscapeHtml(card.back)}</textarea>
            <div class="flashcard-preview-group">
                <span class="flashcard-preview-label">Student preview · Back</span>
                <div class="flashcard-rendered-preview" data-flashcard-preview="back"></div>
            </div>
            <p class="flashcard-source">Source: ${flashcardEscapeHtml(flashcardSourceLabel(card.source))}</p>
        </li>
    `;
}

/**
 * Disable a button for the length of a request without losing keyboard focus.
 * A focused button that becomes `disabled` drops focus to the page body, and
 * re-enabling it does not bring focus back, so this hands it back afterwards
 * (unless focus has since been moved somewhere deliberate).
 * @param {HTMLButtonElement} button - The button that was pressed
 * @param {() => Promise<void>} work - The request to run while it is disabled
 */
async function withBusyFlashcardButton(button, work) {
    const hadFocus = document.activeElement === button;
    button.disabled = true;
    try {
        await work();
    } finally {
        button.disabled = false;
        const focusDropped = !document.activeElement || document.activeElement === document.body;
        if (hadFocus && focusDropped && button.isConnected) button.focus({ preventScroll: true });
    }
}

/**
 * Render one editable card side exactly as it will appear to students.
 *
 * @param {Element} row Instructor card editor row
 * @param {'front'|'back'} side Card side to render
 * @returns {void}
 */
function renderInstructorFlashcardPreview(row, side) {
    const input = row.querySelector(`.flashcard-${side}-input`);
    const preview = row.querySelector(`[data-flashcard-preview="${side}"]`);
    if (!input || !preview) return;

    const value = input.value || '';
    if (typeof RichText === 'undefined') {
        preview.textContent = value;
        return;
    }
    RichText.render(preview, value);
}

/**
 * Initialize and keep live previews in sync with their raw textareas.
 *
 * @param {Element} root Editor container or newly inserted row
 * @returns {void}
 */
function initializeInstructorFlashcardPreviews(root) {
    const rows = root.matches?.('.flashcard-editor-row')
        ? [root]
        : Array.from(root.querySelectorAll('.flashcard-editor-row'));

    rows.forEach(row => {
        renderInstructorFlashcardPreview(row, 'front');
        renderInstructorFlashcardPreview(row, 'back');
        row.querySelectorAll('.flashcard-front-input, .flashcard-back-input').forEach(input => {
            input.addEventListener('input', () => {
                const side = input.classList.contains('flashcard-front-input') ? 'front' : 'back';
                renderInstructorFlashcardPreview(row, side);
            });
        });
    });
}

async function generateFlashcardDraft(unitName, button) {
    const original = button.innerHTML;
    const unitLabel = typeof getUnitLabel === 'function' ? getUnitLabel(unitName) : unitName;
    setFlashcardSectionMessage(unitName, 'Generating a source-grounded draft. This may take a moment.');

    await withBusyFlashcardButton(button, async () => {
        button.textContent = 'Generating…';
        try {
            const courseId = await getCurrentCourseId();
            const unitId = flashcardUnitId(unitName);
            const count = Number(document.getElementById(`flashcard-count-${unitId}`)?.value || 10);
            // Ticked by default in the markup; a missing checkbox means an older
            // rendering of the section, which should keep the notation rules.
            const chemistryCheckbox = document.getElementById(`flashcard-chemistry-${unitId}`);
            const chemistryNotation = chemistryCheckbox ? chemistryCheckbox.checked : true;
            const response = await fetch('/api/flashcards/instructor/generate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ courseId, lectureName: unitName, cardCount: count, chemistryNotation })
            });
            const result = await response.json();
            if (!response.ok || !result.success) throw new Error(result.message || 'Generation failed');

            flashcardDecksByUnit.set(unitName, result.data);
            renderInstructorFlashcardSection(unitName);
            // Say which unit the draft is for: every unit has its own Generate button.
            showNotification(`${unitLabel}: ${result.message || 'Flashcard draft generated.'}`, 'success');
        } catch (error) {
            console.error('Error generating flashcards:', error);
            setFlashcardSectionMessage(unitName, error.message, 'error');
            showNotification(error.message, 'error');
        } finally {
            button.innerHTML = original;
        }
    });
}

function collectFlashcardDraftCards(unitName) {
    const editor = document.getElementById(`flashcard-editor-${flashcardUnitId(unitName)}`);
    return Array.from(editor?.querySelectorAll('.flashcard-editor-row') || []).map(row => {
        let source = null;
        try {
            source = JSON.parse(decodeURIComponent(row.dataset.source || 'null'));
        } catch (error) {
            source = null;
        }
        return {
            cardId: row.dataset.cardId || undefined,
            front: row.querySelector('.flashcard-front-input')?.value.trim(),
            back: row.querySelector('.flashcard-back-input')?.value.trim(),
            source
        };
    });
}

async function saveFlashcardDraft(unitName, { quiet = false } = {}) {
    const deck = flashcardDecksByUnit.get(unitName);
    if (!deck?.deckId) throw new Error('Generate a draft first');
    const cards = collectFlashcardDraftCards(unitName);
    if (cards.length === 0) throw new Error('A deck needs at least one card');

    const response = await fetch(`/api/flashcards/instructor/${encodeURIComponent(deck.deckId)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cards })
    });
    const result = await response.json();
    if (!response.ok || !result.success) throw new Error(result.message || 'Unable to save draft');

    flashcardDecksByUnit.set(unitName, result.data);
    renderInstructorFlashcardSection(unitName);
    if (!quiet) showNotification('Flashcard draft saved.', 'success');
    return result.data;
}

function addManualFlashcard(unitName) {
    const editor = document.querySelector(`#flashcard-editor-${flashcardUnitId(unitName)} .flashcard-editor-list`);
    if (!editor) return;
    const count = editor.querySelectorAll('.flashcard-editor-row').length;
    if (count >= 20) {
        showNotification('A deck can contain at most 20 cards.', 'warning');
        return;
    }
    editor.insertAdjacentHTML('beforeend', renderFlashcardEditorRow({ front: '', back: '', source: null }, count, false, unitName));
    const row = editor.lastElementChild;
    if (row) initializeInstructorFlashcardPreviews(row);
    row?.querySelector('.flashcard-front-input')?.focus();
}

async function removeFlashcardEditorRow(button) {
    const section = button.closest('.flashcards-section');
    const unitName = section?.dataset.flashcardUnit;
    const row = button.closest('.flashcard-editor-row');
    const list = row?.parentElement;
    if (!unitName || !row || !list) return;

    if (list.querySelectorAll('.flashcard-editor-row').length <= 1) {
        showNotification('A deck needs at least one card.', 'warning');
        return;
    }

    // Removing the row takes the focused button with it. Park focus on the
    // neighbouring card's Remove button until the save re-renders the list
    // (which then restores focus to the card in the same position).
    const neighbour = row.nextElementSibling || row.previousElementSibling;
    row.remove();
    neighbour?.querySelector('.flashcard-remove-btn')?.focus({ preventScroll: true });
    try {
        await saveFlashcardDraft(unitName, { quiet: true });
        showNotification('Flashcard removed.', 'success');
    } catch (error) {
        renderInstructorFlashcardSection(unitName);
        showNotification(error.message || 'Unable to remove flashcard.', 'error');
    }
}

async function publishFlashcardDeck(unitName, button) {
    // Not disabled while it runs: disabling the focused button drops keyboard
    // focus, and the re-render that follows needs to know where focus was.
    if (button.getAttribute('aria-busy') === 'true') return;
    button.setAttribute('aria-busy', 'true');
    try {
        const deck = await saveFlashcardDraft(unitName, { quiet: true });
        const response = await fetch(`/api/flashcards/instructor/${encodeURIComponent(deck.deckId)}/publish`, { method: 'POST' });
        const result = await response.json();
        if (!response.ok || !result.success) throw new Error(result.message || 'Unable to publish deck');

        flashcardDecksByUnit.set(unitName, result.data);
        renderInstructorFlashcardSection(unitName);
        showNotification('Flashcard deck published to students.', 'success');
    } catch (error) {
        showNotification(error.message, 'error');
    } finally {
        button.removeAttribute('aria-busy');
    }
}

async function unpublishFlashcardDeck(unitName, button) {
    const deck = flashcardDecksByUnit.get(unitName);
    if (!deck?.deckId) return;
    if (button.getAttribute('aria-busy') === 'true') return;
    button.setAttribute('aria-busy', 'true');
    try {
        const response = await fetch(`/api/flashcards/instructor/${encodeURIComponent(deck.deckId)}/unpublish`, { method: 'POST' });
        const result = await response.json();
        if (!response.ok || !result.success) throw new Error(result.message || 'Unable to unpublish deck');
        flashcardDecksByUnit.set(unitName, result.data);
        renderInstructorFlashcardSection(unitName);
        showNotification('Flashcard deck unpublished.', 'success');
    } catch (error) {
        showNotification(error.message, 'error');
    } finally {
        button.removeAttribute('aria-busy');
    }
}
