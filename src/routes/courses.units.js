/**
 * Courses API Routes — unit (lecture) management
 */

const express = require('express');
const router = express.Router();
const CourseModel = require('../models/Course');
const DocumentModel = require('../models/Document');
const { deleteDocumentFromAllCollections } = require('../services/embeddingIndexService');
const qdrantMaintenance = require('../services/qdrantMaintenance');
const { hasCourseManagementAccess } = require('./courses.shared');

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

        if (user.role === 'instructor' && instructorId !== user.userId) {
            return res.status(403).json({
                success: false,
                message: 'You do not have permission to modify this course'
            });
        }

        // Consistent with unit rename/delete (both gated on 'materials' via
        // hasCourseManagementAccess) - a TA who can manage units can add one.
        const { hasPermission } = require('../services/permissions');
        const hasAccess = await hasPermission(db, user, courseId, 'materials');
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
