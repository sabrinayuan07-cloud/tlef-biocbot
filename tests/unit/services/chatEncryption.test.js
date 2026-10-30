/// <reference types="node" />
/// <reference types="jest" />

'use strict';

const {
    initializeChatEncryption,
    isChatEncryptionEnabled
} = require('../../../src/services/chatEncryption');
const {
    loadEncryptionToolkit,
    ENCRYPTED_COLLECTIONS,
    ENCRYPTED_FIELDS,
    resolveEncryptedFields
} = require('../../../src/config/chatEncryption');
const { encryptedMemoryDb } = require('../helpers/encrypted-memory-db');
const MentalHealthFlag = require('../../../src/models/MentalHealthFlag');
const FlaggedQuestion = require('../../../src/models/FlaggedQuestion');
const QuizAttempt = require('../../../src/models/QuizAttempt');

// The toolkit is an optional dependency on GitHub Packages, so an install
// without a registry token (CI, a fresh clone) does not have it. The feature
// flag and pass-through behaviour still get covered there; only the cases that
// exercise real encryption need the package present.
const describeWithToolkit = loadEncryptionToolkit() ? describe : describe.skip;

const SYNTHETIC_KEY = Buffer.alloc(32, 7).toString('base64');

/** @returns {any} */
function fakeDb() {
    return {
        collection: jest.fn(() => ({}))
    };
}

/** @returns {any} */
function memoryDb() {
    /** @type {any} */
    let storedDocument = null;
    const collection = {
        collectionName: 'chat_sessions',
        dbName: 'synthetic-encryption-test',
        async replaceOne(/** @type {any} */ _filter, /** @type {any} */ replacement) {
            storedDocument = replacement;
            return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 1 };
        },
        async findOne() {
            return storedDocument;
        }
    };
    return {
        collection: jest.fn(() => collection),
        getStoredDocument: () => storedDocument
    };
}

describe('student chat encryption startup', () => {
    test('is disabled by default and returns the raw database', async () => {
        const db = fakeDb();

        expect(isChatEncryptionEnabled({})).toBe(false);
        await expect(initializeChatEncryption(db, {})).resolves.toBe(db);
    });

    test.each(['true', '1', ' TRUE '])('accepts enabled value %p', (value) => {
        expect(isChatEncryptionEnabled({
            BIOCBOT_CHAT_ENCRYPTION_ENABLED: value
        })).toBe(true);
    });

    test.each(['false', '0', ' FALSE '])('accepts disabled value %p', (value) => {
        expect(isChatEncryptionEnabled({
            BIOCBOT_CHAT_ENCRYPTION_ENABLED: value
        })).toBe(false);
    });

    test('rejects an ambiguous feature flag', () => {
        expect(() => isChatEncryptionEnabled({
            BIOCBOT_CHAT_ENCRYPTION_ENABLED: 'yes'
        })).toThrow('BIOCBOT_CHAT_ENCRYPTION_ENABLED must be true, false, 1, or 0');
    });

});

