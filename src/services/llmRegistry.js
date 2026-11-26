const LLMService = require('./llm');
const QdrantService = require('./qdrantService');
const config = require('./config');
const adminModelSettings = require('./adminModelSettings');
const scopeModelSettings = require('./scopeModelSettings');
const { DEFAULT_PROFILE_REVISION, buildEmbeddingProfile } = require('./embeddingConfig');
const { normalizeProvider } = require('./llmProviders');
const { configuredDefaultModel, defaultEmbeddingModelForProvider } = require('./llmModels');
const { LANES } = require('./llmLanes');
const {
    KEY_STATUSES,
    LlmKeyError,
    LlmPreparationError,
    decryptApiKey,
    isOllamaProvider,
    publicKeySummary,
    readProviderState,
    scopedKeysRequired,
    updateOwnerKeyStatus
} = require('./llmKeyStore');

const CACHE_TTL_MS = 10 * 60 * 1000;

function cacheKey(scope) {
    return `${scope.type}:${scope.id || 'global'}`;
}

/**
 * Cache identity for a resolved scope. It must change whenever anything that
 * would produce different behaviour changes: the selected provider, the models
 * that provider is configured with, or the credential itself.
 */
function resolutionSignature({
    provider,
    chatModel,
    reasoningEffort,
    backendChatModel,
    backendReasoningEffort,
    embeddingModel,
    embeddingRevision,
    keyUpdatedAt
}) {
    return [
        provider,
        chatModel,
        reasoningEffort,
        backendChatModel,
        backendReasoningEffort,
        embeddingModel,
        embeddingRevision,
        keyUpdatedAt
    ].join('|');
}

/**
 * Resolves the AI services for a scope (course, Super Course bucket, notes,
 * instructor Super Course chat).
 *
 * There is no server-wide provider any more: every scope carries its own
 * `activeLlmProvider` plus its own encrypted per-provider credentials, and the
 * models come from the admin settings for THAT provider. A course on GPT and a
 * bucket on Sandbox resolve completely independently.
 */
class LlmRegistry {
    constructor() {
        this.cache = new Map();
    }

    evict(scope) {
        this.cache.delete(cacheKey(scope));
    }

    evictCourse(courseId) {
        this.evict({ type: 'course', id: courseId });
    }

    evictSuperchat(superchatId) {
        this.evict({ type: 'superchat', id: superchatId });
    }

    evictNotes() {
        this.evict({ type: 'notes', id: 'notesLlm' });
    }

    evictSuperCourseChat() {
        this.evict({ type: 'superCourseChat', id: 'superCourseChat' });
    }

    clear() {
        this.cache.clear();
        // Admin model settings are cached separately; a global clear is also
        // how routes signal "the model configuration just changed".
        adminModelSettings.invalidateCache();
    }

    async forCourse(db, courseId) {
        // Only a non-empty string names a course.
        if (typeof courseId !== 'string' || !courseId) {
            throw new LlmKeyError(KEY_STATUSES.MISSING, { type: 'course', id: null });
        }
        const course = await db.collection('courses').findOne(
            { courseId },
            { projection: { llmApiKey: 1, llmCredentials: 1, activeLlmProvider: 1, pendingLlmProvider: 1, providerMigrationId: 1, aiPreparationRequired: 1, llmModelSettings: 1 } }
        );
        return this._resolve(db, { type: 'course', id: courseId }, course);
    }

    async forSuperchat(db, superchatId) {
        if (!superchatId) throw new LlmKeyError(KEY_STATUSES.MISSING, { type: 'superchat', id: superchatId });
        const superchat = await db.collection('superchats').findOne(
            { superchatId, isDeleted: { $ne: true } },
            { projection: { llmApiKey: 1, llmCredentials: 1, activeLlmProvider: 1, pendingLlmProvider: 1, providerMigrationId: 1, aiPreparationRequired: 1, llmModelSettings: 1 } }
        );
        return this._resolve(db, { type: 'superchat', id: superchatId }, superchat);
    }

