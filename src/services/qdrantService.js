/**
 * Qdrant Service
 * Handles vector database operations for document embeddings and semantic search
 */

const { QdrantClient } = require('@qdrant/js-client-rest');
const { EmbeddingsModule } = require('ubc-genai-toolkit-embeddings');
const { ChunkingModule } = require('ubc-genai-toolkit-chunking');
const { ConsoleLogger } = require('ubc-genai-toolkit-core');
const { randomUUID } = require('crypto');
const config = require('./config');
const { LlmKeyError, mapProviderErrorToStatus } = require('./llmKeyStore');
const { buildEmbeddingProfile } = require('./embeddingConfig');
const {
    configuredProvider,
    defaultEmbeddingModelForProvider
} = require('./llmModels');

console.log('✅ Successfully imported embeddings library:', typeof EmbeddingsModule);

// A provider that accepts the connection and then never answers would otherwise
// hang a migration forever on its first item, with no failed item to retry and
// no error to show. Bound every embedding call so a stall becomes a normal
// item failure instead.
const EMBEDDING_TIMEOUT_MS = Math.max(
    5000,
    Number(process.env.EMBEDDING_TIMEOUT_MS) || 30_000
);

/**
 * Last-resort embedding profile for callers that predate profile plumbing —
 * Qdrant maintenance operations (skipEmbeddings) and local dev runtimes.
 * Every request-serving path supplies an explicit profile instead.
 */
function envFallbackProfile() {
    const provider = configuredProvider();
    const embeddingModel = process.env.LLM_EMBEDDING_MODEL
        || defaultEmbeddingModelForProvider(provider);

    let endpoint = null;
    let apiKey;
    try {
        const infra = config.getProviderInfra(provider);
        endpoint = infra.endpoint;
        apiKey = infra.bootstrapApiKey;
    } catch (_) {
        // Unknown provider: leave infrastructure unset; embeddings init will
        // surface the real error if this profile is ever used for work.
    }

    return buildEmbeddingProfile({ provider, embeddingModel, endpoint, apiKey: apiKey || null });
}

/**
 * Reject a hung embedding call instead of waiting on it forever. The provider
 * request itself keeps running; only this caller stops waiting, which is enough
 * to turn a stalled migration item into a retryable failure.
 */
