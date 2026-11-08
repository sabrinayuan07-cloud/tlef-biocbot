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

/**
 * Visually hidden text that finishes a repeated control's name: what it acts
 * on, then the unit ("Save Draft" + " (Student Flashcards) (1. Cell Structure)"),
 * so no two controls on the page share a name. See unitContext() in
 * instructor-units.js and the builders in instructor-names.js.
 * @param {string} unitName - Internal unit name (e.g. "Unit 1")
 * @param {string} [lead] - What in the unit the control acts on, e.g. " (Card 2)"
 * @returns {string} HTML for the hidden span
 */
function flashcardContext(unitName, lead = '') {
    const label = typeof getUnitReference === 'function' ? getUnitReference(unitName) : unitName;
    return typeof unitContext === 'function'
        ? unitContext(label, lead)
        : `<span class="visually-hidden">${flashcardEscapeHtml(lead)} (${flashcardEscapeHtml(label)})</span>`;
}

/** " (Student Flashcards)": the deck-wide controls' target. */
function flashcardDeckLead() {
    return typeof CourseUploadNames !== 'undefined' ? CourseUploadNames.getSectionLead('flashcards') : ' (Student Flashcards)';
}

/** " (Card 2)": one card's controls and fields. @param {number} cardNumber */
function flashcardCardLead(cardNumber) {
    return typeof CourseUploadNames !== 'undefined' ? CourseUploadNames.getCardLead(cardNumber) : ` (Card ${cardNumber})`;
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
            ${cards.map((card, index) => renderFlashcardEditorRow(card, index, !isEditableDraft, unitName, cards.length)).join('')}
        </ul>
        <div class="flashcard-editor-actions">
            ${isEditableDraft ? `
                <button type="button" class="secondary-button flashcard-add-btn" id="flashcard-add-${unitId}" onclick="addManualFlashcard('${unitName}')">Add Card${flashcardContext(unitName, flashcardDeckLead())}</button>
                <button type="button" class="secondary-button flashcard-save-btn" id="flashcard-save-${unitId}" onclick="saveFlashcardDraft('${unitName}')">Save Draft${flashcardContext(unitName, flashcardDeckLead())}</button>
            ` : ''}
            ${(isEditableDraft || deck.isPublished) ? `
                <div class="publish-toggle">
                    <label class="toggle-switch">
                        <input type="checkbox" id="flashcard-publish-${unitId}" ${deck.isPublished ? 'checked' : ''} onchange="toggleFlashcardPublish('${unitName}', this)">
                        <span class="toggle-slider"></span>
                        <!-- "Publish (Student Flashcards)", not just "Publish" - the
                             unit's own publish switch already claims that name, and
                             two controls on the page can't share a name. -->
                        ${flashcardContext(unitName, `Publish${flashcardDeckLead()}`)}
                    </label>
                    <!-- Same word as the label above, shown beside the switch. Hidden
                         from assistive technology so it is not read a second time. The
                         switch is named for what turning it on does ("Publish"); whether
                         the deck is published now is its checked state. -->
                    <span class="toggle-label" aria-hidden="true">Publish</span>
                </div>
            ` : ''}
        </div>
    `;
    restoreFlashcardFocus(editor, focusBefore);
    flashcardEditorRows(editor).forEach(wireFlashcardEditorRowDrag);
}

function renderFlashcardEditorRow(card, index, readOnly, unitName, totalCards) {
    const sourceData = encodeURIComponent(JSON.stringify(card.source || null));
    // Ids are positional ("card 2 of this unit"), which is exactly what the
    // heading says, so they stay right after a card is added or removed and
    // the list is re-rendered.
    const key = `${flashcardUnitId(unitName)}-${index + 1}`;
    const which = flashcardContext(unitName, flashcardCardLead(index + 1));
    const isFirst = index === 0;
    const isLast = index === (totalCards - 1);
    return `
        <li class="flashcard-editor-row" data-card-id="${flashcardEscapeHtml(card.cardId || '')}" data-source="${sourceData}" ${readOnly ? '' : 'draggable="true"'}>
            <div class="flashcard-editor-row-heading">
                <span class="flashcard-editor-row-title">
                    ${readOnly ? '' : `
                    <span class="flashcard-drag-handle" aria-hidden="true">
                        <svg width="10" height="16" viewBox="0 0 10 16" fill="currentColor" aria-hidden="true">
                            <circle cx="2" cy="2" r="1.5"></circle><circle cx="8" cy="2" r="1.5"></circle>
                            <circle cx="2" cy="8" r="1.5"></circle><circle cx="8" cy="8" r="1.5"></circle>
                            <circle cx="2" cy="14" r="1.5"></circle><circle cx="8" cy="14" r="1.5"></circle>
                        </svg>
                    </span>
                    <div class="flashcard-move-controls">
                        <button type="button" class="flashcard-move-btn" id="flashcard-move-up-${key}" onclick="moveFlashcardEditorRow(this, 'up')" title="Move up" ${isFirst ? 'disabled' : ''}><span aria-hidden="true">&uarr;</span>${flashcardContext(unitName, `Move Up${flashcardCardLead(index + 1)}`)}</button>
                        <button type="button" class="flashcard-move-btn" id="flashcard-move-down-${key}" onclick="moveFlashcardEditorRow(this, 'down')" title="Move down" ${isLast ? 'disabled' : ''}><span aria-hidden="true">&darr;</span>${flashcardContext(unitName, `Move Down${flashcardCardLead(index + 1)}`)}</button>
                    </div>`}
                    <h6 class="flashcard-card-title" id="flashcard-title-${key}" tabindex="-1">Card ${index + 1}</h6>
                </span>
                ${readOnly ? '' : `
                <span class="flashcard-editor-row-actions">
                    <button type="button" class="flashcard-convert-btn" id="flashcard-convert-${key}" onclick="convertFlashcardToQuestion(this)" title="Create an assessment question pre-filled from this card's term and definition">Convert to Question${which}</button>
                    <button type="button" class="flashcard-remove-btn" id="flashcard-remove-${key}" onclick="removeFlashcardEditorRow(this)" title="Remove this card">${Icons.trash}${flashcardContext(unitName, `Remove${flashcardCardLead(index + 1)}`)}</button>
                </span>`}
            </div>
            <label for="flashcard-front-${key}">Term${which}</label>
            <textarea class="flashcard-front-input" id="flashcard-front-${key}" rows="2" maxlength="300" ${readOnly ? 'readonly' : ''}>${flashcardEscapeHtml(card.front)}</textarea>
            <label for="flashcard-back-${key}">Definition${which}</label>
            <textarea class="flashcard-back-input" id="flashcard-back-${key}" rows="3" maxlength="1200" ${readOnly ? 'readonly' : ''}>${flashcardEscapeHtml(card.back)}</textarea>
            <p class="flashcard-source">Source: ${flashcardEscapeHtml(flashcardSourceLabel(card.source))}</p>
        </li>
    `;
}

function flashcardEditorRows(editor) {
    return Array.from(editor.querySelectorAll('.flashcard-editor-row'));
}

/**
 * Renumber "Card N" headings in document order and fix up the move
 * buttons' disabled state (first row can't move up, last can't move
 * down) - the only things a reorder, add, or remove needs to fix up
 * locally. Card order itself is picked up automatically on the next
 * save, since collectFlashcardDraftCards() reads rows in DOM order.
 */
function relabelFlashcardEditorRows(editor) {
    const rows = flashcardEditorRows(editor);
    rows.forEach((row, index) => {
        const heading = row.querySelector('.flashcard-card-title');
        if (heading) heading.textContent = `Card ${index + 1}`;
        const [up, down] = row.querySelectorAll('.flashcard-move-btn');
        if (up) up.disabled = index === 0;
        if (down) down.disabled = index === rows.length - 1;
    });
}

/**
 * Move a card row one slot up or down via its keyboard-accessible move
 * button - drag-and-drop's only reorder affordance otherwise.
 * @param {HTMLButtonElement} button - The pressed move button
 * @param {'up'|'down'} direction - Direction to move the row
 */
function moveFlashcardEditorRow(button, direction) {
    const row = button.closest('.flashcard-editor-row');
    const editor = row?.closest('.flashcard-editor-list');
    if (!row || !editor) return;

    const sibling = direction === 'up' ? row.previousElementSibling : row.nextElementSibling;
    if (!sibling) return;

    if (direction === 'up') {
        sibling.insertAdjacentElement('beforebegin', row);
    } else {
        sibling.insertAdjacentElement('afterend', row);
    }
    relabelFlashcardEditorRows(editor);
    // The button itself didn't move or get rebuilt, so it keeps focus
    // automatically - unless this move just disabled it (now first/last).
    if (!button.disabled) button.focus({ preventScroll: true });
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
    editor.insertAdjacentHTML('beforeend', renderFlashcardEditorRow({ front: '', back: '', source: null }, count, false, unitName, count + 1));
    const row = editor.lastElementChild;
    if (row) wireFlashcardEditorRowDrag(row);
    // The previously-last row's "move down" button was rendered disabled;
    // it no longer is, now that this new row follows it.
    relabelFlashcardEditorRows(editor);
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
