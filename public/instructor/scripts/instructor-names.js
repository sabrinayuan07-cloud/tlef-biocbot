/**
 * Course Upload page: how repeated controls are named.
 *
 * Every unit repeats the same controls (Rename, Move Up, Delete, Add Question,
 * View, Remove…), so each control's accessible name is its visible label
 * followed by visually hidden context naming its target, from most to least
 * specific, each part in parentheses:
 *
 *   "Delete lecture.pdf (Cell Structure)"
 *   "Remove (Card 2) (1. Cell Structure)"
 *   "Save Draft (Student Flashcards) (Cell Structure - 1 of 2)"
 *
 * The name always starts with the visible label (WCAG 2.5.3 Label in Name).
 * The context is real text inside the control (`.visually-hidden`), never
 * aria-label. When two units, files or objectives share a name, the reference
 * carries a position ("Cell Structure - 1 of 2", see same-name.js).
 *
 * A control's name is `label + lead + unit`, where `lead` says which item
 * inside the unit it acts on and `unit` is the unit's reference. The builders
 * below make the label and lead for each kind of control; the page renders the
 * unit part inside a `.unit-name-ref` span so a rename can update every control
 * of every unit in one pass (refreshUnitNames in instructor-units.js).
 *
 * House rules: ubc/ltic-accessibility-skills,
 * descriptive-button-and-call-to-action-link-names.md and
 * handling-items-with-same-name.md.
 *
 * Loaded in the browser as `window.CourseUploadNames`, and by Jest through `require`.
 */
