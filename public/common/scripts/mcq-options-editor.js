/**
 * Shared dynamic multiple-choice option editor, used by the "Create
 * Assessment Question" modal on both the main Course Upload page
 * (instructor-questions.js) and the onboarding flow's identical modal
 * (onboarding-objectives-questions.js), plus the AI-generation fill-in on
 * both pages (instructor-ai-generation.js / onboarding-ai-generation.js).
 *
 * Starts at a single option (A). Pressing Enter in an option's text input,
 * or clicking the "+ Add option" button below the list, inserts a new
 * empty option - Enter inserts right after the current one (not at the
 * end), shifting every later option down a letter; the + button always
 * appends at the end. Both are capped at MCQ_MAX_OPTIONS; at the cap,
 * Enter just moves focus to the next option instead (same as Tab), and the
 * + button disables. A remove button deletes an option and re-letters what
 * follows; dragging a row by any part of its bar (not just the grip icon)
 * reorders it, pushing the other rows out of the way live as it moves, and
 * re-letters everything on drop.
 *
 * Re-lettering only ever changes a row's *label* (data-option, placeholder,
 * radio value) - the row's typed text and whichever radio is checked are
 * carried on the row's own DOM node itself (reorder = physically reposition
 * that node, not copy values between nodes), so "the answer I marked
 * correct" stays correct through any insert, delete, or drag. Deleting the
 * row that was marked correct simply clears the correct-answer selection,
 * same as if the instructor had never picked one.
 *
 * Load order: after ui-utils.js, before the page script that calls
 * resetMcqOptions()/ensureMcqOptionCount().
 */

const MCQ_MIN_OPTIONS = 1;
const MCQ_MAX_OPTIONS = 6;

// Set for the duration of a drag (dragstart -> dragend) so drop handlers on
// other rows know which row is being moved. Native HTML5 drag-and-drop data
// transfer is string-only and awkward for "move this exact DOM node" - a
// module-level reference is simpler and there's only ever one drag active
// at a time in this UI.
let mcqDraggedRow = null;

function mcqOptionLetter(index) {
    return String.fromCharCode(65 + index); // 0 -> 'A', 1 -> 'B', ...
}

function buildMcqOptionRow() {
    const row = document.createElement('div');
    row.className = 'mcq-option';
    row.draggable = true;
    row.innerHTML = `
        <span class="mcq-option-drag-handle" aria-hidden="true">
            <svg width="10" height="16" viewBox="0 0 10 16" fill="currentColor" aria-hidden="true">
                <circle cx="2" cy="2" r="1.5"></circle><circle cx="8" cy="2" r="1.5"></circle>
                <circle cx="2" cy="8" r="1.5"></circle><circle cx="8" cy="8" r="1.5"></circle>
                <circle cx="2" cy="14" r="1.5"></circle><circle cx="8" cy="14" r="1.5"></circle>
            </svg>
        </span>
        <input type="text" class="mcq-input" aria-label="">
        <label class="radio-option">
            <input type="radio" name="mcq-correct" disabled>
            <span class="correct-label">Correct</span>
        </label>
        <button type="button" class="mcq-option-remove" aria-label="">&times;</button>
    `;
    return row;
}

/**
 * The persistent "type Return to add another option" hint + "+ Add option"
 * button, always the last child of the options container so newly inserted
 * rows (which land before it) never end up below it. Created once per
 * container and reused - resetMcqOptions() clears the whole container so it
 * gets rebuilt (and rewired) fresh each time that runs.
 */
function mcqOptionsFooter(container) {
    let footer = container.querySelector('.mcq-options-footer');
    if (footer) return footer;

    footer = document.createElement('div');
    footer.className = 'mcq-options-footer';
    footer.innerHTML = `
        <p class="mcq-options-hint">Type Return to add another option</p>
        <button type="button" class="mcq-option-add">+ Add option</button>
    `;
    container.appendChild(footer);

    footer.querySelector('.mcq-option-add').addEventListener('click', () => {
        if (mcqOptionRows(container).length >= MCQ_MAX_OPTIONS) return;
        const newRow = buildMcqOptionRow();
        appendMcqOptionRow(container, newRow);
        wireMcqOptionRow(container, newRow);
        relabelMcqOptions(container);
        focusMcqInput(newRow);
    });

    return footer;
}

/** Insert a new row at the end of the list - i.e. right before the footer. */
function appendMcqOptionRow(container, row) {
    mcqOptionsFooter(container).insertAdjacentElement('beforebegin', row);
}

/**
 * Re-letter every option row in document order - this is the only place
 * that assigns data-option/placeholder/aria-label/radio value, so inserting,
 * removing, or reordering a row just means rebuilding this once afterward.
 * Doesn't touch typed text or which radio is checked, so content and the
 * correct-answer choice both keep following their row under its new letter.
 * Also syncs the remove button's visibility and the footer's
 * add-button/hint to the current count.
 */
function relabelMcqOptions(container) {
    const rows = mcqOptionRows(container);
    rows.forEach((row, index) => {
        const letter = mcqOptionLetter(index);
        const input = row.querySelector('.mcq-input');
        const radio = row.querySelector('input[name="mcq-correct"]');
        const removeBtn = row.querySelector('.mcq-option-remove');
        input.dataset.option = letter;
        input.placeholder = `Option ${letter}`;
        input.setAttribute('aria-label', `Option ${letter} text`);
        radio.value = letter;
        removeBtn.setAttribute('aria-label', `Remove option ${letter}`);
        row.setAttribute('aria-label', `Option ${letter}, drag to reorder`);
    });

    // Hiding (not removing) the remove button below the minimum keeps the
    // row's layout/gap consistent instead of the input jumping wider.
    const canRemove = rows.length > MCQ_MIN_OPTIONS;
    rows.forEach(row => {
        row.querySelector('.mcq-option-remove').style.visibility = canRemove ? '' : 'hidden';
    });

    const footer = mcqOptionsFooter(container);
    const atMax = rows.length >= MCQ_MAX_OPTIONS;
    footer.querySelector('.mcq-option-add').disabled = atMax;
    footer.querySelector('.mcq-options-hint').textContent = atMax
        ? `Maximum of ${MCQ_MAX_OPTIONS} options`
        : 'Type Return to add another option';
}

