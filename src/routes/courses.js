/**
 * Courses API Routes
 * Handles course creation, management, and instructor operations
 */

const express = require('express');
const router = express.Router();
const CourseModel = require('../models/Course');
const UserModel = require('../models/User');
const DocumentModel = require('../models/Document');
const QdrantService = require('../services/qdrantService');
const gridfs = require('../services/gridfs');
const { hasSystemAdminAccess } = require('../services/authorization');
const previewSession = require('../services/previewSession');
const { createId } = require('../services/id');
const {
    activeProviderOf,
    buildKeySubdocument,
    credentialDocumentFields,
    credentialSetFields,
    decryptApiKey,
    publicKeySummary,
    publicProviderKeyState,
    validateApiKey
} = require('../services/llmKeyStore');
const providerKeys = require('../services/providerKeyService');
const scopeModelSettings = require('../services/scopeModelSettings');
const { normalizeProvider, providerCatalog, providerLabel } = require('../services/llmProviders');
const { buildEmbeddingProfile } = require('../services/embeddingConfig');
const {
    INDEX_STATUSES,
    contentHash,
    deleteDocumentFromAllCollections,
    indexesOf
} = require('../services/embeddingIndexService');
const qdrantMaintenance = require('../services/qdrantMaintenance');
const { LANES } = require('../services/llmLanes');
const { resolveCourseAi } = require('./llmKeyMiddleware');
const { getAcademicApiClient, isAcademicApiEnabled } = require('../services/academicApi');

// Middleware to parse JSON bodies
router.use(express.json());

/**
 * True when the UBC academic record lists this user as an instructor of record
 * for at least one section linked to the course. Such an instructor can join
 * the BiocBot course directly, without an instructor course code — they're
 * already a verified co-instructor of the underlying section (e.g. a colleague
 * joining a pre-made, co-taught course).
 *
 * Fails closed: any missing data or academic-API error returns false, so the
 * normal code-based join still applies.
 */
async function isVerifiedInstructorOfRecord(req, course, user) {
    // Gated off by default: with no academic API, instructor-of-record can't be
    // verified, so the normal instructor-code join applies (pre-feature behavior).
    if (!await isAcademicApiEnabled(req.app.locals.db)) {
        return false;
    }

    const sync = course && course.academicSync;
    const linkedSectionIds = Array.isArray(sync && sync.sectionIds)
        ? sync.sectionIds.filter(Boolean)
        : [];
    const academicPeriod = sync && sync.academicPeriod;

    if (!user || !user.puid || !academicPeriod || linkedSectionIds.length === 0) {
        return false;
    }

    try {
        const api = req.app.locals.academicApi || getAcademicApiClient();
        const sections = await api.getInstructorSections(user.puid, academicPeriod);
        const taughtSectionIds = new Set(
            (sections || [])
                .map((s) => s.courseSectionId || s.id || s.sectionId)
                .filter(Boolean)
        );
        return linkedSectionIds.some((id) => taughtSectionIds.has(id));
    } catch (error) {
        console.error('Instructor-of-record verification failed:', error.message);
        return false;
    }
}

function hasInstructorOrTAAccess(course, userId) {
    return course.instructorId === userId ||
        (Array.isArray(course.instructors) && course.instructors.includes(userId)) ||
        (Array.isArray(course.tas) && course.tas.includes(userId));
}

function hasInstructorAccess(course, userId) {
    return course.instructorId === userId ||
        (Array.isArray(course.instructors) && course.instructors.includes(userId));
}

async function hasCourseManagementAccess(db, course, user) {
    if (!course || !user) {
        return false;
    }

    if (hasInstructorAccess(course, user.userId)) {
        return true;
    }

    if (user.role === 'ta' && Array.isArray(course.tas) && course.tas.includes(user.userId)) {
        return CourseModel.checkTAPermission(db, course.courseId, user.userId, 'courses');
    }

    return false;
}

async function requireCourseKeyAccess(req, res, db, courseId) {
    const user = req.user;
    if (!user) {
        res.status(401).json({ success: false, message: 'Authentication required' });
        return null;
    }

    const course = await CourseModel.getCourseById(db, courseId);
    if (!course) {
        res.status(404).json({ success: false, message: 'Course not found' });
        return null;
    }

    if (hasSystemAdminAccess(user) || hasInstructorAccess(course, user.userId)) {
        return course;
    }

    res.status(403).json({ success: false, message: 'Only course instructors or system admins can manage this API key' });
    return null;
}

function isInactiveCourse(course = {}) {
    return (course.status || 'active') === 'inactive';
}

/**
 * Calculate the measured duration of a saved student chat. Newer sessions
 * persist an elapsedTime (milliseconds since the preceding message) on every
 * message; summing those values preserves the timing captured by the client.
 * Older sessions fall back to their message timestamps.
 *
 * @param {Object} session - Saved chat session
 * @returns {number} Measured duration in milliseconds
 */
function calculateMeasuredSessionDurationMs(session) {
    const messages = Array.isArray(session?.chatData?.messages)
        ? session.chatData.messages
        : [];
    const firstUserIndex = messages.findIndex(message => message?.type === 'user');
    if (firstUserIndex === -1) return 0;

    const isSyntheticBotMessage = (message) => {
        if (!message || message.type !== 'bot') return false;
        if (message.sourceAttribution?.source === 'System') return true;
        const content = typeof message.content === 'string' ? message.content : '';
        return content.includes('Welcome to BiocBot!') &&
            content.includes('I can see you have access to published units');
    };

    let endIndex = -1;
    for (let index = messages.length - 1; index >= firstUserIndex; index--) {
        if (messages[index]?.type === 'bot' && !isSyntheticBotMessage(messages[index])) {
            endIndex = index;
            break;
        }
    }
    if (endIndex === -1) {
        for (let index = messages.length - 1; index >= firstUserIndex; index--) {
            if (!isSyntheticBotMessage(messages[index])) {
                endIndex = index;
                break;
            }
        }
    }
    if (endIndex <= firstUserIndex) return 0;

    const elapsedIntervals = messages
        .slice(firstUserIndex + 1, endIndex + 1)
        .map(message => message?.elapsedTime !== null
            && message?.elapsedTime !== undefined
            && message?.elapsedTime !== ''
            ? Number(message.elapsedTime)
            : NaN);
    if (elapsedIntervals.every(value => Number.isFinite(value) && value >= 0)) {
        return elapsedIntervals.reduce((total, value) => total + value, 0);
    }

    const startMs = new Date(messages[firstUserIndex]?.timestamp).getTime();
    const endMs = new Date(messages[endIndex]?.timestamp).getTime();
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
        return 0;
    }
    return endMs - startMs;
}

function sortCoursesWithInactiveLast(courses = []) {
    return [...courses].sort((a, b) => {
        const aInactive = isInactiveCourse(a) ? 1 : 0;
        const bInactive = isInactiveCourse(b) ? 1 : 0;

        if (aInactive !== bInactive) {
            return aInactive - bInactive;
        }

        const aUpdatedAt = new Date(a.updatedAt || a.createdAt || 0).getTime();
        const bUpdatedAt = new Date(b.updatedAt || b.createdAt || 0).getTime();

        if (aUpdatedAt !== bUpdatedAt) {
            return bUpdatedAt - aUpdatedAt;
        }

        return String(a.courseName || a.courseId || '').localeCompare(
            String(b.courseName || b.courseId || '')
        );
    });
}

function extractFirstJSONObject(text = '') {
    if (!text || typeof text !== 'string') return null;
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) return null;

    const jsonSlice = text.substring(start, end + 1);
    try {
        return JSON.parse(jsonSlice);
    } catch (error) {
        return null;
    }
}

const TOPIC_EXTRACTION_BATCH_CHAR_LIMIT = 10000;
const TOPIC_CANDIDATES_PER_BATCH = 5;

/**
 * Split a block that cannot fit in one topic-extraction batch at a natural
 * boundary. The fallback hard split guarantees progress for content without
 * whitespace (for example, a long OCR artefact).
 */
function splitOversizedTopicContent(content, maxChars = TOPIC_EXTRACTION_BATCH_CHAR_LIMIT) {
    const chunks = [];
    let remaining = String(content || '').trim();

    while (remaining.length > maxChars) {
        const minimumNaturalBreak = Math.floor(maxChars * 0.75);
        let splitAt = remaining.lastIndexOf('\n\n', maxChars);
        if (splitAt < minimumNaturalBreak) splitAt = remaining.lastIndexOf('\n', maxChars);
        if (splitAt < minimumNaturalBreak) splitAt = remaining.lastIndexOf(' ', maxChars);
        if (splitAt < minimumNaturalBreak) splitAt = maxChars;

        const chunk = remaining.slice(0, splitAt).trim();
        if (chunk) chunks.push(chunk);
        remaining = remaining.slice(splitAt).trimStart();
    }

    if (remaining) chunks.push(remaining);
    return chunks;
}

/**
 * Pack parsed course content into roughly 10,000-character LLM batches.
 * PowerPoint parsing produces "Slide N" headings, so keep complete slides
 * together whenever they fit. Other files fall back to natural text breaks.
 */
function splitTopicExtractionBatches(content, maxChars = TOPIC_EXTRACTION_BATCH_CHAR_LIMIT) {
    const normalizedContent = typeof content === 'string' ? content.trim() : '';
    if (!normalizedContent) return [];
    if (normalizedContent.length <= maxChars) return [normalizedContent];

    const slideHeadingPattern = /^(?:#{1,6}\s*)?Slide\s+\d+(?:\s*[:—-].*)?\s*$/gim;
    const slideMatches = [...normalizedContent.matchAll(slideHeadingPattern)];
    const contentUnits = [];

    if (slideMatches.length > 0) {
        if (slideMatches[0].index > 0) {
            contentUnits.push(normalizedContent.slice(0, slideMatches[0].index));
        }
        for (let index = 0; index < slideMatches.length; index++) {
            const start = slideMatches[index].index;
            const end = index + 1 < slideMatches.length
                ? slideMatches[index + 1].index
                : normalizedContent.length;
            contentUnits.push(normalizedContent.slice(start, end));
        }
    } else {
        contentUnits.push(normalizedContent);
    }

    const unitsThatFit = contentUnits.flatMap((unit) =>
        splitOversizedTopicContent(unit, maxChars)
    );
    const batches = [];
    let currentBatch = '';

    for (const unit of unitsThatFit) {
        const trimmedUnit = unit.trim();
        if (!trimmedUnit) continue;

        const combined = currentBatch ? `${currentBatch}\n\n${trimmedUnit}` : trimmedUnit;
        if (combined.length <= maxChars) {
            currentBatch = combined;
            continue;
        }

        if (currentBatch) batches.push(currentBatch);
        currentBatch = trimmedUnit;
    }

    if (currentBatch) batches.push(currentBatch);
    return batches;
}

function buildTopicExtractionPrompt(content, maxTopics = 8) {
    return `
You are BIOCBOT, an expert chemistry/biochemistry curriculum analyst.
Read the uploaded course content and extract chemistry or biochemistry concepts that students might struggle with.

Requirements:
1. Return ${maxTopics} or fewer concise topic labels.
2. Each topic should be 1-5 words.
3. Include only topics directly relevant to chemistry or biochemistry, including stoichiometry, atomic structure, bonding, solutions, equilibrium, acids and bases, thermochemistry, electrochemistry, molecular biology, metabolism, enzymes, proteins, nucleic acids, membranes, cellular signaling, or biochemical methods.
4. If the content is not about chemistry or biochemistry, return an empty topics array.
5. Do not extract humanities, literature, history, politics, geography, legal, or general social-science topics.
6. Prefer concept-level terms (e.g., "Hydrophilic Interactions", "Enzyme Kinetics", "Protein Structure").
7. Avoid duplicates and overly generic labels like "Chemistry" or "General".
8. Return JSON ONLY.

JSON format:
{
  "topics": ["topic 1", "topic 2"]
}

Course content:
"""
${content}
"""
`;
}

function buildTopicConsolidationPrompt(candidateTopics, maxTopics = 8) {
    return `
You are BIOCBOT, an expert chemistry/biochemistry curriculum analyst.
Consolidate chemistry and biochemistry struggle-topic candidates extracted from every batch of one course document.

Requirements:
1. Return ${maxTopics} or fewer concise topic labels.
2. Each topic should be 1-5 words.
3. Merge duplicates and near-duplicates (for example, "Enzyme Rate" and "Enzyme Kinetics").
4. Keep the most specific, concept-level label for each distinct idea.
5. Include only chemistry or biochemistry topics represented in the candidate list; do not invent new topics.
6. Return JSON ONLY.

JSON format:
{
  "topics": ["topic 1", "topic 2"]
}

Candidate topics from all document batches:
${JSON.stringify(candidateTopics)}
`;
}

function filterChemistryTopics(topics = []) {
    const biochemistryPattern = /\b(amino acid|protein|peptide|enzyme|kinetic|cataly|substrate|active site|alloster|metabol|glycolysis|gluconeogenesis|krebs|citric acid|tca|electron transport|oxidative phosphorylation|atp|bioenergetic|carbohydrate|glucose|glycogen|lipid|fatty acid|cholesterol|membrane|phospholipid|hydrophilic|hydrophobic|polarity|polar|nonpolar|nucleic acid|dna|rna|nucleotide|transcription|translation|replication|gene expression|molecular biology|cell signal|signal transduction|receptor|ligand|hormone|cofactor|vitamin|redox|oxidation|reduction|buffer|ph\b|acid-base|equilibrium|thermodynamic\w*|thermochemistry|enthalpy|entropy|calorimetry|hess|gibbs|free energy|stoichiometr\w*|moles?|limiting reactant\w*|chemical equation\w*|atomic structure|electron configuration|orbital\w*|periodic trend\w*|ion formation|chemical bond\w*|lewis structure\w*|vsepr|intermolecular force\w*|solution\w*|concentration|molarity|dilution|solubility|precipitation|electrochem\w*|galvanic|standard potential\w*|electrolysis|hemoglobin|myoglobin|collagen|antibody|immunoglobulin|western blot|pcr|electrophoresis|chromatography|spectrophotometry|assay)\b/i;
    const nonBiochemistryPattern = /\b(erasure|poetry|poetic|literary|literature|treaty|indigenous|colonial|dispossession|endowment|territory|musqueam|university|crown land|government|policy|rights|legal|historical|history|geography|map)\b/i;

    return CourseModel.normalizeTopicList(topics)
        .filter((topic) => biochemistryPattern.test(topic) && !nonBiochemistryPattern.test(topic));
}

function generateCourseCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
}

function generateDistinctCourseCode(existingCodes = []) {
    const normalizedExistingCodes = new Set(
        existingCodes
            .filter(Boolean)
            .map((code) => String(code).trim().toUpperCase())
    );

    let code = generateCourseCode();
    let attempts = 0;

    while (normalizedExistingCodes.has(code) && attempts < 20) {
        code = generateCourseCode();
        attempts += 1;
    }

    return code;
}

function normalizeCourseCode(code) {
    if (typeof code !== 'string') {
        return '';
    }

    return code.trim().toUpperCase();
}

async function userCanBypassCourseCodes(db, user) {
    if (!user) {
        return false;
    }

    if (hasSystemAdminAccess(user)) {
        return true;
    }

    let hydratedUser = user;

    if (!hydratedUser.email && hydratedUser.userId && db) {
        hydratedUser = await UserModel.getUserById(db, hydratedUser.userId);
    }

    if (!hydratedUser) {
        return false;
    }

    if (hasSystemAdminAccess(hydratedUser)) {
        return true;
    }

    return false;
}

function generateCourseId(courseName = '') {
    return createId('course');
}

function deepClone(value) {
    return JSON.parse(JSON.stringify(value));
}

