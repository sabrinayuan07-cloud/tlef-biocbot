/**
 * Courses API Routes — course transfer (clone a course's content into a new one)
 */

const express = require('express');
const router = express.Router();
const CourseModel = require('../models/Course');
const DocumentModel = require('../models/Document');
const QdrantService = require('../services/qdrantService');
const gridfs = require('../services/gridfs');
const {
    activeProviderOf,
    buildKeySubdocument,
    credentialDocumentFields
} = require('../services/llmKeyStore');
const providerKeys = require('../services/providerKeyService');
const scopeModelSettings = require('../services/scopeModelSettings');
const { normalizeProvider, providerLabel } = require('../services/llmProviders');
const { buildEmbeddingProfile } = require('../services/embeddingConfig');
const {
    INDEX_STATUSES,
    contentHash,
    indexesOf
} = require('../services/embeddingIndexService');
const { hasInstructorAccess, generateCourseId } = require('./courses.shared');

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
            // Inherit the source course's migration status when its TAs come
            // along too, so a still-unmigrated legacy TA record copied over
            // doesn't flip to the wrong default in the new course; a course
            // started with no TAs has nothing to migrate.
            taPermissionsMigrated: transferTAs ? sourceCourse.taPermissionsMigrated === true : true,
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

module.exports = router;
