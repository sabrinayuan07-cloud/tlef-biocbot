/**
 * Qdrant API Routes
 * Handles document processing, embedding, and semantic search operations
 */

const express = require('express');
const router = express.Router();
const QdrantService = require('../services/qdrantService');
const { hasSystemAdminAccess } = require('../services/authorization');
const { hasPermission } = require('../services/permissions');
const { contentHash, markDocumentIndexReady } = require('../services/embeddingIndexService');
const { resolveCourseAi, sendLlmKeyError } = require('./llmKeyMiddleware');

// Initialize Qdrant service
const qdrantService = new QdrantService({ skipEmbeddings: true });

// Middleware to parse JSON bodies
router.use(express.json());

async function requireDirectQdrantAccess(req, res, { courseId, requireExistingCourse = false } = {}) {
    const user = req.user;
    if (!user) {
        res.status(401).json({ success: false, message: 'Authentication required' });
        return null;
    }

    if (hasSystemAdminAccess(user)) {
        return user;
    }

    if (user.role !== 'instructor' && user.role !== 'ta') {
        res.status(403).json({
            success: false,
            message: 'Direct Qdrant access is restricted to course staff'
        });
        return null;
    }

    if (!courseId) {
        return user;
    }

    const db = req.app.locals.db;
    if (!db) {
        res.status(503).json({
            success: false,
            message: 'Database connection not available'
        });
        return null;
    }

    const course = await db.collection('courses').findOne(
        { courseId },
        { projection: { _id: 1 } }
    );

    if (!course) {
        if (requireExistingCourse) {
            res.status(404).json({ success: false, message: 'Course not found' });
            return null;
        }
        return user;
    }

    if (!(await hasPermission(db, user, courseId, 'materials'))) {
        res.status(403).json({
            success: false,
            message: 'You do not have permission to access vectors for this course'
        });
        return null;
    }

    return user;
}

/**
 * GET /api/qdrant/status
 * Get Qdrant service status and collection statistics
 */
router.get('/status', async (req, res) => {
    try {
        // Ensure service is initialized
        if (!qdrantService.client) {
            await qdrantService.initialize();
        }

        const stats = await qdrantService.getCollectionStats();
        
        res.json({
            success: true,
            data: {
                status: 'connected',
                collection: stats,
                service: 'Qdrant Vector Database'
            }
        });

    } catch (error) {
        console.error('Error getting Qdrant status:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to get Qdrant status',
            error: error.message
        });
    }
});

/**
 * POST /api/qdrant/process-document
 * Process a document: chunk, embed, and store in Qdrant
 */
router.post('/process-document', async (req, res) => {
    try {
        const {
            courseId,
            lectureName,
            documentId,
            content,
            fileName,
            mimeType,
            documentType,
            type
        } = req.body;

        const user = await requireDirectQdrantAccess(req, res, { courseId });
        if (!user) return;

        // Validate required fields
        if (!courseId || !lectureName || !documentId || !content || !fileName) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields: courseId, lectureName, documentId, content, fileName'
            });
        }

        const ai = await resolveCourseAi(req, res, courseId);
        if (!ai) return;

        // Process and store document
        const result = await ai.qdrant.processAndStoreDocument({
            courseId,
            lectureName,
            documentId,
            content,
            fileName,
            mimeType: mimeType || 'text/plain',
            documentType,
            type
        });

        if (result.success) {
            // This direct endpoint bypasses documentIngestion, so it must write
            // the same per-profile readiness record itself. Without it, the
            // vectors exist in Qdrant but provider switching and course
            // transfer cannot discover or reuse them.
            if (ai.qdrant.embeddingProfile) {
                await markDocumentIndexReady(
                    req.app.locals.db,
                    documentId,
                    ai.qdrant.embeddingProfile,
                    contentHash(content)
                );
            }
            res.json({
                success: true,
                message: result.message,
                data: {
                    chunksProcessed: result.chunksProcessed,
                    chunksStored: result.chunksStored,
                    documentId,
                    courseId,
                    lectureName
                }
            });
        } else {
            res.status(500).json({
                success: false,
                message: 'Failed to process document',
                error: result.error
            });
        }

    } catch (error) {
        if (sendLlmKeyError(res, error)) return;
        console.error('Error processing document:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error while processing document',
            error: error.message
        });
    }
});

/**
 * POST /api/qdrant/search
 * Search for relevant document chunks using semantic similarity
 */
router.post('/search', async (req, res) => {
    try {
        const { query, courseId, lectureName, limit = 10 } = req.body;

        // Authorize before validating inputs so unauthorized callers (e.g. a
        // student hitting the API directly) get a 403 rather than a validation
        // 400 that leaks request shape — matching /process-document's ordering.
        const user = await requireDirectQdrantAccess(req, res, { courseId });
        if (!user) return;

        if (!courseId) {
            return res.status(400).json({
                success: false,
                message: 'courseId is required for semantic search'
            });
        }

        if (!query) {
            return res.status(400).json({
                success: false,
                message: 'Search query is required'
            });
        }

        const ai = await resolveCourseAi(req, res, courseId);
        if (!ai) return;

        // Build filters
        const filters = {};
        if (courseId) filters.courseId = courseId;
        if (lectureName) filters.lectureName = lectureName;

        // Perform search
        const searchResults = await ai.qdrant.searchDocuments(query, filters, limit);

        res.json({
            success: true,
            data: {
                query,
                results: searchResults,
                totalResults: searchResults.length,
                filters
            }
        });

    } catch (error) {
        if (sendLlmKeyError(res, error)) return;
        console.error('Error searching documents:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error while searching',
            error: error.message
        });
    }
});