function normalizeTransferUnitConfig(unit = {}) {
    return {
        unitName: unit.unitName || unit.name || unit.lectureName || '',
        transferDocuments: unit.transferDocuments !== false,
        transferLearningObjectives: unit.transferLearningObjectives !== false,
        transferAssessmentQuestions: unit.transferAssessmentQuestions !== false
    };
}

function getStoredFileBuffer(fileData) {
    if (!fileData) {
        return null;
    }

    if (Buffer.isBuffer(fileData)) {
        return fileData;
    }

    if (fileData.buffer) {
        return Buffer.from(fileData.buffer);
    }

    if (typeof fileData === 'string') {
        return Buffer.from(fileData, 'base64');
    }

    return null;
}

function inferDocumentSize(sourceDocument, content = '', fileBuffer = null) {
    if (typeof sourceDocument.size === 'number' && sourceDocument.size > 0) {
        return sourceDocument.size;
    }

    if (fileBuffer) {
        return fileBuffer.length;
    }

    return Buffer.byteLength(content || '', 'utf8');
}

function getStoredDocumentContent(sourceDocument, fileBuffer = null) {
    const contentType = sourceDocument.contentType || (sourceDocument.fileData ? 'file' : 'text');

    if (contentType === 'text') {
        return typeof sourceDocument.content === 'string' ? sourceDocument.content : '';
    }

    const mimeType = (sourceDocument.mimeType || '').toLowerCase();
    if (fileBuffer && (mimeType === 'text/plain' || mimeType === 'text/markdown')) {
        return fileBuffer.toString('utf8');
    }

    return typeof sourceDocument.content === 'string' ? sourceDocument.content : '';
}

/**
 * GET /api/courses/:courseId/llm-key
 * Platform selection, key status per platform, and any in-flight migration.
 * Never returns key material.
 */
router.get('/:courseId/llm-key', async (req, res) => {
    try {
        const db = req.app.locals.db;
        if (!db) {
            return res.status(503).json({ success: false, message: 'Database connection not available' });
        }

        const course = await requireCourseKeyAccess(req, res, db, req.params.courseId);
        if (!course) return;

        const state = await providerKeys.surfaceKeyState(db, { type: 'course', id: course.courseId });
        res.json({ success: true, providers: providerCatalog(), ...state });
    } catch (error) {
        console.error('Error fetching course API key status:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch course API key status' });
    }
});

router.put('/:courseId/llm-key', async (req, res) => {
    try {
        const db = req.app.locals.db;
        if (!db) {
            return res.status(503).json({ success: false, message: 'Database connection not available' });
        }

        const course = await requireCourseKeyAccess(req, res, db, req.params.courseId);
        if (!course) return;

        const result = await providerKeys.saveSurfaceKey(db, {
            scope: { type: 'course', id: course.courseId },
            provider: normalizeProvider(req.body && req.body.llmProvider),
            apiKey: req.body && req.body.apiKey,
            updatedBy: req.user.userId,
            registry: req.app.locals.llmRegistry
        });

        if (result.ok && result.httpStatus === 200) {
            result.body.message = 'Course API key saved';
        }

        res.status(result.httpStatus).json(result.body);
    } catch (error) {
        console.error('Error saving course API key:', error);
        res.status(500).json({ success: false, message: 'Failed to save course API key' });
    }
});

/**
 * POST /api/courses/:courseId/llm-provider
 * Switch back to a platform whose key is already stored, without re-entering it.
 */
router.post('/:courseId/llm-provider', async (req, res) => {
    try {
        const db = req.app.locals.db;
        if (!db) {
            return res.status(503).json({ success: false, message: 'Database connection not available' });
        }

        const course = await requireCourseKeyAccess(req, res, db, req.params.courseId);
        if (!course) return;

        const result = await providerKeys.switchToStoredProvider(db, {
            scope: { type: 'course', id: course.courseId },
            provider: normalizeProvider(req.body && req.body.llmProvider),
            requestedBy: req.user.userId,
            registry: req.app.locals.llmRegistry
        });

        res.status(result.httpStatus).json(result.body);
    } catch (error) {
        console.error('Error switching course platform:', error);
        res.status(500).json({ success: false, message: 'Failed to switch platform' });
    }
});

/** POST /api/courses/:courseId/llm-provider/prepare */
router.post('/:courseId/llm-provider/prepare', async (req, res) => {
    try {
        const db = req.app.locals.db;
        if (!db) return res.status(503).json({ success: false, message: 'Database connection not available' });
        const course = await requireCourseKeyAccess(req, res, db, req.params.courseId);
        if (!course) return;

        const result = await providerKeys.prepareStoredProvider(db, {
            scope: { type: 'course', id: course.courseId },
            provider: normalizeProvider(req.body && req.body.llmProvider),
            requestedBy: req.user.userId,
            registry: req.app.locals.llmRegistry
        });
        res.status(result.httpStatus).json(result.body);
    } catch (error) {
        console.error('Error preparing course material:', error);
        res.status(500).json({ success: false, message: 'Failed to prepare course material' });
    }
});

router.post('/:courseId/llm-key/test', async (req, res) => {
    try {
        const db = req.app.locals.db;
        if (!db) {
            return res.status(503).json({ success: false, message: 'Database connection not available' });
        }

        const course = await requireCourseKeyAccess(req, res, db, req.params.courseId);
        if (!course) return;

        const result = await providerKeys.testSurfaceKey(db, {
            scope: { type: 'course', id: course.courseId },
            provider: req.body && req.body.llmProvider,
            registry: req.app.locals.llmRegistry
        });

        if (result.body.code === 'LLM_KEY_MISSING') {
            result.body.message = 'No API key is saved for this course.';
        } else if (result.ok) {
            result.body.message = 'Course API key is valid';
        }

        res.status(result.httpStatus).json(result.body);
    } catch (error) {
        console.error('Error testing course API key:', error);
        res.status(500).json({ success: false, message: 'Failed to test course API key' });
    }
});

/**
 * A maintenance QdrantService (no embeddings needed — cloning copies existing
 * vectors) bound to the collection an index record lives in. Cached per
 * collection for the duration of a transfer.
 */
async function getTransferQdrantService(cache, record) {
    if (!cache.byCollection) cache.byCollection = new Map();
    const existing = cache.byCollection.get(record.collection);
    if (existing) return existing;

    const profile = buildEmbeddingProfile({
        provider: record.provider,
        embeddingModel: record.model,
        revision: record.revision,
        vectorSize: record.vectorSize || undefined
    });
    const service = new QdrantService({ skipEmbeddings: true, embeddingProfile: profile });
    await service.initialize();
    cache.byCollection.set(record.collection, service);
    return service;
}

async function cloneDocumentForTransfer({
    db,
    sourceDocument,
    targetCourseId,
    lectureName,
    instructorId,
    qdrantService
}) {
    const contentType = sourceDocument.contentType || (sourceDocument.fileData ? 'file' : 'text');
    const fileBuffer = contentType === 'file' ? getStoredFileBuffer(sourceDocument.fileData) : null;
    const storedContent = getStoredDocumentContent(sourceDocument, fileBuffer);
    const metadata = sourceDocument.metadata && typeof sourceDocument.metadata === 'object'
        ? deepClone(sourceDocument.metadata)
        : {};

    const documentData = {
        courseId: targetCourseId,
        lectureName,
        documentType: sourceDocument.documentType || 'additional',
        instructorId,
        contentType,
        filename: sourceDocument.filename || sourceDocument.originalName || 'Transferred Material',
        originalName: sourceDocument.originalName || sourceDocument.filename || 'Transferred Material',
        content: storedContent || '',
        mimeType: sourceDocument.mimeType || 'text/plain',
        size: inferDocumentSize(sourceDocument, storedContent, fileBuffer),
        metadata
    };

    if (contentType === 'file') {
        if (sourceDocument.fileId) {
            // Source binary lives in GridFS — give the clone its own copy so the
            // two documents can be deleted independently.
            const copiedFileId = await gridfs.copyFile(db, sourceDocument.fileId);
            if (copiedFileId) {
                documentData.fileId = copiedFileId;
            }
        } else if (fileBuffer) {
            // Legacy inline binary.
            documentData.fileData = fileBuffer;
        }
    }

    const createdDocument = await DocumentModel.uploadDocument(db, documentData);
    const warnings = [];
    const sourceStatus = sourceDocument.status || 'uploaded';
    await DocumentModel.updateDocumentStatus(db, createdDocument.documentId, sourceStatus);

    // A document can hold indexes in several embedding profiles (e.g. it was
    // embedded with OpenAI, then again with Qwen for a Sandbox bucket). Clone
    // each profile's vectors into that same profile's collection under the NEW
    // document/course id — never across profiles. Anything that cannot be
    // cloned is left out of embeddingIndexes so it is rebuilt on demand rather
    // than being reused under the wrong profile.
    const sourceIndexes = indexesOf(sourceDocument);
    const profileKeys = Object.keys(sourceIndexes);
    const targetHash = contentHash(documentData.content);
    const clonedIndexes = {};

    for (const profileKey of profileKeys) {
        const record = sourceIndexes[profileKey];
        if (!record || record.status !== INDEX_STATUSES.READY || !record.collection) continue;

        try {
            const profileService = await getTransferQdrantService(qdrantService, record);
            const cloneResult = await profileService.cloneDocumentChunks({
                sourceDocumentId: sourceDocument.documentId,
                targetDocumentId: createdDocument.documentId,
                targetCourseId,
                targetLectureName: lectureName,
                targetFileName: documentData.filename,
                targetMimeType: documentData.mimeType,
                targetDocumentType: documentData.documentType,
                targetType: createdDocument.type
            });

            if (!cloneResult.success) {
                warnings.push(`Chunk transfer failed for "${documentData.originalName}" (${profileKey}): ${cloneResult.error}`);
                continue;
            }
            if (cloneResult.clonedCount === 0) {
                // Reaching this branch already means the explicit profile
                // record claimed ready vectors. Document lifecycle status is
                // unrelated (`uploaded` is terminal), so a zero-vector clone
                // is always worth reporting.
                warnings.push(`No stored chunks were found to transfer for "${documentData.originalName}" (${profileKey}).`);
                continue;
            }

            // Only claim the clone is current when the content really matches
            // what the source index was built from.
            if (record.contentHash && record.contentHash !== targetHash) {
                warnings.push(`"${documentData.originalName}" will be re-indexed for ${profileKey}: content differs from the source index.`);
                continue;
            }

            clonedIndexes[profileKey] = {
                ...record,
                contentHash: targetHash,
                indexedAt: new Date()
            };
        } catch (error) {
            warnings.push(`Chunk transfer failed for "${documentData.originalName}" (${profileKey}): ${error.message}`);
        }
    }

    if (Object.keys(clonedIndexes).length > 0) {
        await db.collection('documents').updateOne(
            { documentId: createdDocument.documentId },
            { $set: { embeddingIndexes: clonedIndexes, updatedAt: new Date() } }
        );
    }

    return {
        document: createdDocument,
        reference: {
            documentId: createdDocument.documentId,
            documentType: documentData.documentType,
            filename: documentData.filename,
            originalName: documentData.originalName,
            mimeType: documentData.mimeType,
            size: documentData.size,
            status: sourceStatus,
            metadata
        },
        warnings
    };
}

/**
 * POST /api/courses
 * Create a new course for an instructor (updated for onboarding)
 */
router.post('/', async (req, res) => {
    try {
        // Get authenticated user information
        const user = req.user;
        if (!user) {
            return res.status(401).json({
                success: false,
                message: 'Authentication required'
            });
        }
        
        // Only instructors can create courses
        if (user.role !== 'instructor') {
            return res.status(403).json({
                success: false,
                message: 'Only instructors can create courses'
            });
        }
        
        const { course, weeks, lecturesPerWeek, contentTypes, apiKey } = req.body;
        const normalizedContentTypes = contentTypes === undefined ? [] : contentTypes;
        
        // Use authenticated user's ID
        const instructorId = user.userId;
        
        // Validate required fields
        if (!course || !weeks || !lecturesPerWeek) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields: course, weeks, lecturesPerWeek'
            });
        }

        if (!Array.isArray(normalizedContentTypes)) {
            return res.status(400).json({
                success: false,
                message: 'contentTypes must be an array'
            });
        }
        
        // Validate weeks is a positive number
        if (isNaN(weeks) || weeks < 1 || weeks > 20) {
            return res.status(400).json({
                success: false,
                message: 'Weeks must be a number between 1 and 20'
            });
        }
        
        // Validate lectures per week
        if (isNaN(lecturesPerWeek) || lecturesPerWeek < 1 || lecturesPerWeek > 5) {
            return res.status(400).json({
                success: false,
                message: 'Lectures per week must be a number between 1 and 5'
            });
        }
        
        // Get database instance from app.locals
        const db = req.app.locals.db;
        if (!db) {
            return res.status(503).json({
                success: false,
                message: 'Database connection not available'
            });
        }

        // The instructor picks a platform (GPT or Sandbox); the key is
        // validated against that platform's configured models.
        const selectedProvider = normalizeProvider(req.body.llmProvider);
        const validation = await providerKeys.validateForProvider(db, selectedProvider, apiKey);
        if (!validation.ok) {
            return res.status(400).json({
                success: false,
                code: providerKeys.errorCodeForStatus(validation.status),
                message: validation.message
                    || `A valid ${providerLabel(selectedProvider)} API key is required to create a course.`,
                detail: validation.detail,
                llmProvider: selectedProvider
            });
        }
        
        // Generate course ID
        const courseId = generateCourseId(course);
        
        // Create course structure
        const courseStructure = {
            weeks: parseInt(weeks),
            lecturesPerWeek: parseInt(lecturesPerWeek),
            totalUnits: weeks * lecturesPerWeek
        };
        
        // Prepare onboarding data for course creation
        const onboardingData = {
            courseId,
            courseName: course,
            instructorId,
            courseDescription: `Course: ${course}`,
            learningOutcomes: [],
            assessmentCriteria: '',
            courseMaterials: normalizedContentTypes,
            unitFiles: {},
            courseStructure
        };
        
        // Create course in database using Course model
        const result = await CourseModel.createCourseFromOnboarding(db, onboardingData);
        
        if (!result.success) {
            return res.status(500).json({
                success: false,
                message: 'Failed to create course in database'
            });
        }

        const llmApiKey = buildKeySubdocument(apiKey, user.userId, selectedProvider);
        await db.collection('courses').updateOne(
            { courseId },
            { $set: { ...credentialSetFields(selectedProvider, llmApiKey), updatedAt: new Date() } }
        );
        const courseScope = { type: 'course', id: courseId };
        await scopeModelSettings.materialize(db, courseScope, { updatedBy: user.userId });
        if (Array.isArray(validation.models)) {
            await scopeModelSettings.applyCredentialRoster(
                db,
                courseScope,
                selectedProvider,
                validation.models,
                user.userId,
                validation.defaultConfiguration
            );
        }
        const scopedSettings = await scopeModelSettings.getAll(db, courseScope);

        if (req.app.locals.llmRegistry) {
            req.app.locals.llmRegistry.evictCourse(courseId);
        }
        
        console.log('Course created in database:', { courseId, course, instructorId });
        
        res.status(201).json({
            success: true,
            message: 'Course created successfully',
            data: {
                id: courseId,
                name: course,
                weeks: parseInt(weeks),
                lecturesPerWeek: parseInt(lecturesPerWeek),
                contentTypes: normalizedContentTypes,
                instructorId: instructorId,
                llmKey: publicKeySummary(llmApiKey),
                llmConfigurationStatus: scopedSettings.providers[selectedProvider].configurationStatus,
                aiAvailable: scopedSettings.providers[selectedProvider].configurationStatus === scopeModelSettings.READY,
                createdAt: new Date().toISOString(),
                status: 'active',
                structure: generateCourseStructure(weeks, lecturesPerWeek, normalizedContentTypes),
                totalUnits: result.totalUnits
            }
        });
        
    } catch (error) {
        console.error('Error creating course:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error'
        });
    }
});

