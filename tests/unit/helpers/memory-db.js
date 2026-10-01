/**
 * In-memory MongoDB collection/db doubles for unit tests.
 *
 * This is a self-contained Mongo-style fake for unit tests. It intentionally
 * avoids booting an Express server or requiring any E2E infrastructure.
 *
 * Supported query operators: $or, $and, $ne, $in, $nin, $exists, $size,
 * $gt/$gte/$lt/$lte, dotted field paths, and Mongo's "scalar matches an array by
 * membership" rule. Supported update operators: $set, $setOnInsert (on upsert),
 * $inc, $unset, $addToSet (with $each), $pull (scalar or sub-document match), $push (with $each).
 * Also supports findOneAndUpdate(), replaceOne() (with { upsert }), countDocuments(), and distinct(field).
 * Just enough for the model/service helpers under test — not a full Mongo.
 */

// Realm-local deep clone. We deliberately avoid structuredClone here: under
// jest-environment-node it produces Date objects from the host realm, so
// `instanceof Date` fails against the sandbox's Date. Rebuilding Dates with the
// local constructor keeps assertions like toBeInstanceOf(Date) honest.
function clone(value) {
    if (value === null || typeof value !== 'object') return value;
    if (value instanceof Date) return new Date(value.getTime());
    if (Array.isArray(value)) return value.map(clone);
    const out = {};
    for (const [key, val] of Object.entries(value)) out[key] = clone(val);
    return out;
}

