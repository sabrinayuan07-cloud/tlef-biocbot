// Replace the heavy/connecting collaborators. llmKeyStore stays REAL so the
// encrypt/decrypt + key-status logic the registry depends on is exercised end to
// end (the test key is derived deterministically under NODE_ENV=test).
jest.mock('../../../src/services/config', () => ({
    getLLMConfig: jest.fn(() => ({ provider: 'openai' })),
}));
jest.mock('../../../src/services/llm', () => ({
    create: jest.fn(async () => ({ setDbAccessor: jest.fn() })),
}));
jest.mock('../../../src/services/qdrantService', () =>
    jest.fn().mockImplementation(() => ({
        initialize: jest.fn().mockResolvedValue(undefined),
        embeddings: { tag: 'embeddings' },
    }))
);

const LlmRegistry = require('../../../src/services/llmRegistry');
const LLMService = require('../../../src/services/llm');
const { buildKeySubdocument } = require('../../../src/services/llmKeyStore');
const { memoryDb } = require('../helpers/memory-db');

const OLD_ENV = process.env;
beforeEach(() => {
    process.env = { ...OLD_ENV };
    delete process.env.LLM_PROVIDER;
    delete process.env.BIOCBOT_TEST_LLM_STUB;
});
afterAll(() => {
    process.env = OLD_ENV;
});

// Every selectable platform (GPT / Sandbox) now requires a per-surface key.
// `ollama` is the only runtime left that bypasses key enforcement, so these
// cache-behaviour tests run against it.
describe('LlmRegistry cache behavior (keys not enforced)', () => {
    beforeEach(() => {
        process.env.LLM_PROVIDER = 'ollama';
    });

    test('forCourse caches per scope and reuses the same services', async () => {
        const reg = new LlmRegistry();
        const db = memoryDb({ courses: [{ courseId: 'C1' }] });

        const first = await reg.forCourse(db, 'C1');
        const second = await reg.forCourse(db, 'C1');

        expect(LLMService.create).toHaveBeenCalledTimes(1);
        expect(second).toBe(first);
        expect(first).toMatchObject({ scope: { type: 'course', id: 'C1' } });
    });

    test('different scopes get independent cache entries', async () => {
        const reg = new LlmRegistry();
        const db = memoryDb({ courses: [{ courseId: 'C1' }], superchats: [{ superchatId: 'S1' }] });

        await reg.forCourse(db, 'C1');
        await reg.forSuperchat(db, 'S1');

        expect(LLMService.create).toHaveBeenCalledTimes(2);
    });

    test('evicting a scope forces a rebuild on the next call', async () => {
        const reg = new LlmRegistry();
        const db = memoryDb({ courses: [{ courseId: 'C1' }] });

        await reg.forCourse(db, 'C1');
        reg.evictCourse('C1');
        await reg.forCourse(db, 'C1');

        expect(LLMService.create).toHaveBeenCalledTimes(2);
    });

    test('clear() drops every cache entry', async () => {
        const reg = new LlmRegistry();
        const db = memoryDb({ courses: [{ courseId: 'C1' }] });

        await reg.forCourse(db, 'C1');
        reg.clear();
        await reg.forCourse(db, 'C1');

        expect(LLMService.create).toHaveBeenCalledTimes(2);
    });

    test('a stale entry past the TTL is rebuilt', async () => {
        const reg = new LlmRegistry();
        const db = memoryDb({ courses: [{ courseId: 'C1' }] });

        await reg.forCourse(db, 'C1');
        // Age the cached entry past the 10-minute TTL (white-box poke).
        reg.cache.get('course:C1').createdAt = Date.now() - (10 * 60 * 1000 + 1);
        await reg.forCourse(db, 'C1');

        expect(LLMService.create).toHaveBeenCalledTimes(2);
    });

    test('forCourse / forSuperchat reject a missing id with an LlmKeyError', async () => {
        const reg = new LlmRegistry();
        const db = memoryDb({});
        await expect(reg.forCourse(db, '')).rejects.toMatchObject({ name: 'LlmKeyError', code: 'LLM_KEY_MISSING' });
        await expect(reg.forSuperchat(db, null)).rejects.toMatchObject({ name: 'LlmKeyError' });
    });

    test('forCourse names a course only with a string, so another course\'s key is never chosen', async () => {
        const reg = new LlmRegistry();
        const db = memoryDb({ courses: [{ courseId: 'C1' }] });
        for (const courseId of [{ $gte: '' }, { $in: ['C1'] }, ['C1']]) {
            await expect(reg.forCourse(db, courseId)).rejects.toMatchObject({ name: 'LlmKeyError', code: 'LLM_KEY_MISSING', scope: { type: 'course', id: null } });
        }
    });
});