/**
 * Generate course structure based on weeks and content types
 */
function generateCourseStructure(weeks, lecturesPerWeek, contentTypes) {
    const structure = {
        weeks: [],
        specialFolders: []
    };
    
    // Generate week folders
    for (let week = 1; week <= weeks; week++) {
        structure.weeks.push({
            id: `week-${week}`,
            name: `Week ${week}`,
            lectures: lecturesPerWeek,
            documents: []
        });
    }
    
    if (contentTypes.includes('practice-quizzes')) {
        structure.specialFolders.push({
            id: 'quizzes',
            name: 'Practice Quizzes',
            type: 'quiz'
        });
    }
    
    return structure;
}

/**
 * POST /api/courses/:courseId/content
 * Upload content to a specific course
 */
router.post('/:courseId/content', async (req, res) => {
    try {
        const { courseId } = req.params;
        const { title, description, week, type, instructorId } = req.body;
        
        // Validate required fields
        if (!title || !week || !type || !instructorId) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields: title, week, type, instructorId'
            });
        }
        
        // TODO: In a real implementation, this would:
        // 1. Validate instructor permissions for this course
        // 2. Handle file upload (multipart/form-data)
        // 3. Process document (parse, chunk, embed)
        // 4. Store in database and vector store
        // 5. Update course structure
        
        const contentData = {
            id: createId('content'),
            courseId: courseId,
            title: title,
            description: description || '',
            week: parseInt(week),
            type: type,
            instructorId: instructorId,
            uploadedAt: new Date().toISOString(),
            status: 'processing',
            fileSize: req.body.fileSize || 0,
            fileName: req.body.fileName || ''
        };
        
        console.log('Content uploaded:', contentData);
        
        res.status(201).json({
            success: true,
            message: 'Content uploaded successfully',
            data: contentData
        });
        
    } catch (error) {
        console.error('Error uploading content:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error'
        });
    }
});

/**
 * GET /api/courses
 * Get all courses for an instructor
 */
router.get('/', async (req, res) => {
    try {
        // Get authenticated user information
        const user = req.user;
        if (!user) {
            return res.status(401).json({
                success: false,
                message: 'Authentication required'
            });
        }
        
        // Only instructors can access their courses
        if (user.role !== 'instructor') {
            return res.status(403).json({
                success: false,
                message: 'Only instructors can access courses'
            });
        }
        
        // Use authenticated user's ID
        const instructorId = user.userId;
        
        // Get database instance from app.locals
        const db = req.app.locals.db;
        if (!db) {
            return res.status(503).json({
                success: false,
                message: 'Database connection not available'
            });
        }
        
        // Query database for instructor's courses (exclude soft-deleted).
        const collection = db.collection('courses');
        const courseQuery = hasSystemAdminAccess(user)
            ? { status: { $ne: 'deleted' } }
            : { instructorId, status: { $ne: 'deleted' } };
        const courses = await collection.find(courseQuery).toArray();
        
        // Transform the data to match expected format
        const transformedCourses = courses.map(course => ({
            id: course.courseId,
            name: course.courseName,
            llmKey: publicProviderKeyState(course).llmKey,
            llmProvider: publicProviderKeyState(course).llmProvider,
            aiAvailable: publicProviderKeyState(course).aiAvailable,
            weeks: course.courseStructure?.weeks || 0,
            lecturesPerWeek: course.courseStructure?.lecturesPerWeek || 0,
            instructorId: course.instructorId,
            createdAt: course.createdAt?.toISOString() || new Date().toISOString(),
            status: course.status || 'active',
            documentCount: course.lectures?.reduce((total, lecture) => total + (lecture.documents?.length || 0), 0) || 0,
            studentCount: 0, // TODO: Implement student tracking
            totalUnits: course.courseStructure?.totalUnits || 0
        }));
        
        res.json({
            success: true,
            data: transformedCourses
        });
        
    } catch (error) {
        console.error('Error fetching courses:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error'
        });
    }
});

/**
 * GET /api/courses/statistics
 * Get aggregated statistics for all instructor/TA courses
 * NOTE: This route must come before /:courseId to avoid route matching issues
 */
router.get('/statistics', async (req, res) => {
    try {
        // Get authenticated user information
        const user = req.user;
        if (!user) {
            return res.status(401).json({
                success: false,
                message: 'Authentication required'
            });
        }
        
        // Only instructors and assigned TAs can access statistics
        if (user.role !== 'instructor' && user.role !== 'ta') {
            return res.status(403).json({
                success: false,
                message: 'Only instructors and TAs can access statistics'
            });
        }
        
        // Get database instance from app.locals
        const db = req.app.locals.db;
        if (!db) {
            return res.status(503).json({
                success: false,
                message: 'Database connection not available'
            });
        }
        
        // Get courseId from query params if provided
        const { courseId: requestedCourseId } = req.query;
        
        // Get all courses for this instructor or TA
        const coursesCollection = db.collection('courses');
        let coursesQuery = { status: { $ne: 'deleted' } };

        if (user.role === 'instructor') {
            coursesQuery.$or = [
                { instructorId: user.userId },
                { instructors: user.userId }
            ];
        } else {
            coursesQuery.tas = user.userId;
        }
        
        // If a specific courseId is requested, filter to that course
        if (requestedCourseId) {
            coursesQuery.courseId = requestedCourseId;
        }
        
        const courses = await coursesCollection.find(coursesQuery).toArray();
        
        if (courses.length === 0) {
            return res.json({
                success: true,
                data: {
                    totalStudents: 0,
                    totalSessions: 0,
                    modeDistribution: { tutor: 0, protege: 0 },
                    averageSessionLength: 0,
                    averageMessagesPerSession: 0,
                    averageMessageLength: 0
                }
            });
        }
        
        const courseIds = courses.map(c => c.courseId);
        
        // Get all chat sessions for these courses
        const chatSessionsCollection = db.collection('chat_sessions');
        const allSessions = await chatSessionsCollection.find({
            courseId: { $in: courseIds },
            // Sandbox transcripts from "View as Student" would inflate student
            // counts and skew every average below.
            ...previewSession.excludePreviewFilter('studentId'),
            $or: [
                { isDeleted: { $exists: false } },
                { isDeleted: false }
            ]
        }).toArray();
        
        // Calculate statistics
        const uniqueStudents = new Set();
        let totalMessages = 0;
        let totalMessageLength = 0;
        let messageCount = 0;
        let modeDistribution = { tutor: 0, protege: 0 };
        let totalSessionDurationMs = 0;
        let sessionsWithDuration = 0;
        
        allSessions.forEach(session => {
            const durationMs = calculateMeasuredSessionDurationMs(session);

            // Empty/instantaneous autosaves are not real dashboard sessions.
            // Exclude them from the count and every per-session aggregation so
            // totals, mode distribution, and averages stay internally aligned.
            if (durationMs <= 0) return;

            totalSessionDurationMs += durationMs;
            sessionsWithDuration++;

            // Count unique students
            if (session.studentId) {
                uniqueStudents.add(session.studentId);
            }
            
            // Get mode from chatData
            if (session.chatData && session.chatData.metadata) {
                const mode = session.chatData.metadata.currentMode || 'tutor';
                if (mode === 'protege' || mode === 'protégé') {
                    modeDistribution.protege++;
                } else {
                    modeDistribution.tutor++;
                }
            } else {
                // Default to tutor if mode not found
                modeDistribution.tutor++;
            }
            
            // Calculate message statistics
            if (session.chatData && session.chatData.messages && Array.isArray(session.chatData.messages)) {
                const messages = session.chatData.messages;
                totalMessages += messages.length;
                
                messages.forEach(msg => {
                    if (msg.content && typeof msg.content === 'string') {
                        totalMessageLength += msg.content.length;
                        messageCount++;
                    }
                });
            }
            
        });
        
        // Calculate averages
        const totalSessions = sessionsWithDuration;
        const averageSessionLength = sessionsWithDuration > 0 
            ? Math.round(totalSessionDurationMs / sessionsWithDuration / 1000) // in seconds
            : 0;
        const averageMessagesPerSession = totalSessions > 0 
            ? Math.round((totalMessages / totalSessions) * 10) / 10 
            : 0;
        const averageMessageLength = messageCount > 0 
            ? Math.round(totalMessageLength / messageCount) 
            : 0;
        
        // Format average session length
        const formatDuration = (seconds) => {
            if (seconds < 60) {
                return `${seconds}s`;
            } else if (seconds < 3600) {
                const minutes = Math.floor(seconds / 60);
                const secs = seconds % 60;
                return `${minutes}m ${secs}s`;
            } else {
                const hours = Math.floor(seconds / 3600);
                const minutes = Math.floor((seconds % 3600) / 60);
                return `${hours}h ${minutes}m`;
            }
        };
        
        res.json({
            success: true,
            data: {
                totalStudents: uniqueStudents.size,
                totalSessions: totalSessions,
                modeDistribution: modeDistribution,
                averageSessionLength: formatDuration(averageSessionLength),
                averageSessionLengthSeconds: averageSessionLength,
                averageMessagesPerSession: averageMessagesPerSession,
                averageMessageLength: averageMessageLength
            }
        });
        
    } catch (error) {
        console.error('Error fetching statistics:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error while fetching statistics'
        });
    }
});

/**
 * GET /api/courses/:courseId
 * Get course details (for instructors)
 */
router.get('/:courseId', async (req, res) => {
    try {
        const { courseId } = req.params;
        
        // Get authenticated user information
        const user = req.user;
        if (!user) {
            return res.status(401).json({
                success: false,
                message: 'Authentication required'
            });
        }
        
        // Use authenticated user's ID
        const instructorId = user.userId;
        
        // Check if user is instructor or student
        if (user.role === 'student') {
            console.log(`Student request for course: ${courseId}`);
            return await getCourseForStudent(req, res, courseId);
        }
        
        console.log(`${user.role} request for course: ${courseId}, user: ${instructorId}`);
        
        // Get database instance from app.locals
        const db = req.app.locals.db;
        if (!db) {
            return res.status(503).json({
                success: false,
                message: 'Database connection not available'
            });
        }
        
        // Query database for course details (check instructorId, instructors array, and tas array)
        const collection = db.collection('courses');
        const course = await collection.findOne({
            courseId: courseId,
            $or: [
                { instructorId: instructorId },
                { instructors: { $in: [instructorId] } },
                { tas: { $in: [instructorId] } }
            ]
        });
        
        if (!course) {
            return res.status(404).json({
                success: false,
                message: 'Course not found'
            });
        }
        
        // Transform the data to match expected format
        const transformedCourse = {
            id: course.courseId,
            courseId: course.courseId,
            name: course.courseName,
            courseName: course.courseName,
            llmKey: publicProviderKeyState(course).llmKey,
            llmProvider: publicProviderKeyState(course).llmProvider,
            aiAvailable: publicProviderKeyState(course).aiAvailable,
            courseCode: course.courseCode, // Backward compatible student code field
            studentCourseCode: course.courseCode,
            instructorCourseCode: course.instructorCourseCode,
            approvedStruggleTopics: CourseModel.normalizeTopicList(course.approvedStruggleTopics || []),
            approvedStruggleTopicDetails: CourseModel.normalizeTopicObjectList(course.approvedStruggleTopics || []),
            weeks: course.courseStructure?.weeks || 0,
            lecturesPerWeek: course.courseStructure?.lecturesPerWeek || 0,
            // Stored year level, or a sensible default derived from the course
            // name for courses created before this field existed.
            yearLevel: CourseModel.normalizeYearLevel(course.yearLevel)
                ?? CourseModel.parseYearLevelFromName(course.courseName),
            isAdditiveRetrieval: !!course.isAdditiveRetrieval,
            instructorId: course.instructorId,
            createdAt: course.createdAt?.toISOString() || new Date().toISOString(),
            status: course.status || 'active',
            documentCount: course.lectures?.reduce((total, lecture) => total + (lecture.documents?.length || 0), 0) || 0,
            studentCount: 0, // TODO: Implement student tracking
            // Include lectures array that instructors expect (with documents, learning objectives, and assessment questions)
            lectures: course.lectures?.map(lecture => ({
                id: lecture.id || lecture.name,
                name: lecture.name,
                displayName: lecture.displayName || null,
                showUnitNumber: lecture.showUnitNumber !== false,
                isPublished: lecture.isPublished || false,
                documents: lecture.documents || [],
                questions: lecture.questions || [],
                learningObjectives: lecture.learningObjectives || [],
                assessmentQuestions: lecture.assessmentQuestions || [],
                passThreshold: lecture.passThreshold
            })) || [],
            structure: {
                weeks: course.lectures?.map((lecture, index) => ({
                    id: `week-${Math.floor(index / (course.courseStructure?.lecturesPerWeek || 1)) + 1}`,
                    name: `Week ${Math.floor(index / (course.courseStructure?.lecturesPerWeek || 1)) + 1}`,
                    lectures: course.courseStructure?.lecturesPerWeek || 0,
                    documents: lecture.documents?.length || 0
                })) || [],
                specialFolders: [
                    { id: 'quizzes', name: 'Practice Quizzes', type: 'quiz' }
                ]
            }
        };
        
        res.json({
            success: true,
            data: transformedCourse
        });
        
    } catch (error) {
        console.error('Error fetching course:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error'
        });
    }
});

/**
 * GET /api/courses/:courseId/approved-topics
 * Fetch the per-course approved struggle topic list
 */
router.get('/:courseId/approved-topics', async (req, res) => {
    try {
        const { courseId } = req.params;
        const user = req.user;

        if (!user) {
            return res.status(401).json({ success: false, message: 'Authentication required' });
        }

        const db = req.app.locals.db;
        if (!db) {
            return res.status(503).json({ success: false, message: 'Database connection not available' });
        }

        const course = await CourseModel.getCourseById(db, courseId);
        if (!course) {
            return res.status(404).json({ success: false, message: 'Course not found' });
        }

        let hasAccess = false;
        if (user.role === 'instructor' || user.role === 'ta') {
            hasAccess = hasInstructorOrTAAccess(course, user.userId);
        } else if (user.role === 'student') {
            const enrollment = await CourseModel.getStudentEnrollment(db, courseId, user.userId);
            hasAccess = enrollment.success && enrollment.enrolled === true;
        }

        if (!hasAccess) {
            return res.status(403).json({
                success: false,
                message: 'You do not have access to this course'
            });
        }

        const topics = await CourseModel.getApprovedStruggleTopicObjects(db, courseId);
        return res.json({
            success: true,
            data: {
                courseId,
                topics,
                topicLabels: CourseModel.normalizeTopicList(topics)
            }
        });
    } catch (error) {
        console.error('Error fetching approved topics:', error);
        return res.status(500).json({
            success: false,
            message: 'Internal server error while fetching approved topics'
        });
    }
});

/**
 * PUT /api/courses/:courseId/approved-topics
 * Replace the approved struggle topic list for a course
 */
router.put('/:courseId/approved-topics', async (req, res) => {
    try {
        const { courseId } = req.params;
        const { topics } = req.body;
        const user = req.user;

        if (!user) {
            return res.status(401).json({ success: false, message: 'Authentication required' });
        }

        if (!Array.isArray(topics)) {
            return res.status(400).json({ success: false, message: 'topics must be an array' });
        }

        const db = req.app.locals.db;
        if (!db) {
            return res.status(503).json({ success: false, message: 'Database connection not available' });
        }

        const course = await CourseModel.getCourseById(db, courseId);
        if (!course) {
            return res.status(404).json({ success: false, message: 'Course not found' });
        }

        const hasAccess = await hasCourseManagementAccess(db, course, user);
        if (!hasAccess) {
            return res.status(403).json({
                success: false,
                message: 'Only instructors/TAs with course management access can update approved topics'
            });
        }

        const result = await CourseModel.setApprovedStruggleTopics(db, courseId, topics, user.userId);
        if (!result.success) {
            return res.status(404).json({
                success: false,
                message: result.error || 'Course not found'
            });
        }

        return res.json({
            success: true,
            message: 'Approved struggle topics updated',
            data: {
                courseId,
                topics: result.topics,
                topicLabels: result.topicLabels
            }
        });
    } catch (error) {
        console.error('Error updating approved topics:', error);
        return res.status(500).json({
            success: false,
            message: 'Internal server error while updating approved topics'
        });
    }
});

