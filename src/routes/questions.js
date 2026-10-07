const express = require('express');
const router = express.Router();

// Import the Course model instead of Question model
const CourseModel = require('../models/Course');
const prompts = require('../services/prompts');
const { hasSystemAdminAccess } = require('../services/authorization');
const { hasPermission } = require('../services/permissions');
const { resolveCourseAi, sendLlmKeyError } = require('./llmKeyMiddleware');
const { LANES } = require('../services/llmLanes');

// Middleware for JSON parsing
router.use(express.json());

const QUESTION_UPDATE_FIELDS = [
    'questionType',
    'question',
    'options',
    'correctAnswer',
    'explanation',
    'difficulty',
    'tags',
    'points',
    'metadata',
    'learningObjective'
];

function normalizeLearningObjective(value) {
    if (typeof value !== 'string') {
        return '';
    }

    return value.trim();
}

function sanitizeQuestionPayload(input = {}) {
    const payload = {};

    QUESTION_UPDATE_FIELDS.forEach(field => {
        if (Object.prototype.hasOwnProperty.call(input, field)) {
            payload[field] = field === 'learningObjective'
                ? normalizeLearningObjective(input[field])
                : input[field];
        }
    });

    return payload;
}

function extractFirstJSONObject(str) {
    try {
        return JSON.parse(str);
    } catch {
        const match = str.match(/\{[\s\S]*\}/);
        if (!match) {
            return null;
        }

        try {
            return JSON.parse(match[0]);
        } catch {
            return null;
        }
    }
}

function resolveMatchedObjective(candidate, learningObjectives) {
    const normalizedCandidate = normalizeLearningObjective(candidate);
    if (!normalizedCandidate) {
        return '';
    }

    const matchedObjective = learningObjectives.find(objective =>
        objective.toLowerCase() === normalizedCandidate.toLowerCase()
    );

    return matchedObjective || '';
}

function summarizeAutoLinkResults(matchedQuestions = []) {
    const linkedCount = matchedQuestions.filter(question =>
        normalizeLearningObjective(question.learningObjective)
    ).length;
    const unassignedCount = matchedQuestions.length - linkedCount;
    const message = unassignedCount > 0
        ? `Auto-link complete: ${linkedCount} question${linkedCount === 1 ? '' : 's'} linked, ${unassignedCount} left unassigned.`
        : `Auto-link complete: ${linkedCount} question${linkedCount === 1 ? '' : 's'} linked.`;

    return {
        linkedCount,
        unassignedCount,
        totalQuestions: matchedQuestions.length,
        message
    };
}

// Reading questions is not staff-only - enrolled students reach this same
// route for quizzes/practice, so a student role still falls through to
// userHasCourseAccess's enrollment check (that's the real getStudentEnrollment
// path, not the lectures.js-style footgun, since this route genuinely
// serves students). Only the TA branch is gated by the 'questions'
// permission; instructors and students keep their pre-existing checks.
function canReadCourseQuestions(db, courseId, user) {
    if (hasSystemAdminAccess(user)) return true;
    if (user.role === 'ta') return hasPermission(db, user, courseId, 'questions');
    return CourseModel.userHasCourseAccess(db, courseId, user.userId, user.role);
}
// Mutating (creating/editing) questions IS staff-only - no student role
// should ever reach this, so it can safely delegate to hasPermission()
// wholesale (denies students, checks TA 'questions' permission, checks
// instructor course ownership).
function canMutateCourseQuestions(db, courseId, user) {
    return hasPermission(db, user, courseId, 'questions');
}

async function requireCourseQuestionAccess(req, res, db, courseId, { mode, instructorId } = {}) {
    const user = req.user;
    if (!user) {
        res.status(401).json({ success: false, message: 'Authentication required' });
        return null;
    }

    if (mode === 'write') {
        if (user.role === 'instructor' && instructorId && instructorId !== user.userId) {
            res.status(403).json({
                success: false,
                message: 'You do not have permission to modify questions for this course'
            });
            return null;
        }

        const canAttemptWrite = hasSystemAdminAccess(user) || user.role === 'instructor' || user.role === 'ta';
        if (!canAttemptWrite) {
            res.status(403).json({
                success: false,
                message: 'You do not have permission to modify questions for this course'
            });
            return null;
        }

        const course = await db.collection('courses').findOne(
            { courseId },
            { projection: { _id: 1 } }
        );

        if (!course) {
            return user;
        }

        if (!(await canMutateCourseQuestions(db, courseId, user))) {
            res.status(403).json({
                success: false,
                message: 'You do not have permission to modify questions for this course'
            });
            return null;
        }

        return user;
    }

    if (!(await canReadCourseQuestions(db, courseId, user))) {
        res.status(403).json({
            success: false,
            message: 'You do not have permission to access questions for this course'
        });
        return null;
    }

    return user;
}