    async forNotes(db) {
        const settings = await db.collection('settings').findOne(
            { _id: 'notesLlm' },
            { projection: { llmApiKey: 1, llmCredentials: 1, activeLlmProvider: 1, pendingLlmProvider: 1, providerMigrationId: 1, aiPreparationRequired: 1, llmModelSettings: 1 } }
        );
        return this._resolve(db, { type: 'notes', id: 'notesLlm' }, settings);
    }

    /**
     * Resolve the dedicated key for the global instructor Super Course chat.
     * This is its OWN key and its OWN provider (stored on the superCourseChat
     * settings doc), not tied to any student-facing bucket or member course —
     * so a Sandbox instructor chat can pool courses that themselves run on GPT.
     */
    async forSuperCourseChat(db) {
        const settings = await db.collection('settings').findOne(
            { _id: 'superCourseChat' },
            { projection: { llmApiKey: 1, llmCredentials: 1, activeLlmProvider: 1, pendingLlmProvider: 1, providerMigrationId: 1, aiPreparationRequired: 1, llmModelSettings: 1 } }
        );
        return this._resolve(db, { type: 'superCourseChat', id: 'superCourseChat' }, settings);
    }

    /**
     * The embedding profile a scope retrieves with, without building any
     * clients. Used to decide which Qdrant collection a surface must search and
     * which indexes member courses need before a bucket can be activated.
     */
    async embeddingProfileForScope(db, scope, doc) {
        const provider = this._providerFor(doc);
        const settings = await this._modelSettingsFor(db, provider, scope);
        this._assertConfigured(provider, settings);
        return buildEmbeddingProfile({
            provider,
            embeddingModel: settings.embeddingModel,
            revision: settings.embeddingRevision,
            vectorSize: settings.vectorSize || undefined,
            endpoint: this._endpointFor(provider)
        });
    }

    _assertConfigured(provider, settings) {
        if (provider === 'ollama') return;
        if (settings?.configured && settings?.configurationStatus !== scopeModelSettings.NEEDS_ADMIN) return;
        const missing = [];
        if (!settings?.chatModel) missing.push('front-end chat model');
        if (!settings?.lanes?.[LANES.BACKEND]?.chatModel) missing.push('back-end chat model');
        if (!settings?.embeddingModel || !settings?.vectorSize) missing.push('embedding model');
        if (missing.length === 0) return;

        const error = new Error(
            `${provider} is not configured for this AI surface. A system admin must select and save ${missing.join(', ') || 'compatible models'}.`
        );
        error.code = 'LLM_CONFIGURATION_REQUIRED';
        error.httpStatus = 409;
        error.httpStatus = 409;
        throw error;
    }

    _providerFor(doc) {
        if (isOllamaProvider() && process.env.BIOCBOT_TEST_LLM_STUB !== '1') {
            return 'ollama';
        }
        return readProviderState(doc).activeProvider;
    }

    _endpointFor(provider) {
        try {
            return config.getProviderInfra(provider).endpoint;
        } catch (_) {
            return null;
        }
    }

    async _resolve(db, scope, doc) {
        if (!scopedKeysRequired() || isOllamaProvider()) {
            return this._getOrCreate(db, scope, doc, null, 'ollama');
        }

        const state = readProviderState(doc);
        const provider = state.activeProvider;
        const credential = state.credentials[provider];
        const summary = publicKeySummary(credential);

        if (state.preparationRequired) {
            throw new LlmPreparationError({ ...scope, provider }, provider);
        }

        if (summary.status !== KEY_STATUSES.VALID || !credential || !credential.ciphertext) {
            throw new LlmKeyError(summary.status || KEY_STATUSES.MISSING, { ...scope, provider }, provider);
        }

        return this._getOrCreate(db, scope, doc, credential, provider);
    }

