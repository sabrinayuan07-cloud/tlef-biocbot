/**
 * Small shared DOM/format helpers used across instructor pages.
 * Load before topic-review.js and the page script.
 */

function escapeHTML(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
}

function formatFileSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * Turn heading text into an id: lower case, words joined by hyphens.
 * @param {string} text - The heading's text
 * @returns {string}
 */
function slugify(text) {
    const slug = String(text || '')
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    return slug || 'section';
}

// Ids handed out during the current task but not in the document yet (several
// headings are often built into one HTML string before any of it is inserted).
const pendingHeadingIds = new Set();

/**
 * Attributes every heading gets: a unique id made from its text (a number is
 * added when the text repeats, e.g. "learning-objectives-2"), and
 * tabindex="-1" so focus can be moved to it from script.
 * @param {string} text - The heading's text
 * @param {string} [fixedId] - Use this id instead of a slug, for headings that
 *   are re-rendered in place and need the same id each time
 * @returns {string} `id="…" tabindex="-1"`, ready to drop into a start tag
 */
function headingAttrs(text, fixedId) {
    let id = fixedId;
    if (!id) {
        const base = slugify(text);
        id = base;
        for (let n = 2; document.getElementById(id) || pendingHeadingIds.has(id); n += 1) {
            id = `${base}-${n}`;
        }
        pendingHeadingIds.add(id);
        if (pendingHeadingIds.size === 1) {
            setTimeout(() => pendingHeadingIds.clear(), 0);
        }
    }
    return `id="${id}" tabindex="-1"`;
}