async function linkQuestionsToLearningObjectives(llmService, learningObjectives = [], questions = [], preserveExisting = true) {
    const normalizedObjectives = (learningObjectives || [])
        .map(objective => normalizeLearningObjective(objective))
        .filter(Boolean);

    const normalizedQuestions = (questions || []).map((question, index) => ({
        ...question,
        ref: question.ref || question.questionId || `question-${index + 1}`,
        learningObjective: normalizeLearningObjective(question.learningObjective)
    }));

    if (normalizedQuestions.length === 0 || normalizedObjectives.length === 0) {
        return normalizedQuestions.map(question => {
            const { ref, ...rest } = question;
            return rest;
        });
    }

    const questionsToMatch = normalizedQuestions.filter(question =>
        !(preserveExisting && question.learningObjective)
    );

    if (questionsToMatch.length === 0) {
        return normalizedQuestions.map(question => {
            const { ref, ...rest } = question;
            return rest;
        });
    }

    const prompt = prompts.buildQuestionObjectiveLinkingPrompt(normalizedObjectives, questionsToMatch);
    const response = await llmService.sendMessage(prompt, {
        lane: LANES.BACKEND,
        temperature: 0.1,
        maxTokens: 2048,
        response_format: { type: 'json_object' }
    });

    const parsed = extractFirstJSONObject(response?.content || '');
    const rawMatches = Array.isArray(parsed?.matches) ? parsed.matches : [];
    const matches = new Map();

    rawMatches.forEach(match => {
        if (!match?.ref) {
            return;
        }

        matches.set(String(match.ref), resolveMatchedObjective(match.learningObjective, normalizedObjectives));
    });

    return normalizedQuestions.map(question => {
        const assignedObjective = preserveExisting && question.learningObjective
            ? question.learningObjective
            : (matches.get(question.ref) || '');

        const { ref, ...rest } = question;
        return {
            ...rest,
            learningObjective: assignedObjective
        };
    });
}

/**
 * POST /api/questions
 * Create a new assessment question
 */
router.post('/', async (req, res) => {
    try {
        const { 
            courseId, 
            lectureName, 
            instructorId, 
            questionType, 
            question, 
            options, 
            correctAnswer, 
            explanation,
            difficulty,
            tags,
            learningObjective,
            points,
            metadata
        } = req.body;
        
        // Validate required fields. Use an explicit presence check for
        // correctAnswer so structured falsy answers (TF `false`, MCQ index `0`)
        // aren't rejected as missing.
        const correctAnswerMissing =
            correctAnswer === undefined || correctAnswer === null || correctAnswer === '';
        if (!courseId || !lectureName || !instructorId || !questionType || !question || correctAnswerMissing) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields: courseId, lectureName, instructorId, questionType, question, correctAnswer'
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

        const user = await requireCourseQuestionAccess(req, res, db, courseId, {
            mode: 'write',
            instructorId
        });
        if (!user) return;
        
        // Prepare question data
        const questionData = {
            questionType,
            question,
            options: options || {},
            correctAnswer,
            explanation: explanation || '',
            difficulty: difficulty || 'medium',
            tags: tags || [],
            learningObjective: normalizeLearningObjective(learningObjective),
            points: points || 1,
            metadata: {
                source: 'manual',
                aiGenerated: false,
                reviewStatus: 'draft',
                ...metadata
            }
        };
        
        // Create question in the course structure using Course model
        const result = await CourseModel.updateAssessmentQuestions(
            db, 
            courseId, 
            lectureName, 
            questionData, 
            user.userId
        );
        
        if (!result.success) {
            return res.status(400).json({
                success: false,
                message: result.error || 'Failed to create question'
            });
        }
        
        console.log(`Question created for ${lectureName} by user ${user.userId}`);
        
        res.json({
            success: true,
            message: 'Question created successfully!',
            data: {
                questionId: result.questionId,
                question: questionData.question,
                questionType: questionData.questionType,
                learningObjective: questionData.learningObjective,
                createdAt: new Date().toISOString(),
                created: result.created
            }
        });
        
    } catch (error) {
        console.error('Error creating question:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error while creating question',
            error: error.message
        });
    }
});

/**
 * GET /api/questions/lecture
 * Get all questions for a specific lecture/unit
 */