    /**
     * Model settings for a provider. Ollama is a local dev runtime with no
     * admin-managed platform settings, so it reads its models from env.
     */
    async _modelSettingsFor(db, provider, scope) {
        if (provider === 'ollama') {
            return {
                chatModel: configuredDefaultModel('ollama'),
                embeddingModel: defaultEmbeddingModelForProvider('ollama'),
                embeddingRevision: DEFAULT_PROFILE_REVISION,
                reasoningEffort: 'minimal'
            };
        }
        try {
            return await scopeModelSettings.getProviderSettings(db, scope, provider);
        } catch (error) {
            if (!String(error.message || '').startsWith('AI scope not found:')) throw error;
            // A caller may be resolving an owner document that has not yet been
            // persisted (notably creation previews). Use the copy-on-create
            // template for that transient resolution only.
            return adminModelSettings.getProviderSettings(db, provider);
        }
    }

    async _getOrCreate(db, scope, doc, credential, provider) {
        const normalizedProvider = provider === 'ollama' ? 'ollama' : normalizeProvider(provider);
        const modelSettings = await this._modelSettingsFor(db, normalizedProvider, scope);
        this._assertConfigured(normalizedProvider, modelSettings);
        const keyUpdatedAt = credential && credential.updatedAt
            ? new Date(credential.updatedAt).getTime()
            : 0;

        const signature = resolutionSignature({
            provider: normalizedProvider,
            chatModel: modelSettings.chatModel,
            reasoningEffort: modelSettings.reasoningEffort,
            backendChatModel: modelSettings.lanes?.[LANES.BACKEND]?.chatModel || modelSettings.chatModel,
            backendReasoningEffort: modelSettings.lanes?.[LANES.BACKEND]?.reasoningEffort || modelSettings.reasoningEffort,
            embeddingModel: modelSettings.embeddingModel,
            embeddingRevision: modelSettings.embeddingRevision,
            keyUpdatedAt
        });

        const key = cacheKey(scope);
        const cached = this.cache.get(key);
        if (
            cached &&
            Date.now() - cached.createdAt < CACHE_TTL_MS &&
            cached.signature === signature
        ) {
            return cached.services;
        }

        const apiKey = credential && credential.ciphertext
            ? decryptApiKey(credential.ciphertext)
            : null;
        const endpoint = this._endpointFor(normalizedProvider);

        // Runtime config assembled from: the scope's provider, the scope's
        // decrypted key, the admin model settings for that provider, and the
        // infrastructure endpoint.
        const llmConfig = {
            provider: normalizedProvider,
            defaultModel: modelSettings.chatModel,
            ...(endpoint ? { endpoint } : {}),
            ...(apiKey ? { apiKey } : {})
        };

        if (!apiKey && normalizedProvider === 'ollama') {
            // Local dev runtime: fall back to the env-configured LLM settings.
            try {
                Object.assign(llmConfig, config.getLLMConfig());
            } catch (_) {
                // Keep the scope-derived config if env validation fails.
            }
        }

        const scopeWithProvider = { ...scope, provider: normalizedProvider };
        const onProviderKeyFailure = async (status) => {
            await updateOwnerKeyStatus(db, scopeWithProvider, status, normalizedProvider);
            this.evict(scope);
        };

        const llm = await LLMService.create({
            llmConfig,
            scope: scopeWithProvider,
            onProviderKeyFailure
        });
        if (typeof llm.setDbAccessor === 'function') {
            llm.setDbAccessor(() => db);
        }

        const embeddingProfile = buildEmbeddingProfile({
            provider: normalizedProvider,
            embeddingModel: modelSettings.embeddingModel,
            revision: modelSettings.embeddingRevision,
            vectorSize: modelSettings.vectorSize || undefined,
            endpoint,
            apiKey
        });

        const qdrant = new QdrantService({
            llmConfig,
            embeddingProfile,
            onProviderKeyFailure
        });
        await qdrant.initialize();

        const services = {
            llm,
            qdrant,
            embeddings: qdrant.embeddings,
            scope: scopeWithProvider,
            provider: normalizedProvider,
            embeddingProfile,
            modelSettings
        };
        this.cache.set(key, {
            services,
            createdAt: Date.now(),
            signature
        });
        return services;
    }
}

module.exports = LlmRegistry;
