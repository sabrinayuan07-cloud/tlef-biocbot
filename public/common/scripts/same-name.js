/**
 * Telling apart list items that share a name.
 *
 * Instructors may give two units the same title, upload the same file twice or
 * write the same objective twice. The page tells such items apart with an
 * automatic position suffix ("Cell Structure (1 of 2)") that is never stored
 * and never editable: it is worked out from the current list every time it is
 * shown. A name that is unique gets no suffix.
 *
 * Names are compared after trimming surrounding spaces and case-sensitively,
 * and items are numbered in their current list order. House rules:
 * ubc/ltic-accessibility-skills, handling-items-with-same-name.md.
 *
 * Loaded in the browser as `window.SameName`, and by Jest through `require`.
 */
(function sameNameModule(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.SameName = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function createSameName() {
    'use strict';

    /**
     * @typedef {{ id: string, title: string }} NamedItem
     */

    /**
     * @param {readonly NamedItem[]} items
     * @param {string} id
     * @returns {NamedItem|undefined}
     */
    function find(items, id) {
        return (items || []).find((item) => item.id === id);
    }

    /**
     * The item's position among the items that share its name.
     * @param {readonly NamedItem[]} items - The list, in page order
     * @param {string} id - The item's id
     * @returns {string} e.g. "1 of 2", or "" when the name is unique or the id is unknown
     */
    function getOrdinal(items, id) {
        const target = find(items, id);
        if (!target) return '';
        const name = String(target.title ?? '').trim();
        const namesakes = items.filter((item) => String(item.title ?? '').trim() === name);
        return namesakes.length < 2 ? '' : `${namesakes.indexOf(target) + 1} of ${namesakes.length}`;
    }

    /**
     * @param {readonly NamedItem[]} items
     * @param {string} id
     * @returns {string} The item's own title, or "" when the id is unknown
     */
    function titleOf(items, id) {
        return String(find(items, id)?.title ?? '');
    }

    /**
     * For visible text: headings, labels, toasts that name the item unquoted.
     * @param {readonly NamedItem[]} items
     * @param {string} id
     * @returns {string} e.g. "Cell Structure (1 of 2)", or "Cell Structure" when unique
     */
    function getDisplayName(items, id) {
        const ordinal = getOrdinal(items, id);
        return ordinal ? `${titleOf(items, id)} (${ordinal})` : titleOf(items, id);
    }

    /**
     * For text that quotes the user's own words (confirmations, toasts).
     * @param {readonly NamedItem[]} items
     * @param {string} id
     * @returns {string} e.g. '"Explain osmosis" (1 of 2)', or '"Explain osmosis"' when unique
     */
    function getQuotedName(items, id) {
        const ordinal = getOrdinal(items, id);
        return ordinal ? `"${titleOf(items, id)}" (${ordinal})` : `"${titleOf(items, id)}"`;
    }

    /**
     * For the hidden part of a button name, which already wraps its target in
     * parentheses: "Delete Unit (Cell Structure - 1 of 2)".
     * @param {readonly NamedItem[]} items
     * @param {string} id
     * @returns {string} e.g. "Cell Structure - 1 of 2", or "Cell Structure" when unique
     */
    function getButtonName(items, id) {
        const ordinal = getOrdinal(items, id);
        return ordinal ? `${titleOf(items, id)} - ${ordinal}` : titleOf(items, id);
    }

    /**
     * For a button name whose target is free text the user typed, quoted
     * inside the parentheses: 'Remove Objective ("Explain osmosis" - 1 of 2)'.
     * @param {readonly NamedItem[]} items
     * @param {string} id
     * @returns {string} e.g. '"Explain osmosis" - 1 of 2', or '"Explain osmosis"' when unique
     */
    function getQuotedButtonName(items, id) {
        const ordinal = getOrdinal(items, id);
        return ordinal ? `"${titleOf(items, id)}" - ${ordinal}` : `"${titleOf(items, id)}"`;
    }

    return { getOrdinal, getDisplayName, getQuotedName, getButtonName, getQuotedButtonName };
}));