function focusMcqInput(row) {
    row.querySelector('.mcq-input')?.focus();
}

function mcqOptionRows(container) {
    return Array.from(container.querySelectorAll('.mcq-option'));
}

function wireMcqOptionRow(container, row) {
    const input = row.querySelector('.mcq-input');
    const radio = row.querySelector('input[name="mcq-correct"]');
    const removeBtn = row.querySelector('.mcq-option-remove');

    // A row can only be marked "correct" once it has text - matches the
    // existing validation an instructor already relies on.
    input.addEventListener('input', () => {
        const hasText = input.value.trim().length > 0;
        radio.disabled = !hasText;
        if (!hasText) radio.checked = false;
    });

    input.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();

        const rows = mcqOptionRows(container);
        if (rows.length >= MCQ_MAX_OPTIONS) {
            // At the cap, Enter can't insert - just move on, like Tab would.
            const next = rows[rows.indexOf(row) + 1];
            if (next) focusMcqInput(next);
            return;
        }

        const newRow = buildMcqOptionRow();
        row.insertAdjacentElement('afterend', newRow);
        wireMcqOptionRow(container, newRow);
        relabelMcqOptions(container);
        focusMcqInput(newRow);
    });

    removeBtn.addEventListener('click', () => {
        const rows = mcqOptionRows(container);
        if (rows.length <= MCQ_MIN_OPTIONS) return;
        row.remove();
        relabelMcqOptions(container);
    });

    // Drag-to-reorder: the whole row is draggable so the instructor can grab
    // it anywhere along the bar, not just the grip icon. Starting a drag from
    // the text input, the "Correct" radio/label, or the remove button is
    // suppressed so those keep their normal click/typing behavior instead of
    // hijacking the gesture into a drag.
    row.addEventListener('dragstart', (event) => {
        if (event.target.closest('.mcq-input, .radio-option, .mcq-option-remove')) {
            event.preventDefault();
            return;
        }
        mcqDraggedRow = row;
        event.dataTransfer.effectAllowed = 'move';
        // Firefox requires setData to actually start a drag.
        event.dataTransfer.setData('text/plain', '');
        row.classList.add('mcq-option-dragging');
    });

    row.addEventListener('dragend', () => {
        row.classList.remove('mcq-option-dragging');
        mcqDraggedRow = null;
    });

    // Live reorder: as the dragged row passes the halfway point of another
    // row, physically move it there right away (not just on drop) so the
    // other options visibly shift up/down to preview where it'll land.
    //
    // preventDefault() has to run on every dragover while a drag is active -
    // including when the cursor ends up back over the dragged row itself,
    // which happens as soon as it's live-moved under the cursor. Skipping it
    // in that case (as an earlier version did) left the last dragover before
    // release unhandled, so the browser treated the drop as rejected and
    // played its native snap-back-to-start animation before the row settled
    // into place - a confusing flash right at release.
    row.addEventListener('dragover', (event) => {
        if (!mcqDraggedRow) return;
        event.preventDefault(); // required for drop to fire at all
        event.dataTransfer.dropEffect = 'move';
        if (mcqDraggedRow === row) return; // already here, nothing to reposition

        const rect = row.getBoundingClientRect();
        const dropAfter = event.clientY > rect.top + rect.height / 2;
        if (dropAfter && row.nextElementSibling !== mcqDraggedRow) {
            row.insertAdjacentElement('afterend', mcqDraggedRow);
            relabelMcqOptions(container);
        } else if (!dropAfter && row.previousElementSibling !== mcqDraggedRow) {
            row.insertAdjacentElement('beforebegin', mcqDraggedRow);
            relabelMcqOptions(container);
        }
    });

    row.addEventListener('drop', (event) => {
        if (!mcqDraggedRow) return;
        event.preventDefault();
        // The dragover handler above already moved the row into place as the
        // instructor dragged, so dropping just finalizes where it already is.
        relabelMcqOptions(container);
        focusMcqInput(mcqDraggedRow);
    });
}

/**
 * Collapse back to a single empty option (A). Call whenever the question
 * type is (re)set to multiple-choice, or the question form/modal is reset.
 */
function resetMcqOptions(container) {
    if (!container) return;
    container.innerHTML = '';
    const row = buildMcqOptionRow();
    container.appendChild(row);
    wireMcqOptionRow(container, row);
    relabelMcqOptions(container);
}

/**
 * Grow (never shrink) to at least `count` options, appending empty rows at
 * the end as needed, capped at MCQ_MAX_OPTIONS. Used before AI-generated
 * content is written into specific lettered inputs (e.g.
 * `.mcq-input[data-option="C"]`), so those inputs exist to be found -
 * AI-generated content can include more than the single option the form
 * starts with.
 */
function ensureMcqOptionCount(container, count) {
    if (!container) return;
    const target = Math.min(Math.max(count, MCQ_MIN_OPTIONS), MCQ_MAX_OPTIONS);
    while (mcqOptionRows(container).length < target) {
        const row = buildMcqOptionRow();
        appendMcqOptionRow(container, row);
        wireMcqOptionRow(container, row);
    }
    relabelMcqOptions(container);
}