router.get('/lecture', async (req, res) => {
    try {
        const { courseId, lectureName } = req.query;
        
        if (!courseId || !lectureName) {
            return res.status(400).json({
                success: false,
                message: 'Missing required parameters: courseId, lectureName'
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

        const course = await db.collection('courses').findOne(
            { courseId },
            { projection: { _id: 1 } }
        );

        if (!course) {
            return res.json({
                success: true,
                data: {
                    courseId,
                    lectureName,
                    questions: [],
                    count: 0
                }
            });
        }

        const user = await requireCourseQuestionAccess(req, res, db, courseId, { mode: 'read' });
        if (!user) return;
        
        // Fetch questions from the course structure using Course model
        const questions = await CourseModel.getAssessmentQuestions(db, courseId, lectureName);
        
        res.json({
            success: true,
            data: {
                courseId,
                lectureName,
                questions: questions,
                count: questions.length
            }
        });
        
    } catch (error) {
        console.error('Error fetching questions:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error while fetching questions'
        });
    }
});

/**
 * POST /api/questions/auto-link-learning-objectives
 * Match assessment questions to the most relevant learning objective
 */
router.post('/auto-link-learning-objectives', async (req, res) => {
    try {
        const {
            courseId,
            lectureName,
            instructorId,
            learningObjectives,
            questions
        } = req.body;

        if (!courseId || !lectureName) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields: courseId, lectureName'
            });
        }

        const db = req.app.locals.db;
        if (!db) {
            return res.status(503).json({
                success: false,
                message: 'Database connection not available'
            });
        }

        const user = await requireCourseQuestionAccess(req, res, db, courseId, {
            mode: 'write',
            instructorId
        });
        if (!user) return;

        const ai = await resolveCourseAi(req, res, courseId);
        if (!ai) return;
        const llmService = ai.llm;

        const normalizedObjectives = Array.isArray(learningObjectives)
            ? learningObjectives.map(objective => normalizeLearningObjective(objective)).filter(Boolean)
            : await CourseModel.getLearningObjectives(db, courseId, lectureName);

        if (normalizedObjectives.length === 0) {
            return res.json({
                success: true,
                message: 'No learning objectives available to link.',
                data: {
                    updatedCount: 0,
                    linkedCount: 0,
                    matchedQuestions: Array.isArray(questions)
                        ? questions.map(question => ({
                            ...question,
                            learningObjective: normalizeLearningObjective(question.learningObjective)
                        }))
                        : []
                }
            });
        }

        const sourceQuestions = Array.isArray(questions)
            ? questions
            : await CourseModel.getAssessmentQuestions(db, courseId, lectureName);

        if (!sourceQuestions || sourceQuestions.length === 0) {
            return res.json({
                success: true,
                message: 'No assessment questions found to link.',
                data: {
                    updatedCount: 0,
                    linkedCount: 0,
                    matchedQuestions: []
                }
            });
        }

        const matchedQuestions = await linkQuestionsToLearningObjectives(
            llmService,
            normalizedObjectives,
            sourceQuestions,
            true
        );

        if (Array.isArray(questions)) {
            const summary = summarizeAutoLinkResults(matchedQuestions);
            return res.json({
                success: true,
                message: summary.message,
                data: {
                    updatedCount: 0,
                    linkedCount: summary.linkedCount,
                    unassignedCount: summary.unassignedCount,
                    totalQuestions: summary.totalQuestions,
                    matchedQuestions
                }
            });
        }

        let updatedCount = 0;
        const originalById = new Map(sourceQuestions.map(question => [question.questionId, question]));

        for (const matchedQuestion of matchedQuestions) {
            const originalQuestion = originalById.get(matchedQuestion.questionId);
            const originalObjective = normalizeLearningObjective(originalQuestion?.learningObjective);
            const matchedObjective = normalizeLearningObjective(matchedQuestion.learningObjective);

            if (!matchedQuestion.questionId || originalObjective || !matchedObjective) {
                continue;
            }

            const result = await CourseModel.updateAssessmentQuestions(
                db,
                courseId,
                lectureName,
                {
                    questionId: matchedQuestion.questionId,
                    learningObjective: matchedObjective
                },
                user.userId
            );

            if (result.success) {
                updatedCount++;
            }
        }

        const summary = summarizeAutoLinkResults(matchedQuestions);

        return res.json({
            success: true,
            message: summary.message,
            data: {
                updatedCount,
                linkedCount: summary.linkedCount,
                unassignedCount: summary.unassignedCount,
                totalQuestions: summary.totalQuestions,
                matchedQuestions
            }
        });

    } catch (error) {
        if (sendLlmKeyError(res, error)) return;
        console.error('Error auto-linking questions to learning objectives:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error while auto-linking questions',
            error: error.message
        });
    }
});

// Static GET paths must be registered before /:questionId, otherwise Express
// matches them as questionId lookups and the real handlers never run.

/**
 * GET /api/questions/stats
 * Get question statistics for a course
 */