async function withEmbeddingDeadline(promise, embeddingModel) {
    let timer = null;
    try {
        return await Promise.race([
            promise,
            new Promise((_, reject) => {
                timer = setTimeout(() => {
                    const error = new Error(
                        `Embedding request for ${embeddingModel} timed out after `
                        + `${Math.round(EMBEDDING_TIMEOUT_MS / 1000)}s`
                    );
                    error.code = 'EMBEDDING_TIMEOUT';
                    reject(error);
                }, EMBEDDING_TIMEOUT_MS);
            })
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

class QdrantService {
    /**
     * @param {Object} options
     * @param {Object} [options.embeddingProfile] - Explicit embedding profile
     *   (provider, endpoint, embedding model, vector size, revision, collection,
     *   scoped API key). Required for anything that reads or writes vectors on
     *   behalf of a specific surface.
     */
    constructor(options = {}) {
        this.client = null;
        this.embeddings = options.embeddings || null;
        this.chunker = null;
        this.llmConfigOverride = options.llmConfig || null;
        this.skipEmbeddings = options.skipEmbeddings === true;
        // The probe in initialize() is diagnostic only — the profile, not the
        // provider, decides the vector size. A migration skips it so the job's
        // first real item is also its first provider call.
        this.skipEmbeddingProbe = options.skipEmbeddingProbe === true;
        this.shouldCancel = typeof options.shouldCancel === 'function'
            ? options.shouldCancel
            : null;
        this.onProviderKeyFailure = typeof options.onProviderKeyFailure === 'function'
            ? options.onProviderKeyFailure
            : null;
        // Maintenance clients (deletion sweeps across historical profiles) must
        // not conjure empty collections for profiles that were never used.
        this.createCollectionIfMissing = options.createCollectionIfMissing !== false;

        // The profile decides the collection AND the dimensionality. Vectors
        // from different embedding models never share a collection, even when
        // their dimensionality happens to match.
        this.embeddingProfile = options.embeddingProfile || (this.skipEmbeddings
            // Maintenance-only clients never generate vectors. Give them the
            // historical collection profile without inventing a proxy model.
            ? buildEmbeddingProfile({ provider: 'openai', embeddingModel: 'text-embedding-3-small' })
            : envFallbackProfile());
        this.provider = this.embeddingProfile.provider;
        this.embeddingModel = this.embeddingProfile.embeddingModel;
        this.collectionName = this.embeddingProfile.collection;
        this.vectorSize = this.embeddingProfile.vectorSize;
    }

    /** Stop a long embedding loop before it can write more migration data. */
    async assertNotCancelled() {
        if (this.shouldCancel && await this.shouldCancel()) {
            const error = new Error('Migration cancelled');
            error.code = 'MIGRATION_CANCELLED';
            throw error;
        }
    }

    /**
     * Initialize Qdrant client and embeddings service
     */
    async initialize() {
        try {
            console.log('🔧 Initializing Qdrant service...');
            console.log('Environment variables for Qdrant:', {
                QDRANT_URL: process.env.QDRANT_URL,
                QDRANT_API_KEY: process.env.QDRANT_API_KEY ? 'SET' : 'NOT SET'
            });
            
            // Initialize Qdrant client using centralized configuration
            let vectorDBConfig;
            try {
                vectorDBConfig = config.getVectorDBConfig();
                console.log('Vector DB config:', vectorDBConfig);
            } catch (configError) {
                console.error('❌ Failed to get vector DB config:', configError);
                throw new Error(`Vector DB configuration error: ${configError.message}`);
            }
            
            const qdrantUrl = process.env.QDRANT_URL || `http://${vectorDBConfig.host}:${vectorDBConfig.port}`;
            const qdrantApiKey = process.env.QDRANT_API_KEY || 'super-secret-dev-key';
            
            console.log('Qdrant connection details:', {
                url: qdrantUrl,
                apiKey: qdrantApiKey ? 'SET' : 'NOT SET'
            });
            
            this.client = new QdrantClient({
                url: qdrantUrl,
                apiKey: qdrantApiKey
            });

            // Test Qdrant connection
            console.log('Testing Qdrant connection...');
            await this.client.getCollections();
            console.log('✅ Successfully connected to Qdrant');

            // Initialize embeddings service using centralized configuration
            console.log('Initializing embeddings service...');
            
            // Use the centralized LLM configuration from config service
            let llmConfig;
            if (!this.skipEmbeddings) {
                try {
                    // The embedding profile is authoritative: it names the
                    // provider, endpoint, model and scoped key to embed with.
                    // getLLMConfig() is only consulted for legacy/dev callers
                    // that supplied no profile-derived key.
                    llmConfig = this.llmConfigOverride || config.getLLMConfig();
                    console.log('LLM config retrieved:', {
                        provider: llmConfig.provider,
                        endpoint: llmConfig.endpoint || llmConfig.apiKey ? 'SET' : 'NOT SET',
                        model: llmConfig.defaultModel
                    });
                } catch (configError) {
                    console.error('❌ Failed to get LLM config:', configError);
                    throw new Error(`LLM configuration error: ${configError.message}`);
                }

                const logger = new ConsoleLogger('biocbot-qdrant');
                const profile = this.embeddingProfile;

                // A profile's endpoint is authoritative. In particular, an
                // OpenAI profile normally has no custom endpoint; retaining the
                // server-wide Sandbox endpoint would send the instructor's
                // OpenAI key to LiteLLM and make provider migrations fail with
                // a misleading 401.
                const profileBaseConfig = { ...llmConfig };
                delete profileBaseConfig.endpoint;

                // Add embedding-specific configuration
                const embeddingConfig = {
                    providerType: 'ubc-genai-toolkit-llm',
                    logger: logger,
                    llmConfig: {
                        ...profileBaseConfig,
                        provider: profile.provider,
                        ...(profile.endpoint ? { endpoint: profile.endpoint } : {}),
                        ...(profile.apiKey ? { apiKey: profile.apiKey } : {}),
                        embeddingModel: profile.embeddingModel,
                        // // Drop unsupported parameters when talking to Ollama
                        litellm: {
                            drop_params: true
                        }
                    }
                };

                console.log('Embedding config:', {
                    providerType: embeddingConfig.providerType,
                    embeddingModel: embeddingConfig.llmConfig.embeddingModel,
                    llmProvider: embeddingConfig.llmConfig.provider,
                    profile: profile.key,
                    collection: this.collectionName
                });

                try {
                    if (this.embeddings) {
                        console.log('✅ Using provided embeddings service');
                    } else if (process.env.BIOCBOT_TEST_LLM_STUB === '1') {
                        const { EmbeddingsStub } = require('./embeddingsStub');
                        this.embeddings = new EmbeddingsStub({ vectorSize: profile.vectorSize });
                        console.log(`🧪 Embeddings stub active (BIOCBOT_TEST_LLM_STUB=1) — no provider traffic (${profile.vectorSize}d)`);
                    } else {
                        this.embeddings = await EmbeddingsModule.create(embeddingConfig);
                        console.log('✅ Successfully initialized embeddings service');
                    }
                } catch (embeddingError) {
                    console.error('❌ Failed to initialize embeddings service:', embeddingError);
                    throw new Error(`Embeddings initialization error: ${embeddingError.message}`);
                }
            } else {
                console.log('ℹ️ Skipping embeddings initialization for Qdrant maintenance operation');
            }

            // Initialize chunking service using centralized configuration
            console.log('Initializing chunking service...');
            if (!this.skipEmbeddings) {
                const chunkLogger = new ConsoleLogger('biocbot-chunking');

                // Use centralized configuration for chunking parameters
                const chunkingConfig = {
                    strategy: process.env.CHUNK_STRATEGY || 'recursiveCharacter',
                    defaultOptions: {
                        chunkSize: Number(process.env.CHUNK_SIZE) || 1000,
                        chunkOverlap: Number(process.env.CHUNK_OVERLAP) || 200,
                        minChunkSize: Number(process.env.CHUNK_MIN) || 100
                    },
                    logger: chunkLogger
                };

                this.chunker = new ChunkingModule(chunkingConfig);
                console.log(`✅ Successfully initialized chunking service (strategy=${this.chunker.getDefaultStrategyName()})`);
            }

            // Vector size comes from the embedding profile, which is also what
            // named the collection — the two can never drift apart.
            console.log(
                `🔍 Embedding profile ${this.embeddingProfile.key} -> collection ${this.collectionName} `
                + `(${this.vectorSize} dimensions)`
            );
            
            console.log(`✅ Successfully initialized embeddings service (vector size: ${this.vectorSize} dimensions)`);
            
            // Test embeddings service to verify it's working (but don't rely on it for vector size)
            if (!this.skipEmbeddings && !this.skipEmbeddingProbe) {
                console.log('Testing embeddings service...');
                try {
                    const testEmbedding = await this.embed('test');
                console.log(`🔍 Test embedding result:`, {
                    isArray: Array.isArray(testEmbedding),
                    length: testEmbedding ? testEmbedding.length : 'undefined',
                    type: typeof testEmbedding,
                    firstFew: testEmbedding ? testEmbedding.slice(0, 5) : 'undefined'
                });
                
                if (testEmbedding && Array.isArray(testEmbedding) && testEmbedding.length > 0) {
                    // Check if the embedding is nested (UBC GenAI Toolkit sometimes returns [[...]] instead of [...])
                    let actualEmbedding = testEmbedding;
                    if (testEmbedding.length === 1 && Array.isArray(testEmbedding[0])) {
                        console.log(`🔧 Detected nested array format, flattening...`);
                        actualEmbedding = testEmbedding[0];
                    }
                    
                    if (actualEmbedding.length === 1 && actualEmbedding[0] === 1) {
                        console.warn(`⚠️ Embeddings service returned fallback value [1] - this indicates an error in embedding generation`);
                        console.warn(`⚠️ The actual embedding generation may be failing silently`);
                    } else if (actualEmbedding.length === this.vectorSize) {
                        console.log(`✅ Embeddings service test successful (${actualEmbedding.length} dimensions)`);
                    } else {
                        // The profile named the collection AND its dimensionality.
                        // Adopting the provider-reported size here would create a
                        // mis-sized collection for this model, so keep the profile
                        // authoritative and surface the mismatch instead.
                        console.warn(
                            `⚠️ Embeddings service returned ${actualEmbedding.length} dimensions but embedding profile `
                            + `${this.embeddingProfile.key} expects ${this.vectorSize}; keeping the profile size`
                        );
                    }
                } else {
                    console.warn(`⚠️ Embeddings service test returned unexpected result, but continuing with model-based vector size`);
                }
                
                } catch (embeddingTestError) {
                    console.warn(`⚠️ Embeddings service test failed:`, embeddingTestError.message);
                    console.log(`🔧 Continuing with model-based vector size: ${this.vectorSize}`);
                }
            }

            // Ensure collection exists
            await this.ensureCollectionExists();

        } catch (error) {
            console.error('❌ Failed to initialize Qdrant service:', error);
            console.error('Error details:', {
                message: error.message,
                stack: error.stack,
                name: error.name
            });
            throw error;
        }
    }

    /**
     * Ensure the documents collection exists in Qdrant with correct vector dimensions
     */
    async ensureCollectionExists() {
        try {
            const collections = await this.client.getCollections();
            const collectionExists = collections.collections.some(
                col => col.name === this.collectionName
            );

            if (!collectionExists && !this.createCollectionIfMissing) {
                console.log(`ℹ️ Collection ${this.collectionName} does not exist; skipping creation (maintenance mode)`);
                this.collectionMissing = true;
                return;
            }

            if (!collectionExists) {
                console.log(`Creating collection: ${this.collectionName}`);

                await this.client.createCollection(this.collectionName, {
                    vectors: {
                        size: this.vectorSize,
                        distance: 'Cosine'
                    }
                });

                console.log(`✅ Collection ${this.collectionName} created successfully`);
            } else {
                // Check if existing collection has correct vector dimensions
                const collectionInfo = await this.client.getCollection(this.collectionName);
                const existingVectorSize = collectionInfo.config.params.vectors.size;
                
                console.log(`🔍 Collection validation: existing=${existingVectorSize}, required=${this.vectorSize}`);
                
                if (existingVectorSize !== this.vectorSize) {
                    throw new Error(
                        `Qdrant collection ${this.collectionName} has ${existingVectorSize}-dimension vectors, ` +
                        `but embedding profile ${this.embeddingProfile.key} returns ${this.vectorSize}. ` +
                        'Bump the profile revision so a new collection is created; BioCBot never deletes existing vectors.'
                    );
                } else {
                    console.log(`✅ Collection ${this.collectionName} already exists with correct dimensions`);
                }
            }
        } catch (error) {
            console.error('❌ Error ensuring collection exists:', error);
            throw error;
        }
    }

    /**
     * Process and store a document in Qdrant
     * @param {Object} documentData - Document information
     * @param {string} documentData.courseId - Course ID
     * @param {string} documentData.lectureName - Lecture/Unit name
     * @param {string} documentData.documentId - Document ID
     * @param {string} documentData.content - Document text content
     * @param {string} documentData.fileName - Original filename
     * @param {string} documentData.mimeType - File MIME type
     * @param {string} documentData.documentType - Document type for source attribution
     * @param {string} documentData.type - Specific document type
     * @returns {Promise<Object>} Result of document processing
     */
    async processAndStoreDocument(documentData) {
        try {
            console.log(`Processing document: ${documentData.fileName} for ${documentData.lectureName}`);
            console.log(`Document content length: ${documentData.content ? documentData.content.length : 'undefined'} characters`);
            
            // Validate input
            if (!documentData.content || typeof documentData.content !== 'string') {
                throw new Error('Invalid document content: content must be a non-empty string');
            }
            
            if (documentData.content.trim().length === 0) {
                throw new Error('Document content is empty or contains only whitespace');
            }

            // Sanitize content - remove any non-printable characters that might cause issues
            let sanitizedContent = documentData.content
                .replace(/[\x00-\x1F\x7F-\x9F]/g, '') // Remove control characters
                .replace(/\r\n/g, '\n') // Normalize line endings
                .replace(/\r/g, '\n'); // Convert remaining carriage returns
            
            // Check if content looks reasonable
            if (sanitizedContent.length < 10) {
                throw new Error('Document content is too short to process meaningfully');
            }
            
            // Check for suspicious patterns (like repeated characters)
            const suspiciousPattern = /(.)\1{10,}/; // Same character repeated 10+ times
            if (suspiciousPattern.test(sanitizedContent)) {
                console.warn('⚠️ Document content contains suspicious patterns (repeated characters)');
                // Clean up the suspicious patterns
                sanitizedContent = sanitizedContent.replace(/(.)\1{10,}/g, '$1$1$1');
            }
            
            console.log(`Sanitized content length: ${sanitizedContent.length} characters`);
            console.log(`Content preview: "${sanitizedContent.substring(0, 100)}..."`);

            // Chunk the document content using toolkit chunker
            if (!this.chunker) {
                throw new Error('Chunking service is not initialized');
            }

            const documents = [{
                content: sanitizedContent,
                metadata: { sourceId: documentData.documentId }
            }];

            const chunkResp = await this.chunker.chunkDocuments(documents, {});
            const sortedChunks = [...chunkResp.chunks].sort(
                (a, b) => a.metadata.chunkNumber - b.metadata.chunkNumber
            );
            const chunks = sortedChunks.map(c => c.text);
            const strategyUsed = chunkResp.strategy || this.chunker.getDefaultStrategyName();

            console.log(`Created ${chunks.length} chunks from document (strategy=${strategyUsed})`);
            
            if (chunks.length === 0) {
                throw new Error('No chunks were created from the document content');
            }

            // Generate embeddings for each chunk
            const embeddings = await this.generateEmbeddings(chunks);
            console.log(`Generated embeddings for ${embeddings.length} chunks`);
            
            if (embeddings.length === 0) {
                throw new Error('No embeddings were generated for the document chunks');
            }

            // Store chunks and embeddings in Qdrant
            await this.assertNotCancelled();
            const storedChunks = await this.storeChunks(documentData, chunks, embeddings, strategyUsed);
            console.log(`Stored ${storedChunks.length} chunks in Qdrant`);

            return {
                success: true,
                chunksProcessed: chunks.length,
                chunksStored: storedChunks.length,
                message: `Document processed and ${storedChunks.length} chunks stored successfully`
            };

        } catch (error) {
            console.error('❌ Error processing document:', error);
            console.error('Document data:', {
                fileName: documentData.fileName,
                lectureName: documentData.lectureName,
                contentLength: documentData.content ? documentData.content.length : 'undefined',
                contentPreview: documentData.content ? documentData.content.substring(0, 100) + '...' : 'undefined'
            });
            return {
                success: false,
                error: error.message
            };
        }
    }

    

    /**
     * Generate embeddings for text chunks
     * @param {Array<string>} chunks - Array of text chunks
     * @returns {Promise<Array<Array<number>>>} Array of embedding vectors
     */
    async generateEmbeddings(chunks) {
        try {
            if (!chunks || !Array.isArray(chunks) || chunks.length === 0) {
                throw new Error('Invalid chunks array provided to generateEmbeddings');
            }
            
            console.log(`Generating embeddings for ${chunks.length} chunks...`);
            const embeddings = [];
            
            for (let i = 0; i < chunks.length; i++) {
                await this.assertNotCancelled();
                const chunk = chunks[i];
                console.log(`Processing chunk ${i + 1}/${chunks.length}: "${chunk.substring(0, 50)}..."`);
                
                if (!chunk || typeof chunk !== 'string' || chunk.trim().length === 0) {
                    console.warn(`Skipping empty chunk ${i + 1}`);
                    continue;
                }
                
                try {
                    const embedding = await this.embed(chunk);
                    
                    if (!embedding || !Array.isArray(embedding) || embedding.length === 0) {
                        throw new Error(`Invalid embedding returned for chunk ${i + 1}: ${typeof embedding}`);
                    }
                    
                    // The embed method returns an array, we want the first (and only) embedding
                    const embeddingVector = embedding[0];
                    if (!Array.isArray(embeddingVector)) {
                        throw new Error(`Embedding vector is not an array for chunk ${i + 1}: ${typeof embeddingVector}`);
                    }
                    
                    if (embeddingVector.length !== this.vectorSize) {
                        console.warn(`Warning: Chunk ${i + 1} embedding size (${embeddingVector.length}) doesn't match expected size (${this.vectorSize})`);
                    }
                    
                    embeddings.push(embeddingVector);
                    console.log(`✅ Generated embedding for chunk ${i + 1}: ${embeddingVector.length} dimensions`);
                    
                } catch (chunkError) {
                    console.error(`❌ Error generating embedding for chunk ${i + 1}:`, chunkError);
                    throw new Error(`Failed to generate embedding for chunk ${i + 1}: ${chunkError.message}`);
                }
            }
            
            console.log(`Successfully generated ${embeddings.length} embeddings`);
            return embeddings;
            
        } catch (error) {
            console.error('❌ Error generating embeddings:', error);
            throw error;
        }
    }

    /**
     * Store document chunks and embeddings in Qdrant
     * @param {Object} documentData - Document metadata
     * @param {Array<string>} chunks - Text chunks
     * @param {Array<Array<number>>} embeddings - Embedding vectors
     * @param {string} strategyUsed - Chunking strategy identifier
     * @returns {Promise<Array<Object>>} Array of stored chunk IDs
     */
    async storeChunks(documentData, chunks, embeddings, strategyUsed = 'toolkit') {
        try {
            // Ensure collection exists before storing chunks
            await this.ensureCollectionExists();
            
            const points = [];
            const storedChunks = [];

            for (let i = 0; i < chunks.length; i++) {
                const chunkId = randomUUID();
                const chunkMetadata = Array.isArray(documentData.chunkMetadata) && documentData.chunkMetadata[i]
                    ? documentData.chunkMetadata[i]
                    : {};
                
                const point = {
                    id: chunkId,
                    vector: embeddings[i],
                    payload: {
                        ...chunkMetadata,
                        courseId: documentData.courseId,
                        lectureName: documentData.lectureName,
                        documentId: documentData.documentId,
                        fileName: documentData.fileName,
                        mimeType: documentData.mimeType,
                        documentType: documentData.documentType || 'unknown',
                        type: documentData.type || 'unknown',
                        chunkIndex: i,
                        totalChunks: chunks.length,
                        chunkText: chunks[i],
                        chunkLength: chunks[i].length,
                        strategyUsed: strategyUsed,
                        timestamp: new Date().toISOString()
                    }
                };

                points.push(point);
                storedChunks.push({ 
                    id: chunkId, 
                    chunkIndex: i,
                    documentId: documentData.documentId,
                    chunkText: chunks[i].substring(0, 50) + '...' // First 50 chars for reference
                });
            }

            // Upsert points to Qdrant
            await this.client.upsert(this.collectionName, {
                points: points
            });

            return storedChunks;

        } catch (error) {
            console.error('❌ Error storing chunks in Qdrant:', error);
            throw error;
        }
    }

    /**
     * Embed a query string and normalize the result to a flat number[] vector.
     * Shared by searchDocuments and the multi-course search so a single query is
     * only embedded once even when fanned out across several course filters.
     * @param {string} query - Search query text
     * @returns {Promise<number[]>} Normalized query embedding
     */
    async generateQueryVector(query) {
        const rawEmbedding = await this.embed(query);
        let queryVector = rawEmbedding;
        if (Array.isArray(rawEmbedding)) {
            // If provider returns a batch ([[...]]), unwrap the first vector
            if (rawEmbedding.length > 0 && Array.isArray(rawEmbedding[0])) {
                if (rawEmbedding.length !== 1) {
                    console.warn(`Embed returned ${rawEmbedding.length} vectors for a single query; using the first`);
                }
                queryVector = rawEmbedding[0];
            }
        } else if (rawEmbedding && typeof rawEmbedding === 'object') {
            // Handle possible object wrappers
            if (Array.isArray(rawEmbedding.embedding)) {
                queryVector = rawEmbedding.embedding;
            } else if (Array.isArray(rawEmbedding.data) && Array.isArray(rawEmbedding.data[0])) {
                queryVector = rawEmbedding.data[0];
            }
        }

        if (!Array.isArray(queryVector) || !queryVector.every(n => typeof n === 'number')) {
            throw new Error('Invalid query embedding shape: expected number[]');
        }
        if (this.vectorSize && queryVector.length !== this.vectorSize) {
            console.warn(`Query embedding size (${queryVector.length}) does not match expected collection size (${this.vectorSize})`);
        }
        return queryVector;
    }

    async embed(input) {
        try {
            return await withEmbeddingDeadline(
                this.embeddings.embed(input),
                this.embeddingModel
            );
        } catch (error) {
            const status = mapProviderErrorToStatus(error);
            if (status && this.onProviderKeyFailure) {
                try {
                    await this.onProviderKeyFailure(status, error);
                } catch (handlerError) {
                    console.error('❌ Error handling scoped embeddings key failure:', handlerError.message);
                }
                throw new LlmKeyError(status, {}, this.provider);
            }
            throw error;
        }
    }

    /**
     * Transform a raw Qdrant search hit into the flattened result shape the rest
     * of the app expects.
     * @param {Object} result - Raw Qdrant point with score + payload
     * @returns {Object} Flattened result
     */
    transformSearchResult(result) {
        return {
            id: result.id,
            score: result.score,
            courseId: result.payload.courseId,
            lectureName: result.payload.lectureName,
            documentId: result.payload.documentId,
            fileName: result.payload.fileName,
            documentType: result.payload.documentType,
            type: result.payload.type,
            chunkText: result.payload.chunkText,
            chunkIndex: result.payload.chunkIndex,
            timestamp: result.payload.timestamp
        };
    }

    /**
     * Search for relevant document chunks using semantic similarity
     * @param {string} query - Search query text
     * @param {Object} filters - Optional filters for search
     * @param {number} limit - Maximum number of results to return
     * @returns {Promise<Array<Object>>} Array of search results
     */
    async searchDocuments(query, filters = {}, limit = 10) {
        try {
            console.log(`Searching for: "${query}"`);

            // Ensure collection exists before searching
            await this.ensureCollectionExists();

            // Generate embedding for the search query and normalize to number[]
            const queryVector = await this.generateQueryVector(query);

            // Build search parameters
            const searchParams = {
                query: queryVector,
                limit: limit,
                with_payload: true,
                with_vector: false
            };

            // Add filters if provided
            if (Array.isArray(filters.courseId) && filters.courseId.length > 0) {
                searchParams.filter = {
                    must: [
                        {
                            key: 'courseId',
                            match: { any: filters.courseId }
                        }
                    ]
                };
            } else if (filters.courseId) {
                searchParams.filter = {
                    must: [
                        {
                            key: 'courseId',
                            match: { value: filters.courseId }
                        }
                    ]
                };
            }

            if (filters.lectureName) {
                if (!searchParams.filter) {
                    searchParams.filter = { must: [] };
                }
                searchParams.filter.must.push({
                    key: 'lectureName',
                    match: { value: filters.lectureName }
                });
            }

            // Support array of lecture names (any-of match)
            if (filters.lectureNames && Array.isArray(filters.lectureNames) && filters.lectureNames.length > 0) {
                if (!searchParams.filter) {
                    searchParams.filter = { must: [] };
                }
                searchParams.filter.must.push({
                    key: 'lectureName',
                    match: { any: filters.lectureNames }
                });
            }

            // Additional-material chunks carry 'additional' in documentType and/or
            // type (legacy points may only have one of the two set), so both keys
            // are checked when scoping the search around them.
            if (filters.excludeAdditionalMaterials) {
                if (!searchParams.filter) {
                    searchParams.filter = { must: [] };
                }
                searchParams.filter.must_not = [
                    { key: 'documentType', match: { value: 'additional' } },
                    { key: 'type', match: { value: 'additional' } }
                ];
            } else if (filters.additionalMaterialsOnly) {
                if (!searchParams.filter) {
                    searchParams.filter = { must: [] };
                }
                searchParams.filter.must.push({
                    should: [
                        { key: 'documentType', match: { value: 'additional' } },
                        { key: 'type', match: { value: 'additional' } }
                    ]
                });
            }

            // Perform search
            const { points: searchResults } = await this.client.query(
                this.collectionName,
                searchParams
            );

            console.log(`Found ${searchResults.length} relevant chunks`);

            // Transform results to a more useful format
            const transformedResults = searchResults.map(result => this.transformSearchResult(result));

            return transformedResults;

        } catch (error) {
            console.error('❌ Error searching documents:', error);
            throw error;
        }
    }

    /**
     * Run the same semantic search independently against each course and return
     * the per-course top hits, keyed by courseId. The query is embedded once and
     * the vector reused for every course filter (no repeated embedding cost).
     *
     * Callers use this to guarantee each course representation in a multi-course
     * pool (e.g. the Super Course), which a single pooled top-K search cannot do:
     * a course with denser/more-similar chunks would otherwise win every slot.
     *
     * @param {string} query - Search query text
     * @param {string[]} courseIds - Course IDs to search across
     * @param {number} perCourseLimit - Max hits to fetch per course
     * @returns {Promise<Map<string, Array<Object>>>} courseId -> results (score desc)
     */
    async searchDocumentsByCourse(query, courseIds = [], perCourseLimit = 10) {
        const resultsByCourse = new Map();
        if (!Array.isArray(courseIds) || courseIds.length === 0) {
            return resultsByCourse;
        }

        await this.ensureCollectionExists();
        const queryVector = await this.generateQueryVector(query);

        // Fan out across courses in parallel, reusing the single query vector.
        const perCourse = await Promise.all(courseIds.map(async (courseId) => {
            const { points: searchResults } = await this.client.query(this.collectionName, {
                query: queryVector,
                limit: perCourseLimit,
                with_payload: true,
                with_vector: false,
                filter: {
                    must: [{ key: 'courseId', match: { value: courseId } }]
                }
            });
            return [courseId, searchResults.map(result => this.transformSearchResult(result))];
        }));

        for (const [courseId, results] of perCourse) {
            resultsByCourse.set(courseId, results);
        }
        return resultsByCourse;
    }

    /**
     * Run the same semantic search independently against each lecture/unit and
     * return the per-lecture top hits, keyed by lectureName. The query is
     * embedded once and the vector reused for every lecture filter.
     *
     * Mirrors searchDocumentsByCourse: a single pooled top-K search across many
     * units lets whichever unit's chunks score highest take every slot, even
     * when several units are equally in-scope and equally relevant to the
     * query. Callers that need guaranteed per-unit representation (e.g. a
     * student asking about several units at once) should use this instead of
     * searchDocuments with a multi-value lectureNames filter.
     *
     * @param {string} query - Search query text
     * @param {string} courseId - Course the lectures belong to
     * @param {string[]} lectureNames - Lecture/unit names to search across
     * @param {number} perLectureLimit - Max hits to fetch per lecture
     * @param {Object} [extraFilters] - Additional must/must_not filter pieces,
     *   e.g. { excludeAdditionalMaterials: true } (same options searchDocuments supports)
     * @returns {Promise<Map<string, Array<Object>>>} lectureName -> results (score desc)
     */
    async searchDocumentsByLecture(query, courseId, lectureNames = [], perLectureLimit = 10, extraFilters = {}) {
        const resultsByLecture = new Map();
        if (!courseId || !Array.isArray(lectureNames) || lectureNames.length === 0) {
            return resultsByLecture;
        }

        await this.ensureCollectionExists();
        const queryVector = await this.generateQueryVector(query);

        const baseMust = [
            { key: 'courseId', match: { value: courseId } }
        ];
        let mustNot;
        if (extraFilters.excludeAdditionalMaterials) {
            mustNot = [
                { key: 'documentType', match: { value: 'additional' } },
                { key: 'type', match: { value: 'additional' } }
            ];
        } else if (extraFilters.additionalMaterialsOnly) {
            baseMust.push({
                should: [
                    { key: 'documentType', match: { value: 'additional' } },
                    { key: 'type', match: { value: 'additional' } }
                ]
            });
        }

        // Fan out across lectures in parallel, reusing the single query vector.
        const perLecture = await Promise.all(lectureNames.map(async (lectureName) => {
            const filter = { must: [...baseMust, { key: 'lectureName', match: { value: lectureName } }] };
            if (mustNot) filter.must_not = mustNot;
            const { points: searchResults } = await this.client.query(this.collectionName, {
                query: queryVector,
                limit: perLectureLimit,
                with_payload: true,
                with_vector: false,
                filter
            });
            return [lectureName, searchResults.map(result => this.transformSearchResult(result))];
        }));

        for (const [lectureName, results] of perLecture) {
            resultsByLecture.set(lectureName, results);
        }
        return resultsByLecture;
    }

    /**
     * Merge per-lecture search results into one ranked list that guarantees
     * every lecture with any hits a floor of representation, instead of a
     * plain global top-K that lets one unit crowd out the rest.
     *
     * Same "round-robin by rank up to a floor, then fill the remainder by
     * global score" shape as superCourseService.js's mergeBalancedCourseResults
     * - deliberately duplicated rather than shared, since the two merges
     * operate over different grouping keys (lectureName vs courseId) from
     * different call sites, and a shared generic version wasn't worth the
     * indirection for ~25 lines of plain array logic.
     *
     * When there are more lectures than `target`, not every lecture can get
     * even its one guaranteed slot, and something has to be cut. Lectures are
     * ordered by their own best score (descending) before the round-robin
     * runs, so that cut falls on the lowest-scoring lectures, not on
     * whichever lecture happens to sort last by name/insertion order - a
     * student in a later unit asking about that unit's own content must not
     * lose to earlier units just because they come first in course order.
     *
     * @param {Map<string, Array<Object>>} resultsByLecture - lectureName -> results (score desc)
     * @param {number} target - Total number of results to return
     * @returns {Array<Object>} Merged results, length <= target
     */
    static mergeBalancedLectureResults(resultsByLecture, target) {
        const lists = [...resultsByLecture.values()]
            .filter(list => list.length > 0)
            .sort((a, b) => (b[0].score || 0) - (a[0].score || 0));
        if (lists.length === 0) return [];

        const floor = Math.max(1, Math.floor(target / lists.length));

        const taken = new Set();
        const guaranteed = [];
        // Round-robin by rank: each lecture's #1 chunk, then each lecture's #2,
        // ... up to the floor - so the front of the list is balanced across units.
        for (let rank = 0; rank < floor; rank++) {
            for (const list of lists) {
                const item = list[rank];
                if (item && !taken.has(item.id)) {
                    taken.add(item.id);
                    guaranteed.push(item);
                }
            }
        }

        // Everything not already taken, ranked globally by score, fills the remainder.
        const remainder = [];
        for (const list of lists) {
            for (const item of list) {
                if (!taken.has(item.id)) remainder.push(item);
            }
        }
        remainder.sort((a, b) => (b.score || 0) - (a.score || 0));

        return [...guaranteed, ...remainder].slice(0, target);
    }

    /**
     * Retrieve all chunks for a specific document, ordered by chunkIndex
     * @param {string} documentId - Document ID to retrieve chunks for
     * @returns {Promise<Array>} Array of chunk texts in order
     */
    async getDocumentChunks(documentId) {
        try {
            console.log(`Retrieving chunks for document: ${documentId}`);

            const filter = {
                must: [
                    { key: 'documentId', match: { value: documentId } }
                ]
            };

            const allChunks = [];
            let nextOffset = null;
            let loopCount = 0;
            const MAX_LOOPS = 100;

            do {
                loopCount++;
                const scrollResult = await this.client.scroll(this.collectionName, {
                    filter: filter,
                    limit: 1000,
                    with_payload: true,
                    offset: nextOffset
                });

                const points = scrollResult.points || [];
                nextOffset = scrollResult.next_page_offset;

                for (const point of points) {
                    allChunks.push({
                        chunkIndex: point.payload.chunkIndex,
                        chunkText: point.payload.chunkText
                    });
                }

                if (points.length === 0 || loopCount >= MAX_LOOPS) break;
            } while (nextOffset);

            // Sort by chunkIndex to maintain document order
            allChunks.sort((a, b) => a.chunkIndex - b.chunkIndex);

            console.log(`Retrieved ${allChunks.length} chunks for document: ${documentId}`);
            return allChunks.map(c => c.chunkText);
        } catch (error) {
            console.error('Error retrieving document chunks:', error);
            throw error;
        }
    }

    /**
     * Retrieve the upload-time chunks for a course unit, optionally restricted
     * to the supplied current document IDs. Payload metadata is preserved so
     * downstream features can cite the original slide/page when available.
     * @param {string} courseId
     * @param {string} lectureName
     * @param {string[]} documentIds
     * @returns {Promise<Array<Object>>}
     */
    async getUnitChunkRecords(courseId, lectureName, documentIds = []) {
        try {
            const must = [
                { key: 'courseId', match: { value: courseId } },
                { key: 'lectureName', match: { value: lectureName } }
            ];
            if (Array.isArray(documentIds) && documentIds.length > 0) {
                must.push({ key: 'documentId', match: { any: documentIds } });
            }

            const records = [];
            let nextOffset = null;
            let loopCount = 0;
            const MAX_LOOPS = 100;

            do {
                loopCount += 1;
                const scrollResult = await this.client.scroll(this.collectionName, {
                    filter: { must },
                    limit: 1000,
                    with_payload: true,
                    offset: nextOffset
                });
                const points = scrollResult.points || [];
                nextOffset = scrollResult.next_page_offset;

                for (const point of points) {
                    const payload = point.payload || {};
                    if (typeof payload.chunkText !== 'string' || !payload.chunkText.trim()) continue;
                    records.push({
                        id: point.id,
                        courseId: payload.courseId,
                        lectureName: payload.lectureName,
                        documentId: payload.documentId,
                        fileName: payload.fileName,
                        chunkIndex: payload.chunkIndex,
                        totalChunks: payload.totalChunks,
                        chunkText: payload.chunkText,
                        pageNumber: payload.pageNumber,
                        slideNumber: payload.slideNumber,
                        sourceUnit: payload.sourceUnit,
                        strategyUsed: payload.strategyUsed
                    });
                }

                if (points.length === 0 || loopCount >= MAX_LOOPS) break;
            } while (nextOffset);

            records.sort((a, b) => {
                const documentOrder = String(a.documentId || '').localeCompare(String(b.documentId || ''));
                return documentOrder || Number(a.chunkIndex || 0) - Number(b.chunkIndex || 0);
            });
            return records;
        } catch (error) {
            console.error('Error retrieving unit chunk records:', error);
            throw error;
        }
    }

    /**
     * Clone all stored chunks for one document onto another document/course/unit without re-chunking.
     * Reuses the existing vectors and chunk text payload so transfers stay 1:1 with the source.
     * @param {Object} params
     * @param {string} params.sourceDocumentId
     * @param {string} params.targetDocumentId
     * @param {string} params.targetCourseId
     * @param {string} params.targetLectureName
     * @param {string} params.targetFileName
     * @param {string} params.targetMimeType
     * @param {string} params.targetDocumentType
     * @param {string} params.targetType
     * @returns {Promise<Object>} Result of clone operation
     */
    async cloneDocumentChunks({
        sourceDocumentId,
        targetDocumentId,
        targetCourseId,
        targetLectureName,
        targetFileName,
        targetMimeType,
        targetDocumentType,
        targetType
    }) {
        try {
            if (!sourceDocumentId || !targetDocumentId || !targetCourseId || !targetLectureName) {
                throw new Error('Missing required chunk clone parameters');
            }

            await this.ensureCollectionExists();

            const filter = {
                must: [
                    { key: 'documentId', match: { value: sourceDocumentId } }
                ]
            };

            const sourcePoints = [];
            let nextOffset = null;
            let loopCount = 0;
            const MAX_LOOPS = 100;

            do {
                loopCount += 1;
                const scrollResult = await this.client.scroll(this.collectionName, {
                    filter,
                    limit: 1000,
                    with_payload: true,
                    with_vector: true,
                    offset: nextOffset
                });

                const points = scrollResult.points || [];
                nextOffset = scrollResult.next_page_offset;

                sourcePoints.push(...points);

                if (points.length === 0 || loopCount >= MAX_LOOPS) {
                    break;
                }
            } while (nextOffset);

            if (sourcePoints.length === 0) {
                return {
                    success: true,
                    clonedCount: 0,
                    message: 'No stored chunks were found for the source document'
                };
            }

            const clonedPoints = sourcePoints.map((point) => ({
                id: randomUUID(),
                vector: point.vector,
                payload: {
                    ...(point.payload || {}),
                    courseId: targetCourseId,
                    lectureName: targetLectureName,
                    documentId: targetDocumentId,
                    fileName: targetFileName,
                    mimeType: targetMimeType,
                    documentType: targetDocumentType || point.payload?.documentType || 'unknown',
                    type: targetType || point.payload?.type || 'unknown',
                    timestamp: new Date().toISOString()
                }
            }));

            await this.client.upsert(this.collectionName, {
                points: clonedPoints
            });

            return {
                success: true,
                clonedCount: clonedPoints.length,
                message: `Cloned ${clonedPoints.length} stored chunks successfully`
            };
        } catch (error) {
            console.error('❌ Error cloning document chunks:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    /**
     * Delete all chunks for a specific document
     * @param {string} documentId - Document ID to delete
     * @param {string} [courseId] - Optional course ID to scope the deletion
     * @returns {Promise<Object>} Result of deletion
     */
    async deleteDocumentChunks(documentId, courseId = null) {
        try {
            console.log(
                `Removing stale/partial target chunks for document: ${documentId}`
                + `${courseId ? ` in course: ${courseId}` : ''}`
                + ` from collection: ${this.collectionName} (other provider collections are untouched)`
            );

            const filter = {
                must: [
                    {
                        key: 'documentId',
                        match: { value: documentId }
                    }
                ]
            };

            // Add courseId scope if provided
            if (courseId) {
                filter.must.push({
                    key: 'courseId',
                    match: { value: courseId }
                });
            }

            let totalDeleted = 0;
            let nextOffset = null;
            let loopCount = 0;
            const MAX_LOOPS = 100; // Safety break

            console.log('Starting deletion loop...');

            do {
                loopCount++;
                
                // Find chunks for this document (page by page)
                const scrollResult = await this.client.scroll(this.collectionName, {
                    filter: filter,
                    limit: 1000, // Processing in batches of 1000
                    with_payload: false,
                    offset: nextOffset
                });

                const points = scrollResult.points || [];
                nextOffset = scrollResult.next_page_offset;

                if (points.length === 0) {
                    if (loopCount === 1) {
                        console.log(`No existing target chunks found for document: ${documentId}`);
                        return {
                            success: true,
                            message: 'No chunks found for document',
                            deletedCount: 0
                        };
                    }
                    break; // No more points
                }

                // Delete the chunks in this batch
                const chunkIds = points.map(point => point.id);
                await this.client.delete(this.collectionName, {
                    points: chunkIds
                });
                
                totalDeleted += chunkIds.length;
                console.log(`Batch ${loopCount}: Deleted ${chunkIds.length} chunks. Total so far: ${totalDeleted}`);

                if (loopCount >= MAX_LOOPS) {
                    console.warn(`Safety break triggered in deletion loop after ${MAX_LOOPS} iterations`);
                    break;
                }

            } while (nextOffset);

            console.log(`Successfully deleted total ${totalDeleted} chunks for document: ${documentId}`);

            return {
                success: true,
                message: `Deleted ${totalDeleted} chunks successfully`,
                deletedCount: totalDeleted
            };

        } catch (error) {
            console.error('❌ Error deleting document chunks:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    /**
     * Get collection statistics
     * @returns {Promise<Object>} Collection statistics
     */
    async getCollectionStats() {
        try {
            // Ensure service is initialized
            if (!this.client) {
                await this.initialize();
            }

            const collectionInfo = await this.client.getCollection(this.collectionName);
            const collectionStats = await this.client.getCollection(this.collectionName);
            
            return {
                name: collectionInfo.name,
                vectorSize: collectionInfo.config.params.vectors.size,
                distance: collectionInfo.config.params.vectors.distance,
                pointsCount: collectionStats.points_count,
                segmentsCount: collectionStats.segments_count,
                status: collectionInfo.status
            };
        } catch (error) {
            console.error('❌ Error getting collection stats:', error);
            throw error;
        }
    }

    /**
     * Delete the entire collection
     * @returns {Promise<Object>} Result of collection deletion
     */
    async deleteCollection() {
        try {
            console.log(`Deleting entire collection: ${this.collectionName}`);

            // Ensure service is initialized
            if (!this.client) {
                await this.initialize();
            }

            // Check if collection exists
            const collections = await this.client.getCollections();
            const collectionExists = collections.collections.some(
                col => col.name === this.collectionName
            );

            if (!collectionExists) {
                return {
                    success: true,
                    message: 'Collection does not exist',
                    deletedCount: 0
                };
            }

            // Delete the collection
            await this.client.deleteCollection(this.collectionName);
            console.log(`✅ Successfully deleted collection: ${this.collectionName}`);

            return {
                success: true,
                message: `Collection ${this.collectionName} deleted successfully`,
                deletedCount: 'all'
            };

        } catch (error) {
            console.error('❌ Error deleting collection:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    /**
     * Get service status and LLM integration information
     * @returns {Object} Service status information
     */
    getStatus() {
        return {
            qdrant: {
                isConnected: !!this.client,
                collectionName: this.collectionName,
                vectorSize: this.vectorSize
            },
            embeddings: {
                isInitialized: !!this.embeddings,
                provider: (this.llmConfigOverride && this.llmConfigOverride.provider) || process.env.LLM_PROVIDER || null,
                isReady: !!this.embeddings
            },
            chunking: {
                isInitialized: !!this.chunker,
                strategy: this.chunker ? this.chunker.getDefaultStrategyName() : null
            },
            timestamp: new Date().toISOString()
        };
    }

    /**
     * Test the LLM service connection through the embeddings
     * @returns {Promise<boolean>} True if connection is working
     */
    async testLLMConnection() {
        try {
            if (!this.embeddings) {
                await this.initialize();
            }
            
            const testEmbedding = await this.embeddings.embed('connection test');
            return Array.isArray(testEmbedding) && testEmbedding.length > 0;
        } catch (error) {
            console.error('❌ LLM connection test failed:', error.message);
            return false;
        }
    }
}

module.exports = QdrantService;