/**
 * PATCH /api/courses/:courseId/approved-topics/unit
 * Assign or reassign one approved struggle topic to a stable unit name.
 */
router.patch('/:courseId/approved-topics/unit', async (req, res) => {
    try {
        const { courseId } = req.params;
        const { topic, unitId } = req.body;
        const user = req.user;

        if (!user) {
            return res.status(401).json({ success: false, message: 'Authentication required' });
        }

        const db = req.app.locals.db;
        if (!db) {
            return res.status(503).json({ success: false, message: 'Database connection not available' });
        }

        const course = await CourseModel.getCourseById(db, courseId);
        if (!course) {
            return res.status(404).json({ success: false, message: 'Course not found' });
        }

        const hasAccess = await hasCourseManagementAccess(db, course, user);
        if (!hasAccess) {
            return res.status(403).json({
                success: false,
                message: 'Only instructors/TAs with course management access can update approved topics'
            });
        }

        const result = await CourseModel.updateApprovedStruggleTopicUnit(
            db,
            courseId,
            topic,
            unitId || null,
            user.userId
        );

        if (!result.success) {
            const status = result.error === 'Course not found' || result.error === 'Approved topic not found'
                ? 404
                : 400;
            return res.status(status).json({
                success: false,
                message: result.error || 'Failed to update topic unit'
            });
        }

        return res.json({
            success: true,
            message: 'Topic unit updated',
            data: {
                courseId,
                topic: result.topic,
                topics: result.topics,
                topicLabels: result.topicLabels
            }
        });
    } catch (error) {
        console.error('Error updating approved topic unit:', error);
        return res.status(500).json({
            success: false,
            message: 'Internal server error while updating topic unit'
        });
    }
});

/**
 * POST /api/courses/:courseId/extract-topics
 * Extract suggested topics from uploaded content using LLM
 */
router.post('/:courseId/extract-topics', async (req, res) => {
    try {
        const { courseId } = req.params;
        const { documentId, content, maxTopics } = req.body;
        const user = req.user;

        if (!user) {
            return res.status(401).json({ success: false, message: 'Authentication required' });
        }

        const db = req.app.locals.db;
        if (!db) {
            return res.status(503).json({ success: false, message: 'Database connection not available' });
        }

        const course = await CourseModel.getCourseById(db, courseId);
        if (!course) {
            return res.status(404).json({ success: false, message: 'Course not found' });
        }

        if (!hasInstructorOrTAAccess(course, user.userId)) {
            return res.status(403).json({
                success: false,
                message: 'Only instructors/TAs with course access can extract topics'
            });
        }

        let sourceContent = typeof content === 'string' ? content : '';
        if (!sourceContent && documentId) {
            const document = await DocumentModel.getDocumentById(db, documentId);
            if (!document || document.courseId !== courseId) {
                return res.status(404).json({
                    success: false,
                    message: 'Document not found in this course'
                });
            }

            // When the course de-prioritizes additional materials (secondary
            // search enabled), struggle topics are not picked from them.
            const isAdditionalMaterial = document.documentType === 'additional' || document.type === 'additional';
            if (isAdditionalMaterial && course.additionalMaterialSecondarySearch === true) {
                return res.json({
                    success: true,
                    data: {
                        courseId,
                        topics: [],
                        skippedAdditionalMaterial: true
                    }
                });
            }

            sourceContent = typeof document.content === 'string' ? document.content : '';
        }

        sourceContent = sourceContent.trim();
        if (!sourceContent) {
            return res.status(400).json({
                success: false,
                message: 'No document content available for topic extraction'
            });
        }

        const topicLimit = Math.min(Math.max(parseInt(maxTopics, 10) || 8, 1), 15);
        const ai = await resolveCourseAi(req, res, courseId);
        if (!ai) return;
        const llm = ai.llm;
        let suggestedTopics = [];

        if (llm && typeof llm.sendMessage === 'function') {
            const contentBatches = splitTopicExtractionBatches(sourceContent);
            const extractionOptions = {
                lane: LANES.BACKEND,
                temperature: 0.1,
                maxTokens: 300,
                systemPrompt: 'You extract concise chemistry and biochemistry topic labels only. If the content is not chemistry or biochemistry, return {"topics":[]}. Return strict JSON only.'
            };

            if (contentBatches.length === 1) {
                const prompt = buildTopicExtractionPrompt(contentBatches[0], topicLimit);
                const llmResponse = await llm.sendMessage(prompt, extractionOptions);
                const parsed = extractFirstJSONObject(llmResponse?.content || '');
                if (parsed && Array.isArray(parsed.topics)) {
                    suggestedTopics = parsed.topics;
                }
            } else {
                const candidateLimit = Math.min(topicLimit, TOPIC_CANDIDATES_PER_BATCH);
                const candidateTopics = [];

                for (const batch of contentBatches) {
                    const prompt = buildTopicExtractionPrompt(batch, candidateLimit);
                    const llmResponse = await llm.sendMessage(prompt, extractionOptions);
                    const parsed = extractFirstJSONObject(llmResponse?.content || '');
                    if (parsed && Array.isArray(parsed.topics)) {
                        candidateTopics.push(...parsed.topics);
                    }
                }

                const filteredCandidates = filterChemistryTopics(candidateTopics);
                if (filteredCandidates.length > 0) {
                    const consolidationPrompt = buildTopicConsolidationPrompt(filteredCandidates, topicLimit);
                    const consolidationResponse = await llm.sendMessage(consolidationPrompt, {
                        lane: LANES.BACKEND,
                        temperature: 0.1,
                        maxTokens: 300,
                        systemPrompt: 'You consolidate and deduplicate chemistry and biochemistry topic labels. Return strict JSON only.'
                    });
                    const parsed = extractFirstJSONObject(consolidationResponse?.content || '');
                    if (parsed && Array.isArray(parsed.topics)) {
                        suggestedTopics = parsed.topics;
                    }
                }
            }
        } else {
            console.warn('LLM service unavailable for /extract-topics; returning empty suggestions');
        }

        suggestedTopics = filterChemistryTopics(suggestedTopics).slice(0, topicLimit);

        return res.json({
            success: true,
            data: {
                courseId,
                topics: suggestedTopics
            }
        });
    } catch (error) {
        console.error('Error extracting topics from course content:', error);
        return res.status(500).json({
            success: false,
            message: 'Internal server error while extracting topics'
        });
    }
});

/**
 * Helper function to get course data for students
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {string} courseId - Course ID
 */
async function getCourseForStudent(req, res, courseId) {
    try {
        console.log(`Getting course data for student: ${courseId}`);
        
        // Get database instance from app.locals
        const db = req.app.locals.db;
        if (!db) {
            return res.status(503).json({
                success: false,
                message: 'Database connection not available'
            });
        }
        
        // Query database for course details (any instructor)
        const collection = db.collection('courses');
        const course = await collection.findOne({ courseId });
        
        if (!course) {
            console.log(`Course not found: ${courseId}`);
            return res.status(404).json({
                success: false,
                message: 'Course not found'
            });
        }

        const enrollment = await CourseModel.getStudentEnrollment(db, courseId, req.user.userId);
        if (!enrollment.success) {
            return res.status(404).json({
                success: false,
                message: 'Course not found'
            });
        }

        if (!enrollment.enrolled) {
            return res.status(403).json({
                success: false,
                message: enrollment.reason === 'course_inactive'
                    ? 'This course is currently deactivated by the instructor.'
                    : 'Your access to this course is disabled by the instructor.'
            });
        }
        
        console.log(`Course found: ${courseId}, lectures count: ${course.lectures?.length || 0}`);
        console.log('Raw course data from DB:', JSON.stringify(course, null, 2));
        console.log('Course lectures structure:', course.lectures);
        
        // Transform the data to include lectures array that students expect
        const transformedCourse = {
            id: course.courseId,
            name: course.courseName,
            llmKey: publicProviderKeyState(course).llmKey,
            llmProvider: publicProviderKeyState(course).llmProvider,
            aiAvailable: publicProviderKeyState(course).aiAvailable,
            approvedStruggleTopics: CourseModel.normalizeTopicList(course.approvedStruggleTopics || []),
            approvedStruggleTopicDetails: CourseModel.normalizeTopicObjectList(course.approvedStruggleTopics || []),
            weeks: course.courseStructure?.weeks || 0,
            lecturesPerWeek: course.courseStructure?.lecturesPerWeek || 0,
            // Stored year level, or a sensible default derived from the course
            // name for courses created before this field existed.
            yearLevel: CourseModel.normalizeYearLevel(course.yearLevel)
                ?? CourseModel.parseYearLevelFromName(course.courseName),
            isAdditiveRetrieval: !!course.isAdditiveRetrieval,
            studentIdleTimeout: course.prompts?.studentIdleTimeout || 240, // Default 4 minutes
            studentSessionTimeout: course.prompts?.studentSessionTimeout || 1800, // Default 30 minutes
            createdAt: course.createdAt?.toISOString() || new Date().toISOString(),
            status: course.status || 'active',
            // Include lectures array that students expect
            lectures: course.lectures?.map(lecture => ({
                id: lecture.id || lecture.name,
                name: lecture.name,
                displayName: lecture.displayName || null,
                showUnitNumber: lecture.showUnitNumber !== false,
                isPublished: lecture.isPublished || false,
                documents: lecture.documents || [],
                questions: lecture.questions || [],
                passThreshold: lecture.passThreshold
            })) || [],
            // Keep structure for compatibility
            structure: {
                weeks: course.lectures?.map((lecture, index) => ({
                    id: `week-${Math.floor(index / (course.courseStructure?.lecturesPerWeek || 1)) + 1}`,
                    name: `Week ${Math.floor(index / (course.courseStructure?.lecturesPerWeek || 1)) + 1}`,
                    lectures: course.courseStructure?.lecturesPerWeek || 0,
                    documents: lecture.documents?.length || 0
                })) || [],
                specialFolders: [
                    { id: 'quizzes', name: 'Practice Quizzes', type: 'quiz' }
                ]
            }
        };
        
        console.log(`Transformed course data:`, {
            courseId: transformedCourse.id,
            name: transformedCourse.name,
            lecturesCount: transformedCourse.lectures.length,
            publishedLectures: transformedCourse.lectures.filter(l => l.isPublished).length,
            lecturesDetails: transformedCourse.lectures.map(l => ({ name: l.name, isPublished: l.isPublished, hasDocuments: l.documents.length > 0, hasQuestions: l.questions.length > 0 }))
        });
        console.log('Full transformed course data:', JSON.stringify(transformedCourse, null, 2));
        
        res.json({
            success: true,
            data: transformedCourse
        });
        
    } catch (error) {
        console.error('Error fetching course for student:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error'
        });
    }
}

/**
 * PUT /api/courses/:courseId
 * Update course details
 */
router.put('/:courseId', async (req, res) => {
    try {
        const { courseId } = req.params;
        const { name, weeks, lecturesPerWeek, status, isAdditiveRetrieval, lectures, yearLevel, instructorId: bodyInstructorId } = req.body;
        // Accept instructorId from query param or body (for compatibility)
        const instructorId = req.query.instructorId || bodyInstructorId;
        
        if (!instructorId) {
            return res.status(400).json({
                success: false,
                message: 'instructorId is required (as query parameter or in body)'
            });
        }
        
        // Get database instance from app.locals
        const db = req.app.locals.db;
        if (!db) {
            return res.status(503).json({
                success: false,
                message: 'Database connection not available'
            });
        }

        const user = req.user;
        if (!user) {
            return res.status(401).json({ success: false, message: 'Authentication required' });
        }

        if (user.role !== 'instructor' || instructorId !== user.userId) {
            return res.status(403).json({
                success: false,
                message: 'You do not have permission to update this course'
            });
        }
        
        // Check if instructor has access to the course
        const hasAccess = await CourseModel.userHasCourseAccess(db, courseId, user.userId, 'instructor');
        if (!hasAccess) {
            return res.status(403).json({
                success: false,
                message: 'You do not have permission to update this course'
            });
        }
        
        // Update course in database
        const collection = db.collection('courses');
        const updateData = {
            updatedAt: new Date()
        };
        
        if (name) updateData.courseName = name;
        if (status !== undefined) {
            if (!CourseModel.isValidCourseStatus(status)) {
                return res.status(400).json({
                    success: false,
                    message: `status must be one of: ${CourseModel.COURSE_STATUS_VALUES.join(', ')}`
                });
            }
            updateData.status = CourseModel.normalizeCourseStatus(status);
        }
        if (typeof isAdditiveRetrieval === 'boolean') updateData.isAdditiveRetrieval = isAdditiveRetrieval;
        // Year level: accept 1-5 (5 = Graduate), or null to clear back to "not set"
        if (yearLevel !== undefined) {
            updateData.yearLevel = yearLevel === null ? null : CourseModel.normalizeYearLevel(yearLevel);
        }
        if (weeks || lecturesPerWeek) {
            updateData.courseStructure = {
                weeks: weeks || 0,
                lecturesPerWeek: lecturesPerWeek || 0,
                totalUnits: (weeks || 0) * (lecturesPerWeek || 0)
            };
        }

        // Handle prompts update
        if (req.body.prompts) {
            updateData.prompts = req.body.prompts;
        } else if (req.body.base || req.body.protege || req.body.tutor) {
            // Backward compatibility / flatten structure if sent individually
            const currentCourse = await collection.findOne({ courseId });
            const currentPrompts = currentCourse.prompts || {};
            
            updateData.prompts = {
                ...currentPrompts,
                ...(req.body.base && { base: req.body.base }),
                ...(req.body.protege && { protege: req.body.protege }),
                ...(req.body.tutor && { tutor: req.body.tutor })
            };
        }
        
        // Allow updating lectures array if provided (for document removal fallback)
        if (lectures && Array.isArray(lectures)) {
            updateData.lectures = lectures;
        }
        
        // Use $or query to match course by instructorId or instructors array
        const result = await collection.updateOne(
            { 
                courseId,
                $or: [
                    { instructorId: user.userId },
                    { instructors: user.userId }
                ]
            },
            { $set: updateData }
        );
        
        if (result.matchedCount === 0) {
            return res.status(404).json({
                success: false,
                message: 'Course not found or you do not have access'
            });
        }
        
        console.log('Course updated in database:', { courseId, name, weeks, lecturesPerWeek, status, instructorId: user.userId });
        
        res.json({
            success: true,
            message: 'Course updated successfully',
            modifiedCount: result.modifiedCount
        });
        
    } catch (error) {
        console.error('Error updating course:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error'
        });
    }
});

/**
 * POST /api/courses/:courseId/transfer
 * Create a brand-new course copy with selective per-unit transfer options.
 */