/**
 * DELETE /api/qdrant/document/:documentId
 * Delete all chunks for a specific document
 */
router.delete('/document/:documentId', async (req, res) => {
    try {
        const { documentId } = req.params;

        const user = await requireDirectQdrantAccess(req, res);
        if (!user) return;

        if (!documentId) {
            return res.status(400).json({
                success: false,
                message: 'Document ID is required'
            });
        }

        const db = req.app.locals.db;
        if (!db) {
            return res.status(503).json({ success: false, message: 'Database connection not available' });
        }

        const document = await db.collection('documents').findOne({ documentId });
        if (!document?.courseId) {
            return res.status(404).json({ success: false, message: 'Document not found' });
        }

        const scopedUser = await requireDirectQdrantAccess(req, res, {
            courseId: document.courseId,
            requireExistingCourse: true
        });
        if (!scopedUser) return;

        // Ensure service is initialized
        if (!qdrantService.client) {
            await qdrantService.initialize();
        }

        // Delete document chunks
        const result = await qdrantService.deleteDocumentChunks(documentId, document.courseId);

        if (result.success) {
            res.json({
                success: true,
                message: result.message,
                data: {
                    documentId,
                    deletedCount: result.deletedCount
                }
            });
        } else {
            res.status(500).json({
                success: false,
                message: 'Failed to delete document chunks',
                error: result.error
            });
        }

    } catch (error) {
        console.error('Error deleting document chunks:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error while deleting document',
            error: error.message
        });
    }
});

/**
 * GET /api/qdrant/collection-stats
 * Get detailed collection statistics
 */
router.get('/collection-stats', async (req, res) => {
    try {
        const user = await requireDirectQdrantAccess(req, res);
        if (!user) return;

        // Ensure service is initialized
        if (!qdrantService.client) {
            await qdrantService.initialize();
        }

        const stats = await qdrantService.getCollectionStats();
        
        res.json({
            success: true,
            data: stats
        });

    } catch (error) {
        console.error('Error getting collection stats:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to get collection statistics',
            error: error.message
        });
    }
});

/**
 * DELETE /api/qdrant/collection
 * Delete the entire collection (DANGEROUS - removes all data)
 */
router.delete('/collection', async (req, res) => {
    try {
        if (!hasSystemAdminAccess(req.user)) {
            return res.status(403).json({
                success: false,
                message: 'Access denied'
            });
        }

        // Ensure service is initialized
        if (!qdrantService.client) {
            await qdrantService.initialize();
        }

        // Delete the entire collection
        const result = await qdrantService.deleteCollection();

        if (result.success) {
            res.json({
                success: true,
                message: result.message,
                data: {
                    deletedCount: result.deletedCount
                }
            });
        } else {
            res.status(500).json({
                success: false,
                message: 'Failed to delete collection',
                error: result.error
            });
        }

    } catch (error) {
        console.error('Error deleting collection:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error while deleting collection',
            error: error.message
        });
    }
});

/**
 * DELETE /api/qdrant/delete-all-collections
 * Delete all collections (Qdrant, MongoDB)
 */
router.delete('/delete-all-collections', async (req, res) => {
    try {
        if (!hasSystemAdminAccess(req.user)) {
            return res.status(403).json({
                success: false,
                message: 'Access denied'
            });
        }

        // Delete Qdrant collection
        const qdrantResult = await qdrantService.deleteCollection();
        if (!qdrantResult.success) {
            return res.status(500).json({
                success: false,
                message: 'Failed to delete Qdrant collection',
                error: qdrantResult.error
            });
        }

        // Delete MongoDB collections using existing connection
        const db = req.app.locals.db;
        if (!db) {
            return res.status(500).json({
                success: false,
                message: 'Database connection not available',
                error: 'Database not initialized'
            });
        }

        console.log('🗑️ Deleting all MongoDB collections...');
        
        // Get all collections that actually exist in the database
        const existingCollections = await db.listCollections().toArray();
        const collectionNames = existingCollections.map(col => col.name);
        
        console.log(`Found existing collections: ${collectionNames.join(', ')}`);

        const mongoResults = {};
        let totalDeleted = 0;

        // Delete each existing collection
        for (const collectionName of collectionNames) {
            try {
                const collection = db.collection(collectionName);
                
                // Get collection document count before deletion
                const documentCount = await collection.countDocuments();
                
                // Delete the collection
                await db.dropCollection(collectionName);
                console.log(`✅ Deleted collection: ${collectionName} (${documentCount} documents)`);
                
                mongoResults[collectionName] = { 
                    exists: true, 
                    deleted: documentCount,
                    success: true 
                };
                totalDeleted += documentCount;
                
            } catch (error) {
                console.error(`❌ Error deleting collection ${collectionName}:`, error);
                mongoResults[collectionName] = { 
                    exists: true, 
                    deleted: 0,
                    success: false,
                    error: error.message 
                };
            }
        }

        console.log(`✅ Completed deletion of MongoDB collections. Total documents removed: ${totalDeleted}`);

        res.json({
            success: true,
            message: 'All collections deleted successfully',
            data: {
                qdrantDeletedCount: qdrantResult.deletedCount,
                mongoDeletedCount: totalDeleted,
                mongoResults: mongoResults
            }
        });

    } catch (error) {
        console.error('Error deleting all collections:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error while deleting all collections',
            error: error.message
        });
    }
});