describeWithToolkit('student chat encryption with the toolkit installed', () => {
    test('fails closed when enabled without a key', async () => {
        await expect(initializeChatEncryption(fakeDb(), {
            BIOCBOT_CHAT_ENCRYPTION_ENABLED: 'true'
        })).rejects.toMatchObject({ code: 'KEY_NOT_FOUND' });
    });

    test('wraps chat_sessions when enabled with a valid dedicated key', async () => {
        const protectedDb = /** @type {any} */ (await initializeChatEncryption(fakeDb(), {
            BIOCBOT_CHAT_ENCRYPTION_ENABLED: 'true',
            BIOCBOT_CHAT_ENCRYPTION_KEY: SYNTHETIC_KEY
        }));

        expect(protectedDb).not.toBeNull();
        expect(protectedDb.isProtected('chat_sessions')).toBe(true);
        expect(protectedDb.isProtected('courses')).toBe(false);
        expect(protectedDb.encryptionConfig.readPolicy).toBe('mixed');
        expect(protectedDb.encryptionConfig.writePolicy).toBe('encrypted');
    });

    test('stores an envelope while returning the original chat payload', async () => {
        const rawDb = memoryDb();
        const protectedDb = /** @type {any} */ (await initializeChatEncryption(rawDb, {
            BIOCBOT_CHAT_ENCRYPTION_ENABLED: 'true',
            BIOCBOT_CHAT_ENCRYPTION_KEY: SYNTHETIC_KEY
        }));
        const chats = protectedDb.collection('chat_sessions');
        const plaintext = {
            sessionId: 'synthetic-session',
            courseId: 'SYNTH-101',
            chatData: {
                messages: [{ type: 'user', content: 'synthetic question' }]
            }
        };

        await chats.replaceOne({ sessionId: plaintext.sessionId }, plaintext, { upsert: true });

        const stored = rawDb.getStoredDocument();
        expect(stored.sessionId).toBe('synthetic-session');
        expect(stored.chatData).toMatchObject({
            __ubc_enc: 1,
            alg: 'A256GCM',
            kid: 'student-chat-2026-01'
        });
        expect(stored.chatData.messages).toBeUndefined();
        expect(stored.chatData.iv.buffer).toHaveLength(12);
        expect(stored.chatData.tag.buffer).toHaveLength(16);

        const found = await chats.findOne({ sessionId: plaintext.sessionId });
        expect(found).toEqual(plaintext);
    });

    test('validates rollout policy values before returning a database', async () => {
        await expect(initializeChatEncryption(fakeDb(), {
            BIOCBOT_CHAT_ENCRYPTION_ENABLED: 'true',
            BIOCBOT_CHAT_ENCRYPTION_KEY: SYNTHETIC_KEY,
            BIOCBOT_CHAT_ENCRYPTION_READ_POLICY: 'lenient'
        })).rejects.toMatchObject({ code: 'CONFIGURATION_ERROR' });
    });
});

