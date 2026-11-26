/**
 * Keeps the values a request sends plain, before any route reads them.
 *
 * Routes hand IDs and other request values to MongoDB, which reads them by
 * shape: a field name starting with "$" is an operator, and a list matches any
 * one of its items. No BiocBot page sends either, so this refuses, once and for
 * every route (including routes written later):
 * - any field name starting with "$", at any depth;
 * - an ID field (a name ending in "Id", `lectureName` or `unitName`) at the
 *   top level that holds an object or a list instead of one value.
 *
 * server.js runs this after the JSON and form parsers, before sign-in, so it
 * sees every request: the walk stays linear in the size of the body, and a
 * body with more than MAX_OBJECTS objects and lists is refused rather than
 * walked. No page sends anything near that many.
 *
 * A route that parses a multipart body itself (multer) runs it again after the
 * parser.
 */

const MAX_OBJECTS = 200000;

/**
 * Walk a parsed body or query string.
 * @param {unknown} value
 * @returns {{ operatorKey: string|null, tooLarge: boolean }} The first field
 *   name starting with "$", or whether the value holds more than MAX_OBJECTS
 *   objects and lists (the walk stops there).
 */
function scanRequestValue(value) {
    const result = { operatorKey: null, tooLarge: false };
    if (value === null || typeof value !== 'object') return result;

    // Parsers build trees, so there is nothing to revisit. The count also
    // ends the walk on anything else.
    const pending = [value];
    let objects = 0;
    while (pending.length > 0) {
        const node = pending.pop();
        objects += 1;
        if (objects > MAX_OBJECTS) {
            result.tooLarge = true;
            return result;
        }
        if (Array.isArray(node)) {
            for (let i = 0; i < node.length; i += 1) {
                const item = node[i];
                if (item !== null && typeof item === 'object') pending.push(item);
            }
            continue;
        }
        // A body parser never puts binary data here, but skip it if one does.
        if (ArrayBuffer.isView(node)) continue;
        const keys = Object.keys(node);
        for (let i = 0; i < keys.length; i += 1) {
            const key = keys[i];
            if (key.startsWith('$')) {
                result.operatorKey = key;
                return result;
            }
            const item = node[key];
            if (item !== null && typeof item === 'object') pending.push(item);
        }
    }
    return result;
}

function isIdField(key) {
    return key.endsWith('Id') || key === 'lectureName' || key === 'unitName';
}

/**
 * The first top-level ID field in `source` whose value is an object or a list,
 * or null.
 * @param {unknown} source - A parsed request body or query
 * @returns {string|null}
 */
function findListOrObjectId(source) {
    if (source === null || typeof source !== 'object' || Array.isArray(source)) return null;
    for (const key of Object.keys(source)) {
        const value = source[key];
        if (isIdField(key) && value !== null && typeof value === 'object') return key;
    }
    return null;
}

function refuse(req, res, status, code, message) {
    // The path only: the request's values stay out of the log.
    console.warn(`⚠️ [REQUEST] Refused (${code}): ${req.method} ${req.originalUrl.split('?')[0]}`);
    return res.status(status).json({ success: false, code, message });
}

/**
 * Express middleware: refuses the request unless the body and the query
 * string hold plain values (see the top of this file).
 */
function requirePlainRequestValues(req, res, next) {
    for (const source of [req.body, req.query]) {
        const scan = scanRequestValue(source);
        if (scan.tooLarge) {
            return refuse(req, res, 413, 'REQUEST_TOO_LARGE', 'The request has too many parts.');
        }
        if (scan.operatorKey !== null) {
            return refuse(req, res, 400, 'INVALID_FIELD_NAME', 'The request has a field name that is not allowed.');
        }
    }
    const idField = findListOrObjectId(req.body) || findListOrObjectId(req.query);
    if (idField !== null) {
        return refuse(req, res, 400, 'INVALID_FIELD_VALUE', `${idField} must be a single value, not a list or an object.`);
    }
    return next();
}

module.exports = { MAX_OBJECTS, scanRequestValue, findListOrObjectId, requirePlainRequestValues };