router.get('/stats', async (req, res) => {
    try {
        const { courseId } = req.query;

        if (!courseId) {
            return res.status(400).json({
                success: false,
                message: 'Missing required parameter: courseId'
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

        if (!req.user) {
            return res.status(401).json({ success: false, message: 'Authentication required' });
        }

        // Get course data to calculate statistics only after authentication.
        const collection = db.collection('courses');
        const course = await collection.findOne({ courseId });

        if (course && !(await canReadCourseQuestions(db, courseId, req.user))) {
            return res.status(403).json({
                success: false,
                message: 'You do not have permission to access questions for this course'
            });
        }

        if (!course || !course.lectures) {
            return res.json({
                success: true,
                data: {
                    courseId,
                    stats: {
                        totalQuestions: 0,
                        totalPoints: 0,
                        typeBreakdown: []
                    }
                }
            });
        }

        // Calculate statistics from the course structure
        let totalQuestions = 0;
        let totalPoints = 0;
        const typeBreakdown = {};

        for (const lecture of course.lectures) {
            if (lecture.assessmentQuestions) {
                for (const question of lecture.assessmentQuestions) {
                    totalQuestions++;
                    totalPoints += question.points || 1;

                    const type = question.questionType;
                    if (!typeBreakdown[type]) {
                        typeBreakdown[type] = { count: 0, points: 0 };
                    }
                    typeBreakdown[type].count++;
                    typeBreakdown[type].points += question.points || 1;
                }
            }
        }

        const stats = {
            totalQuestions,
            totalPoints,
            typeBreakdown: Object.entries(typeBreakdown).map(([type, data]) => ({
                type,
                count: data.count,
                points: data.points
            }))
        };

        res.json({
            success: true,
            data: {
                courseId,
                stats
            }
        });

    } catch (error) {
        console.error('Error fetching question stats:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error while fetching question stats'
        });
    }
});

/**
 * GET /api/questions/course-material
 * Get course material content for AI question generation
 */
router.get('/course-material', async (req, res) => {
    try {
        const { courseId, lectureName, instructorId } = req.query;

        // Validate required fields
        if (!courseId || !lectureName || !instructorId) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields: courseId, lectureName, instructorId'
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

        // Get course data to find documents for the specific lecture/unit
        const course = await CourseModel.getCourseWithOnboarding(db, courseId);

        if (!course) {
            return res.status(404).json({
                success: false,
                message: 'Course not found'
            });
        }

        // Check if the instructor has access to this course
        if (course.instructorId !== instructorId) {
            return res.status(403).json({
                success: false,
                message: 'Access denied: You do not have permission to access this course'
            });
        }

        // Find the specific lecture/unit
        const unit = course.lectures?.find(l => l.name === lectureName);

        if (!unit) {
            return res.status(404).json({
                success: false,
                message: `Unit ${lectureName} not found in course`
            });
        }

        // Get documents for this unit
        const documents = unit.documents || [];

        if (documents.length === 0) {
            return res.status(404).json({
                success: false,
                message: `No course materials found for ${lectureName}`,
                data: {
                    hasMaterials: false,
                    content: null
                }
            });
        }

        // Combine content from all documents (prioritize lecture notes and practice questions)
        let combinedContent = '';
        let hasRequiredMaterials = false;

        // First, look for lecture notes and practice questions
        const priorityDocuments = documents.filter(doc =>
            doc.type === 'lecture_notes' ||
            doc.type === 'practice_q_tutorials' ||
            doc.documentType === 'lecture-notes' ||
            doc.documentType === 'practice-quiz'
        );

        if (priorityDocuments.length > 0) {
            hasRequiredMaterials = true;
            // Combine content from priority documents
            priorityDocuments.forEach(doc => {
                if (doc.content && doc.content.trim()) {
                    combinedContent += `\n\n--- ${doc.originalName || 'Document'} ---\n${doc.content}`;
                }
            });
        } else {
            // Fallback to any document with content
            documents.forEach(doc => {
                if (doc.content && doc.content.trim()) {
                    combinedContent += `\n\n--- ${doc.originalName || 'Document'} ---\n${doc.content}`;
                }
            });
        }

        if (!combinedContent.trim()) {
            return res.status(404).json({
                success: false,
                message: `No content found in documents for ${lectureName}`,
                data: {
                    hasMaterials: false,
                    content: null
                }
            });
        }

        // Handle content length intelligently
        const maxContentLength = 16000; // Increased limit for better context

        if (combinedContent.length > maxContentLength) {
            console.log(`📚 [CONTENT] Original content length: ${combinedContent.length} chars`);

            // Split content into sections
            const sections = combinedContent.split('---').filter(s => s.trim());
            console.log(`📚 [CONTENT] Found ${sections.length} sections`);

            // Sort sections: Priority docs first, then additional materials
            const prioritizedSections = sections.sort((a, b) => {
                const aIsPriority = a.includes('Lecture Notes') || a.includes('Practice Questions');
                const bIsPriority = b.includes('Lecture Notes') || b.includes('Practice Questions');
                if (aIsPriority && !bIsPriority) return -1;
                if (!aIsPriority && bIsPriority) return 1;
                return 0; // Keep original order for additional materials
            });

            console.log('📚 [CONTENT] Section types:', prioritizedSections.map(s => {
                if (s.includes('Lecture Notes')) return 'Lecture Notes';
                if (s.includes('Practice Questions')) return 'Practice Questions';
                return 'Additional Material';
            }));

            // Rebuild content with prioritized sections up to limit
            let newContent = '';
            let sectionsIncluded = 0;

            for (const section of prioritizedSections) {
                if ((newContent + section).length <= maxContentLength) {
                    newContent += '---' + section;
                    sectionsIncluded++;
                } else {
                    break;
                }
            }

            combinedContent = newContent.trim() + `\n\n[Content truncated: ${sectionsIncluded}/${sections.length} sections included]`;
            console.log(`📚 [CONTENT] Truncated to ${combinedContent.length} chars, included ${sectionsIncluded} sections`);
        }

        console.log(`📚 Retrieved course material content for ${lectureName}: ${combinedContent.length} characters`);

        res.json({
            success: true,
            message: 'Course material content retrieved successfully',
            data: {
                hasMaterials: true,
                content: combinedContent,
                documentCount: documents.length,
                unitName: lectureName,
                courseId: courseId
            }
        });

    } catch (error) {
        console.error('Error retrieving course material content:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error while retrieving course material content',
            error: error.message
        });
    }
});

/**
 * GET /api/questions/:questionId
 * Get a specific question by ID (search across all courses)
 */
router.get('/:questionId', async (req, res) => {
    try {
        const { questionId } = req.params;
        
        // Get database instance from app.locals
        const db = req.app.locals.db;
        if (!db) {
            return res.status(503).json({
                success: false,
                message: 'Database connection not available'
            });
        }
        
        // Search for the question across all courses
        const collection = db.collection('courses');
        const course = await collection.findOne({
            'lectures.assessmentQuestions.questionId': questionId
        });
        
        if (!course) {
            return res.status(404).json({
                success: false,
                message: 'Question not found'
            });
        }

        const user = await requireCourseQuestionAccess(req, res, db, course.courseId, { mode: 'read' });
        if (!user) return;
        
        // Find the specific question
        let foundQuestion = null;
        for (const lecture of course.lectures || []) {
            if (lecture.assessmentQuestions) {
                foundQuestion = lecture.assessmentQuestions.find(q => q.questionId === questionId);
                if (foundQuestion) break;
            }
        }
        
        if (!foundQuestion) {
            return res.status(404).json({
                success: false,
                message: 'Question not found'
            });
        }
        
        res.json({
            success: true,
            data: foundQuestion
        });
        
    } catch (error) {
        console.error('Error fetching question:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error while fetching question'
        });
    }
});