router.post('/:courseId/transfer', async (req, res) => {
    try {
        const { courseId } = req.params;
        const {
            newCourseName,
            transferSettings = true,
            transferTAs = true,
            deactivateSourceCourse = false,
            apiKey,
            units = []
        } = req.body;

        const user = req.user;
        if (!user) {
            return res.status(401).json({
                success: false,
                message: 'Authentication required'
            });
        }

        if (user.role !== 'instructor') {
            return res.status(403).json({
                success: false,
                message: 'Only instructors can transfer courses'
            });
        }

        if (!newCourseName || typeof newCourseName !== 'string' || !newCourseName.trim()) {
            return res.status(400).json({
                success: false,
                message: 'A new course name is required'
            });
        }

        const db = req.app.locals.db;
        if (!db) {
            return res.status(503).json({
                success: false,
                message: 'Database connection not available'
            });
        }

        const sourceCourse = await CourseModel.getCourseById(db, courseId);
        if (!sourceCourse) {
            return res.status(404).json({
                success: false,
                message: 'Source course not found'
            });
        }

        const hasInstructorAccess = sourceCourse.instructorId === user.userId ||
            (Array.isArray(sourceCourse.instructors) && sourceCourse.instructors.includes(user.userId));

        if (!hasInstructorAccess) {
            return res.status(403).json({
                success: false,
                message: 'You do not have permission to transfer this course'
            });
        }

        const transferProvider = normalizeProvider(
            req.body && req.body.llmProvider,
            activeProviderOf(sourceCourse)
        );
        const validation = await providerKeys.validateForProvider(db, transferProvider, apiKey);
        if (!validation.ok) {
            return res.status(400).json({
                success: false,
                code: providerKeys.errorCodeForStatus(validation.status),
                message: validation.message || 'A valid API key is required for the new course.',
                detail: validation.detail,
                llmProvider: transferProvider
            });
        }

        const sourceLectures = Array.isArray(sourceCourse.lectures) ? sourceCourse.lectures : [];
        const normalizedUnits = Array.isArray(units) ? units.map(normalizeTransferUnitConfig) : [];
        const transferUnitsByName = new Map(
            sourceLectures.map(lecture => {
                const provided = normalizedUnits.find(unit => unit.unitName === lecture.name);
                return [lecture.name, provided || normalizeTransferUnitConfig({ unitName: lecture.name })];
            })
        );

        const now = new Date();
        const targetCourseId = generateCourseId(newCourseName);
        const targetLectures = sourceLectures.map(lecture => {
            const config = transferUnitsByName.get(lecture.name);
            const lectureCopy = {
                name: lecture.name,
                isPublished: false,
                learningObjectives: config.transferLearningObjectives
                    ? deepClone(lecture.learningObjectives || [])
                    : [],
                passThreshold: typeof lecture.passThreshold === 'number' ? lecture.passThreshold : 2,
                createdAt: now,
                updatedAt: now,
                documents: [],
                assessmentQuestions: config.transferAssessmentQuestions
                    ? deepClone(lecture.assessmentQuestions || [])
                    : []
            };

            if (lecture.displayName) {
                lectureCopy.displayName = lecture.displayName;
            }

            if (lecture.materialsConfirmed) {
                lectureCopy.materialsConfirmed = true;
            }

            if (lecture.materialsConfirmedAt) {
                lectureCopy.materialsConfirmedAt = lecture.materialsConfirmedAt;
            }

            return lectureCopy;
        });

        const studentCourseCode = generateCourseCode();
        const instructorCourseCode = generateDistinctCourseCode([studentCourseCode]);

        const targetCourse = {
            courseId: targetCourseId,
            courseName: newCourseName.trim(),
            courseCode: studentCourseCode,
            instructorCourseCode,
            instructorId: user.userId,
            instructors: [user.userId],
            tas: transferTAs ? deepClone(sourceCourse.tas || []) : [],
            taPermissions: transferTAs ? deepClone(sourceCourse.taPermissions || {}) : {},
            courseDescription: sourceCourse.courseDescription || '',
            assessmentCriteria: sourceCourse.assessmentCriteria || '',
            courseMaterials: Array.isArray(sourceCourse.courseMaterials) ? deepClone(sourceCourse.courseMaterials) : [],
            approvedStruggleTopics: deepClone(CourseModel.normalizeTopicObjectList(sourceCourse.approvedStruggleTopics || [])),
            courseStructure: sourceCourse.courseStructure
                ? deepClone(sourceCourse.courseStructure)
                : {
                    weeks: sourceLectures.length,
                    lecturesPerWeek: 1,
                    totalUnits: sourceLectures.length
                },
            isOnboardingComplete: true,
            status: 'active',
            // Inserted document: nested fields, not dotted $set paths.
            ...credentialDocumentFields(transferProvider, buildKeySubdocument(apiKey, user.userId, transferProvider)),
            lectures: targetLectures,
            createdAt: now,
            updatedAt: now,
            lastUpdatedById: user.userId
        };

        if (transferSettings) {
            if (sourceCourse.prompts) {
                targetCourse.prompts = deepClone(sourceCourse.prompts);
            }

            if (sourceCourse.quizSettings) {
                targetCourse.quizSettings = deepClone(sourceCourse.quizSettings);
            }

            if (sourceCourse.questionPrompts) {
                targetCourse.questionPrompts = deepClone(sourceCourse.questionPrompts);
            }

            if (sourceCourse.mentalHealthDetectionPrompt) {
                targetCourse.mentalHealthDetectionPrompt = sourceCourse.mentalHealthDetectionPrompt;
            }

            if (typeof sourceCourse.isAdditiveRetrieval === 'boolean') {
                targetCourse.isAdditiveRetrieval = sourceCourse.isAdditiveRetrieval;
            }

            if (sourceCourse.anonymizeStudents && sourceCourse.anonymizeStudents[user.userId]) {
                targetCourse.anonymizeStudents = {
                    [user.userId]: deepClone(sourceCourse.anonymizeStudents[user.userId])
                };
            }
        }

        await db.collection('courses').insertOne(targetCourse);
        const targetScope = { type: 'course', id: targetCourseId };
        await scopeModelSettings.materialize(db, targetScope, { updatedBy: user.userId });
        if (Array.isArray(validation.models)) {
            await scopeModelSettings.applyCredentialRoster(
                db,
                targetScope,
                transferProvider,
                validation.models,
                user.userId,
                validation.defaultConfiguration
            );
        }
        const targetModelSettings = await scopeModelSettings.getAll(db, targetScope);

        // Per-collection maintenance clients, created lazily for whichever
        // embedding profiles the source documents were actually indexed in.
        const qdrantService = { byCollection: new Map() };
        const transferWarnings = [];
        let documentsCopied = 0;

        for (const lecture of sourceLectures) {
            const config = transferUnitsByName.get(lecture.name);
            const sourceDocuments = await DocumentModel.getDocumentsForLecture(db, courseId, lecture.name);

            if (!config.transferDocuments) {
                continue;
            }

            for (const sourceDocument of sourceDocuments) {
                try {
                    const transferResult = await cloneDocumentForTransfer({
                        db,
                        sourceDocument,
                        targetCourseId,
                        lectureName: lecture.name,
                        instructorId: user.userId,
                        qdrantService
                    });

                    await CourseModel.addDocumentToUnit(
                        db,
                        targetCourseId,
                        lecture.name,
                        transferResult.reference,
                        user.userId
                    );

                    documentsCopied += 1;
                    transferWarnings.push(...transferResult.warnings);
                } catch (error) {
                    transferWarnings.push(`Failed to transfer "${sourceDocument.originalName || sourceDocument.filename || sourceDocument.documentId}" from ${lecture.name}: ${error.message}`);
                }
            }
        }

        // Reuse any current vectors that were cloned for the selected profile,
        // then asynchronously embed only copied material that is still missing
        // or stale for that profile. A copied course must not expose AI until
        // this first preparation pass is complete.
        let preparation = {
            started: false,
            provider: transferProvider,
            providerLabel: providerLabel(transferProvider),
            migration: null
        };
        let preparationAiAvailable = targetModelSettings.providers[transferProvider].configurationStatus
            === scopeModelSettings.READY;
        try {
            const preparationResult = await providerKeys.prepareStoredProvider(db, {
                scope: { type: 'course', id: targetCourseId },
                provider: transferProvider,
                requestedBy: user.userId,
                disableUntilReady: true
            });

            if (preparationResult.ok) {
                const migration = preparationResult.body.migration || null;
                preparation = {
                    ...preparation,
                    started: preparationResult.httpStatus === 202,
                    migration
                };
                preparationAiAvailable = preparationResult.body.aiAvailable === true;
            } else {
                preparationAiAvailable = false;
                transferWarnings.push(
                    `Automatic ${providerLabel(transferProvider)} material preparation could not start: `
                    + `${preparationResult.body.message || 'unknown error'}`
                );
            }
        } catch (error) {
            preparationAiAvailable = false;
            transferWarnings.push(
                `Automatic ${providerLabel(transferProvider)} material preparation could not start: ${error.message}`
            );
        }

        if (!preparationAiAvailable) {
            try {
                await db.collection('courses').updateOne(
                    { courseId: targetCourseId },
                    { $set: { aiPreparationRequired: true, updatedAt: new Date() } }
                );
            } catch (error) {
                transferWarnings.push(`Failed to mark the copied course as awaiting AI preparation: ${error.message}`);
            }
        }

        if (deactivateSourceCourse) {
            await db.collection('courses').updateOne(
                { courseId, $or: [{ instructorId: user.userId }, { instructors: user.userId }] },
                {
                    $set: {
                        status: 'inactive',
                        updatedAt: new Date(),
                        lastUpdatedById: user.userId
                    }
                }
            );
        }

        return res.json({
            success: true,
            message: transferWarnings.length > 0
                ? 'Course transfer completed with warnings'
                : 'Course transferred successfully',
            data: {
                courseId: targetCourseId,
                courseName: targetCourse.courseName,
                courseCode: targetCourse.courseCode,
                studentCourseCode: targetCourse.courseCode,
                instructorCourseCode: targetCourse.instructorCourseCode,
                sourceCourseId: courseId,
                sourceDeactivated: !!deactivateSourceCourse,
                warnings: transferWarnings,
                aiAvailable: preparationAiAvailable,
                preparation,
                summary: {
                    totalUnits: sourceLectures.length,
                    documentsCopied,
                    settingsTransferred: !!transferSettings,
                    tasTransferred: !!transferTAs
                }
            }
        });
    } catch (error) {
        console.error('Error transferring course:', error);
        return res.status(500).json({
            success: false,
            message: 'Internal server error while transferring course',
            error: error.message
        });
    }
});

/**
 * PUT /api/courses/:courseId/retrieval-mode
 * Update the course's additive retrieval setting (instructor-only)
 */
router.put('/:courseId/retrieval-mode', async (req, res) => {
    try {
        const { courseId } = req.params;
        const { isAdditiveRetrieval } = req.body;
        
        // Validate body
        if (typeof isAdditiveRetrieval !== 'boolean') {
            return res.status(400).json({
                success: false,
                message: 'isAdditiveRetrieval must be a boolean'
            });
        }
        
        // Auth check
        const user = req.user;
        if (!user) {
            return res.status(401).json({ success: false, message: 'Authentication required' });
        }
        if (user.role !== 'instructor') {
            return res.status(403).json({ success: false, message: 'Only instructors can update retrieval mode' });
        }
        
        // Get DB
        const db = req.app.locals.db;
        if (!db) {
            return res.status(503).json({ success: false, message: 'Database connection not available' });
        }
        
        // Check if user has access to this course (either as main instructor or in instructors array)
        const collection = db.collection('courses');
        const course = await collection.findOne({ courseId });
        
        if (!course) {
            return res.status(404).json({ success: false, message: 'Course not found' });
        }
        
        // Check if user is the main instructor or in the instructors array
        const hasAccess = course.instructorId === user.userId || 
                         (Array.isArray(course.instructors) && course.instructors.includes(user.userId));
        
        if (!hasAccess) {
            return res.status(403).json({ 
                success: false, 
                message: 'You do not have access to update this course' 
            });
        }
        
        // Update course
        const result = await collection.updateOne(
            { courseId },
            { $set: { isAdditiveRetrieval, updatedAt: new Date() } }
        );
        
        if (result.matchedCount === 0) {
            return res.status(404).json({ success: false, message: 'Course not found' });
        }
        
        res.json({ success: true, message: 'Retrieval mode updated', data: { courseId, isAdditiveRetrieval } });
    } catch (error) {
        console.error('Error updating retrieval mode:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
});

/**
 * DELETE /api/courses/:courseId
 * Delete a course (soft delete)
 */
router.delete('/:courseId', async (req, res) => {
    try {
        const { courseId } = req.params;
        const instructorId = req.query.instructorId;
        
        if (!instructorId) {
            return res.status(400).json({
                success: false,
                message: 'instructorId is required'
            });
        }
        
        // Get database instance from app.locals
        const db = req.app.locals.db;
        if (!db) {
            return res.status(503).json({
                success: false,
                message: 'Database connection not available'
            });
        }
        
        // Soft delete course (set status to 'deleted')
        const collection = db.collection('courses');
        const result = await collection.updateOne(
            { courseId, instructorId },
            { 
                $set: { 
                    status: 'deleted',
                    updatedAt: new Date()
                } 
            }
        );
        
        if (result.matchedCount === 0) {
            return res.status(404).json({
                success: false,
                message: 'Course not found'
            });
        }
        
        console.log('Course soft deleted:', { courseId, instructorId });
        
        res.json({
            success: true,
            message: 'Course deleted successfully',
            modifiedCount: result.modifiedCount
        });
        
    } catch (error) {
        console.error('Error deleting course:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error'
        });
    }
});

/**
 * POST /api/courses/:courseId/remove-document
 * Remove a specific document from the course structure
 */
router.post('/:courseId/remove-document', async (req, res) => {
    try {
        const { courseId } = req.params;
        const { documentId, instructorId } = req.body;
        
        if (!documentId || !instructorId) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields: documentId, instructorId'
            });
        }
        
        // Get database instance from app.locals
        const db = req.app.locals.db;
        if (!db) {
            return res.status(503).json({
                success: false,
                message: 'Database connection not available'
            });
        }
        
        // Check if instructor has access to the course
        const hasAccess = await CourseModel.userHasCourseAccess(db, courseId, instructorId, 'instructor');
        if (!hasAccess) {
            return res.status(403).json({
                success: false,
                message: 'You do not have permission to remove documents from this course'
            });
        }
        
        // Remove document from any unit in the course using Course model
        const result = await CourseModel.removeDocumentFromAnyUnit(db, courseId, documentId, instructorId);
        
        if (!result.success) {
            return res.status(404).json({
                success: false,
                message: result.error || 'Document not found in course structure'
            });
        }
        
        console.log(`Document ${documentId} removed from course ${courseId} structure`);
        
        res.json({
            success: true,
            message: 'Document removed from course structure successfully!',
            data: {
                documentId,
                courseId,
                removedCount: result.removedCount
            }
        });
        
    } catch (error) {
        console.error('Error removing document from course:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error while removing document from course'
        });
    }
});



/**
 * POST /api/courses/course-materials/confirm
 * Confirm course materials for a specific unit/week
 * This marks the unit as having all required materials confirmed
 */