/**
 * POST /api/qdrant/cleanup-vectors
 * Clean up orphaned vectors in Qdrant that don't satisfy MongoDB document existence
 */
router.post('/cleanup-vectors', async (req, res) => {
    try {
        const { courseId } = req.body;

        const user = await requireDirectQdrantAccess(req, res, { courseId, requireExistingCourse: true });
        if (!user) return;
        
        if (!courseId) {
            return res.status(400).json({
                success: false,
                message: 'Course ID is required to scope the cleanup operation'
            });
        }
        
        // Ensure service is initialized
        if (!qdrantService.client) {
            await qdrantService.initialize();
        }
        
        // Get database instance from app.locals
        const db = req.app.locals.db;
        if (!db) {
            return res.status(503).json({
                success: false,
                message: 'Database connection not available'
            });
        }
        
        console.log(`🧹 Starting vector cleanup for course: ${courseId}`);
        
        // Step 1: Get all document IDs from MongoDB for this course
        const documentsCollection = db.collection('documents');
        const mongoDocs = await documentsCollection.find(
            { courseId: courseId },
            { projection: { _id: 1, documentId: 1 } } // Fetch actual ID field
        ).toArray();
        
        // Create a Set of valid document IDs for O(1) lookup
        // Check both _id (if string) and documentId field just to be safe
        const validDocIds = new Set();
        mongoDocs.forEach(doc => {
            if (doc.documentId) validDocIds.add(doc.documentId.toString());
            if (doc._id) validDocIds.add(doc._id.toString());
        });
        
        console.log(`Found ${validDocIds.size} valid documents in MongoDB for course ${courseId}`);
        
        // Step 2: Scroll through Qdrant to find all vectors for this course
        // We need to find unique document IDs in Qdrant
        const qdrantDocIds = new Set();
        let nextOffset = null;
        let loopCount = 0;
        const MAX_LOOPS = 500; // Safety break
        
        do {
            loopCount++;
            
            const scrollResult = await qdrantService.client.scroll(qdrantService.collectionName, {
                filter: {
                    must: [
                        { key: 'courseId', match: { value: courseId } }
                    ]
                },
                limit: 1000,
                with_payload: true, // Need payload to get documentId
                with_vector: false,
                offset: nextOffset
            });
            
            const points = scrollResult.points || [];
            nextOffset = scrollResult.next_page_offset;
            
            // Extract document IDs from payload
            points.forEach(point => {
                if (point.payload && point.payload.documentId) {
                    qdrantDocIds.add(point.payload.documentId);
                }
            });
            
            if (loopCount >= MAX_LOOPS) break;
            
        } while (nextOffset);
        
        console.log(`Found ${qdrantDocIds.size} unique documents in Qdrant for course ${courseId}`);
        
        // Step 3: Identify orphans
        const orphanedDocIds = [];
        qdrantDocIds.forEach(qDocId => {
            if (!validDocIds.has(qDocId)) {
                orphanedDocIds.push(qDocId);
            }
        });
        
        console.log(`Found ${orphanedDocIds.length} orphaned documents in Qdrant`);
        
        // Step 4: Delete orphans
        let deletedCount = 0;
        const deletedDocs = [];
        
        for (const orphanId of orphanedDocIds) {
            console.log(`Deleting chunks for orphaned document: ${orphanId}`);
            // Pass courseId to ensure scoped deletion (though implicit by doc ID usually)
            const deleteResult = await qdrantService.deleteDocumentChunks(orphanId, courseId);
            if (deleteResult.success) {
                deletedCount += deleteResult.deletedCount;
                deletedDocs.push(orphanId);
            }
        }
        
        res.json({
            success: true,
            message: `Cleanup completed. Removed ${orphanedDocIds.length} orphaned documents (${deletedCount} chunks).`,
            data: {
                courseId,
                validMongoDocs: validDocIds.size,
                qdrantDocs: qdrantDocIds.size,
                orphanedDocs: orphanedDocIds.length,
                deletedChunks: deletedCount,
                deletedDocIds: deletedDocs
            }
        });
        
    } catch (error) {
        console.error('Error cleaning up vectors:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error while cleaning up vectors',
            error: error.message
        });
    }
});

module.exports = router;