// The Super Course and instructor transcript collections joined the same
// policy, key, and namespace as chat_sessions. These cases run the real
// toolkit wrapper over an envelope-safe in-memory Mongo so they assert on what
// MongoDB would actually hold, not on a mock's opinion of it.
describeWithToolkit('chat transcript collections share one encryption policy', () => {
    const NEW_COLLECTIONS = [
        'student_super_course_chat_sessions',
        'instructor_chat_sessions'
    ];

    /**
     * @param {Record<string, any[]>} [seed]
     * @param {Record<string, string>} [extraEnv]
     */
    async function wrap(seed = {}, extraEnv = {}) {
        const rawDb = encryptedMemoryDb(seed);
        const protectedDb = /** @type {any} */ (await initializeChatEncryption(rawDb, {
            BIOCBOT_CHAT_ENCRYPTION_ENABLED: 'true',
            BIOCBOT_CHAT_ENCRYPTION_KEY: SYNTHETIC_KEY,
            ...extraEnv
        }));
        return { rawDb, protectedDb };
    }

    test('every configured collection is protected, and nothing else is', async () => {
        const { protectedDb } = await wrap();

        expect([...ENCRYPTED_COLLECTIONS]).toEqual([
            'chat_sessions',
            'student_super_course_chat_sessions',
            'instructor_chat_sessions',
            'mentalHealthFlags',
            'flaggedQuestions',
            'messageFeedback',
            'chatSurveyResponses',
            'quizAttempts',
            'lms_canvas_tokens',
            'lms_moodle_tokens'
        ]);
        for (const name of ENCRYPTED_COLLECTIONS) {
            expect(protectedDb.isProtected(name)).toBe(true);
        }
        // Collections deliberately left out of this rollout.
        for (const name of [
            'users', 'courses', 'documents', 'superchats', 'struggleActivity',
            'lms_identity_mappings', 'lms_grade_snapshots'
        ]) {
            expect(protectedDb.isProtected(name)).toBe(false);
        }
    });

    test('the LMS token collections stay protected when a deployment renames them', async () => {
        const renames = {
            CANVAS_TOKEN_COLLECTION_NAME: 'renamed_canvas_tokens',
            MOODLE_TOKEN_COLLECTION_NAME: 'renamed_moodle_tokens'
        };
        const { protectedDb } = await wrap({}, renames);

        expect(Object.keys(resolveEncryptedFields(renames)).slice(-2))
            .toEqual(['renamed_canvas_tokens', 'renamed_moodle_tokens']);
        expect(protectedDb.isProtected('renamed_canvas_tokens')).toBe(true);
        expect(protectedDb.isProtected('renamed_moodle_tokens')).toBe(true);
        expect(protectedDb.isProtected('lms_canvas_tokens')).toBe(false);
    });

    test.each(NEW_COLLECTIONS)('%s stores an envelope and returns the original chatData', async (name) => {
        const { rawDb, protectedDb } = await wrap();
        const sessionData = {
            sessionId: 'sess-1',
            studentId: 'stu-1',
            instructorId: 'inst-1',
            superchatId: 'sc-1',
            instructorName: 'Dr I',
            title: 'Super Course Chat',
            messageCount: 2,
            duration: '45s',
            savedAt: '2026-08-26T10:00:00.000Z',
            isDeleted: false,
            chatData: { messages: [{ type: 'user', content: 'confidential transcript' }] }
        };

        await protectedDb.collection(name).replaceOne(
            { sessionId: 'sess-1' },
            sessionData,
            { upsert: true }
        );

        // 1. What MongoDB holds is an envelope, not the transcript.
        const [stored] = rawDb.stored(name);
        expect(stored.chatData).toMatchObject({
            __ubc_enc: 1,
            alg: 'A256GCM',
            kid: 'student-chat-2026-01'
        });
        expect(stored.chatData.messages).toBeUndefined();
        expect(stored.chatData.iv.buffer).toHaveLength(12);
        expect(stored.chatData.tag.buffer).toHaveLength(16);
        expect(stored.title).toMatchObject({ __ubc_enc: 1, kid: 'student-chat-2026-01' });
        expect(JSON.stringify(stored)).not.toContain('confidential transcript');
        expect(JSON.stringify(stored)).not.toContain('Super Course Chat');

        // Operational fields stay plaintext and unchanged.
        expect(stored).toMatchObject({
            sessionId: 'sess-1',
            studentId: 'stu-1',
            instructorId: 'inst-1',
            superchatId: 'sc-1',
            instructorName: 'Dr I',
            messageCount: 2,
            duration: '45s',
            savedAt: '2026-08-26T10:00:00.000Z',
            isDeleted: false
        });

        // 2. A wrapped read returns the original payload unchanged.
        const found = await protectedDb.collection(name).findOne({ sessionId: 'sess-1' });
        expect(found).toEqual(sessionData);
    });

    test.each(NEW_COLLECTIONS)('%s mixed reads still return legacy plaintext documents', async (name) => {
        const legacy = {
            sessionId: 'legacy-1',
            studentId: 'stu-1',
            instructorId: 'inst-1',
            isDeleted: false,
            chatData: { messages: [{ type: 'user', content: 'written before the migration' }] }
        };
        const { protectedDb } = await wrap({ [name]: [legacy] });

        expect(protectedDb.encryptionConfig.readPolicy).toBe('mixed');

        const found = await protectedDb.collection(name).findOne({ sessionId: 'legacy-1' });
        expect(found.chatData).toEqual(legacy.chatData);

        // A migrated document and an un-migrated one coexist and both read back.
        await protectedDb.collection(name).replaceOne(
            { sessionId: 'new-1' },
            { sessionId: 'new-1', studentId: 'stu-1', instructorId: 'inst-1', isDeleted: false, chatData: { messages: [{ type: 'bot', content: 'written after' }] } },
            { upsert: true }
        );
        const both = await protectedDb.collection(name).find({ studentId: 'stu-1' }).toArray();
        expect(both.map((doc) => doc.chatData.messages[0].content).sort()).toEqual([
            'written after',
            'written before the migration'
        ]);
    });

    test.each(NEW_COLLECTIONS)('%s strict reads reject the legacy plaintext the mixed mode allows', async (name) => {
        const { protectedDb } = await wrap(
            { [name]: [{ sessionId: 'legacy-1', chatData: { messages: [] } }] },
            // The toolkit rejects strict reads alongside mixed queries, which is
            // why the runbook flips both switches together.
            {
                BIOCBOT_CHAT_ENCRYPTION_READ_POLICY: 'strict',
                BIOCBOT_CHAT_ENCRYPTION_QUERY_POLICY: 'encrypted'
            }
        );

        await expect(
            protectedDb.collection(name).findOne({ sessionId: 'legacy-1' })
        ).rejects.toMatchObject({ code: 'PLAINTEXT_VALUE_REJECTED' });
    });

    test.each(NEW_COLLECTIONS)('%s still filters and sorts on its plaintext operational fields', async (name) => {
        const { protectedDb } = await wrap();
        const collection = protectedDb.collection(name);
        const rows = [
            { sessionId: 's-old', studentId: 'stu-1', instructorId: 'inst-1', superchatId: 'sc-1', isDeleted: false, updatedAt: new Date('2026-01-01T00:00:00Z'), savedAt: '2026-01-01T00:00:00.000Z', chatData: { messages: [{ content: 'older' }] } },
            { sessionId: 's-new', studentId: 'stu-1', instructorId: 'inst-1', superchatId: 'sc-1', isDeleted: false, updatedAt: new Date('2026-06-01T00:00:00Z'), savedAt: '2026-06-01T00:00:00.000Z', chatData: { messages: [{ content: 'newer' }] } },
            { sessionId: 's-gone', studentId: 'stu-1', instructorId: 'inst-1', superchatId: 'sc-1', isDeleted: true, updatedAt: new Date('2026-07-01T00:00:00Z'), savedAt: '2026-07-01T00:00:00.000Z', chatData: { messages: [{ content: 'deleted' }] } },
            { sessionId: 's-other', studentId: 'stu-2', instructorId: 'inst-2', superchatId: 'sc-1', isDeleted: false, updatedAt: new Date('2026-08-01T00:00:00Z'), savedAt: '2026-08-01T00:00:00.000Z', chatData: { messages: [{ content: 'someone else' }] } }
        ];
        for (const row of rows) {
            await collection.replaceOne({ sessionId: row.sessionId }, row, { upsert: true });
        }

        // The exact filter + sort the session-list routes issue.
        const ownerField = name === 'instructor_chat_sessions' ? 'instructorId' : 'studentId';
        const ownerId = name === 'instructor_chat_sessions' ? 'inst-1' : 'stu-1';
        const listed = await collection
            .find({
                [ownerField]: ownerId,
                $or: [{ isDeleted: { $exists: false } }, { isDeleted: false }]
            })
            .sort({ updatedAt: -1, savedAt: -1 })
            .toArray();

        expect(listed.map((doc) => doc.sessionId)).toEqual(['s-new', 's-old']);
        // Decryption happened on the way out of the sorted cursor.
        expect(listed[0].chatData.messages[0].content).toBe('newer');

        // Single-session load by its plaintext key.
        const one = await collection.findOne({ sessionId: 's-old', [ownerField]: ownerId });
        expect(one.chatData.messages[0].content).toBe('older');

        // Soft delete writes a plaintext flag without disturbing the envelope.
        await collection.updateOne(
            { sessionId: 's-new', [ownerField]: ownerId },
            { $set: { isDeleted: true, deletedAt: new Date() } }
        );
        const afterDelete = await collection
            .find({ [ownerField]: ownerId, $or: [{ isDeleted: { $exists: false } }, { isDeleted: false }] })
            .sort({ updatedAt: -1, savedAt: -1 })
            .toArray();
        expect(afterDelete.map((doc) => doc.sessionId)).toEqual(['s-old']);
        expect(afterDelete[0].chatData.messages[0].content).toBe('older');
    });

    test('student_super_course_chat_sessions still answers the pseudonym distinct() query', async () => {
        // src/services/studentPseudonyms.js enumerates studentIds this way. The
        // field is plaintext, so the wrapper must let it through rather than
        // rejecting it as an encrypted-field enumeration.
        const { protectedDb } = await wrap();
        const collection = protectedDb.collection('student_super_course_chat_sessions');
        for (const studentId of ['stu-1', 'stu-2', 'stu-1']) {
            await collection.replaceOne(
                { sessionId: `${studentId}-${Math.random()}` },
                { sessionId: `${studentId}-s`, studentId, superchatId: 'sc-1', isDeleted: false, chatData: { messages: [] } },
                { upsert: true }
            );
        }

        const ids = await collection.distinct('studentId', { superchatId: 'sc-1', isDeleted: { $ne: true } });
        expect(ids.sort()).toEqual(['stu-1', 'stu-2']);
    });

    test('chat_sessions written under the previous single-collection policy still decrypt', async () => {
        // Adding collections changes the configuration fingerprint, but the AAD
        // binds an envelope to namespace/collection/field/key only. Existing
        // chat_sessions ciphertext must therefore remain readable.
        const { createEncryptedDb } = /** @type {any} */ (loadEncryptionToolkit());
        const { buildChatEncryptionConfig } = require('../../../src/config/chatEncryption');
        const env = { BIOCBOT_CHAT_ENCRYPTION_KEY: SYNTHETIC_KEY };
        const rawDb = encryptedMemoryDb();

        const previousConfig = buildChatEncryptionConfig(env);
        previousConfig.collections = { chat_sessions: { fields: { chatData: { encrypt: true } } } };
        const previousDb = await createEncryptedDb(rawDb, previousConfig);
        const payload = { sessionId: 'pre-existing', chatData: { messages: [{ content: 'legacy ciphertext' }] } };
        await previousDb.collection('chat_sessions').insertOne(payload);
        expect(rawDb.stored('chat_sessions')[0].chatData.__ubc_enc).toBe(1);

        const currentDb = /** @type {any} */ (await createEncryptedDb(rawDb, buildChatEncryptionConfig(env)));
        const found = await currentDb.collection('chat_sessions').findOne({ sessionId: 'pre-existing' });
        expect(found.chatData).toEqual(payload.chatData);
    });
});