/**
 * PUT /api/questions/:questionId
 * Update an existing question
 */
router.put('/:questionId', async (req, res) => {
    try {
        const { questionId } = req.params;
        const { courseId, lectureName, instructorId, ...rawUpdateData } = req.body;
        
        if (!courseId || !lectureName || !instructorId) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields: questionId, courseId, lectureName, instructorId'
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

        const user = await requireCourseQuestionAccess(req, res, db, courseId, {
            mode: 'write',
            instructorId
        });
        if (!user) return;
        
        // Prepare the updated question data
        const questionData = sanitizeQuestionPayload(rawUpdateData);
        questionData.questionId = questionId;

        // Update question in the course structure using Course model
        const result = await CourseModel.updateAssessmentQuestions(
            db,
            courseId,
            lectureName,
            questionData,
            user.userId,
            { requireExisting: true }
        );
        
        if (!result.success) {
            return res.status(result.notFound ? 404 : 400).json({
                success: false,
                message: result.notFound
                    ? `Question ${questionId} not found on lecture ${lectureName}`
                    : (result.error || 'Failed to update question')
            });
        }
        
        console.log(`Question updated: ${questionId}`);
        
        res.json({
            success: true,
            message: 'Question updated successfully!',
            data: {
                questionId,
                updatedCount: result.modifiedCount
            }
        });
        
    } catch (error) {
        console.error('Error updating question:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error while updating question',
            error: error.message
        });
    }
});

/**
 * DELETE /api/questions/:questionId
 * Delete a question (remove from course structure)
 */
router.delete('/:questionId', async (req, res) => {
    try {
        const { questionId } = req.params;
        const { instructorId, courseId, lectureName } = req.body;
        
        if (!instructorId || !courseId || !lectureName) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields: questionId, instructorId, courseId, lectureName'
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

        const user = await requireCourseQuestionAccess(req, res, db, courseId, {
            mode: 'write',
            instructorId
        });
        if (!user) return;
        
        // Delete the question from the course structure using Course model
        const result = await CourseModel.deleteAssessmentQuestion(
            db, 
            courseId, 
            lectureName, 
            questionId, 
            user.userId
        );
        
        if (!result.success) {
            return res.status(400).json({
                success: false,
                message: result.error || 'Failed to delete question'
            });
        }
        
        console.log(`Question deleted: ${questionId} by user ${user.userId}`);
        
        res.json({
            success: true,
            message: 'Question deleted successfully!',
            data: {
                questionId,
                deletedCount: result.deletedCount
            }
        });
        
    } catch (error) {
        console.error('Error deleting question:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error while deleting question'
        });
    }
});

/**
 * POST /api/questions/bulk
 * Bulk create questions (for AI-generated or extracted questions)
 */