describe('LlmRegistry with scoped keys enforced (openai)', () => {
    beforeEach(() => {
        process.env.LLM_PROVIDER = 'openai';
    });

    test('a missing key throws LlmKeyError(missing)', async () => {
        const reg = new LlmRegistry();
        const db = memoryDb({ courses: [{ courseId: 'C1' }] }); // no llmApiKey
        await expect(reg.forCourse(db, 'C1')).rejects.toMatchObject({ name: 'LlmKeyError', status: 'missing' });
        expect(LLMService.create).not.toHaveBeenCalled();
    });

    test('a non-valid key status throws LlmKeyError with that status', async () => {
        const reg = new LlmRegistry();
        const db = memoryDb({ courses: [{ courseId: 'C1', llmApiKey: { status: 'invalid', ciphertext: 'x' } }] });
        await expect(reg.forCourse(db, 'C1')).rejects.toMatchObject({ name: 'LlmKeyError', status: 'invalid' });
    });

    test('a valid key resolves and the decrypted key is injected into the LLM config', async () => {
        const reg = new LlmRegistry();
        const llmApiKey = buildKeySubdocument('sk-test-secret-key', 'admin');
        const db = memoryDb({ courses: [{ courseId: 'C1', llmApiKey }] });

        const services = await reg.forCourse(db, 'C1');
        expect(services).toMatchObject({ scope: { type: 'course', id: 'C1' } });
        expect(LLMService.create).toHaveBeenCalledTimes(1);
        expect(LLMService.create.mock.calls[0][0].llmConfig.apiKey).toBe('sk-test-secret-key');
    });

    test('initial preparation blocks AI even when the stored key is valid', async () => {
        const reg = new LlmRegistry();
        const llmApiKey = buildKeySubdocument('sk-test-secret-key', 'admin');
        const db = memoryDb({ courses: [{
            courseId: 'C1',
            llmApiKey,
            aiPreparationRequired: true,
            pendingLlmProvider: 'openai',
            providerMigrationId: 'mig_prepare',
        }] });

        await expect(reg.forCourse(db, 'C1')).rejects.toMatchObject({
            name: 'LlmPreparationError',
            code: 'LLM_PROVIDER_PREPARING',
            httpStatus: 409,
        });
        expect(LLMService.create).not.toHaveBeenCalled();
    });

    test('changing the stored key updatedAt busts the cache', async () => {
        const reg = new LlmRegistry();
        const llmApiKey = buildKeySubdocument('sk-test-secret-key', 'admin');
        const db = memoryDb({ courses: [{ courseId: 'C1', llmApiKey }] });

        await reg.forCourse(db, 'C1');
        await reg.forCourse(db, 'C1');
        expect(LLMService.create).toHaveBeenCalledTimes(1); // cache hit

        await db.collection('courses').updateOne(
            { courseId: 'C1' },
            { $set: { 'llmApiKey.updatedAt': new Date(Date.now() + 60000) } }
        );
        await reg.forCourse(db, 'C1');
        expect(LLMService.create).toHaveBeenCalledTimes(2); // key rotated -> rebuild
    });
});

describe('LlmRegistry notes / super-course-chat scopes', () => {
    beforeEach(() => {
        process.env.LLM_PROVIDER = 'ollama';
    });

    test('forNotes caches and rebuilds after evictNotes', async () => {
        const reg = new LlmRegistry();
        const db = memoryDb({ settings: [] });

        await reg.forNotes(db);
        await reg.forNotes(db);
        expect(LLMService.create).toHaveBeenCalledTimes(1);

        reg.evictNotes();
        await reg.forNotes(db);
        expect(LLMService.create).toHaveBeenCalledTimes(2);
    });

    test('forSuperCourseChat caches and rebuilds after evictSuperCourseChat', async () => {
        const reg = new LlmRegistry();
        const db = memoryDb({ settings: [] });

        const first = await reg.forSuperCourseChat(db);
        expect(first.scope).toEqual({ type: 'superCourseChat', id: 'superCourseChat', provider: 'ollama' });
        await reg.forSuperCourseChat(db);
        expect(LLMService.create).toHaveBeenCalledTimes(1);

        reg.evictSuperCourseChat();
        await reg.forSuperCourseChat(db);
        expect(LLMService.create).toHaveBeenCalledTimes(2);
    });

    test('evictSuperchat invalidates just that bucket', async () => {
        const reg = new LlmRegistry();
        const db = memoryDb({ superchats: [{ superchatId: 'S1' }] });

        await reg.forSuperchat(db, 'S1');
        reg.evictSuperchat('S1');
        await reg.forSuperchat(db, 'S1');
        expect(LLMService.create).toHaveBeenCalledTimes(2);
    });
});

describe('LlmRegistry provider bypass', () => {
    test('ollama bypasses key enforcement even when scoped keys are otherwise required', async () => {
        // Stub on -> scopedKeysRequired() true; ollama provider -> isOllamaProvider()
        // true, so _resolve still takes the non-enforcing branch.
        process.env.BIOCBOT_TEST_LLM_STUB = '1';
        process.env.LLM_PROVIDER = 'ollama';

        const reg = new LlmRegistry();
        const db = memoryDb({ courses: [{ courseId: 'C1', llmApiKey: { status: 'invalid' } }] });

        const services = await reg.forCourse(db, 'C1'); // would throw if enforced
        expect(services.scope).toEqual({ type: 'course', id: 'C1', provider: 'ollama' });
        expect(LLMService.create).toHaveBeenCalledTimes(1);
    });
});

describe('onProviderKeyFailure callback', () => {
    test('marks the owner key status in Mongo and evicts the cached scope', async () => {
        process.env.LLM_PROVIDER = 'ollama';
        const reg = new LlmRegistry();
        const db = memoryDb({ courses: [{ courseId: 'C1', llmApiKey: { status: 'valid' } }] });

        await reg.forCourse(db, 'C1');
        const { onProviderKeyFailure } = LLMService.create.mock.calls.at(-1)[0];
        await onProviderKeyFailure('invalid');

        // The stored key status flips, and the next lookup rebuilds the services.
        const stored = await db.collection('courses').findOne({ courseId: 'C1' });
        expect(stored.llmApiKey.status).toBe('invalid');
        await reg.forCourse(db, 'C1');
        expect(LLMService.create).toHaveBeenCalledTimes(2);
    });
});
