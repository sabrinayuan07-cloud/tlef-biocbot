/**
 * Instructor-owned shared flashcard draft/publish workflow.
 */

let flashcardDecksByUnit = new Map();

// Set for the duration of a drag (dragstart -> dragend) so dragover handlers
// on other rows know which row is being moved. Same pattern as
// mcq-options-editor.js's drag-to-reorder.
let flashcardDraggedRow = null;

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

function renderInstructorFlashcardSection(unitName) {
    const unitId = flashcardUnitId(unitName);
    const deck = flashcardDecksByUnit.get(unitName);
    const status = document.getElementById(`flashcard-status-${unitId}`);
    const editor = document.getElementById(`flashcard-editor-${unitId}`);
    if (!status || !editor) return;

    if (!deck) {
        status.textContent = 'Not generated';
        status.className = 'flashcard-status-badge';
        editor.style.display = 'none';
        editor.innerHTML = '';
        setFlashcardSectionMessage(unitName, 'Generate a draft after uploading material for this unit.');
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
            <h4>${isEditableDraft ? 'Draft cards' : 'Published cards'}</h4>
            <span>${cards.length} card${cards.length === 1 ? '' : 's'}</span>
        </div>
        <div class="flashcard-editor-list">
            ${cards.map((card, index) => renderFlashcardEditorRow(card, index, !isEditableDraft)).join('')}
        </div>
        <div class="flashcard-editor-actions">
            ${isEditableDraft ? `
                <button type="button" class="secondary-button" onclick="addManualFlashcard('${unitName}')">Add Card</button>
                <button type="button" class="secondary-button" onclick="saveFlashcardDraft('${unitName}')">Save Draft</button>
            ` : ''}
            ${(isEditableDraft || deck.isPublished) ? `
                <div class="publish-toggle">
                    <label class="toggle-switch">
                        <input type="checkbox" id="flashcard-publish-${unitId}" ${deck.isPublished ? 'checked' : ''} aria-label="Publish this flashcard deck to students" onchange="toggleFlashcardPublish('${unitName}', this)">
                        <span class="toggle-slider"></span>
                    </label>
                    <span class="toggle-label">Published</span>
                </div>
            ` : ''}
        </div>
    `;
    flashcardEditorRows(editor).forEach(wireFlashcardEditorRowDrag);
}

function renderFlashcardEditorRow(card, index, readOnly) {
    const sourceData = encodeURIComponent(JSON.stringify(card.source || null));
    return `
        <article class="flashcard-editor-row" data-card-id="${flashcardEscapeHtml(card.cardId || '')}" data-source="${sourceData}" ${readOnly ? '' : 'draggable="true"'}>
            <div class="flashcard-editor-row-heading">
                <span class="flashcard-editor-row-title">
                    ${readOnly ? '' : `
                    <span class="flashcard-drag-handle" aria-hidden="true">
                        <svg width="10" height="16" viewBox="0 0 10 16" fill="currentColor" aria-hidden="true">
                            <circle cx="2" cy="2" r="1.5"></circle><circle cx="8" cy="2" r="1.5"></circle>
                            <circle cx="2" cy="8" r="1.5"></circle><circle cx="8" cy="8" r="1.5"></circle>
                            <circle cx="2" cy="14" r="1.5"></circle><circle cx="8" cy="14" r="1.5"></circle>
                        </svg>
                    </span>`}
                    <strong>Card ${index + 1}</strong>
                </span>
                ${readOnly ? '' : `<button type="button" class="flashcard-convert-btn" onclick="convertFlashcardToQuestion(this)" title="Create an assessment question pre-filled from this card's term and definition">Convert to Question</button><button type="button" class="flashcard-remove-btn" onclick="removeFlashcardEditorRow(this)" title="Remove this card">${Icons.trash}</button>`}
            </div>
            <label>Term
                <textarea class="flashcard-front-input" rows="2" maxlength="300" ${readOnly ? 'readonly' : ''}>${flashcardEscapeHtml(card.front)}</textarea>
            </label>
            <label>Definition
                <textarea class="flashcard-back-input" rows="3" maxlength="1200" ${readOnly ? 'readonly' : ''}>${flashcardEscapeHtml(card.back)}</textarea>
            </label>
            <p class="flashcard-source">Source: ${flashcardEscapeHtml(flashcardSourceLabel(card.source))}</p>
        </article>
    `;
}

function flashcardEditorRows(editor) {
    return Array.from(editor.querySelectorAll('.flashcard-editor-row'));
}

/**
 * Renumber "Card N" headings in document order - the only thing a reorder
 * needs to fix up locally. Card order itself is picked up automatically on
 * the next save, since collectFlashcardDraftCards() reads rows in DOM order.
 */
function relabelFlashcardEditorRows(editor) {
    flashcardEditorRows(editor).forEach((row, index) => {
        const heading = row.querySelector('.flashcard-editor-row-heading strong');
        if (heading) heading.textContent = `Card ${index + 1}`;
    });
}

/**
 * Wire drag-to-reorder on one card row. Same interaction as
 * mcq-options-editor.js: draggable anywhere on the row except the text
 * areas/buttons, live-reorders as it passes another row's midpoint, and
 * re-numbers "Card N" headings as it goes.
 */
function wireFlashcardEditorRowDrag(row) {
    const editor = row.closest('.flashcard-editor-list');
    if (!editor) return;

    row.addEventListener('dragstart', (event) => {
        if (event.target.closest('.flashcard-front-input, .flashcard-back-input, .flashcard-remove-btn, .flashcard-convert-btn')) {
            event.preventDefault();
            return;
        }
        flashcardDraggedRow = row;
        event.dataTransfer.effectAllowed = 'move';
        // Firefox requires setData to actually start a drag.
        event.dataTransfer.setData('text/plain', '');
        row.classList.add('flashcard-editor-row-dragging');
    });

    row.addEventListener('dragend', () => {
        row.classList.remove('flashcard-editor-row-dragging');
        flashcardDraggedRow = null;
    });

    row.addEventListener('dragover', (event) => {
        if (!flashcardDraggedRow) return;
        event.preventDefault(); // required for drop to fire at all
        event.dataTransfer.dropEffect = 'move';
        if (flashcardDraggedRow === row) return;

        const rect = row.getBoundingClientRect();
        const dropAfter = event.clientY > rect.top + rect.height / 2;
        if (dropAfter && row.nextElementSibling !== flashcardDraggedRow) {
            row.insertAdjacentElement('afterend', flashcardDraggedRow);
            relabelFlashcardEditorRows(editor);
        } else if (!dropAfter && row.previousElementSibling !== flashcardDraggedRow) {
            row.insertAdjacentElement('beforebegin', flashcardDraggedRow);
            relabelFlashcardEditorRows(editor);
        }
    });

    row.addEventListener('drop', (event) => {
        if (!flashcardDraggedRow) return;
        event.preventDefault();
        // dragover above already moved the row into place live; drop just
        // finalizes where it already is.
        relabelFlashcardEditorRows(editor);
    });
}

async function generateFlashcardDraft(unitName, button) {
    const original = button.innerHTML;
    button.disabled = true;
    button.textContent = 'Generating…';
    setFlashcardSectionMessage(unitName, 'Generating a source-grounded draft. This may take a moment.');

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
        showNotification(result.message || 'Flashcard draft generated.', 'success');
    } catch (error) {
        console.error('Error generating flashcards:', error);
        setFlashcardSectionMessage(unitName, error.message, 'error');
        showNotification(error.message, 'error');
    } finally {
        button.disabled = false;
        button.innerHTML = original;
    }
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
    editor.insertAdjacentHTML('beforeend', renderFlashcardEditorRow({ front: '', back: '', source: null }, count, false));
    const row = editor.lastElementChild;
    if (row) wireFlashcardEditorRowDrag(row);
    row?.querySelector('.flashcard-front-input')?.focus();
}

function convertFlashcardToQuestion(button) {
    const section = button.closest('.flashcards-section');
    const unitName = section?.dataset.flashcardUnit;
    const row = button.closest('.flashcard-editor-row');
    const front = row?.querySelector('.flashcard-front-input')?.value.trim();
    const back = row?.querySelector('.flashcard-back-input')?.value.trim();
    if (!unitName || !front || !back) {
        showNotification('Add both a front and back to this card before converting it.', 'warning');
        return;
    }
    openQuestionModalFromFlashcard(unitName, front, back);
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

    row.remove();
    try {
        await saveFlashcardDraft(unitName, { quiet: true });
        showNotification('Flashcard removed.', 'success');
    } catch (error) {
        renderInstructorFlashcardSection(unitName);
        showNotification(error.message || 'Unable to remove flashcard.', 'error');
    }
}

/**
 * Single Published toggle standing in for the old separate Publish/Unpublish
 * buttons. Decides which action a click means from the deck's own state
 * rather than the checkbox's native checked value, so clicking while already
 * published but with newer unsaved draft edits ("Draft changes") still
 * republishes that draft instead of unpublishing - same as the old
 * "Publish to Students" button did in that state, just as one control.
 */
function toggleFlashcardPublish(unitName, checkbox) {
    const deck = flashcardDecksByUnit.get(unitName);
    if (!deck) return;
    if (deck.hasDraft || !deck.isPublished) {
        publishFlashcardDeck(unitName, checkbox);
    } else {
        unpublishFlashcardDeck(unitName, checkbox);
    }
}

async function publishFlashcardDeck(unitName, button) {
    button.disabled = true;
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
        button.disabled = false;
    }
}

async function unpublishFlashcardDeck(unitName, button) {
    const deck = flashcardDecksByUnit.get(unitName);
    if (!deck?.deckId) return;
    button.disabled = true;
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
        button.disabled = false;
    }
}