(function courseUploadNamesModule(root, factory) {
    const sameName = (root && root.SameName)
        || (typeof require === 'function' ? require('../../common/scripts/same-name.js') : null);
    const api = factory(sameName);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.CourseUploadNames = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function createCourseUploadNames(SameName) {
    'use strict';

    /** Section titles, as their headings show them. */
    const SECTIONS = Object.freeze({
        objectives: 'Learning Objectives',
        materials: 'Course Materials',
        flashcards: 'Student Flashcards',
        questions: 'Assessment Questions',
    });

    /**
     * Parenthesised context, most specific part first. Empty parts are left
     * out, so a missing parent leaves no empty "()".
     * @param {...(string|null|undefined)} parts
     * @returns {string} e.g. " (Card 2) (1. Cell Structure)", or "" with no parts
     */
    function formatContext(...parts) {
        return parts
            .map((part) => String(part ?? '').trim())
            .filter(Boolean)
            .map((part) => ` (${part})`)
            .join('');
    }

    /**
     * A control's full accessible name.
     * @param {string} label - The visible label (or, for an icon-only control, its hidden equivalent)
     * @param {string} lead - Which item in the unit it acts on (from a lead builder below), or ""
     * @param {string} unitReference - The unit's reference (getUnitReference), or "" when unknown
     * @returns {string} e.g. "Remove (Card 2) (1. Cell Structure)"
     */
    function getControlName(label, lead, unitReference) {
        return `${label}${lead || ''}${formatContext(unitReference)}`;
    }

    // ----------------------------------------------------------------- units

    /**
     * How a control's hidden context refers to a unit: the title its heading
     * shows, with its position when another unit shows the same title.
     * @param {ReadonlyArray<{id: string, title: string}>} units - Every unit, in page order; title is the visible title ("1. Cell Structure")
     * @param {string} unitName - Internal unit name (e.g. "Unit 2")
     * @returns {string} e.g. "1. Cell Structure", "Cell Structure - 1 of 2", or "" when the unit is unknown
     */
    function getUnitReference(units, unitName) {
        return SameName.getButtonName(units, unitName);
    }

    /**
     * The visible suffix after a unit's heading when its title repeats.
     * @param {ReadonlyArray<{id: string, title: string}>} units
     * @param {string} unitName
     * @returns {string} e.g. " (1 of 2)", or "" when the title is unique
     */
    function getUnitHeadingSuffix(units, unitName) {
        const ordinal = SameName.getOrdinal(units, unitName);
        return ordinal ? ` (${ordinal})` : '';
    }

    /**
     * The unit's title quoted, for the controls of its rename editor, whose
     * subject is the title itself.
     * @param {ReadonlyArray<{id: string, title: string}>} units
     * @param {string} unitName
     * @returns {string} e.g. '"Cell Structure" - 1 of 2', or '"1. Cell Structure"'
     */
    function getUnitQuotedReference(units, unitName) {
        return SameName.getQuotedButtonName(units, unitName);
    }

    /**
     * Save and Cancel in a unit's rename editor.
     * @param {'Save'|'Cancel'} label
     * @param {string} quotedReference - From getUnitQuotedReference
     * @returns {string} e.g. 'Save (Rename Unit - "Cell Structure" - 1 of 2)'
     */
    function getRenameEditorButtonName(label, quotedReference) {
        return quotedReference ? `${label} (Rename Unit - ${quotedReference})` : label;
    }

    /**
     * The unit publish switch is named for what switching it on does. Its
     * checked state says whether the unit is published now.
     * @returns {string} "Publish"
     */
    function getPublishSwitchLabel() {
        return 'Publish';
    }

    // ------------------------------------------------------------- materials

    /**
     * Which file a View, Download or Delete control acts on: its title, with
     * its position when the same title is listed more than once in the unit.
     * @param {ReadonlyArray<{id: string, title: string}>} files - The unit's uploaded files, in list order
     * @param {string} fileId
     * @returns {string} e.g. " lecture.pdf (1 of 2)", or "" when the file is unknown
     */
    function getMaterialLead(files, fileId) {
        const name = SameName.getDisplayName(files, fileId);
        return name ? ` ${name}` : '';
    }

    /**
     * The visible suffix after a file's title when the title repeats in its unit.
     * @param {ReadonlyArray<{id: string, title: string}>} files
     * @param {string} fileId
     * @returns {string} e.g. " (2 of 2)", or ""
     */
    function getMaterialTitleSuffix(files, fileId) {
        const ordinal = SameName.getOrdinal(files, fileId);
        return ordinal ? ` (${ordinal})` : '';
    }

    /**
     * What a required-material placeholder's Upload control uploads.
     * @param {'lecture-notes'|'practice-quiz'} contentType
     * @returns {string} " lecture notes" or " practice questions or tutorial"
     */
    function getPlaceholderUploadLead(contentType) {
        return contentType === 'lecture-notes' ? ' lecture notes' : ' practice questions or tutorial';
    }

    // ------------------------------------------------------------ objectives

    /**
     * Which objective a Remove Objective control removes: the instructor's own
     * words, quoted, with a position when the same words appear twice in the unit.
     * @param {ReadonlyArray<{id: string, title: string}>} objectives - The unit's objectives, in list order
     * @param {string} objectiveId
     * @returns {string} e.g. ' ("Explain osmosis" - 1 of 2)'
     */
    function getObjectiveLead(objectives, objectiveId) {
        return formatContext(SameName.getQuotedButtonName(objectives, objectiveId));
    }

    // ------------------------------------------------- flashcards, questions

    /**
     * A control inside one section of the unit, when its label alone does not
     * say what it acts on ("Save Draft" of what?).
     * @param {keyof typeof SECTIONS} section
     * @returns {string} e.g. " (Student Flashcards)"
     */
    function getSectionLead(section) {
        return formatContext(SECTIONS[section]);
    }

    /**
     * A control or field of one flashcard.
     * @param {number} cardNumber - 1-based, as the card's heading shows it
     * @returns {string} e.g. " (Card 2)"
     */
    function getCardLead(cardNumber) {
        return formatContext(`Card ${cardNumber}`);
    }

    /**
     * A control of one assessment question.
     * @param {number} questionNumber - 1-based, as the question shows it
     * @returns {string} e.g. " (Question 1)"
     */
    function getQuestionLead(questionNumber) {
        return formatContext(`Question ${questionNumber}`);
    }

    return {
        SECTIONS,
        formatContext,
        getControlName,
        getUnitReference,
        getUnitHeadingSuffix,
        getUnitQuotedReference,
        getRenameEditorButtonName,
        getPublishSwitchLabel,
        getMaterialLead,
        getMaterialTitleSuffix,
        getPlaceholderUploadLead,
        getObjectiveLead,
        getSectionLead,
        getCardLead,
        getQuestionLead,
    };
}));