router.post('/bulk', async (req, res) => {
    try {
        const { courseId, lectureName, instructorId, questions } = req.body;
        
        if (!courseId || !lectureName || !instructorId || !questions || !Array.isArray(questions)) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields: courseId, lectureName, instructorId, questions (array)'
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

        const user = await requireCourseQuestionAccess(req, res, db, courseId, {
            mode: 'write',
            instructorId
        });
        if (!user) return;
        
        let insertedCount = 0;
        let autoLinkedCount = 0;
        const insertedIds = [];

        let questionsToSave = questions.map(question => ({
            ...question,
            learningObjective: normalizeLearningObjective(question.learningObjective)
        }));

        const unitLearningObjectives = await CourseModel.getLearningObjectives(db, courseId, lectureName);
        const needsAutoLinking = unitLearningObjectives.length > 0 && questionsToSave.some(question => !question.learningObjective);

        if (needsAutoLinking) {
            const ai = await resolveCourseAi(req, res, courseId);
            if (!ai) return;
            try {
                questionsToSave = await linkQuestionsToLearningObjectives(
                    ai.llm,
                    unitLearningObjectives,
                    questionsToSave,
                    true
                );
                autoLinkedCount = questionsToSave.filter(question => question.learningObjective).length;
            } catch (linkError) {
                console.error('Error auto-linking bulk questions to learning objectives:', linkError);
            }
        }
        
        // Create each question individually using the Course model
        for (const question of questionsToSave) {
            const questionData = {
                ...question,
                learningObjective: normalizeLearningObjective(question.learningObjective),
                metadata: {
                    source: 'ai-generated',
                    aiGenerated: true,
                    reviewStatus: 'draft',
                    ...question.metadata
                }
            };
            
            const result = await CourseModel.updateAssessmentQuestions(
                db, 
                courseId, 
                lectureName, 
                questionData, 
                user.userId
            );
            
            if (result.success) {
                insertedCount++;
                insertedIds.push(result.questionId);
            }
        }
        
        console.log(`Bulk created ${insertedCount} questions for ${lectureName}`);
        
        res.json({
            success: true,
            message: `${insertedCount} questions created successfully!`,
            data: {
                courseId,
                lectureName,
                insertedCount,
                insertedIds,
                autoLinkedCount
            }
        });
        
    } catch (error) {
        if (sendLlmKeyError(res, error)) return;
        console.error('Error bulk creating questions:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error while bulk creating questions',
            error: error.message
        });
    }
});

/**
 * POST /api/questions/check-answer
 * Check a student's answer using LLM
 */
router.post('/check-answer', async (req, res) => {
    try {
        const { courseId, question, studentAnswer, expectedAnswer, questionType, studentName } = req.body;

        if (!courseId || !question || !studentAnswer || !expectedAnswer) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields: courseId, question, studentAnswer, expectedAnswer'
            });
        }

        const ai = await resolveCourseAi(req, res, courseId);
        if (!ai) return;
        const llmService = ai.llm;

        const result = await llmService.evaluateStudentAnswer(
            question,
            studentAnswer,
            expectedAnswer,
            questionType,
            studentName || 'Student'
        );

        res.json({
            success: true,
            data: result
        });

    } catch (error) {
        if (sendLlmKeyError(res, error)) return;
        console.error('Error checking answer:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error while checking answer'
        });
    }
});

/**
 * POST /api/questions/generate-ai
 * Generate an assessment question using AI based on course material
 */