router.post('/course-materials/confirm', async (req, res) => {
    console.log('🔧 [BACKEND] Course materials confirm endpoint hit!');
    console.log('🔧 [BACKEND] Request body:', req.body);
    
    try {
        const { week, instructorId } = req.body;
        
        console.log('🔧 [BACKEND] Extracted data:', { week, instructorId });
        
        // Validate required fields
        if (!week || !instructorId) {
            console.log('❌ [BACKEND] Missing required fields');
            return res.status(400).json({
                success: false,
                message: 'Missing required fields: week, instructorId'
            });
        }
        
        // Get database instance from app.locals
        const db = req.app.locals.db;
        if (!db) {
            return res.status(503).json({
                success: false,
                message: 'Database connection not available'
            });
        }
        
        // Get the courses collection
        const coursesCollection = db.collection('courses');
        
        // Find the course that contains this unit/week
        const course = await coursesCollection.findOne({
            instructorId: instructorId,
            'lectures.name': week
        });
        
        if (!course) {
            return res.status(404).json({
                success: false,
                message: `Course not found for instructor ${instructorId} with unit ${week}`
            });
        }
        
        // Update the unit to mark materials as confirmed
        const result = await coursesCollection.updateOne(
            { 
                courseId: course.courseId,
                'lectures.name': week 
            },
            { 
                $set: { 
                    'lectures.$.materialsConfirmed': true,
                    'lectures.$.materialsConfirmedAt': new Date(),
                    'lectures.$.updatedAt': new Date(),
                    updatedAt: new Date()
                }
            }
        );
        
        if (result.modifiedCount === 0) {
            return res.status(404).json({
                success: false,
                message: `Unit ${week} not found in course ${course.courseId}`
            });
        }
        
        console.log(`Course materials confirmed for unit ${week} in course ${course.courseId}`);
        
        res.json({
            success: true,
            message: `Course materials for ${week} confirmed successfully!`,
            data: {
                week,
                courseId: course.courseId,
                materialsConfirmed: true,
                confirmedAt: new Date().toISOString()
            }
        });
        
    } catch (error) {
        console.error('Error confirming course materials:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error while confirming course materials'
        });
    }
});

/**
 * GET /api/courses/available/all
 * Get courses available in the current user's normal selector
 */
router.get('/available/all', async (req, res) => {
    try {
        // Get database instance from app.locals
        const db = req.app.locals.db;
        if (!db) {
            return res.status(503).json({
                success: false,
                message: 'Database connection not available'
            });
        }
        
        const user = req.user;
        
        // Query database for all non-deleted courses, then filter by role below
        const collection = db.collection('courses');
        const courses = await collection.find({ status: { $ne: 'deleted' } }).toArray();

        let availableCourses = courses;

        if (user && user.role === 'instructor' && !hasSystemAdminAccess(user)) {
            availableCourses = availableCourses.filter(course => hasInstructorAccess(course, user.userId));
        }

        if (user && user.role === 'student') {
            availableCourses = availableCourses.filter(course => (course.status || 'active') === 'active');
        }

        // TAs can always see their assigned/invited courses, and can join active courses with a student code.
        if (user && user.role === 'ta') {
            console.log(`Filtering courses for TA ${user.userId}`);

            // Filter from the already-narrowed availableCourses, not the raw
            // `courses` list. Avoids undoing any earlier role-based narrowing.
            availableCourses = availableCourses.filter(course => {
                const isActive = CourseModel.normalizeCourseStatus(course.status) === CourseModel.COURSE_STATUS.ACTIVE;

                return isActive;
            });
            console.log(`TA ${user.userId} sees ${availableCourses.length} courses (from total ${courses.length})`);
        }
        
        // In "View as Student" the selector offers the courses the previewer
        // actually teaches, not every active course on the platform. Picking one
        // re-points the preview grant, so the list has to stay within what they
        // are allowed to preview.
        if (previewSession.isPreviewRequest(req) && req.realUser) {
            const owner = req.realUser;
            const isAdmin = !!(owner.permissions && owner.permissions.systemAdmin === true);

            if (!isAdmin) {
                const ownCourses = await CourseModel.getCoursesForUser(db, owner.userId, owner.role);
                const ownIds = new Set((ownCourses || []).map(course => course.courseId));
                availableCourses = availableCourses.filter(course => ownIds.has(course.courseId));
            }
        }

        availableCourses = sortCoursesWithInactiveLast(availableCourses);
        const canBypassCourseCodes = await userCanBypassCourseCodes(db, user);

        // Transform the data to match expected format for both sides
        // For students, check enrollment status
        const transformedCourses = await Promise.all(availableCourses.map(async (course) => {
            let isEnrolled = false;
            const isTAAssigned = !!(user && user.role === 'ta' && course.tas && course.tas.includes(user.userId));
            const isTAInvited = !!(user && user.role === 'ta' && Array.isArray(user.invitedCourses) && user.invitedCourses.includes(course.courseId));
            
            // If user is student, check explicit enrollment
            if (user && user.role === 'student') {
                const result = await CourseModel.getStudentEnrollment(db, course.courseId, user.userId);
                isEnrolled = result.success && result.enrolled === true;
            }
            
            return {
                courseId: course.courseId,
                courseName: course.courseName || course.courseId,
                instructorId: course.instructorId,
                instructors: course.instructors || [course.instructorId],
                tas: course.tas || [],
                status: course.status || 'active',
                aiAvailable: publicProviderKeyState(course).aiAvailable,
                llmKey: publicProviderKeyState(course).llmKey,
                llmProvider: publicProviderKeyState(course).llmProvider,
                createdAt: course.createdAt?.toISOString() || new Date().toISOString(),
                isEnrolled: isEnrolled,
                isTAAssigned,
                isTAInvited,
                requiresCode: user && user.role === 'ta'
                    ? !isTAAssigned && !isTAInvited && !canBypassCourseCodes
                    : false
            };
        }));

        // With the academic API on, students only get courses they're enrolled in
        // (enrolment comes from the roster sync), so the selector never offers a
        // course they can't enter. With it off (the default), there's no roster to
        // enrol them, so we fall back to the pre-feature behavior: list all active
        // courses and let them join with a course code.
        const academicEnabled = await isAcademicApiEnabled(db);
        const responseCourses = (user && user.role === 'student' && academicEnabled)
            ? transformedCourses.filter(course => course.isEnrolled)
            : transformedCourses;

        console.log(`Retrieved ${responseCourses.length} available courses`);

        res.json({
            success: true,
            data: responseCourses
        });
        
    } catch (error) {
        console.error('Error fetching available courses:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error while fetching available courses'
        });
    }
});

/**
 * GET /api/courses/available/joinable
 * Get courses that an instructor can join with an instructor course code
 */
router.get('/available/joinable', async (req, res) => {
    try {
        const db = req.app.locals.db;
        if (!db) {
            return res.status(503).json({
                success: false,
                message: 'Database connection not available'
            });
        }

        const user = req.user;
        if (!user || user.role !== 'instructor') {
            return res.status(403).json({
                success: false,
                message: 'Only instructors can view joinable courses'
            });
        }

        const collection = db.collection('courses');
        const courses = await collection.find({ status: { $ne: 'deleted' } }).toArray();
        const joinableCourses = sortCoursesWithInactiveLast(
            courses.filter(course => !hasInstructorAccess(course, user.userId))
        );

        const transformedCourses = joinableCourses.map((course) => ({
            courseId: course.courseId,
            courseName: course.courseName || course.courseId,
            instructorId: course.instructorId,
            instructors: course.instructors || [course.instructorId],
            tas: course.tas || [],
            status: course.status || 'active',
            aiAvailable: publicProviderKeyState(course).aiAvailable,
            llmKey: publicProviderKeyState(course).llmKey,
            llmProvider: publicProviderKeyState(course).llmProvider,
            createdAt: course.createdAt?.toISOString() || new Date().toISOString()
        }));

        return res.json({
            success: true,
            data: transformedCourses
        });
    } catch (error) {
        console.error('Error fetching joinable courses:', error);
        return res.status(500).json({
            success: false,
            message: 'Internal server error while fetching joinable courses'
        });
    }
});

/**
 * GET /api/courses/:courseId/instructor-join-status
 * Report whether the current instructor needs a course code to join.
 *
 * This is a UX hint only. The POST join route repeats every check before
 * granting access.
 */
router.get('/:courseId/instructor-join-status', async (req, res) => {
    try {
        const db = req.app.locals.db;
        if (!db) {
            return res.status(503).json({
                success: false,
                message: 'Database connection not available'
            });
        }

        const user = req.user;
        if (!user || user.role !== 'instructor') {
            return res.status(403).json({
                success: false,
                message: 'Only instructors can check instructor join status'
            });
        }

        const course = await db.collection('courses').findOne({
            courseId: req.params.courseId,
            status: { $ne: 'deleted' }
        });
        if (!course) {
            return res.status(404).json({
                success: false,
                message: 'Course not found'
            });
        }

        const alreadyHasAccess = hasInstructorAccess(course, user.userId);
        const canBypassCourseCodes = await userCanBypassCourseCodes(db, user);
        const instructorOfRecord = !alreadyHasAccess && !canBypassCourseCodes
            ? await isVerifiedInstructorOfRecord(req, course, user)
            : false;

        let reason = 'courseCode';
        if (alreadyHasAccess) reason = 'alreadyInstructor';
        else if (canBypassCourseCodes) reason = 'admin';
        else if (instructorOfRecord) reason = 'instructorOfRecord';

        return res.json({
            success: true,
            data: {
                courseId: course.courseId,
                requiresCode: !(alreadyHasAccess || canBypassCourseCodes || instructorOfRecord),
                reason
            }
        });
    } catch (error) {
        console.error('Error checking instructor join status:', error);
        return res.status(500).json({
            success: false,
            message: 'Internal server error while checking instructor join status'
        });
    }
});

/**
 * POST /api/courses/:courseId/join
 * Join a course (Student via code, TA direct join)
 */
router.post('/:courseId/join', async (req, res) => {
    try {
        const { courseId } = req.params;
        const { code } = req.body;
        
        // Get authenticated user information
        const user = req.user;
        if (!user) {
            return res.status(401).json({
                success: false,
                message: 'Authentication required'
            });
        }
        
        // Get database instance from app.locals
        const db = req.app.locals.db;
        if (!db) {
            return res.status(503).json({
                success: false,
                message: 'Database connection not available'
            });
        }

        const canBypassCourseCodes = await userCanBypassCourseCodes(db, user);
        
        // Handle Student Join
        if (user.role === 'student') {
            if (!canBypassCourseCodes && !code) {
                return res.status(400).json({
                    success: false,
                    message: 'Course code is required'
                });
            }
            
            const result = await CourseModel.joinCourse(db, courseId, user.userId, code, {
                skipCodeValidation: canBypassCourseCodes
            });
            
            if (!result.success) {
                // Return 403 for revoked access or invalid code
                return res.status(403).json({
                    success: false,
                    message: result.error || 'Failed to join course'
                });
            }
            
            console.log(`Student ${user.userId} joined course ${courseId}`);
            
            return res.json({
                success: true,
                message: 'Successfully joined course',
                data: {
                    courseId,
                    enrolled: true
                }
            });
        }
        // Handle TA Join
        else if (user.role === 'ta') {
            // Check if course exists first to provide better error message
            const course = await CourseModel.getCourseById(db, courseId);
            if (!course) {
                return res.status(404).json({
                    success: false,
                    message: 'Course not found'
                });
            }

            const invitedCourses = Array.isArray(user.invitedCourses) ? user.invitedCourses : [];
            const isInvited = invitedCourses.includes(courseId);
            const isAssigned = Array.isArray(course.tas) && course.tas.includes(user.userId);
            const canJoinWithoutCode = isInvited || isAssigned || canBypassCourseCodes;

            if (!canJoinWithoutCode) {
                if (!code) {
                    return res.status(400).json({
                        success: false,
                        message: 'Course code is required'
                    });
                }

                if (course.status === 'inactive' || course.status === 'deleted') {
                    return res.status(403).json({
                        success: false,
                        message: 'Course is deactivated by the instructor'
                    });
                }

                if (normalizeCourseCode(course.courseCode) !== normalizeCourseCode(code)) {
                    return res.status(403).json({
                        success: false,
                        message: 'Invalid course code'
                    });
                }
            } else if (code && !canBypassCourseCodes && normalizeCourseCode(course.courseCode) !== normalizeCourseCode(code)) {
                return res.status(403).json({
                    success: false,
                    message: 'Invalid course code'
                });
            }

            // Add TA to course using Course model
            const result = await CourseModel.addTAToCourse(db, courseId, user.userId);
            
            if (!result.success) {
                return res.status(400).json({
                    success: false,
                    message: result.error || 'Failed to join course'
                });
            }

            await db.collection('users').updateOne(
                { userId: user.userId },
                {
                    $pull: { invitedCourses: courseId },
                    $set: { updatedAt: new Date() }
                }
            );
            
            console.log(`TA ${user.userId} joined course ${courseId}`);
            
            return res.json({
                success: true,
                message: 'Successfully joined course',
                data: {
                    courseId,
                    taId: user.userId,
                    courseName: course.courseName,
                    modifiedCount: result.modifiedCount
                }
            });
        }
        // Invalid Role
        else {
            return res.status(403).json({
                success: false,
                message: 'Only students and TAs can join courses'
            });
        }
        
    } catch (error) {
        console.error('Error joining course:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error while joining course'
        });
    }
});

/**
 * POST /api/courses/:courseId/instructors
 * Join a course as an instructor using an instructor course code
 */
router.post('/:courseId/instructors', async (req, res) => {
    try {
        const { courseId } = req.params;
        const { instructorId, code } = req.body;
        
        // Get authenticated user information
        const user = req.user;
        if (!user) {
            return res.status(401).json({
                success: false,
                message: 'Authentication required'
            });
        }
        
        // Only instructors can join as instructors
        if (user.role !== 'instructor') {
            return res.status(403).json({
                success: false,
                message: 'Only instructors can join courses as instructors'
            });
        }
        
        if (!instructorId) {
            return res.status(400).json({
                success: false,
                message: 'instructorId is required'
            });
        }

        if (user.userId !== instructorId) {
            return res.status(403).json({
                success: false,
                message: 'You can only join courses for your own instructor account'
            });
        }
        
        // Get database instance from app.locals
        const db = req.app.locals.db;
        if (!db) {
            return res.status(503).json({
                success: false,
                message: 'Database connection not available'
            });
        }

        const canBypassCourseCodes = await userCanBypassCourseCodes(db, user);
        const existingCourse = await db.collection('courses').findOne({ courseId });

        if (!existingCourse) {
            return res.status(404).json({
                success: false,
                message: 'Course not found'
            });
        }

        const alreadyHasAccess = hasInstructorAccess(existingCourse, instructorId);
        const instructorOfRecord = !canBypassCourseCodes && !alreadyHasAccess
            ? await isVerifiedInstructorOfRecord(req, existingCourse, user)
            : false;
        const canJoinWithoutCode = canBypassCourseCodes || alreadyHasAccess || instructorOfRecord;

        if (!canJoinWithoutCode && !code) {
            return res.status(400).json({
                success: false,
                message: 'Instructor course code is required'
            });
        }

        const result = await CourseModel.joinCourseAsInstructor(db, courseId, instructorId, code, {
            skipCodeValidation: canJoinWithoutCode
        });
        
        if (!result.success) {
            return res.status(403).json({
                success: false,
                message: result.error || 'Failed to join course as instructor'
            });
        }
        
        console.log(`Instructor ${instructorId} joined course ${courseId}`);
        
        res.json({
            success: true,
            message: result.message || 'Instructor added to course successfully',
            data: {
                courseId,
                instructorId,
                modifiedCount: result.alreadyJoined ? 0 : 1,
                alreadyJoined: !!result.alreadyJoined
            }
        });
        
    } catch (error) {
        console.error('Error adding instructor to course:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error while adding instructor to course'
        });
    }
});

/**
 * POST /api/courses/:courseId/tas
 * Add a TA to a course
 */
