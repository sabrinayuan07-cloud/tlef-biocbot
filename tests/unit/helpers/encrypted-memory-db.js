/**
 * A Mongo-style in-memory double that is safe to wrap with the encryption
 * toolkit's ProtectedDb.
 *
 * `helpers/memory-db.js` deep-clones every document on the way in and out. That
 * is correct for plain application documents, but it destroys the BSON `Binary`
 * values inside an encryption envelope: cloning walks a Binary's own enumerable
 * properties, so `_bsontype` (a prototype member) disappears and `buffer` (a
 * Buffer) is rebuilt as an index-keyed object. The toolkit recognises Binary by
 * its `_bsontype` discriminator, so a cloned envelope can never be decrypted
 * again and the test would "prove" a failure that only the fake produces.
 *
 * This double therefore stores documents by reference. Tests are expected not
 * to mutate what they hand it, which is exactly how the routes under test
 * behave.
 *
 * Query matching is delegated to the shared helper so filter semantics ($or,
 * $exists, $ne, dotted paths) stay identical to the rest of the unit suite.
 */

const { matchesQuery } = require('./memory-db');

function getPath(doc, path) {
    if (doc == null) return undefined;
    if (path.indexOf('.') === -1) return doc[path];
    return path.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), doc);
}

function compareValues(a, b) {
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

class EnvelopeSafeCollection {
    constructor(name, docs = []) {
        this.collectionName = name;
        this.dbName = 'encrypted-memory-db';
        this.docs = docs.slice();
    }

    async insertOne(doc) {
        this.docs.push(doc);
        return { acknowledged: true, insertedId: doc._id || `mem-${this.docs.length}` };
    }

    async findOne(query) {
        return this.docs.find((doc) => matchesQuery(doc, query || {})) || null;
    }

    find(query) {
        let rows = this.docs.filter((doc) => matchesQuery(doc, query || {}));
        const cursor = {
            sort: (spec) => { rows = sortRows(rows, spec); return cursor; },
            limit: (n) => { rows = rows.slice(0, n); return cursor; },
            skip: (n) => { rows = rows.slice(n); return cursor; },
            project: () => cursor,
            toArray: async () => rows,
            close: async () => undefined
        };
        return cursor;
    }

    async replaceOne(query, replacement, options = {}) {
        const index = this.docs.findIndex((doc) => matchesQuery(doc, query || {}));
        if (index !== -1) {
            this.docs[index] = replacement;
            return { matchedCount: 1, modifiedCount: 1, upsertedCount: 0 };
        }
        if (options.upsert) {
            this.docs.push(replacement);
            return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1, upsertedId: 'mem-upsert' };
        }
        return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
    }

    async updateOne(query, update, options = {}) {
        const target = this.docs.find((doc) => matchesQuery(doc, query || {}));
        if (!target) {
            if (!options.upsert) return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
            // Like MongoDB, an upsert starts from the filter's plain equality fields.
            const inserted = Object.fromEntries(Object.entries(query || {})
                .filter(([key, value]) => !key.startsWith('$') && (value === null || typeof value !== 'object')));
            Object.assign(inserted, update.$setOnInsert, update.$set);
            this.docs.push(inserted);
            return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1, upsertedId: 'mem-upsert' };
        }
        for (const [key, value] of Object.entries(update.$set || {})) {
            target[key] = value;
        }
        return { matchedCount: 1, modifiedCount: 1, upsertedCount: 0 };
    }

    async deleteOne(query) {
        const index = this.docs.findIndex((doc) => matchesQuery(doc, query || {}));
        if (index === -1) return { deletedCount: 0 };
        this.docs.splice(index, 1);
        return { deletedCount: 1 };
    }

    async createIndex(keys) {
        return Object.keys(keys).map((key) => `${key}_${keys[key]}`).join('_');
    }

    async distinct(field, query = {}) {
        const values = [];
        for (const doc of this.docs.filter((row) => matchesQuery(row, query))) {
            const value = getPath(doc, field);
            if (value !== undefined && !values.includes(value)) values.push(value);
        }
        return values;
    }

    async countDocuments(query = {}) {
        return this.docs.filter((doc) => matchesQuery(doc, query)).length;
    }
}

/**
 * Build an envelope-safe db.
 *
 * @param {Record<string, any[]>} seed collectionName -> documents
 */
function encryptedMemoryDb(seed = {}) {
    const collections = {};
    for (const [name, docs] of Object.entries(seed)) {
        collections[name] = new EnvelopeSafeCollection(name, docs);
    }
    return {
        databaseName: 'encrypted-memory-db',
        collection(name) {
            if (!collections[name]) collections[name] = new EnvelopeSafeCollection(name);
            return collections[name];
        },
        /** The documents as MongoDB actually holds them, envelopes included. */
        stored(name) {
            return collections[name] ? collections[name].docs : [];
        },
        _collections: collections
    };
}

module.exports = { EnvelopeSafeCollection, encryptedMemoryDb };
