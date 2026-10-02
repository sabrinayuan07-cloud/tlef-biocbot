/**
 * Courses API Routes — approved struggle topics and LLM topic extraction
 */

const express = require('express');
const router = express.Router();
const CourseModel = require('../models/Course');
const DocumentModel = require('../models/Document');
const { LANES } = require('../services/llmLanes');
const { resolveCourseAi } = require('./llmKeyMiddleware');
const { hasCourseManagementAccess } = require('./courses.shared');

function hasInstructorOrTAAccess(course, userId) {
    return course.instructorId === userId ||
        (Array.isArray(course.instructors) && course.instructors.includes(userId)) ||
        (Array.isArray(course.tas) && course.tas.includes(userId));
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

module.exports = router;