// Flag reports, feedback, survey comments, and quiz answers hold copies of
// chat text or student-written text, so they joined the same policy and key.
describeWithToolkit('free-text fields outside the transcript collections', () => {
    const NON_CHAT_COLLECTIONS = [
        'mentalHealthFlags',
        'flaggedQuestions',
        'messageFeedback',
        'chatSurveyResponses',
        'quizAttempts'
    ];

    async function wrap(seed = {}) {
        const rawDb = encryptedMemoryDb(seed);
        const protectedDb = /** @type {any} */ (await initializeChatEncryption(rawDb, {
            BIOCBOT_CHAT_ENCRYPTION_ENABLED: 'true',
            BIOCBOT_CHAT_ENCRYPTION_KEY: SYNTHETIC_KEY
        }));
        return { rawDb, protectedDb };
    }

    test.each(NON_CHAT_COLLECTIONS)('%s stores envelopes for its configured fields only', async (name) => {
        const { rawDb, protectedDb } = await wrap();
        /** @type {Record<string, any>} */
        const document = { recordId: 'rec-1', courseId: 'C1', studentId: 'stu-1', status: 'pending' };
        for (const field of ENCRYPTED_FIELDS[name]) {
            document[field] = [{ role: 'user', content: `confidential ${name}.${field}` }];
        }

        await protectedDb.collection(name).insertOne(document);

        const [stored] = rawDb.stored(name);
        for (const field of ENCRYPTED_FIELDS[name]) {
            expect(stored[field]).toMatchObject({ __ubc_enc: 1, alg: 'A256GCM', kid: 'student-chat-2026-01' });
        }
        expect(JSON.stringify(stored)).not.toContain('confidential');
        expect(stored).toMatchObject({ recordId: 'rec-1', courseId: 'C1', studentId: 'stu-1', status: 'pending' });

        const found = await protectedDb.collection(name).findOne({ recordId: 'rec-1' });
        expect(found).toEqual(document);
    });

    test('a survey response without a comment still round-trips', async () => {
        const { protectedDb } = await wrap();
        const response = { responseId: 'r-1', courseId: 'C1', comment: null };

        await protectedDb.collection('chatSurveyResponses').insertOne(response);

        const found = await protectedDb.collection('chatSurveyResponses').findOne({ responseId: 'r-1' });
        expect(found.comment).toBeNull();
    });

    test('the wrapper rejects $group here, which is why the stats helpers count in code', async () => {
        const { protectedDb } = await wrap();
        const pipeline = [{ $match: { courseId: 'C1' } }, { $group: { _id: '$status', count: { $sum: 1 } } }];

        await expect((async () => protectedDb.collection('mentalHealthFlags').aggregate(pipeline).toArray())())
            .rejects.toMatchObject({ code: 'ENCRYPTED_AGGREGATION_NOT_SUPPORTED' });
    });

    test('mental-health flag stats work through the wrapper', async () => {
        const { rawDb, protectedDb } = await wrap();
        for (const concernLevel of ['moderate', 'high']) {
            await MentalHealthFlag.createMentalHealthFlag(protectedDb, {
                studentId: 'stu-1', courseId: 'C1', message: 'confidential message', concernLevel
            });
        }
        const [first] = await MentalHealthFlag.getMentalHealthFlagsForCourse(protectedDb, 'C1');
        await MentalHealthFlag.updateFlagStatus(protectedDb, first.flagId, 'escalated', 'inst-1');

        expect(JSON.stringify(rawDb.stored('mentalHealthFlags'))).not.toContain('confidential');
        expect(first.message).toBe('confidential message');
        expect(await MentalHealthFlag.getMentalHealthFlagStats(protectedDb, 'C1')).toMatchObject({
            total: 2, pending: 1, escalated: 1
        });
    });

    test('flagged-question stats work through the wrapper', async () => {
        const { rawDb, protectedDb } = await wrap();
        await FlaggedQuestion.createFlaggedQuestion(protectedDb, {
            courseId: 'C1', studentId: 'stu-1', flagReason: 'incorrect',
            flagDescription: 'confidential description',
            questionContent: { question: 'confidential bot reply' }
        });

        expect(JSON.stringify(rawDb.stored('flaggedQuestions'))).not.toContain('confidential');
        expect(await FlaggedQuestion.getFlagStatistics(protectedDb, 'C1')).toMatchObject({ total: 1, pending: 1 });
    });

    test('quiz attempt stats work through the wrapper', async () => {
        const { rawDb, protectedDb } = await wrap();
        for (const [lectureName, correct] of [['Unit 1', true], ['Unit 1', false], ['Unit 2', true]]) {
            await QuizAttempt.saveAttempt(protectedDb, {
                studentId: 'stu-1', courseId: 'C1', questionId: 'q', lectureName, correct,
                questionType: 'short-answer', studentAnswer: 'confidential answer', feedback: 'confidential feedback'
            });
        }

        expect(JSON.stringify(rawDb.stored('quizAttempts'))).not.toContain('confidential');
        expect(await QuizAttempt.getAttemptStats(protectedDb, 'stu-1', 'C1')).toEqual({
            totalAttempts: 3,
            correctCount: 2,
            accuracy: 67,
            unitBreakdown: { 'Unit 1': { total: 2, correct: 1 }, 'Unit 2': { total: 1, correct: 1 } }
        });
    });
});
