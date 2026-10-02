/**
 * Courses API Routes — course CRUD, listing, content upload, retrieval mode
 */

const express = require('express');
const router = express.Router();
const CourseModel = require('../models/Course');
const { hasSystemAdminAccess } = require('../services/authorization');
const { createId } = require('../services/id');
const { buildKeySubdocument, credentialSetFields, publicKeySummary, publicProviderKeyState } = require('../services/llmKeyStore');
const providerKeys = require('../services/providerKeyService');
const scopeModelSettings = require('../services/scopeModelSettings');
const { normalizeProvider, providerLabel } = require('../services/llmProviders');
const { generateCourseId } = require('./courses.shared');

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

        // Instructor-only: this route writes status (including soft-delete),
        // prompts, and lectures straight from the request body with no
        // field allowlist, so granting it to any TA with 'settings' (which
        // legacy canAccessCourses and the fail-open default both imply)
        // would let that TA delete the course or overwrite its prompts/units.
        let hasAccess = false;
        if (user.role === 'instructor' && instructorId === user.userId) {
            hasAccess = await CourseModel.userHasCourseAccess(db, courseId, user.userId, 'instructor');
        }
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
        
        // Authorization already happened above via hasAccess (instructor of
        // record) - the update itself just needs to find the course.
        // Filtering again by instructorId/instructors here would be redundant.
        const result = await collection.updateOne(
            { courseId },
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

module.exports = router;