router.post('/generate-ai', async (req, res) => {
    try {
        const { 
            courseId, 
            lectureName, 
            instructorId, 
            questionType, 
            learningObjectives,
            regenerate,
            feedback,
            previousQuestion,
            struggleTopic
        } = req.body;
        
        // Validate required fields
        if (!courseId || !lectureName || !instructorId || !questionType) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields: courseId, lectureName, instructorId, questionType'
            });
        }
        
        // Additional validation for regeneration requests
        if (regenerate && !feedback) {
            return res.status(400).json({
                success: false,
                message: 'Feedback is required for regeneration requests'
            });
        }
        
        console.log('🎯 [GENERATE] Learning objectives:', learningObjectives);
        
        // Validate question type
        const validQuestionTypes = ['true-false', 'multiple-choice', 'short-answer'];
        if (!validQuestionTypes.includes(questionType)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid question type. Must be one of: true-false, multiple-choice, short-answer'
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
        const DocumentModel = require('../models/Document');
        
        // First, get the course material content
        const course = await CourseModel.getCourseWithOnboarding(db, courseId);
        
        if (!course) {
            return res.status(404).json({
                success: false,
                message: 'Course not found'
            });
        }
        
        // AI generation is gated on 'questions' (folded together with manual
        // question-bank management - no role has asked to generate without
        // also being able to edit questions directly). Previously this ran
        // its own ad-hoc check that also assumed course.tas held {userId,
        // email} objects rather than the actual plain-string schema, so a
        // real TA could never pass it via that branch.
        const user = req.user;
        const hasAccess = await hasPermission(db, user, courseId, 'questions');

        if (!hasAccess) {
            console.log(`🚫 [PERMISSION] Access denied for user ${user?.userId || 'unknown'} to course ${courseId}`);
            console.log(`🔍 [PERMISSION] Course instructorId: ${course.instructorId}, User: ${user?.userId}, Email: ${user?.email}`);
            console.log(`🔍 [PERMISSION] Course instructors array: ${JSON.stringify(course.instructors)}`);
            return res.status(403).json({
                success: false,
                message: 'Access denied: You do not have permission to access this course'
            });
        }
        const unit = course.lectures?.find(l => l.name === lectureName);
        
        if (!unit) {
            return res.status(404).json({
                success: false,
                message: `Unit ${lectureName} not found in course`
            });
        }

        const normalizedStruggleTopic = typeof struggleTopic === 'string'
            ? struggleTopic.replace(/\s+/g, ' ').trim()
            : '';

        if (normalizedStruggleTopic) {
            const approvedTopics = CourseModel.normalizeTopicList(course.approvedStruggleTopics || []);
            const isApprovedTopic = approvedTopics.some(
                topic => topic.toLowerCase() === normalizedStruggleTopic.toLowerCase()
            );

            if (!isApprovedTopic) {
                return res.status(400).json({
                    success: false,
                    message: 'Selected struggle topic is not approved for this course'
                });
            }
        }
        
        const documents = unit.documents || [];
        
        if (documents.length === 0) {
            return res.status(400).json({
                success: false,
                message: `No course materials found for ${lectureName}`,
                data: {
                    hasMaterials: false,
                    content: null
                }
            });
        }
        
        // Combine content from all documents, including additional materials
        let combinedContent = '';
        
        // First process priority documents (lecture notes and practice quizzes)
        const priorityDocumentTypes = ['lecture-notes', 'practice-quiz'];
        const priorityDocuments = documents.filter(doc => priorityDocumentTypes.includes(doc.documentType));
        
        // Then process additional materials
        const additionalDocuments = documents.filter(doc => !priorityDocumentTypes.includes(doc.documentType));
        
        // Process all documents, starting with priority ones
        const docsToProcess = [...priorityDocuments, ...additionalDocuments];
        console.log(`📚 [CONTENT] Processing ${priorityDocuments.length} priority docs and ${additionalDocuments.length} additional docs`);

        for (const docRef of docsToProcess) {
            if (docRef.documentId) {
                const fullDoc = await DocumentModel.getDocumentById(db, docRef.documentId);
                if (fullDoc && fullDoc.content && fullDoc.content.trim()) {
                    combinedContent += `\n\n--- ${fullDoc.originalName || 'Document'} ---\n${fullDoc.content}`;
                }
            }
        }
        
        if (!combinedContent.trim()) {
            return res.status(400).json({
                success: false,
                message: `No content found in documents for ${lectureName}`,
                data: {
                    hasMaterials: false,
                    content: null
                }
            });
        }

        if (normalizedStruggleTopic) {
            combinedContent = `Question focus: Generate one assessment question that targets the struggle topic "${normalizedStruggleTopic}" using the ${lectureName} course materials below.\n\n${combinedContent}`;
        }
        
        // Handle content length intelligently
        const maxContentLength = 6000; // Optimized limit for better performance
        
        if (combinedContent.length > maxContentLength) {
            console.log(`📚 [CONTENT] Original content length: ${combinedContent.length} chars`);
            
            // Split content into sections
            const sections = combinedContent.split('---').filter(s => s.trim());
            console.log(`📚 [CONTENT] Found ${sections.length} sections`);
            
            // Sort sections: Priority docs first, then additional materials
            const prioritizedSections = sections.sort((a, b) => {
                const aIsPriority = a.includes('Lecture Notes') || a.includes('Practice Questions');
                const bIsPriority = b.includes('Lecture Notes') || b.includes('Practice Questions');
                if (aIsPriority && !bIsPriority) return -1;
                if (!aIsPriority && bIsPriority) return 1;
                return 0; // Keep original order for additional materials
            });
            
            console.log('📚 [CONTENT] Section types:', prioritizedSections.map(s => {
                if (s.includes('Lecture Notes')) return 'Lecture Notes';
                if (s.includes('Practice Questions')) return 'Practice Questions';
                return 'Additional Material';
            }));
            
            // Rebuild content with prioritized sections up to limit
            let newContent = '';
            let sectionsIncluded = 0;
            
            for (const section of prioritizedSections) {
                if ((newContent + section).length <= maxContentLength) {
                    newContent += '---' + section;
                    sectionsIncluded++;
                } else {
                    break;
                }
            }
            
            combinedContent = newContent.trim() + `\n\n[Content truncated: ${sectionsIncluded}/${sections.length} included]`;
            console.log(`📚 [CONTENT] Truncated to ${combinedContent.length} chars, included ${sectionsIncluded} sections`);
        }
        
        // Get the initialized LLM service from app.locals
        const ai = await resolveCourseAi(req, res, courseId);
        if (!ai) return;
        const llmService = ai.llm;
        
        try {
            const normalizedLearningObjectives = Array.isArray(learningObjectives)
                ? learningObjectives.map(objective => normalizeLearningObjective(objective)).filter(Boolean)
                : [];

            // Format learning objectives for the prompt
            // For normal generation: randomly select ONE objective to ensure question variety.
            // Sending all objectives every time causes the LLM to gravitate toward the same one,
            // producing near-identical questions on repeat clicks.
            // For regeneration: pass all objectives so feedback-based improvements have full context.
            let formattedLearningObjectives = '';
            let selectedLearningObjective = '';
            if (normalizedLearningObjectives.length > 0) {
                if (regenerate) {
                    formattedLearningObjectives = normalizedLearningObjectives.map((obj, i) => `${i + 1}. ${obj}`).join('\n');
                } else {
                    const randomIndex = Math.floor(Math.random() * normalizedLearningObjectives.length);
                    const selectedObjective = normalizedLearningObjectives[randomIndex];
                    selectedLearningObjective = normalizeLearningObjective(selectedObjective);
                    formattedLearningObjectives = `Focus on this learning objective:\n1. ${selectedObjective}`;
                    console.log(`[GENERATE] Randomly selected objective ${randomIndex + 1}/${normalizedLearningObjectives.length}: "${selectedObjective}"`);
                }
            }

            console.log('🎯 [GENERATE] Learning objectives available:', formattedLearningObjectives ? 'Yes' : 'No');
            
            // Check for course-specific question prompts
            let customPrompts = null;
            if (course.questionPrompts) {
                console.log('📝 [GENERATE] Using course-specific question prompts');
                customPrompts = course.questionPrompts;
            }
            
            let generatedQuestion;
            
            if (regenerate) {
                console.log('🔄 [REGENERATE] Processing regeneration request with feedback:', feedback);
                
                // Call regenerate method with lower temperature and feedback
                generatedQuestion = await llmService.regenerateAssessmentQuestion(
                    questionType,
                    combinedContent,
                    lectureName,
                    formattedLearningObjectives,
                    previousQuestion,
                    feedback
                );
                
                console.log(`🔄 AI question regenerated successfully for ${lectureName}: ${questionType}`);
            } else {
                // Normal generation - pass custom prompts if available
                generatedQuestion = await llmService.generateAssessmentQuestion(
                    questionType, 
                    combinedContent, 
                    lectureName,
                    formattedLearningObjectives,
                    customPrompts  // Pass course-specific prompts (will be null if none set)
                );
                
                console.log(`🤖 AI question generated successfully for ${lectureName}: ${questionType}`);
            }

            if (regenerate && normalizedLearningObjectives.length > 0) {
                try {
                    const [relinkedQuestion] = await linkQuestionsToLearningObjectives(
                        llmService,
                        normalizedLearningObjectives,
                        [{
                            ref: 'regenerated-question',
                            questionType,
                            question: generatedQuestion.question,
                            options: generatedQuestion.options || {},
                            correctAnswer: generatedQuestion.answer || '',
                            learningObjective: ''
                        }],
                        false
                    );

                    selectedLearningObjective = normalizeLearningObjective(relinkedQuestion?.learningObjective);
                    console.log(`🔗 [REGENERATE] Re-linked regenerated question to learning objective: "${selectedLearningObjective || 'unassigned'}"`);
                } catch (linkError) {
                    console.error('Error re-linking regenerated question to learning objective:', linkError);
                    selectedLearningObjective = '';
                }
            }
            
            res.json({
                success: true,
                message: 'AI question generated successfully',
                data: {
                    question: generatedQuestion.question,
                    answer: generatedQuestion.answer,
                    options: generatedQuestion.options || {},
                    questionType: questionType,
                    unitName: lectureName,
                    courseId: courseId,
                    struggleTopic: normalizedStruggleTopic || '',
                    selectedLearningObjective,
                    wasRegenerated: Boolean(regenerate),
                    aiGenerated: true,
                    timestamp: new Date().toISOString()
                }
            });
            
        } catch (llmError) {
            console.error('LLM service error:', llmError);
            
            // Provide specific error messages based on the type of error
            let errorMessage = 'Failed to generate AI question. Please try again.';
            let statusCode = 500;
            
            if (llmError.message.includes('timed out')) {
                errorMessage = 'AI question generation is taking longer than expected. This may be due to high server load. Please try again with a shorter document or try again later.';
                statusCode = 408; // Request Timeout
            } else if (llmError.message.includes('JSON')) {
                errorMessage = 'AI generated an invalid response format. Please try again.';
                statusCode = 422; // Unprocessable Entity
            } else if (llmError.message.includes('not initialized')) {
                errorMessage = 'AI service is not available. Please contact support.';
                statusCode = 503; // Service Unavailable
            }
            
            return res.status(statusCode).json({
                success: false,
                message: errorMessage,
                error: llmError.message,
                troubleshooting: {
                    suggestions: [
                        'Try again in a few moments',
                        'Ensure your course materials are not too lengthy',
                        'Check that all required services are running'
                    ]
                }
            });
        }
        
    } catch (error) {
        if (sendLlmKeyError(res, error)) return;
        console.error('Error generating AI question:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error while generating AI question',
            error: error.message
        });
    }
});

module.exports = router;
