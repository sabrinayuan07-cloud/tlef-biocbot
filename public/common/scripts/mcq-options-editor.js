/**
 * Shared dynamic multiple-choice option editor, used by the "Create
 * Assessment Question" modal on both the main Course Upload page
 * (instructor-questions.js) and the onboarding flow's identical modal
 * (onboarding-objectives-questions.js), plus the AI-generation fill-in on
 * both pages (instructor-ai-generation.js / onboarding-ai-generation.js).
 *
 * Starts at a single option (A). Pressing Enter in an option's text input
 * inserts a new empty option right after it - not at the end - shifting
 * every later option down a letter, up to MCQ_MAX_OPTIONS; at the cap,
 * Enter just moves focus to the next option instead (same as Tab). A
 * remove button deletes an option and re-letters what follows. Both the
 * insert-and-shift and the remove-and-reletter paths only change each row's
 * *label* (data-option, placeholder, radio value) - the row's typed text
 * and whichever radio is checked travel with the row, so "the answer I
 * marked correct" stays correct even after it's relettered. Deleting the
 * row that was marked correct simply clears the correct-answer selection,
 * same as if the instructor had never picked one.
 *
 * Load order: after ui-utils.js, before the page script that calls
 * resetMcqOptions()/ensureMcqOptionCount().
 */

const MCQ_MIN_OPTIONS = 1;
const MCQ_MAX_OPTIONS = 6;

function mcqOptionLetter(index) {
    return String.fromCharCode(65 + index); // 0 -> 'A', 1 -> 'B', ...
}

function buildMcqOptionRow() {
    const row = document.createElement('div');
    row.className = 'mcq-option';
    row.innerHTML = `
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
 * Re-letter every option row in document order - this is the only place
 * that assigns data-option/placeholder/aria-label/radio value, so inserting
 * or removing a row just means rebuilding this once afterward. Doesn't
 * touch typed text or which radio is checked, so content and the
 * correct-answer choice both keep following their row under its new letter.
 */
function relabelMcqOptions(container) {
    const rows = Array.from(container.querySelectorAll('.mcq-option'));
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
    });
    // Hiding (not removing) the remove button below the minimum keeps the
    // row's layout/gap consistent instead of the input jumping wider.
    const canRemove = rows.length > MCQ_MIN_OPTIONS;
    rows.forEach(row => {
        row.querySelector('.mcq-option-remove').style.visibility = canRemove ? '' : 'hidden';
    });
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
        container.appendChild(row);
        wireMcqOptionRow(container, row);
    }
    relabelMcqOptions(container);
}