router.post('/:courseId/tas', async (req, res) => {
    try {
        const { courseId } = req.params;
        const { taId } = req.body;
        
        // Get authenticated user information
        const user = req.user;
        if (!user) {
            return res.status(401).json({
                success: false,
                message: 'Authentication required'
            });
        }
        
        // Only instructors can add TAs
        if (user.role !== 'instructor') {
            return res.status(403).json({
                success: false,
                message: 'Only instructors can add TAs to courses'
            });
        }
        
        if (!taId) {
            return res.status(400).json({
                success: false,
                message: 'taId is required'
            });
        }
        
        // Get database instance from app.locals
        const db = req.app.locals.db;
        if (!db) {
            return res.status(503).json({
                success: false,
                message: 'Database connection not available'
            });
        }
        
        // Add TA to course using Course model
        const result = await CourseModel.addTAToCourse(db, courseId, taId);
        
        if (!result.success) {
            return res.status(400).json({
                success: false,
                message: result.error || 'Failed to add TA to course'
            });
        }
        
        console.log(`Added TA ${taId} to course ${courseId}`);
        
        res.json({
            success: true,
            message: 'TA added to course successfully',
            data: {
                courseId,
                taId,
                modifiedCount: result.modifiedCount
            }
        });
        
    } catch (error) {
        console.error('Error adding TA to course:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error while adding TA to course'
        });
    }
});

/**
 * DELETE /api/courses/:courseId/tas/:taId
 * Remove a TA from one course only
 */
router.delete('/:courseId/tas/:taId', async (req, res) => {
    try {
        const { courseId, taId } = req.params;

        const user = req.user;
        if (!user) {
            return res.status(401).json({
                success: false,
                message: 'Authentication required'
            });
        }

        if (user.role !== 'instructor') {
            return res.status(403).json({
                success: false,
                message: 'Only instructors can remove TAs from courses'
            });
        }

        const db = req.app.locals.db;
        if (!db) {
            return res.status(503).json({
                success: false,
                message: 'Database connection not available'
            });
        }

        const coursesCollection = db.collection('courses');
        const course = await coursesCollection.findOne({ courseId });

        if (!course || course.status === 'deleted') {
            return res.status(404).json({
                success: false,
                message: 'Course not found'
            });
        }

        if (!hasInstructorAccess(course, user.userId)) {
            return res.status(403).json({
                success: false,
                message: 'Access denied. You can only remove TAs from your own courses.'
            });
        }

        const result = await coursesCollection.updateOne(
            { courseId },
            {
                $pull: { tas: taId },
                $unset: { [`taPermissions.${taId}`]: '' },
                $set: { updatedAt: new Date() }
            }
        );

        const usersCollection = db.collection('users');
        await usersCollection.updateOne(
            { userId: taId },
            {
                $pull: { invitedCourses: courseId },
                $set: { updatedAt: new Date() }
            }
        );

        const [remainingCourseCount, refreshedTA] = await Promise.all([
            coursesCollection.countDocuments({
                tas: taId,
                status: { $ne: 'deleted' }
            }),
            usersCollection.findOne(
                { userId: taId },
                { projection: { invitedCourses: 1, role: 1 } }
            )
        ]);

        const hasPendingInvites = Array.isArray(refreshedTA?.invitedCourses) && refreshedTA.invitedCourses.length > 0;
        const shouldRemainTA = remainingCourseCount > 0 || hasPendingInvites;

        if (refreshedTA && shouldRemainTA && refreshedTA.role !== 'ta') {
            await usersCollection.updateOne(
                { userId: taId },
                {
                    $set: {
                        role: 'ta',
                        updatedAt: new Date()
                    }
                }
            );
        } else if (refreshedTA && refreshedTA.role === 'ta' && !shouldRemainTA) {
            await usersCollection.updateOne(
                { userId: taId },
                {
                    $set: {
                        role: 'student',
                        updatedAt: new Date()
                    }
                }
            );
        }

        console.log(`Removed TA ${taId} from course ${courseId}`);

        return res.json({
            success: true,
            message: 'TA removed from course successfully',
            data: {
                courseId,
                taId,
                modifiedCount: result.modifiedCount,
                remainingCourseCount,
                role: shouldRemainTA ? 'ta' : 'student'
            }
        });
    } catch (error) {
        console.error('Error removing TA from course:', error);
        return res.status(500).json({
            success: false,
            message: 'Internal server error while removing TA from course'
        });
    }
});


/**
 * GET /api/courses/ta/:taId
 * Get all courses for a specific TA
 */
router.get('/ta/:taId', async (req, res) => {
    try {
        const { taId } = req.params;
        
        // Get authenticated user information
        const user = req.user;
        if (!user) {
            return res.status(401).json({
                success: false,
                message: 'Authentication required'
            });
        }
        
        // Only TAs can access their own courses
        if (user.role !== 'ta' || user.userId !== taId) {
            return res.status(403).json({
                success: false,
                message: 'Access denied. You can only view your own courses.'
            });
        }
        
        // Get database instance from app.locals
        const db = req.app.locals.db;
        if (!db) {
            return res.status(503).json({
                success: false,
                message: 'Database connection not available'
            });
        }
        
        // Get courses for TA using Course model
        const courses = await CourseModel.getCoursesForUser(db, taId, 'ta');
        
        // Transform the data to match expected format
        const transformedCourses = courses.map(course => ({
            courseId: course.courseId,
            courseName: course.courseName,
            instructorId: course.instructorId,
            instructors: course.instructors || [course.instructorId],
            tas: course.tas || [],
            status: course.status || 'active',
            aiAvailable: publicProviderKeyState(course).aiAvailable,
            llmKey: publicProviderKeyState(course).llmKey,
            llmProvider: publicProviderKeyState(course).llmProvider,
            createdAt: course.createdAt?.toISOString() || new Date().toISOString(),
            updatedAt: course.updatedAt?.toISOString() || new Date().toISOString(),
            totalUnits: course.courseStructure?.totalUnits || 0
        }));
        
        console.log(`Retrieved ${transformedCourses.length} courses for TA ${taId}`);
        
        res.json({
            success: true,
            data: transformedCourses
        });
        
    } catch (error) {
        console.error('Error fetching TA courses:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error while fetching TA courses'
        });
    }
});

/**
 * PUT /api/courses/:courseId/ta-permissions/:taId
 * Update TA permissions for a specific course
 */
router.put('/:courseId/ta-permissions/:taId', async (req, res) => {
    try {
        const { courseId, taId } = req.params;
        const { canAccessCourses, canAccessFlags } = req.body;
        
        // Get authenticated user information
        const user = req.user;
        if (!user) {
            return res.status(401).json({
                success: false,
                message: 'Authentication required'
            });
        }
        
        // Only instructors can manage TA permissions
        if (user.role !== 'instructor') {
            return res.status(403).json({
                success: false,
                message: 'Only instructors can manage TA permissions'
            });
        }
        
        // Validate required fields
        if (typeof canAccessCourses !== 'boolean' || typeof canAccessFlags !== 'boolean') {
            return res.status(400).json({
                success: false,
                message: 'canAccessCourses and canAccessFlags must be boolean values'
            });
        }
        
        // Get database instance from app.locals
        const db = req.app.locals.db;
        if (!db) {
            return res.status(503).json({
                success: false,
                message: 'Database connection not available'
            });
        }
        
        // Check if instructor has access to this course
        const hasAccess = await CourseModel.userHasCourseAccess(db, courseId, user.userId, 'instructor');
        if (!hasAccess) {
            return res.status(403).json({
                success: false,
                message: 'Access denied. You can only manage permissions for your own courses.'
            });
        }
        
        // Update TA permissions
        const result = await CourseModel.updateTAPermissions(db, courseId, taId, {
            canAccessCourses,
            canAccessFlags
        });
        
        if (!result.success) {
            return res.status(400).json({
                success: false,
                message: result.error || 'Failed to update TA permissions'
            });
        }
        
        console.log(`Updated TA permissions for ${taId} in course ${courseId}`);
        
        res.json({
            success: true,
            message: 'TA permissions updated successfully',
            data: {
                courseId,
                taId,
                canAccessCourses,
                canAccessFlags,
                modifiedCount: result.modifiedCount
            }
        });
        
    } catch (error) {
        console.error('Error updating TA permissions:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error while updating TA permissions'
        });
    }
});

/**
 * GET /api/courses/:courseId/ta-permissions/:taId
 * Get TA permissions for a specific course
 */
router.get('/:courseId/ta-permissions/:taId', async (req, res) => {
    try {
        const { courseId, taId } = req.params;
        
        // Get authenticated user information
        const user = req.user;
        if (!user) {
            return res.status(401).json({
                success: false,
                message: 'Authentication required'
            });
        }
        
        // Allow instructors to view any TA's permissions, or TAs to view their own permissions
        if (user.role !== 'instructor' && (user.role !== 'ta' || user.userId !== taId)) {
            return res.status(403).json({
                success: false,
                message: 'Access denied. You can only view your own permissions or instructors can view any TA permissions.'
            });
        }
        
        // Get database instance from app.locals
        const db = req.app.locals.db;
        if (!db) {
            return res.status(503).json({
                success: false,
                message: 'Database connection not available'
            });
        }
        
        // Check if user has access to this course
        // For instructors: check instructor access
        // For TAs: check TA access
        const userRole = user.role === 'instructor' ? 'instructor' : 'ta';
        const hasAccess = await CourseModel.userHasCourseAccess(db, courseId, user.userId, userRole);
        if (!hasAccess) {
            return res.status(403).json({
                success: false,
                message: 'Access denied. You can only view permissions for courses you have access to.'
            });
        }
        
        // Get TA permissions
        const result = await CourseModel.getTAPermissions(db, courseId, taId);
        
        if (!result.success) {
            return res.status(400).json({
                success: false,
                message: result.error || 'Failed to get TA permissions'
            });
        }
        
        res.json({
            success: true,
            data: {
                courseId,
                taId,
                permissions: result.permissions
            }
        });
        
    } catch (error) {
        console.error('Error getting TA permissions:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error while getting TA permissions'
        });
    }
});

/**
 * GET /api/courses/:courseId/ta-permissions
 * Get all TA permissions for a specific course
 */
router.get('/:courseId/ta-permissions', async (req, res) => {
    try {
        const { courseId } = req.params;
        
        // Get authenticated user information
        const user = req.user;
        if (!user) {
            return res.status(401).json({
                success: false,
                message: 'Authentication required'
            });
        }
        
        // Only instructors can view TA permissions
        if (user.role !== 'instructor') {
            return res.status(403).json({
                success: false,
                message: 'Only instructors can view TA permissions'
            });
        }
        
        // Get database instance from app.locals
        const db = req.app.locals.db;
        if (!db) {
            return res.status(503).json({
                success: false,
                message: 'Database connection not available'
            });
        }
        
        // Check if instructor has access to this course
        const hasAccess = await CourseModel.userHasCourseAccess(db, courseId, user.userId, 'instructor');
        if (!hasAccess) {
            return res.status(403).json({
                success: false,
                message: 'Access denied. You can only view permissions for your own courses.'
            });
        }
        
        // Get course details
        const course = await CourseModel.getCourseById(db, courseId);
        if (!course) {
            return res.status(404).json({
                success: false,
                message: 'Course not found'
            });
        }
        
        // Get permissions for all TAs in the course
        const taPermissions = {};
        if (course.tas && course.tas.length > 0) {
            for (const taId of course.tas) {
                const result = await CourseModel.getTAPermissions(db, courseId, taId);
                if (result.success) {
                    taPermissions[taId] = result.permissions;
                }
            }
        }
        
        res.json({
            success: true,
            data: {
                courseId,
                taPermissions
            }
        });
        
    } catch (error) {
        console.error('Error getting all TA permissions:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error while getting TA permissions'
        });
    }
});

/**
 * GET /api/courses/:courseId/students
 * List students associated with a course with enrollment status
 */
router.get('/:courseId/students', async (req, res) => {
    try {
        const { courseId } = req.params;

        // Auth
        const user = req.user;
        if (!user) {
            return res.status(401).json({ success: false, message: 'Authentication required' });
        }
        if (user.role !== 'instructor' && user.role !== 'ta') {
            return res.status(403).json({ success: false, message: 'Only instructors and TAs can view students' });
        }

        // DB
        const db = req.app.locals.db;
        if (!db) {
            return res.status(503).json({ success: false, message: 'Database connection not available' });
        }

        // Check course access. TAs may access inactive courses as long as they remain assigned.
        const accessRole = user.role === 'ta' ? 'ta' : 'instructor';
        const hasAccess = hasSystemAdminAccess(user)
            || await CourseModel.userHasCourseAccess(db, courseId, user.userId, accessRole);
        if (!hasAccess) {
            return res.status(403).json({ success: false, message: 'Access denied. You can only view courses you have access to.' });
        }

        if (user.role === 'ta') {
            const canAccessFlags = await CourseModel.checkTAPermission(db, courseId, user.userId, 'flags');
            if (!canAccessFlags) {
                return res.status(403).json({ success: false, message: 'Access denied. You do not have permission to view student flags for this course.' });
            }
        }

        // Gather students by union of:
        // 1) Users with role student whose preferences.courseId == courseId
        // 2) Students who have chat sessions in this course
        // 3) Students appearing in course.studentEnrollment overrides
        const usersCol = db.collection('users');
        const chatCol = db.collection('chat_sessions');
        const coursesCol = db.collection('courses');

        const [prefStudents, chatStudents, courseDoc] = await Promise.all([
            // The "View as Student" sandbox has a real user record (parts of the
            // student UI read from it), so it must be filtered out explicitly or
            // it appears in this course's student list as a phantom student.
            usersCol.find({ role: 'student', 'preferences.courseId': courseId, isActive: true, isPreview: { $ne: true } })
                .project({ userId: 1, username: 1, email: 1, displayName: 1, role: 1, invitedCourses: 1, createdAt: 1, lastLogin: 1, struggleState: 1 })
                .toArray(),
            chatCol.distinct('studentId', { courseId, ...previewSession.excludePreviewFilter('studentId') }),
            coursesCol.findOne({ courseId }, { projection: { studentEnrollment: 1, courseName: 1 } })
        ]);

        // Strip preview sandboxes out of the enrollment overrides before they
        // reach the merge below. The fallback branch there renders any unknown
        // enrollment key as a student row using the raw id as a display name,
        // so a stray preview entry shows up as a student named after its
        // internal id. Preview writes are blocked at the join route now; this
        // also hides entries left over from before that guard existed.
        const rawEnrollmentMap = (courseDoc && courseDoc.studentEnrollment) || {};
        const enrollmentMap = Object.fromEntries(
            Object.entries(rawEnrollmentMap)
                .filter(([studentId]) => !previewSession.isPreviewUserId(studentId))
        );

        const chatStudentUsers = chatStudents.length > 0
            ? await usersCol.find({ userId: { $in: chatStudents }, role: 'student', isActive: true, isPreview: { $ne: true } })
                .project({ userId: 1, username: 1, email: 1, displayName: 1, role: 1, invitedCourses: 1, createdAt: 1, lastLogin: 1, struggleState: 1 })
                .toArray()
            : [];

        // Merge and unique by userId
        const byId = new Map();
        [...prefStudents, ...chatStudentUsers].forEach(s => {
            byId.set(s.userId, s);
        });

        // Also include any students present only in enrollmentMap (no profile fetched yet)
        const missingIds = Object.keys(enrollmentMap).filter(id => !byId.has(id));
        
        // Track which enrollmentMap IDs correspond to known-inactive accounts so
        // we can skip the synthetic fallback below and avoid resurrecting them.
        const inactiveIds = new Set();

        if (missingIds.length > 0) {
            // Fetch details for these users regardless of role
            const additionalUsers = await usersCol.find({ userId: { $in: missingIds } })
                .project({ userId: 1, username: 1, email: 1, displayName: 1, role: 1, invitedCourses: 1, createdAt: 1, lastLogin: 1, struggleState: 1, isActive: 1 })
                .toArray();

            additionalUsers.forEach(s => {
                if (s.isActive === false) {
                    inactiveIds.add(s.userId);
                    return;
                }
                byId.set(s.userId, s);
            });
        }

        // Fallback for truly missing users (still not found in DB)
        for (const studentId of Object.keys(enrollmentMap)) {
            if (inactiveIds.has(studentId)) continue;
            if (!byId.has(studentId)) {
                byId.set(studentId, {
                    userId: studentId,
                    username: studentId,
                    email: null,
                    displayName: studentId,
                    createdAt: null,
                    lastLogin: null
                });
            }
        }

        const students = Array.from(byId.values()).map(s => ({
            userId: s.userId,
            username: s.username,
            email: s.email,
            displayName: s.displayName,
            role: s.role,
            invitedCourses: s.invitedCourses || [],
            lastLogin: s.lastLogin,
            createdAt: s.createdAt,
            // Default enrolled=true if no override exists
            enrolled: enrollmentMap[s.userId] ? !!enrollmentMap[s.userId].enrolled : true,
            struggleState: s.struggleState || { topics: [] }
        }));

        // Sort by displayName
        students.sort((a, b) => (a.displayName || '').localeCompare(b.displayName || ''));

        return res.json({
            success: true,
            data: {
                courseId,
                courseName: courseDoc?.courseName || courseId,
                students,
                totalStudents: students.length
            }
        });
    } catch (error) {
        console.error('Error listing course students:', error);
        return res.status(500).json({ success: false, message: 'Internal server error while listing students' });
    }
});