function getPath(obj, rawPath, positionalIndexes) {
    if (obj == null) return undefined;
    const path = resolvePositional(rawPath, positionalIndexes);
    if (path.indexOf('.') === -1) return obj[path];
    return path.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

// Mongo dotted queries traverse arrays of embedded documents implicitly. Keep
// update-path handling in getPath() strict, but flatten array branches for query
// matching (e.g. `lectures.assessmentQuestions.questionId`).
function getQueryPath(obj, path) {
    const walk = (value, keys) => {
        if (keys.length === 0 || value == null) return value;
        if (Array.isArray(value)) {
            return value.flatMap((item) => {
                const found = walk(item, keys);
                return Array.isArray(found) ? found : [found];
            });
        }
        const [key, ...rest] = keys;
        return walk(value[key], rest);
    };
    return walk(obj, path.split('.'));
}

// Resolve Mongo's positional "$" operator (e.g. 'lectures.$.displayName') to
// the concrete array index that matched the update's query, so setPath/unsetPath
// can treat it as an ordinary numeric path segment ('lectures.0.displayName').
// positionalIndexes maps arrayField -> matched index, from findPositionalIndexes().
function resolvePositional(path, positionalIndexes = {}) {
    if (path.indexOf('$') === -1) return path;
    const keys = path.split('.');
    for (let i = 0; i < keys.length; i++) {
        if (keys[i] !== '$') continue;
        const arrayField = keys[i - 1];
        const idx = positionalIndexes[arrayField];
        keys[i] = idx !== undefined ? String(idx) : '0';
    }
    return keys.join('.');
}

function setPath(obj, rawPath, value, positionalIndexes) {
    const path = resolvePositional(rawPath, positionalIndexes);
    if (path.indexOf('.') === -1) {
        obj[path] = value;
        return;
    }
    const keys = path.split('.');
    const last = keys.pop();
    let cursor = obj;
    for (const key of keys) {
        if (cursor[key] == null || typeof cursor[key] !== 'object') cursor[key] = {};
        cursor = cursor[key];
    }
    cursor[last] = value;
}

function unsetPath(obj, rawPath, positionalIndexes) {
    const path = resolvePositional(rawPath, positionalIndexes);
    if (path.indexOf('.') === -1) { delete obj[path]; return; }
    const keys = path.split('.');
    const last = keys.pop();
    let cursor = obj;
    for (const key of keys) {
        if (cursor[key] == null || typeof cursor[key] !== 'object') return; // nothing to unset
        cursor = cursor[key];
    }
    delete cursor[last];
}

// For each dotted query field that traverses an array (e.g. 'lectures.name'),
// find the index of the first array element that matches the query's condition
// for that field. That's what Mongo's positional "$" operator refers to in the
// corresponding update.
function findPositionalIndexes(doc, query = {}) {
    const indexes = {};
    for (const [key, cond] of Object.entries(query)) {
        if (key.startsWith('$') || key.indexOf('.') === -1) continue;
        const [arrayField, ...restParts] = key.split('.');
        const arr = doc[arrayField];
        if (!Array.isArray(arr)) continue;
        const rest = restParts.join('.');
        const idx = arr.findIndex((item) => matchesField(rest ? getPath(item, rest) : item, cond));
        if (idx !== -1) indexes[arrayField] = idx;
    }
    return indexes;
}

function matchesOperators(docValue, cond) {
    return Object.entries(cond).every(([op, val]) => {
        switch (op) {
            case '$ne':
                return Array.isArray(docValue) ? !docValue.includes(val) : docValue !== val;
            case '$in':
                return Array.isArray(docValue)
                    ? docValue.some((v) => val.includes(v))
                    : val.includes(docValue);
            case '$nin':
                return !val.includes(docValue);
            case '$exists':
                return (docValue !== undefined) === val;
            case '$size':
                return Array.isArray(docValue) && docValue.length === val;
            case '$gt': return docValue > val;
            case '$gte': return docValue >= val;
            case '$lt': return docValue < val;
            case '$lte': return docValue <= val;
            case '$regex': {
                const pattern = val instanceof RegExp
                    ? val
                    : new RegExp(val, cond.$options || '');
                return typeof docValue === 'string' && pattern.test(docValue);
            }
            case '$not': {
                // Mongo's $not takes a regex or an operator document, and a
                // missing field counts as "not matching" — so an absent field
                // satisfies $not, unlike most operators here.
                if (val instanceof RegExp) {
                    return !(typeof docValue === 'string' && val.test(docValue));
                }
                return !matchesOperators(docValue, val);
            }
            case '$options':
                return true;
            default:
                return false;
        }
    });
}

function matchesField(docValue, cond) {
    if (cond && typeof cond === 'object' && !Array.isArray(cond)) {
        return matchesOperators(docValue, cond);
    }
    // Mongo: a scalar query against an array field matches by membership.
    if (Array.isArray(docValue)) return docValue.includes(cond);
    return docValue === cond;
}

function matchesQuery(doc, query = {}) {
    return Object.entries(query).every(([key, cond]) => {
        if (key === '$or') return Array.isArray(cond) && cond.some((sub) => matchesQuery(doc, sub));
        if (key === '$and') return Array.isArray(cond) && cond.every((sub) => matchesQuery(doc, sub));
        return matchesField(getQueryPath(doc, key), cond);
    });
}

function pullMatches(item, cond) {
    if (cond && typeof cond === 'object' && !Array.isArray(cond)) {
        return Object.entries(cond).every(([k, v]) => item && item[k] === v);
    }
    return item === cond;
}

function applyUpdate(doc, update, { isInsert = false, positionalIndexes } = {}) {
    let modified = false;
    const sets = { ...(update.$set || {}), ...(isInsert ? update.$setOnInsert || {} : {}) };
    for (const [key, value] of Object.entries(sets)) {
        setPath(doc, key, value, positionalIndexes);
        modified = true;
    }
    for (const [key, value] of Object.entries(update.$inc || {})) {
        const current = getPath(doc, key, positionalIndexes);
        setPath(doc, key, (typeof current === 'number' ? current : 0) + value, positionalIndexes);
        modified = true;
    }
    for (const key of Object.keys(update.$unset || {})) {
        unsetPath(doc, key, positionalIndexes);
        modified = true;
    }
    for (const [key, value] of Object.entries(update.$addToSet || {})) {
        let arr = getPath(doc, key, positionalIndexes);
        if (!Array.isArray(arr)) { arr = []; setPath(doc, key, arr, positionalIndexes); }
        const values = value && value.$each ? value.$each : [value];
        for (const v of values) {
            if (!arr.includes(v)) { arr.push(v); modified = true; }
        }
    }
    for (const [key, cond] of Object.entries(update.$pull || {})) {
        const arr = getPath(doc, key, positionalIndexes);
        if (Array.isArray(arr)) {
            const kept = arr.filter((item) => !pullMatches(item, cond));
            if (kept.length !== arr.length) { setPath(doc, key, kept, positionalIndexes); modified = true; }
        }
    }
    for (const [key, value] of Object.entries(update.$push || {})) {
        let arr = getPath(doc, key, positionalIndexes);
        if (!Array.isArray(arr)) { arr = []; setPath(doc, key, arr, positionalIndexes); }
        const values = value && value.$each ? value.$each : [value];
        arr.push(...values);
        modified = true;
    }
    return modified;
}

function seedFromQuery(doc, query = {}) {
    for (const [key, value] of Object.entries(query)) {
        if (key.startsWith('$')) continue;
        if (value && typeof value === 'object' && !Array.isArray(value)) continue; // operator object
        setPath(doc, key, value);
    }
}

function compareValues(a, b) {
    // null/undefined sort last in ascending order.
    if (a == null && b == null) return 0;
    if (a == null) return 1;
    if (b == null) return -1;
    if (typeof a === 'string' && typeof b === 'string') return a.localeCompare(b);
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
}

function sortRows(rows, spec = {}) {
    const entries = Object.entries(spec);
    return rows.slice().sort((a, b) => {
        for (const [key, dir] of entries) {
            const cmp = compareValues(getPath(a, key), getPath(b, key));
            if (cmp !== 0) return dir < 0 ? -cmp : cmp;
        }
        return 0;
    });
}

// --- Minimal aggregation support (for the *Stats model helpers) ---
// Covers the pipeline shapes these models actually use: $match, $group, $project,
// $sort, $limit, $skip. Group accumulators: $sum, $avg, $push, $addToSet, $first, $last,
// $min, $max. Expressions: field refs ('$field'), literals, projection objects,
// and the operators $cond, $eq, $ne, $ifNull, $toLower, $size, $isoWeek,
// $isoWeekYear, $dateFromParts. Anything else throws — extend it (and re-run
// the whole suite) rather than guessing.

function aggIsFalsy(v) {
    // MongoDB boolean context: false, null, undefined, 0, NaN are false.
    return v === false || v === null || v === undefined || v === 0
        || (typeof v === 'number' && Number.isNaN(v));
}

function isoWeekParts(dateValue) {
    const date = dateValue instanceof Date ? dateValue : new Date(dateValue);
    if (Number.isNaN(date.getTime())) {
        throw new Error('memory-db aggregate: ISO week expression requires a valid Date');
    }
    const utc = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    const day = utc.getUTCDay() || 7;
    utc.setUTCDate(utc.getUTCDate() + 4 - day);
    const isoWeekYear = utc.getUTCFullYear();
    const yearStart = new Date(Date.UTC(isoWeekYear, 0, 1));
    const isoWeek = Math.ceil((((utc - yearStart) / 86400000) + 1) / 7);
    return { isoWeekYear, isoWeek };
}

function dateFromIsoParts(parts) {
    const isoWeekYear = Number(parts.isoWeekYear);
    const isoWeek = Number(parts.isoWeek);
    const isoDayOfWeek = Number(parts.isoDayOfWeek ?? 1);
    if (![isoWeekYear, isoWeek, isoDayOfWeek].every(Number.isFinite)) {
        throw new Error('memory-db aggregate: $dateFromParts requires ISO week fields');
    }
    const jan4 = new Date(Date.UTC(isoWeekYear, 0, 4));
    const jan4Day = jan4.getUTCDay() || 7;
    const weekOneMonday = new Date(jan4);
    weekOneMonday.setUTCDate(jan4.getUTCDate() - jan4Day + 1);
    const result = new Date(weekOneMonday);
    result.setUTCDate(weekOneMonday.getUTCDate() + ((isoWeek - 1) * 7) + (isoDayOfWeek - 1));
    result.setUTCHours(0, 0, 0, 0);
    return result;
}

function evalAggExpr(doc, expr) {
    if (typeof expr === 'string') {
        return expr.startsWith('$') ? getPath(doc, expr.slice(1)) : expr;
    }
    if (expr instanceof Date) return new Date(expr.getTime());
    if (expr === null || typeof expr !== 'object') return expr;
    if (Array.isArray(expr)) return expr.map((e) => evalAggExpr(doc, e));

    const opKey = Object.keys(expr).find((k) => k.startsWith('$'));
    if (opKey) {
        const arg = expr[opKey];
        switch (opKey) {
            case '$cond': {
                const c = Array.isArray(arg) ? { if: arg[0], then: arg[1], else: arg[2] } : arg;
                return aggIsFalsy(evalAggExpr(doc, c.if)) ? evalAggExpr(doc, c.else) : evalAggExpr(doc, c.then);
            }
            case '$eq': return evalAggExpr(doc, arg[0]) === evalAggExpr(doc, arg[1]);
            case '$ne': return evalAggExpr(doc, arg[0]) !== evalAggExpr(doc, arg[1]);
            case '$ifNull': {
                const v = evalAggExpr(doc, arg[0]);
                return v === null || v === undefined ? evalAggExpr(doc, arg[1]) : v;
            }
            case '$toLower': {
                const v = evalAggExpr(doc, arg);
                return v == null ? '' : String(v).toLowerCase();
            }
            case '$size': {
                const arr = evalAggExpr(doc, arg);
                if (!Array.isArray(arr)) {
                    throw new Error('memory-db aggregate: $size requires an array expression');
                }
                return arr.length;
            }
            case '$isoWeekYear': return isoWeekParts(evalAggExpr(doc, arg)).isoWeekYear;
            case '$isoWeek': return isoWeekParts(evalAggExpr(doc, arg)).isoWeek;
            case '$dateFromParts': {
                return dateFromIsoParts({
                    isoWeekYear: evalAggExpr(doc, arg.isoWeekYear),
                    isoWeek: evalAggExpr(doc, arg.isoWeek),
                    isoDayOfWeek: evalAggExpr(doc, arg.isoDayOfWeek ?? 1),
                });
            }
            default:
                throw new Error(`memory-db aggregate: unsupported expression operator ${opKey}`);
        }
    }
    const out = {};
    for (const [k, v] of Object.entries(expr)) out[k] = evalAggExpr(doc, v);
    return out;
}

function aggAccumulate(docs, acc) {
    const [op, expr] = Object.entries(acc)[0];
    switch (op) {
        case '$sum':
            if (typeof expr === 'number') return docs.length * expr;
            return docs.reduce((s, d) => s + (Number(evalAggExpr(d, expr)) || 0), 0);
        case '$avg': {
            const nums = docs.map((d) => Number(evalAggExpr(d, expr))).filter((n) => !Number.isNaN(n));
            return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
        }
        case '$push': return docs.map((d) => evalAggExpr(d, expr));
        case '$addToSet': {
            const set = [];
            for (const d of docs) {
                const v = evalAggExpr(d, expr);
                if (!set.some((x) => JSON.stringify(x) === JSON.stringify(v))) set.push(v);
            }
            return set;
        }
        case '$first': return docs.length ? evalAggExpr(docs[0], expr) : null;
        case '$last': return docs.length ? evalAggExpr(docs[docs.length - 1], expr) : null;
        case '$min': return docs.reduce((m, d) => { const v = evalAggExpr(d, expr); return m === undefined || v < m ? v : m; }, undefined) ?? null;
        case '$max': return docs.reduce((m, d) => { const v = evalAggExpr(d, expr); return m === undefined || v > m ? v : m; }, undefined) ?? null;
        default:
            throw new Error(`memory-db aggregate: unsupported group accumulator ${op}`);
    }
}

function aggUnwind(rows, spec) {
    const path = (typeof spec === 'string' ? spec : spec.path).replace(/^\$/, '');
    const preserve = typeof spec === 'object' && spec.preserveNullAndEmptyArrays === true;
    const out = [];
    for (const doc of rows) {
        const val = getPath(doc, path);
        if (Array.isArray(val)) {
            if (val.length === 0) { if (preserve) out.push(doc); continue; }
            for (const item of val) { const copy = clone(doc); setPath(copy, path, item); out.push(copy); }
        } else if (val === undefined || val === null) {
            if (preserve) out.push(doc);
        } else {
            out.push(doc); // non-array scalar unwinds to itself
        }
    }
    return out;
}

function aggGroup(rows, spec) {
    const { _id: idExpr, ...accumulators } = spec;
    const groups = new Map();
    const order = [];
    for (const doc of rows) {
        const idVal = idExpr === null || idExpr === undefined ? null : evalAggExpr(doc, idExpr);
        const key = JSON.stringify(idVal ?? null);
        if (!groups.has(key)) { groups.set(key, { _id: idVal ?? null, docs: [] }); order.push(key); }
        groups.get(key).docs.push(doc);
    }
    return order.map((key) => {
        const { _id, docs } = groups.get(key);
        const result = { _id };
        for (const [field, acc] of Object.entries(accumulators)) {
            result[field] = aggAccumulate(docs, acc);
        }
        return result;
    });
}

function aggProject(rows, spec) {
    return rows.map((doc) => {
        const out = {};
        for (const [field, expr] of Object.entries(spec)) {
            if (expr === 0) continue;
            if (expr === 1) {
                const value = getPath(doc, field);
                if (value !== undefined) setPath(out, field, clone(value));
                continue;
            }
            setPath(out, field, evalAggExpr(doc, expr));
        }
        return out;
    });
}

class MemoryCollection {
    constructor(docs = []) {
        this.docs = docs.map(clone);
    }

    async findOne(query) {
        const found = this.docs.find((doc) => matchesQuery(doc, query || {}));
        return found ? clone(found) : null;
    }

    find(query) {
        let rows = this.docs.filter((doc) => matchesQuery(doc, query || {})).map(clone);
        const cursor = {
            project: () => cursor,
            projection: () => cursor,
            sort: (spec) => { rows = sortRows(rows, spec); return cursor; },
            limit: (n) => { rows = rows.slice(0, n); return cursor; },
            skip: (n) => { rows = rows.slice(n); return cursor; },
            toArray: async () => rows,
        };
        return cursor;
    }

    async insertOne(doc) {
        const stored = clone(doc);
        this.docs.push(stored);
        return { acknowledged: true, insertedId: stored._id || `mem-${this.docs.length}` };
    }

    async insertMany(docs = []) {
        for (const doc of docs) this.docs.push(clone(doc));
        return { acknowledged: true, insertedCount: docs.length };
    }

    async updateOne(query, update, options = {}) {
        const target = this.docs.find((doc) => matchesQuery(doc, query || {}));
        if (target) {
            const positionalIndexes = findPositionalIndexes(target, query || {});
            const modified = applyUpdate(target, update, { positionalIndexes });
            return { matchedCount: 1, modifiedCount: modified ? 1 : 0, upsertedCount: 0 };
        }
        if (options.upsert) {
            const fresh = {};
            seedFromQuery(fresh, query);
            applyUpdate(fresh, update, { isInsert: true });
            this.docs.push(fresh);
            return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1, upsertedId: fresh._id || 'mem-upsert' };
        }
        return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
    }

    async findOneAndUpdate(query, update, options = {}) {
        const index = this.docs.findIndex((doc) => matchesQuery(doc, query || {}));
        const wantsAfter = options.returnDocument === 'after' || options.returnOriginal === false;
        if (index !== -1) {
            const before = clone(this.docs[index]);
            const positionalIndexes = findPositionalIndexes(this.docs[index], query || {});
            applyUpdate(this.docs[index], update, { positionalIndexes });
            const value = wantsAfter ? clone(this.docs[index]) : before;
            if (options.includeResultMetadata) {
                return { value, lastErrorObject: { updatedExisting: true }, ok: 1 };
            }
            return value;
        }

        if (options.upsert) {
            const fresh = {};
            seedFromQuery(fresh, query);
            applyUpdate(fresh, update, { isInsert: true });
            if (fresh._id === undefined) fresh._id = `mem-upsert-${this.docs.length + 1}`;
            this.docs.push(fresh);
            const value = wantsAfter ? clone(fresh) : null;
            if (options.includeResultMetadata) {
                return {
                    value,
                    lastErrorObject: { updatedExisting: false, upserted: fresh._id },
                    ok: 1,
                };
            }
            return value;
        }

        if (options.includeResultMetadata) {
            return { value: null, lastErrorObject: { updatedExisting: false }, ok: 1 };
        }
        return null;
    }

    async updateMany(query, update) {
        const targets = this.docs.filter((doc) => matchesQuery(doc, query || {}));
        let modifiedCount = 0;
        for (const target of targets) {
            const positionalIndexes = findPositionalIndexes(target, query || {});
            if (applyUpdate(target, update, { positionalIndexes })) modifiedCount += 1;
        }
        return { matchedCount: targets.length, modifiedCount };
    }

    async replaceOne(query, replacement, options = {}) {
        const index = this.docs.findIndex((doc) => matchesQuery(doc, query || {}));
        if (index !== -1) {
            const { _id } = this.docs[index];
            const fresh = clone(replacement);
            if (fresh._id === undefined && _id !== undefined) fresh._id = _id;
            this.docs[index] = fresh;
            return { matchedCount: 1, modifiedCount: 1, upsertedCount: 0 };
        }
        if (options.upsert) {
            const fresh = clone(replacement);
            // Mongo adds the filter's equality fields to the new doc when absent.
            for (const [key, value] of Object.entries(query || {})) {
                if (key.startsWith('$')) continue;
                if (value && typeof value === 'object' && !Array.isArray(value)) continue;
                if (getPath(fresh, key) === undefined) setPath(fresh, key, value);
            }
            if (fresh._id === undefined) fresh._id = `mem-replace-${this.docs.length + 1}`;
            this.docs.push(fresh);
            return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1, upsertedId: fresh._id };
        }
        return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
    }

    async deleteOne(query) {
        const index = this.docs.findIndex((doc) => matchesQuery(doc, query || {}));
        if (index === -1) return { deletedCount: 0 };
        this.docs.splice(index, 1);
        return { deletedCount: 1 };
    }

    /**
     * Applies the operations in order, which is enough for the unordered
     * upsert batches this codebase writes (LMS grade snapshots and identity
     * mappings). Only the operation types those callers use are supported.
     */
    async bulkWrite(operations = []) {
        const result = {
            insertedCount: 0,
            matchedCount: 0,
            modifiedCount: 0,
            upsertedCount: 0,
            deletedCount: 0
        };

        for (const operation of operations) {
            if (operation.insertOne) {
                await this.insertOne(operation.insertOne.document);
                result.insertedCount += 1;
            } else if (operation.updateOne) {
                const { filter, update, upsert } = operation.updateOne;
                const outcome = await this.updateOne(filter, update, { upsert });
                result.matchedCount += outcome.matchedCount;
                result.modifiedCount += outcome.modifiedCount;
                result.upsertedCount += outcome.upsertedCount;
            } else if (operation.updateMany) {
                const outcome = await this.updateMany(operation.updateMany.filter, operation.updateMany.update);
                result.matchedCount += outcome.matchedCount;
                result.modifiedCount += outcome.modifiedCount;
            } else if (operation.deleteOne) {
                result.deletedCount += (await this.deleteOne(operation.deleteOne.filter)).deletedCount;
            } else if (operation.deleteMany) {
                result.deletedCount += (await this.deleteMany(operation.deleteMany.filter)).deletedCount;
            } else {
                throw new Error(`memory-db bulkWrite does not support ${Object.keys(operation).join(', ')}`);
            }
        }
        return result;
    }

    async deleteMany(query = {}) {
        const before = this.docs.length;
        this.docs = this.docs.filter((doc) => !matchesQuery(doc, query));
        return { deletedCount: before - this.docs.length };
    }

    async countDocuments(query = {}) {
        return this.docs.filter((doc) => matchesQuery(doc, query)).length;
    }

    async distinct(field, query = {}) {
        const values = [];
        for (const doc of this.docs.filter((row) => matchesQuery(row, query))) {
            const value = getPath(doc, field);
            const candidates = Array.isArray(value) ? value : [value];
            for (const candidate of candidates) {
                if (candidate === undefined) continue;
                if (!values.some((existing) => JSON.stringify(existing) === JSON.stringify(candidate))) {
                    values.push(clone(candidate));
                }
            }
        }
        return values;
    }

    aggregate(pipeline = []) {
        let rows = this.docs.map(clone);
        for (const stage of pipeline) {
            if (stage.$match) rows = rows.filter((doc) => matchesQuery(doc, stage.$match));
            else if (stage.$unwind) rows = aggUnwind(rows, stage.$unwind);
            else if (stage.$group) rows = aggGroup(rows, stage.$group);
            else if (stage.$project) rows = aggProject(rows, stage.$project);
            else if (stage.$sort) rows = sortRows(rows, stage.$sort);
            else if (typeof stage.$limit === 'number') rows = rows.slice(0, stage.$limit);
            else if (typeof stage.$skip === 'number') rows = rows.slice(stage.$skip);
            else throw new Error(`memory-db aggregate: unsupported stage ${Object.keys(stage)[0]}`);
        }
        return { toArray: async () => rows.map(clone) };
    }

    async createIndex() {
        return 'ok';
    }
}

/**
 * Build a fake db. Pass a map of collectionName -> array-of-docs (or
 * MemoryCollection) to seed; unknown collections are created empty on first use.
 */
function memoryDb(seed = {}) {
    const collections = {};
    for (const [name, value] of Object.entries(seed)) {
        collections[name] = value instanceof MemoryCollection ? value : new MemoryCollection(value);
    }
    return {
        collection(name) {
            if (!collections[name]) collections[name] = new MemoryCollection();
            return collections[name];
        },
        _collections: collections,
    };
}

module.exports = { MemoryCollection, memoryDb, matchesQuery };
