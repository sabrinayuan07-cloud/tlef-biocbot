#!/usr/bin/env node
'use strict';

require('dotenv').config({ quiet: true });

const { randomBytes } = require('node:crypto');
const { MongoClient } = require('mongodb');
const {
    buildChatEncryptionConfig,
    requireEncryptionToolkit,
    resolveEncryptedFields
} = require('../src/config/chatEncryption');

/** Every configured value carries this, so stored plaintext is easy to spot. */
const SYNTHETIC_MARKER = 'synthetic-canary-plaintext';

/**
 * The synthetic document each collection is probed with. Every configured
 * field gets a value containing SYNTHETIC_MARKER; the operational fields around
 * them must survive as plaintext so existing filters and sorts keep working.
 *
 * @param {string} collectionName
 * @param {readonly string[]} fields
 */
function syntheticDocument(collectionName, fields) {
    /** @type {Record<string, any>} */
    const document = {
        canaryId: `synthetic-canary-${collectionName}`,
        courseId: 'SYNTH-101',
        studentId: 'synthetic-student',
        isDeleted: false,
        savedAt: new Date().toISOString()
    };
    for (const field of fields) {
        document[field] = {
            messages: [
                { type: 'user', content: `${SYNTHETIC_MARKER} ${collectionName}.${field}` }
            ]
        };
    }
    return document;
}

async function main() {
    if (!process.env.MONGO_URI) {
        throw new Error('MONGO_URI is required for the synthetic encryption canary');
    }

    const { createEncryptedDb } = requireEncryptionToolkit();

    const databaseName = `biocbot-encryption-canary-${process.pid}-${Date.now()}`;
    const client = new MongoClient(process.env.MONGO_URI);
    let canaryDb;

    try {
        await client.connect();
        canaryDb = client.db(databaseName);

        const config = buildChatEncryptionConfig({
            ...process.env,
            BIOCBOT_CHAT_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
            BIOCBOT_CHAT_ENCRYPTION_READ_POLICY: 'mixed',
            BIOCBOT_CHAT_ENCRYPTION_QUERY_POLICY: 'mixed'
        });
        const protectedDb = await createEncryptedDb(canaryDb, config);

        // Every configured collection is probed, not just the first one. A
        // collection added to the policy but missed here would otherwise pass a
        // green canary while writing plaintext in production.
        const report = {
            database: databaseName,
            collections: {}
        };

        for (const [collectionName, fields] of Object.entries(resolveEncryptedFields(process.env))) {
            const protectedCollection = protectedDb.collection(collectionName);
            const rawCollection = canaryDb.collection(collectionName);
            const document = syntheticDocument(collectionName, fields);

            await protectedCollection.insertOne(document);
            const raw = await rawCollection.findOne({ canaryId: document.canaryId });
            const roundTrip = await protectedCollection.findOne({ canaryId: document.canaryId });

            /** @type {Record<string, any>} */
            const storedFields = {};
            for (const field of fields) {
                const envelope = raw?.[field];
                storedFields[field] = {
                    isEnvelope: envelope?.__ubc_enc === 1,
                    algorithm: envelope?.alg,
                    keyId: envelope?.kid,
                    ivBytes: envelope?.iv?.buffer?.length,
                    tagBytes: envelope?.tag?.buffer?.length,
                    hasCiphertext: (envelope?.ct?.buffer?.length || 0) > 0
                };
            }

            const collectionReport = {
                isProtected: protectedDb.isProtected(collectionName),
                operationalFieldsRemainQueryable:
                    raw?.canaryId === document.canaryId && raw?.courseId === document.courseId,
                storedFields,
                plaintextPresentAtRest: JSON.stringify(raw).includes(SYNTHETIC_MARKER),
                protectedReadMatches: fields.every(
                    (field) => JSON.stringify(roundTrip?.[field]) === JSON.stringify(document[field])
                )
            };
            report.collections[collectionName] = collectionReport;

            if (
                !collectionReport.isProtected ||
                !collectionReport.operationalFieldsRemainQueryable ||
                !Object.values(storedFields).every((stored) => stored.isEnvelope) ||
                collectionReport.plaintextPresentAtRest ||
                !collectionReport.protectedReadMatches
            ) {
                throw new Error(
                    `synthetic encryption canary did not meet its assertions for ${collectionName}`
                );
            }
        }

        console.log(JSON.stringify(report, null, 2));
    } finally {
        if (canaryDb) {
            await canaryDb.dropDatabase();
            console.log(`Removed synthetic canary database: ${databaseName}`);
        }
        await client.close();
    }
}

if (require.main === module) {
    main().catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
    });
}