/**
 * PUT /api/courses/:courseId/student-enrollment/:studentId
 * Update a student's enrollment (enrolled=true/false) for a course
 */
router.put('/:courseId/student-enrollment/:studentId', async (req, res) => {
    try {
        const { courseId, studentId } = req.params;
        const { enrolled } = req.body;

        // Validate
        if (typeof enrolled !== 'boolean') {
            return res.status(400).json({ success: false, message: 'enrolled must be a boolean' });
        }

        // Auth
        const user = req.user;
        if (!user) {
            return res.status(401).json({ success: false, message: 'Authentication required' });
        }
        if (user.role !== 'instructor') {
            return res.status(403).json({ success: false, message: 'Only instructors can update enrollment' });
        }

        // DB
        const db = req.app.locals.db;
        if (!db) {
            return res.status(503).json({ success: false, message: 'Database connection not available' });
        }

        // Access check
        const hasAccess = await CourseModel.userHasCourseAccess(db, courseId, user.userId, 'instructor');
        if (!hasAccess) {
            return res.status(403).json({ success: false, message: 'Access denied. You can only manage your own courses.' });
        }

        const result = await CourseModel.updateStudentEnrollment(db, courseId, studentId, enrolled);
        if (!result.success) {
            return res.status(400).json({ success: false, message: result.error || 'Failed to update enrollment' });
        }

        return res.json({
            success: true,
            message: 'Student enrollment updated successfully',
            data: { courseId, studentId, enrolled }
        });
    } catch (error) {
        console.error('Error updating student enrollment:', error);
        return res.status(500).json({ success: false, message: 'Internal server error while updating enrollment' });
    }
});

/**
 * GET /api/courses/:courseId/student-enrollment
 * Get current student's enrollment status for the course
 */
router.get('/:courseId/student-enrollment', async (req, res) => {
    try {
        const { courseId } = req.params;
        const user = req.user;
        if (!user) {
            return res.status(401).json({ success: false, message: 'Authentication required' });
        }
        if (user.role !== 'student') {
            return res.status(403).json({ success: false, message: 'Only students can view their enrollment' });
        }

        const db = req.app.locals.db;
        if (!db) {
            return res.status(503).json({ success: false, message: 'Database connection not available' });
        }

        // Preview sandboxes are handled inside getStudentEnrollment, which
        // reports them enrolled in the one course their id encodes.
        const result = await CourseModel.getStudentEnrollment(db, courseId, user.userId);
        if (!result.success) {
            return res.status(404).json({ success: false, message: 'Course not found' });
        }

        return res.json({ 
            success: true, 
            data: { 
                courseId, 
                enrolled: result.enrolled,
                status: result.status 
            } 
        });
    } catch (error) {
        console.error('Error getting student enrollment:', error);
        return res.status(500).json({ success: false, message: 'Internal server error while getting enrollment' });
    }
});

/**
 * POST /api/courses/:courseId/units
 * Add a new unit to a course
 */
router.post('/:courseId/units', async (req, res) => {
    try {
        const { courseId } = req.params;
        const { instructorId } = req.body;
        
        if (!instructorId) {
            return res.status(400).json({
                success: false,
                message: 'instructorId is required'
            });
        }
        
        // Get database instance from app.locals
        const db = req.app.locals.db;
        if (!db) {
            return res.status(503).json({
                success: false,
                message: 'Database connection not available'
            });
        }

        const user = req.user;
        if (!user) {
            return res.status(401).json({ success: false, message: 'Authentication required' });
        }

        if (user.role !== 'instructor' || instructorId !== user.userId) {
            return res.status(403).json({
                success: false,
                message: 'You do not have permission to modify this course'
            });
        }
        
        // Check if instructor has access
        const hasAccess = await CourseModel.userHasCourseAccess(db, courseId, user.userId, 'instructor');
        if (!hasAccess) {
            return res.status(403).json({
                success: false,
                message: 'You do not have permission to modify this course'
            });
        }
        
        // Get current course to determine next unit number
        const collection = db.collection('courses');
        const course = await collection.findOne({ courseId });
        
        if (!course) {
            return res.status(404).json({
                success: false,
                message: 'Course not found'
            });
        }
        
        // Calculate new unit number. Deletes leave gaps in the numbering, so this
        // has to come from the highest number in use - counting units instead would
        // hand out a name that already exists once anything has been deleted.
        const existingUnits = course.lectures || [];
        const highestUnitNum = existingUnits.reduce((highest, lecture) => {
            const match = /\d+/.exec(lecture?.name || '');
            return match ? Math.max(highest, parseInt(match[0], 10)) : highest;
        }, 0);
        const structureUnitsCount = course.courseStructure ? course.courseStructure.totalUnits : 0;
        const newUnitNum = Math.max(highestUnitNum, structureUnitsCount) + 1;
        const newUnitName = `Unit ${newUnitNum}`;
        
        const now = new Date();
        const newUnit = {
            name: newUnitName,
            isPublished: false,
            learningObjectives: [],
            passThreshold: 2,
            createdAt: now,
            updatedAt: now,
            documents: [],
            assessmentQuestions: []
        };
        
        // Update course: add unit to lectures array AND update courseStructure.
        // totalUnits counts the units that exist; it is not the highest unit number,
        // which runs ahead of the count once a unit has been deleted.
        const newTotalUnits = existingUnits.length + 1;
        const result = await collection.updateOne(
            { courseId },
            {
                $push: { lectures: newUnit },
                $set: { 'courseStructure.totalUnits': newTotalUnits, updatedAt: now }
            }
        );

        console.log(`Added ${newUnitName} to course ${courseId}`);

        res.json({
            success: true,
            message: `${newUnitName} added successfully`,
            data: {
                unit: newUnit,
                totalUnits: newTotalUnits
            }
        });
        
    } catch (error) {
        console.error('Error adding new unit:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error while adding new unit'
        });
    }
});

/**
 * PATCH /api/courses/:courseId/units/:unitName/order
 * Move a unit one slot up or down without changing its stable internal name.
 */
router.patch('/:courseId/units/:unitName/order', async (req, res) => {
    try {
        const { courseId, unitName } = req.params;
        const { instructorId, direction } = req.body || {};

        if (!instructorId || !['up', 'down'].includes(direction)) {
            return res.status(400).json({
                success: false,
                message: 'instructorId and a direction of "up" or "down" are required'
            });
        }

        const db = req.app.locals.db;
        if (!db) {
            return res.status(503).json({
                success: false,
                message: 'Database connection not available'
            });
        }

        const user = req.user;
        if (!user) {
            return res.status(401).json({ success: false, message: 'Authentication required' });
        }

        if (user.role !== 'instructor' || instructorId !== user.userId) {
            return res.status(403).json({
                success: false,
                message: 'You do not have permission to modify this course'
            });
        }

        const hasAccess = await CourseModel.userHasCourseAccess(db, courseId, user.userId, 'instructor');
        if (!hasAccess) {
            return res.status(403).json({
                success: false,
                message: 'You do not have permission to modify this course'
            });
        }

        const collection = db.collection('courses');
        const course = await collection.findOne({ courseId });
        if (!course) {
            return res.status(404).json({ success: false, message: 'Course not found' });
        }

        const lectures = Array.isArray(course.lectures) ? [...course.lectures] : [];
        const currentIndex = lectures.findIndex(lecture => lecture?.name === unitName);
        if (currentIndex === -1) {
            return res.status(404).json({ success: false, message: 'Unit not found' });
        }

        const targetIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1;
        if (targetIndex < 0 || targetIndex >= lectures.length) {
            return res.status(409).json({
                success: false,
                message: `${unitName} is already at the ${direction === 'up' ? 'top' : 'bottom'}`
            });
        }

        [lectures[currentIndex], lectures[targetIndex]] = [lectures[targetIndex], lectures[currentIndex]];
        const now = new Date();
        await collection.updateOne(
            { courseId },
            { $set: { lectures, updatedAt: now } }
        );

        return res.json({
            success: true,
            message: `${unitName} moved to position ${targetIndex + 1}`,
            data: {
                unitName,
                position: targetIndex + 1,
                orderedUnitNames: lectures.map(lecture => lecture.name)
            }
        });
    } catch (error) {
        console.error('Error reordering unit:', error);
        return res.status(500).json({
            success: false,
            message: 'Internal server error while reordering unit'
        });
    }
});

/**
 * DELETE /api/courses/:courseId/units/:unitName
 * Delete a unit and all its documents
 */
router.delete('/:courseId/units/:unitName', async (req, res) => {
    try {
        const { courseId, unitName } = req.params;
        // Default to {} so a DELETE with no body (the documented querystring fallback) doesn't throw.
        const { instructorId } = req.body || {};

        // If instructorID is not in body, check query (common for DELETE requests)
        const effectiveInstructorId = instructorId || req.query.instructorId;
        
        if (!effectiveInstructorId) {
            return res.status(400).json({
                success: false,
                message: 'instructorId is required'
            });
        }
        
        // Get database instance from app.locals
        const db = req.app.locals.db;
        if (!db) {
            return res.status(503).json({
                success: false,
                message: 'Database connection not available'
            });
        }

        const user = req.user;
        if (!user) {
            return res.status(401).json({ success: false, message: 'Authentication required' });
        }

        if (effectiveInstructorId !== user.userId) {
            return res.status(403).json({
                success: false,
                message: 'You do not have permission to modify this course'
            });
        }
        
        const collection = db.collection('courses');
        const course = await collection.findOne({ courseId });
        
        if (!course) {
            return res.status(404).json({
                success: false,
                message: 'Course not found'
            });
        }

        const hasAccess = await hasCourseManagementAccess(db, course, user);
        if (!hasAccess) {
            return res.status(403).json({
                success: false,
                message: 'You do not have permission to modify this course'
            });
        }
        
        // Find the unit
        const unit = course.lectures ? course.lectures.find(l => l.name === unitName) : null;
        if (!unit) {
            return res.status(404).json({
                success: false,
                message: 'Unit not found'
            });
        }

        if (course.lectures.length <= 1) {
            return res.status(409).json({
                success: false,
                message: 'A course must have at least one unit'
            });
        }
        
        // 1. Delete all documents associated with this unit
        // Vectors are removed from every embedding profile's collection the
        // document was indexed into, sharing one set of maintenance clients.
        const maintenanceFactory = qdrantMaintenance.createMaintenanceFactory();
        
        let deletedDocsCount = 0;
        if (unit.documents && unit.documents.length > 0) {
            console.log(`Deleting ${unit.documents.length} documents for ${unitName}...`);
            
            for (const docRef of unit.documents) {
                if (docRef.documentId) {
                    try {
                        const storedDocument = await db.collection('documents').findOne({ documentId: docRef.documentId });

                        // Delete from MongoDB Documents collection
                        await DocumentModel.deleteDocument(db, docRef.documentId);
                        
                        // Delete from every Qdrant collection holding its vectors
                        try {
                            const sweep = await deleteDocumentFromAllCollections(
                                db,
                                { ...(storedDocument || {}), documentId: docRef.documentId, courseId },
                                maintenanceFactory
                            );
                            for (const failure of sweep.errors) {
                                console.warn(`Failed to delete Qdrant chunks for ${docRef.documentId}:`, failure.error);
                            }
                        } catch (qErr) {
                            console.warn(`Failed to delete Qdrant chunks for ${docRef.documentId}:`, qErr.message);
                        }
                        
                        deletedDocsCount++;
                    } catch (dErr) {
                        console.error(`Failed to delete document ${docRef.documentId}:`, dErr);
                    }
                }
            }
        }
        
        const now = new Date();

        // 2. Remove the unit from the course. totalUnits is set from what actually
        // remains rather than decremented, so it can't drift away from the units
        // themselves and leave the instructor page rendering units that don't exist.
        const remainingUnits = course.lectures.filter(l => l.name !== unitName).length;
        const updateResult = await collection.updateOne(
            { courseId },
            {
                $pull: { lectures: { name: unitName } },
                $set: { 'courseStructure.totalUnits': remainingUnits, updatedAt: now }
            }
        );
        
        console.log(`Deleted ${unitName} from course ${courseId}. Removed ${deletedDocsCount} documents.`);
        
        res.json({
            success: true,
            message: `Unit ${unitName} and ${deletedDocsCount} documents deleted successfully`,
            data: {
                deletedUnit: unitName,
                deletedDocumentsCount: deletedDocsCount
            }
        });
        
    } catch (error) {
        console.error('Error deleting unit:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error while deleting unit'
        });
    }
});

/**
 * PUT /api/courses/:courseId/units/:unitName/rename
 * Update the display name of a unit (for custom unit titles)
 */
router.put('/:courseId/units/:unitName/rename', async (req, res) => {
    try {
        const { courseId, unitName } = req.params;
        const { displayName, instructorId, showUnitNumber } = req.body;

        if (typeof showUnitNumber !== 'undefined' && typeof showUnitNumber !== 'boolean') {
            return res.status(400).json({
                success: false,
                message: 'showUnitNumber must be a boolean'
            });
        }

        if (!instructorId) {
            return res.status(400).json({
                success: false,
                message: 'instructorId is required'
            });
        }
        
        // Get database instance from app.locals
        const db = req.app.locals.db;
        if (!db) {
            return res.status(503).json({
                success: false,
                message: 'Database connection not available'
            });
        }

        const user = req.user;
        if (!user) {
            return res.status(401).json({ success: false, message: 'Authentication required' });
        }

        if (instructorId !== user.userId) {
            return res.status(403).json({
                success: false,
                message: 'You do not have permission to modify this course'
            });
        }
        
        const course = await CourseModel.getCourseById(db, courseId);
        if (!course) {
            return res.status(404).json({
                success: false,
                message: 'Course not found'
            });
        }

        const hasAccess = await hasCourseManagementAccess(db, course, user);
        if (!hasAccess) {
            return res.status(403).json({
                success: false,
                message: 'You do not have permission to modify this course'
            });
        }
        
        // Update the unit display name
        const result = await CourseModel.updateUnitDisplayName(
            db,
            courseId,
            decodeURIComponent(unitName),
            displayName,
            user.userId,
            showUnitNumber
        );

        if (!result.success) {
            return res.status(404).json({
                success: false,
                message: result.error || 'Unit not found'
            });
        }

        console.log(`Updated display name for ${unitName} to "${displayName || '(cleared)'}" in course ${courseId}`);

        res.json({
            success: true,
            message: displayName ? `Unit renamed to "${displayName}"` : 'Unit name cleared',
            data: {
                unitName: decodeURIComponent(unitName),
                displayName: result.displayName,
                showUnitNumber: result.showUnitNumber
            }
        });
        
    } catch (error) {
        console.error('Error renaming unit:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error while renaming unit'
        });
    }
});

module.exports = router;
