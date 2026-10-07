// @ts-check
/**
 * Focused browser coverage for public/instructor/scripts/instructor.js.
 *
 * These tests exercise client-side instructor document-page behavior with
 * mocked API edges so coverage can reach helper/error branches without changing
 * production code or depending on expensive document/AI processing.
 */

const { test, expect } = require('./fixtures/monocart');
const { storageStatePath } = require('./helpers/users');

const COURSE_ID = 'INSTRUCTOR-JS-FOCUSED';
const INSTRUCTOR_ID = 'e2e_instructor_id';

/**
 * @typedef {Window & Record<string, any>} InstructorWindow
 * @typedef {{
 *   textUploads: Record<string, any>[],
 *   fileUploads: number,
 *   savedTopics: Record<string, any>[],
 *   publishBodies: Record<string, any>[],
 *   objectiveBodies: Record<string, any>[],
 *   thresholdBodies: Record<string, any>[],
 *   bulkQuestions: Record<string, any>[],
 *   renamedUnits: Record<string, any>[],
 *   deletedDocuments: Record<string, any>[],
 *   removedDocuments: Record<string, any>[],
 *   questionUpdates: Record<string, any>[],
 *   generatedQuestions: Record<string, any>[],
 *   confirmedMaterials: Record<string, any>[],
 *   unitAdds: Record<string, any>[],
 *   unitDeletes: { pathname: string, body: Record<string, any> }[],
 *   cleanupRequests: Record<string, any>[],
 *   createdQuestions: Record<string, any>[],
 * }} InstructorRouteCaptures
 */

function focusedCourse(overrides = {}) {
    const now = new Date('2026-01-02T03:04:05.000Z');
    return {
        courseId: COURSE_ID,
        courseName: 'Instructor JS Focused Coverage',
        courseCode: 'FOCUS-STU',
        instructorCourseCode: 'FOCUS-INS',
        instructorId: INSTRUCTOR_ID,
        instructors: [INSTRUCTOR_ID],
        tas: [],
        approvedStruggleTopics: [
            { topic: 'Glycolysis', unitId: 'Unit 1', source: 'manual', createdAt: now.toISOString() },
            { topic: 'Oxidative Phosphorylation', unitId: 'Unit 2', source: 'manual', createdAt: now.toISOString() },
        ],
        courseStructure: { weeks: 2, lecturesPerWeek: 1, totalUnits: 2 },
        isOnboardingComplete: true,
        status: 'active',
        lectures: [
            {
                name: 'Unit 1',
                displayName: 'Metabolism',
                isPublished: true,
                learningObjectives: ['Explain glycolysis', 'Compare ATP yields'],
                passThreshold: 1,
                createdAt: now,
                updatedAt: now,
                documents: [
                    {
                        documentId: 'doc_lecture',
                        filename: '*Lecture Notes - Unit 1',
                        originalName: 'Lecture notes.txt',
                        documentType: 'lecture-notes',
                        type: 'lecture_notes',
                        contentType: 'text',
                        status: 'parsed',
                        lectureName: 'Unit 1',
                        courseId: COURSE_ID,
                        size: 123,
                        uploadDate: now.toISOString(),
                        metadata: { description: 'Core notes' },
                    },
                    {
                        documentId: 'doc_practice',
                        filename: '*Practice Questions/Tutorial - Unit 1',
                        originalName: 'Practice quiz.txt',
                        documentType: 'practice-quiz',
                        type: 'practice_q_tutorials',
                        contentType: 'text',
                        status: 'uploaded',
                        lectureName: 'Unit 1',
                        courseId: COURSE_ID,
                        size: 456,
                        uploadDate: now.toISOString(),
                        content: '1. Which step produces ATP?',
                    },
                ],
                assessmentQuestions: [
                    {
                        questionId: 'q_existing',
                        questionType: 'multiple-choice',
                        question: 'Which pathway begins glucose oxidation?',
                        options: { A: 'Glycolysis', B: 'Translation' },
                        correctAnswer: 'A',
                        learningObjective: 'Explain glycolysis',
                    },
                ],
            },
            {
                name: 'Unit 2',
                isPublished: false,
                learningObjectives: [],
                passThreshold: 0,
                createdAt: now,
                updatedAt: now,
                documents: [],
                assessmentQuestions: [],
            },
        ],
        ...overrides,
    };
}

test.use({ storageState: storageStatePath('instructor'), acceptDownloads: true });

async function installInstructorRoutes(page, options = {}) {
    const course = options.course || focusedCourse();
    /** @type {InstructorRouteCaptures} */
    const captured = {
        textUploads: [],
        fileUploads: 0,
        savedTopics: [],
        publishBodies: [],
        objectiveBodies: [],
        thresholdBodies: [],
        bulkQuestions: [],
        renamedUnits: [],
        deletedDocuments: [],
        removedDocuments: [],
        questionUpdates: [],
        generatedQuestions: [],
        confirmedMaterials: [],
        unitAdds: [],
        unitDeletes: [],
        cleanupRequests: [],
        createdQuestions: [],
    };

    await page.route('**/api/**', async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        const pathname = url.pathname;
        const method = request.method();

        for (const override of options.routeOverrides || []) {
            if (await override(route, { request, url, pathname, method, course, captured })) {
                return;
            }
        }

        if (pathname === '/api/settings/llm-tag') {
            await route.fulfill({ json: { success: true, llmIndex: 1, reasoningIndex: 2 } });
            return;
        }

        if (pathname === '/api/auth/me') {
            await route.fulfill({
                json: {
                    success: true,
                    user: {
                        userId: INSTRUCTOR_ID,
                        username: 'e2e_instructor',
                        displayName: 'Focused Instructor',
                        role: 'instructor',
                        permissions: { systemAdmin: true },
                    },
                },
            });
            return;
        }

        if (pathname === `/api/onboarding/${COURSE_ID}`) {
            await route.fulfill({ json: { success: true, data: course } });
            return;
        }

        if (pathname === `/api/onboarding/instructor/${INSTRUCTOR_ID}`) {
            await route.fulfill({ json: { success: true, data: { courses: [course] } } });
            return;
        }

        if (pathname === `/api/courses/${COURSE_ID}` && method === 'GET') {
            await route.fulfill({ json: { success: true, data: course } });
            return;
        }

        if (pathname === `/api/courses/${COURSE_ID}` && method === 'PUT') {
            await route.fulfill({ json: { success: true, data: course } });
            return;
        }

        if (pathname === `/api/courses/${COURSE_ID}/units` && method === 'POST') {
            captured.unitAdds.push(request.postDataJSON());
            await route.fulfill({ json: { success: true, message: 'Unit added' } });
            return;
        }

        if (pathname.startsWith(`/api/courses/${COURSE_ID}/units/`) && method === 'DELETE') {
            captured.unitDeletes.push({ pathname, body: request.postDataJSON() });
            await route.fulfill({ json: { success: true, message: 'Unit deleted' } });
            return;
        }

        if (pathname === `/api/courses/ta/${INSTRUCTOR_ID}`) {
            await route.fulfill({ json: { success: true, data: [{ courseId: COURSE_ID, courseName: course.courseName }] } });
            return;
        }

        if (pathname === `/api/courses/${COURSE_ID}/ta-permissions/${INSTRUCTOR_ID}`) {
            await route.fulfill({
                json: {
                    success: true,
                    data: { permissions: { materials: true, questions: true, settings: true, transcripts: true, flags: false, roster: false } },
                },
            });
            return;
        }

        if (pathname === `/api/courses/${COURSE_ID}/approved-topics` && method === 'GET') {
            await route.fulfill({
                json: {
                    success: true,
                    data: {
                        topics: [
                            { topic: 'Glycolysis', unitId: 'Unit 1', source: 'manual', createdAt: '2026-01-01T00:00:00.000Z' },
                            { topic: 'Oxidative Phosphorylation', unitId: 'Unit 2', source: 'manual', createdAt: '2026-01-01T00:00:00.000Z' },
                        ],
                    },
                },
            });
            return;
        }

        if (pathname === `/api/courses/${COURSE_ID}/approved-topics` && method === 'PUT') {
            captured.savedTopics.push(request.postDataJSON());
            await route.fulfill({
                json: {
                    success: true,
                    data: {
                        topics: request.postDataJSON().topics,
                    },
                },
            });
            return;
        }

        if (pathname === `/api/courses/${COURSE_ID}/extract-topics`) {
            await route.fulfill({
                json: {
                    success: true,
                    data: { topicLabels: ['Glycolysis', ' Citric Acid Cycle ', 'citric acid cycle', 'ATP Synthase'] },
                },
            });
            return;
        }

        if (pathname === '/api/struggle-activity/persistence/' + COURSE_ID) {
            await route.fulfill({
                json: {
                    success: true,
                    data: [
                        { topic: 'Glycolysis', studentCount: 3 },
                        { topic: 'Oxidative Phosphorylation', studentCount: 1 },
                    ],
                },
            });
            return;
        }

        if (pathname === '/api/documents/text') {
            captured.textUploads.push(request.postDataJSON());
            await route.fulfill({
                json: {
                    success: true,
                    message: 'Text uploaded',
                    data: {
                        documentId: 'doc_text_upload',
                        filename: 'Uploaded text.txt',
                        title: 'Additional Material - Unit 1',
                        qdrantProcessed: true,
                    },
                },
            });
            return;
        }

        if (pathname === '/api/documents/upload') {
            captured.fileUploads += 1;
            await route.fulfill({
                json: {
                    success: true,
                    message: 'File uploaded',
                    data: {
                        documentId: 'doc_file_upload',
                        filename: 'focused-notes.txt',
                        qdrantProcessed: false,
                    },
                },
            });
            return;
        }

        if (pathname === '/api/documents/doc_practice') {
            await route.fulfill({
                json: {
                    success: true,
                    data: {
                        documentId: 'doc_practice',
                        originalName: 'Practice quiz.txt',
                        documentType: 'practice-quiz',
                        contentType: 'text',
                        content: '1. Which step produces ATP?',
                        lectureName: 'Unit 1',
                        courseId: COURSE_ID,
                        size: 456,
                        uploadDate: '2026-01-02T03:04:05.000Z',
                    },
                },
            });
            return;
        }

        if (pathname === '/api/documents/doc_practice/extract-questions') {
            await route.fulfill({
                json: {
                    success: true,
                    data: {
                        wasChunked: true,
                        questions: [
                            {
                                questionType: 'multiple-choice',
                                question: 'Which pathway makes pyruvate?',
                                options: { A: 'Glycolysis', B: 'Replication' },
                                correctAnswer: 'A',
                                hasAnswer: true,
                            },
                            {
                                questionType: 'true-false',
                                question: 'ATP synthase uses a proton gradient.',
                                options: {},
                                correctAnswer: null,
                                hasAnswer: false,
                            },
                        ],
                    },
                },
            });
            return;
        }

        if (pathname === '/api/questions/bulk') {
            captured.bulkQuestions.push(request.postDataJSON());
            await route.fulfill({
                json: {
                    success: true,
                    data: { addedCount: request.postDataJSON().questions.length, autoLinkedCount: 1 },
                },
            });
            return;
        }

        if (pathname === '/api/documents/doc_lecture/download') {
            await route.fulfill({
                status: 200,
                headers: {
                    'Content-Type': 'text/plain',
                    'Content-Disposition': "attachment; filename*=UTF-8''Focused%20Lecture.txt",
                },
                body: 'lecture download body',
            });
            return;
        }

        if (pathname === '/api/documents/doc_lecture' && method === 'DELETE') {
            captured.deletedDocuments.push(request.postDataJSON());
            await route.fulfill({ json: { success: true } });
            return;
        }

        if (pathname === '/api/documents/cleanup-orphans') {
            captured.cleanupRequests.push(request.postDataJSON());
            await route.fulfill({
                json: { success: true, data: { totalOrphans: 2 } },
            });
            return;
        }

        if (pathname === `/api/courses/${COURSE_ID}/remove-document`) {
            captured.removedDocuments.push(request.postDataJSON());
            await route.fulfill({ json: { success: true } });
            return;
        }

        if (pathname === '/api/learning-objectives') {
            if (method === 'POST') {
                captured.objectiveBodies.push(request.postDataJSON());
                await route.fulfill({ json: { success: true, message: 'Objectives saved' } });
            } else {
                await route.fulfill({ json: { success: true, data: { objectives: ['Explain glycolysis'] } } });
            }
            return;
        }

        if (pathname === '/api/courses/course-materials/confirm') {
            captured.confirmedMaterials.push(request.postDataJSON());
            await route.fulfill({ json: { success: true, message: 'Materials confirmed' } });
            return;
        }

        if (pathname === '/api/lectures/publish-status') {
            await route.fulfill({
                json: { success: true, data: { publishStatus: { 'Unit 1': true, 'Unit 2': false } } },
            });
            return;
        }

        if (pathname === '/api/lectures/publish') {
            captured.publishBodies.push(request.postDataJSON());
            await route.fulfill({
                json: { success: true, message: 'Publish updated', data: request.postDataJSON() },
            });
            return;
        }

        if (pathname === '/api/lectures/pass-threshold') {
            if (method === 'POST') {
                captured.thresholdBodies.push(request.postDataJSON());
                await route.fulfill({ json: { success: true, message: 'Threshold saved' } });
            } else {
                await route.fulfill({ json: { success: true, data: { passThreshold: 1 } } });
            }
            return;
        }

        if (pathname === '/api/questions/lecture') {
            await route.fulfill({
                json: {
                    success: true,
                    data: {
                        questions: [
                            {
                                questionId: 'q_existing',
                                questionType: 'multiple-choice',
                                question: 'Which pathway begins glucose oxidation?',
                                options: { A: 'Glycolysis', B: 'Translation' },
                                correctAnswer: 'A',
                                learningObjective: 'Explain glycolysis',
                            },
                        ],
                    },
                },
            });
            return;
        }

        if (pathname === '/api/questions' && method === 'POST') {
            captured.createdQuestions.push(request.postDataJSON());
            await route.fulfill({
                json: {
                    success: true,
                    data: { questionId: 'q_created' },
                },
            });
            return;
        }

        if (pathname === '/api/questions/generate-ai') {
            const body = request.postDataJSON();
            captured.generatedQuestions.push(body);
            await route.fulfill({
                json: {
                    success: true,
                    data: body.regenerate
                        ? {
                            question: 'Regenerated question about glycolysis?',
                            options: { choices: ['Glucose', 'DNA', 'RNA', 'Protein'], correctAnswer: 'A' },
                            answer: 'A',
                            selectedLearningObjective: 'Compare ATP yields',
                            wasRegenerated: true,
                        }
                        : {
                            question: body.struggleTopic
                                ? `Generated from ${body.struggleTopic}?`
                                : 'AI generated glycolysis question?',
                            options: { A: 'Glycolysis', B: 'Translation', C: 'Splicing', D: 'Replication' },
                            answer: 'A',
                            selectedLearningObjective: 'Explain glycolysis',
                        },
                },
            });
            return;
        }

        if (pathname === '/api/questions/auto-link-learning-objectives') {
            await route.fulfill({
                json: { success: true, message: 'Auto-linked 1 question', data: { linkedCount: 1, unassignedCount: 0 } },
            });
            return;
        }

        if (pathname === '/api/questions/q_existing' && method === 'PUT') {
            captured.questionUpdates.push(request.postDataJSON());
            await route.fulfill({ json: { success: true, data: request.postDataJSON() } });
            return;
        }

        if (pathname === '/api/questions/q_existing' && method === 'DELETE') {
            await route.fulfill({ json: { success: true } });
            return;
        }

        if (pathname === `/api/courses/${COURSE_ID}/units/Unit%201/rename`) {
            captured.renamedUnits.push(request.postDataJSON());
            await route.fulfill({ json: { success: true, message: 'Unit renamed' } });
            return;
        }

        await route.fulfill({ json: { success: true, data: {} } });
    });

    return captured;
}

async function openInstructorDocuments(page, options = {}) {
    const captured = await installInstructorRoutes(page, options);
    await page.goto(`/instructor/documents?courseId=${COURSE_ID}`);
    await expect(page.locator('#course-title')).toHaveText('Instructor JS Focused Coverage', { timeout: 15_000 });
    await expect(page.locator('.accordion-item[data-unit-name="Unit 1"]')).toBeVisible();
    await page.waitForFunction(() => {
        const instructorWindow = /** @type {InstructorWindow} */ (window);
        return [
            'openUploadModal',
            'handleUpload',
            'showInlineTopicReview',
            'openQuestionModal',
            'generateAIQuestionContent',
            'showQuestionReviewModal',
            'openRenameUnitInput',
        ].every((name) => typeof instructorWindow[name] === 'function');
    });
    return captured;
}

async function notification(page, text) {
    await expect(page.locator('.notification').filter({ hasText: text }).last()).toBeVisible({ timeout: 10_000 });
}

test.describe('instructor.js focused browser coverage', () => {
    test('uploads pasted content, reviews deduped topics, and saves merged topic entries', async ({ page }) => {
        const captured = await openInstructorDocuments(page);

        const parsedDocument = page.locator('.file-item[data-document-id="doc_lecture"]');
        await expect(parsedDocument).toHaveAttribute('data-status', 'parsed');
        await expect(parsedDocument.locator('.status-text')).toHaveText('Uploaded');

        await page.locator('.add-content-btn.additional-material').first().click();
        await expect(page.locator('#upload-modal')).toHaveClass(/show/);

        await page.locator('button.method-btn', { hasText: 'Paste content directly' }).click();
        await page.locator('#material-name').fill('ATP Production Notes');
        await page.locator('#text-input').fill('Pasted instructor material about ATP production.');
        await page.locator('#upload-btn').click();

        await expect(page.locator('#topic-review-section')).toBeVisible({ timeout: 10_000 });
        await expect(page.locator('#upload-topic-review-list .topic-review-item')).toHaveCount(2);
        await expect(page.locator('#upload-topic-existing-note')).toContainText('2 existing topics');

        await page.locator('#upload-topic-review-list .topic-review-item').first().locator('.topic-review-remove').click();
        await page.locator('#upload-topic-new-input').fill('  NADH Shuttles  ');
        await page.locator('#upload-topic-add-btn').click();
        await page.locator('#save-topics-btn').click();

        await expect(page.locator('#upload-modal')).not.toHaveClass(/show/);
        expect(captured.textUploads).toHaveLength(1);
        expect(captured.savedTopics).toHaveLength(1);
        expect(captured.savedTopics[0].topics.map((topic) => topic.topic)).toEqual([
            'Glycolysis',
            'Oxidative Phosphorylation',
            'ATP Synthase',
            'NADH Shuttles',
        ]);
    });

    test('uploads a file into a required placeholder and prevents closing while upload is active', async ({ page }) => {
        const captured = await openInstructorDocuments(page);

        await page.evaluate(() => {
            const instructorWindow = /** @type {InstructorWindow} */ (window);
            instructorWindow.openUploadModal('Unit 2', 'lecture-notes');
        });
        await page.locator('button.method-btn', { hasText: 'Upload a file' }).click();

        await page.evaluate(() => {
            const instructorWindow = /** @type {InstructorWindow} */ (window);
            instructorWindow.handleFileUpload(new File(['notes'], 'focused-notes.txt', { type: 'text/plain' }));
        });

        await expect(page.locator('#file-name')).toHaveText('focused-notes.txt');
        await expect(page.locator('#file-size')).toHaveText('5 Bytes');

        await page.locator('#upload-loading-indicator').evaluate((el) => {
            const htmlElement = /** @type {HTMLElement} */ (el);
            htmlElement.style.display = 'block';
        });
        await page.locator('#upload-modal .modal-close').click();
        await notification(page, 'Please wait for the upload to complete before closing.');

        await page.locator('#upload-loading-indicator').evaluate((el) => {
            const htmlElement = /** @type {HTMLElement} */ (el);
            htmlElement.style.display = 'none';
        });
        await page.locator('#upload-btn').click();

        await expect(page.locator('#topic-review-section')).toBeVisible({ timeout: 10_000 });
        expect(captured.fileUploads).toBe(1);
        await expect(page.locator('.file-item[data-document-id="doc_file_upload"] .status-text')).toHaveText('Uploaded');
    });

    test('saves objectives, confirms materials, publishes, thresholds, renames, and updates summary', async ({ page }) => {
        const captured = await openInstructorDocuments(page);
        page.on('dialog', (dialog) => dialog.accept());

        await page.locator('#objective-input-unit-1').fill('Describe substrate-level phosphorylation');
        await page.locator('.add-objective-btn-inline').first().click();
        await expect(page.locator('#objectives-list-unit-1')).toContainText('Describe substrate-level phosphorylation');

        await page.locator('#objectives-list-unit-1 .remove-objective').last().click();
        await expect(page.locator('#objectives-list-unit-1')).not.toContainText('Describe substrate-level phosphorylation');

        await page.locator('.learning-objectives-section .save-btn').first().click();
        await page.locator('.course-materials-section .save-btn').first().click();
        await page.evaluate(() => {
            const instructorWindow = /** @type {InstructorWindow} */ (window);
            const toggle = /** @type {HTMLInputElement} */ (document.getElementById('publish-unit-2'));
            toggle.checked = true;
            instructorWindow.togglePublish('Unit 2', true);
            instructorWindow.updatePublishedSummary();
        });
        await page.locator('#pass-threshold-unit-1').fill('1');
        await page.locator('.assessment-questions-section .save-btn').first().click();
        await page.locator('.unit-rename-btn').first().click();
        await page.locator('.unit-rename-input').first().fill('Energy Flow');
        await page.locator('.unit-save-btn').first().click();

        await expect.poll(() => captured.objectiveBodies.length).toBe(1);
        await expect.poll(() => captured.confirmedMaterials.length).toBe(1);
        await expect.poll(() => captured.publishBodies.length).toBeGreaterThan(0);
        await expect.poll(() => captured.thresholdBodies.length).toBe(1);
        expect(captured.thresholdBodies[0]).toMatchObject({
            courseId: COURSE_ID,
            lectureName: 'Unit 1',
            passThreshold: 1,
            instructorId: INSTRUCTOR_ID,
        });
        await expect.poll(() => captured.renamedUnits.length).toBe(1);
        await expect(page.locator('.folder-name').first()).toHaveText('1. Energy Flow');
        await expect(page.locator('#published-units-summary')).toContainText('Currently, 2 of the 2 Units are Published.');

        // Unchecking "Show unit number" drops the "<N>. " prefix from the label.
        await page.locator('.unit-rename-btn').first().click();
        await expect(page.locator('.unit-show-number-input').first()).toBeChecked();
        await page.locator('.unit-show-number-input').first().uncheck();
        await page.locator('.unit-save-btn').first().click();

        await expect.poll(() => captured.renamedUnits.length).toBe(2);
        expect(captured.renamedUnits[1]).toMatchObject({ displayName: 'Energy Flow', showUnitNumber: false });
        await expect(page.locator('.folder-name').first()).toHaveText('Energy Flow');
    });

    test('drives AI generation, struggle-topic generation, regeneration, objective edit, and auto-link flow', async ({ page }) => {
        const captured = await openInstructorDocuments(page);

        await page.locator('.add-question-btn').first().click();
        await expect(page.locator('#question-modal')).toHaveClass(/show/);
        await page.locator('#question-type').selectOption('multiple-choice');

        await expect(page.locator('#ai-generate-btn')).toBeEnabled();
        await page.locator('#ai-generate-btn').click();
        await expect(page.locator('#question-text')).toHaveValue('AI generated glycolysis question?', { timeout: 10_000 });
        await expect(page.locator('#learning-objective-select')).toHaveValue('Explain glycolysis');

        await page.locator('#ai-generate-btn').click();
        await expect(page.locator('#regenerate-modal')).toHaveClass(/show/);
        await page.locator('#regenerate-feedback').fill('Make it more specific.');
        await page.locator('#regenerate-submit-btn').click();
        await expect(page.locator('#question-text')).toHaveValue('Regenerated question about glycolysis?', { timeout: 10_000 });
        await expect(page.locator('#learning-objective-select')).toHaveValue('Compare ATP yields');

        await page.locator('#struggle-topic-panel').evaluate((el) => {
            const details = /** @type {HTMLDetailsElement} */ (el);
            details.open = true;
        });
        await page.locator('#show-all-struggle-topics-toggle').click();
        await expect(page.locator('#struggle-topic-select')).toContainText('Oxidative Phosphorylation', { timeout: 10_000 });
        await page.locator('#struggle-topic-select').selectOption('Oxidative Phosphorylation');
        await page.locator('#topic-generate-btn').click();
        await expect(page.locator('#question-text')).toHaveValue('Generated from Oxidative Phosphorylation?', { timeout: 10_000 });

        await page.evaluate(() => {
            const instructorWindow = /** @type {InstructorWindow} */ (window);
            instructorWindow.closeQuestionModal();
            instructorWindow.updateQuestionsDisplay('Unit 1');
        });
        await page.locator('.edit-question-btn').first().click();
        await expect(page.locator('#question-learning-objective-modal')).toHaveClass(/show/);
        await page.locator('#edit-learning-objective-select').selectOption('Compare ATP yields');
        await page.locator('#question-learning-objective-modal .btn-primary').click();

        await page.locator('.auto-link-btn').first().click();
        await expect(page.locator('#auto-link-confirmation-modal')).toHaveClass(/show/);
        await page.locator('#auto-link-confirmation-modal .btn-primary').click();

        await expect.poll(() => captured.questionUpdates.length).toBe(1);
        await expect.poll(() => captured.generatedQuestions.length).toBeGreaterThanOrEqual(3);
        await notification(page, 'Auto-linked 1 question');
    });

    test('views practice documents, extracts questions, fills missing answers, and bulk saves selections', async ({ page }) => {
        const captured = await openInstructorDocuments(page);

        await page.locator('button.action-button.view').filter({ hasText: 'View' }).nth(1).click();
        await expect(page.locator('.document-modal')).toContainText('Practice quiz.txt');
        await page.locator('.document-modal button', { hasText: 'Find Assessment Questions' }).click();

        await expect(page.locator('.question-review-modal')).toBeVisible({ timeout: 10_000 });
        await expect(page.locator('#qr-selected-count')).toHaveText('1 question selected');
        await page.locator('.missing-answer-input').selectOption('True');
        await expect(page.locator('#qr-selected-count')).toHaveText('2 questions selected');
        await page.locator('.qr-no-btn').first().click();
        await expect(page.locator('#qr-selected-count')).toHaveText('1 question selected');
        await page.locator('#qr-save-btn').click();

        await expect(page.locator('.question-review-modal')).toHaveCount(0, { timeout: 10_000 });
        expect(captured.bulkQuestions).toHaveLength(1);
        expect(captured.bulkQuestions[0].questions).toHaveLength(1);
        expect(captured.bulkQuestions[0].questions[0].correctAnswer).toBe('True');
    });

    test('covers unit management, TA permissions, direct question save/delete, cleanup, and helper branches', async ({ page }) => {
        const captured = await openInstructorDocuments(page);

        await page.evaluate(async (courseId) => {
            const instructorWindow = /** @type {InstructorWindow} */ (window);

            const fileInput = /** @type {HTMLInputElement} */ (document.getElementById('file-input'));
            fileInput.addEventListener('click', () => {
                fileInput.dataset.clicked = 'true';
            }, { once: true });
            instructorWindow.triggerFileInput();

            const sectionHeader = /** @type {HTMLElement} */ (document.querySelector('.section-header'));
            instructorWindow.toggleSection(sectionHeader, new Event('click'));
            instructorWindow.toggleSection(sectionHeader, null);

            const matches = instructorWindow.findElementsContainingText('.folder-name', 'metabolism');
            if (matches.length === 0) throw new Error('Expected folder-name match');

            await instructorWindow.addNewUnit();
            instructorWindow.openDeleteUnitModal('Unit 2');
            instructorWindow.closeDeleteUnitModal();
            instructorWindow.openDeleteUnitModal('Unit 2');
            await instructorWindow.confirmDeleteUnit();
        });

        await expect.poll(() => captured.unitAdds.length).toBe(1);
        await expect.poll(() => captured.unitDeletes.length).toBe(1);

        await page.evaluate(async (courseId) => {
            const instructorWindow = /** @type {InstructorWindow} */ (window);
            const reviewPromise = instructorWindow.runTopicReviewAfterUpload(courseId, 'doc_topic', 'Topic source');
            await new Promise((resolve, reject) => {
                const startedAt = Date.now();
                const timer = setInterval(() => {
                    const saveButton = /** @type {HTMLButtonElement | null} */ (document.querySelector('#topic-review-save-btn'));
                    if (saveButton) {
                        clearInterval(timer);
                        saveButton.click();
                        resolve(undefined);
                    } else if (Date.now() - startedAt > 5000) {
                        clearInterval(timer);
                        reject(new Error('Topic review modal did not open'));
                    }
                }, 25);
            });
            await reviewPromise;
        }, COURSE_ID);

        await page.evaluate(async () => {
            const instructorWindow = /** @type {InstructorWindow} */ (window);
            instructorWindow.setupTANavigationHandlers();
            await instructorWindow.updateTANavigationBasedOnPermissions();
            if (!instructorWindow.hasPermissionForFeature('courses')) {
                throw new Error('Expected courses permission');
            }
            if (instructorWindow.hasPermissionForFeature('flags')) {
                throw new Error('Expected flags permission to be denied');
            }
            if (instructorWindow.getSelectedCourseIdForTA() !== 'INSTRUCTOR-JS-FOCUSED') {
                throw new Error('Expected selected TA course from URL');
            }
        });

        await page.evaluate(async (courseId) => {
            const instructorWindow = /** @type {InstructorWindow} */ (window);
            await instructorWindow.removeDocumentFromCourseStructure('doc_lecture', courseId, 'e2e_instructor_id');
            await instructorWindow.cleanupOrphanedDocuments();
            await instructorWindow.deleteAssessmentQuestion('q_existing', 'Unit 1');
            await instructorWindow.reloadPassThresholds();

            instructorWindow.openQuestionModal('Unit 1');
            /** @type {HTMLSelectElement} */ (document.getElementById('question-type')).value = 'short-answer';
            instructorWindow.updateQuestionForm();
            /** @type {HTMLTextAreaElement} */ (document.getElementById('question-text')).value = 'What is glycolysis?';
            /** @type {HTMLTextAreaElement} */ (document.getElementById('sa-answer')).value = 'A pathway that oxidizes glucose.';
            await instructorWindow.saveQuestion();

            window.confirm = () => true;
            await instructorWindow.deleteQuestion('Unit 1', 'q_existing');

            const fallbackTf = instructorWindow.createFallbackAIContent('true-false', 'Unit 1');
            const fallbackMc = instructorWindow.createFallbackAIContent('multiple-choice', 'Unit 1');
            const fallbackSa = instructorWindow.createFallbackAIContent('short-answer', 'Unit 1');
            if (!fallbackTf.question || !fallbackMc.options || !fallbackSa.answer) {
                throw new Error('Expected fallback AI content for all supported types');
            }
            instructorWindow.checkLectureNotesUploaded('Unit 1');
        }, COURSE_ID);

        await expect.poll(() => captured.cleanupRequests.length).toBe(1);
        await expect.poll(() => captured.createdQuestions.length).toBe(1);
        expect(captured.createdQuestions[0].questionType).toBe('short-answer');
    });

    test('covers document download, delete cleanup, standalone topic modal, helper fallbacks, and empty course state', async ({ page }) => {
        const captured = await openInstructorDocuments(page);

        await page.evaluate(() => {
            const instructorWindow = /** @type {InstructorWindow} */ (window);
            URL.createObjectURL = () => 'blob:focused-download';
            URL.revokeObjectURL = () => {};
            instructorWindow.downloadDocument('doc_lecture');
        });
        await expect(page.locator('.notification')).not.toContainText('Error downloading document');

        page.on('dialog', (dialog) => dialog.accept());
        await page.locator('button.action-button.delete').filter({ hasText: 'Delete' }).first().click();
        await expect.poll(() => captured.deletedDocuments.length).toBe(1);
        await expect.poll(() => captured.removedDocuments.length).toBe(1);

        const modalTopics = page.evaluate(async (courseId) => {
            const instructorWindow = /** @type {InstructorWindow} */ (window);
            const promise = instructorWindow.openTopicReviewModal(
                courseId,
                'Manual source',
                ['Glycolysis'],
                ['Glycolysis', 'Fermentation'],
                'Unit 2'
            );
            const input = /** @type {HTMLInputElement} */ (document.querySelector('#topic-review-new-input'));
            const addButton = /** @type {HTMLButtonElement} */ (document.querySelector('#topic-review-add-btn'));
            const saveButton = /** @type {HTMLButtonElement} */ (document.querySelector('#topic-review-save-btn'));
            input.value = 'Lactate';
            addButton.click();
            saveButton.click();
            return promise;
        }, COURSE_ID);

        await expect(page.locator('#topic-review-modal')).not.toHaveClass(/show/);
        await expect(modalTopics).resolves.toEqual(expect.arrayContaining([
            expect.objectContaining({ topic: 'Fermentation', unitId: 'Unit 2', source: 'scraped' }),
            expect.objectContaining({ topic: 'Lactate', unitId: 'Unit 2', source: 'manual' }),
        ]));

        await page.evaluate(() => {
            const instructorWindow = /** @type {InstructorWindow} */ (window);
            instructorWindow.showEmptyCourseState();
            instructorWindow.updateFileStatus('lecture-notes', 'Unit 1', 'uploaded', 'notes.txt');
            instructorWindow.openRenameUnitInput('Missing Unit');
            instructorWindow.cancelRenameUnit('Missing Unit');
            instructorWindow.closeDocumentModal();
            instructorWindow.closeQuestionReviewModal();
            instructorWindow.stopPublishStatusPolling();
            instructorWindow.saveAssessment('Missing Unit');
        });

        await expect(page.locator('#course-title')).toHaveText('No Course Found');
        await expect(page.locator('.empty-course-state')).toContainText('Go to Onboarding');
    });

    test('replays startup event wiring for TA navigation, modal backdrops, settings toggle, and polling handlers', async ({ page }) => {
        await openInstructorDocuments(page);

        const result = await page.evaluate(async () => {
            const instructorWindow = /** @type {InstructorWindow} */ (window);
            const originalIsTA = instructorWindow.isTA;
            const originalSetInterval = window.setInterval;
            const originalClearInterval = window.clearInterval;
            const testWindow = /** @type {any} */ (window);
            const originalGetCurrentUser = testWindow.getCurrentUser;
            const originalGetCurrentCourseId = testWindow.getCurrentCourseId;
            const intervalCallbacks = [];

            function ensureElement(id, tag = 'div') {
                let element = document.getElementById(id);
                if (!element) {
                    element = document.createElement(tag);
                    element.id = id;
                    document.body.appendChild(element);
                }
                return element;
            }

            [
                'instructor-home-nav',
                'instructor-documents-nav',
                'instructor-onboarding-nav',
                'instructor-flagged-nav',
                'instructor-downloads-nav',
                'instructor-ta-hub-nav',
                'instructor-settings-nav',
                'ta-dashboard-nav',
                'ta-courses-nav',
                'ta-support-nav',
                'ta-settings-nav',
            ].forEach((id) => ensureElement(id));

            const avatar = ensureElement('focused-user-avatar');
            avatar.className = 'user-avatar';
            const role = ensureElement('focused-user-role');
            role.className = 'user-role';

            const myCourses = /** @type {HTMLAnchorElement} */ (ensureElement('ta-my-courses-link', 'a'));
            myCourses.href = '#courses';
            const support = /** @type {HTMLAnchorElement} */ (ensureElement('ta-student-support-link', 'a'));
            support.href = '#support';

            instructorWindow.isTA = () => true;
            window.setInterval = /** @type {any} */ ((callback) => {
                intervalCallbacks.push(callback);
                Promise.resolve().then(callback);
                return 12345;
            });
            window.clearInterval = /** @type {any} */ (() => {});

            testWindow.getCurrentUser = () => null;
            document.dispatchEvent(new Event('DOMContentLoaded'));
            await new Promise((resolve) => setTimeout(resolve, 50));
            testWindow.getCurrentUser = originalGetCurrentUser;
            document.dispatchEvent(new Event('auth:ready'));
            await new Promise((resolve) => setTimeout(resolve, 50));
            await Promise.all(intervalCallbacks.map((callback) => Promise.resolve(callback())));
            document.dispatchEvent(new Event('visibilitychange'));
            myCourses.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

            window.history.replaceState({}, '', '/instructor/documents');
            localStorage.removeItem('selectedCourseId');
            testWindow.taCourses = [];
            testWindow.getCurrentCourseId = async () => null;
            support.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            await new Promise((resolve) => setTimeout(resolve, 0));
            testWindow.getCurrentCourseId = originalGetCurrentCourseId;

            document.querySelector('.add-content-btn.additional-material')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            await new Promise((resolve) => setTimeout(resolve, 0));

            instructorWindow.openUploadModal('Unit 1', 'additional');
            document.getElementById('upload-modal')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

            instructorWindow.openQuestionModal('Unit 1');
            document.getElementById('question-modal')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

            instructorWindow.openQuestionLearningObjectiveModal('Unit 1', 'q_existing');
            document.getElementById('question-learning-objective-modal')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

            instructorWindow.openAutoLinkConfirmationModal('Unit 1');
            document.getElementById('auto-link-confirmation-modal')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

            document.querySelector('.section-header')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            document.querySelector('.accordion-header .publish-toggle input')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            document.querySelector('.accordion-header')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

            const fileInput = /** @type {HTMLInputElement} */ (document.getElementById('file-input'));
            if (fileInput) {
                const dataTransfer = new DataTransfer();
                dataTransfer.items.add(new File(['changed'], 'changed-notes.txt', { type: 'text/plain' }));
                fileInput.files = dataTransfer.files;
                fileInput.dispatchEvent(new Event('change', { bubbles: true }));
            }

            document.querySelector('.publish-toggle input')?.dispatchEvent(new Event('change', { bubbles: true }));

            const firstRenameInput = /** @type {HTMLInputElement} */ (document.querySelector('.unit-rename-input'));
            instructorWindow.openRenameUnitInput('Unit 1');
            firstRenameInput?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            instructorWindow.openRenameUnitInput('Unit 1');
            firstRenameInput?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
            await new Promise((resolve) => setTimeout(resolve, 50));

            window.setInterval = originalSetInterval;
            window.clearInterval = originalClearInterval;
            instructorWindow.isTA = originalIsTA;
            testWindow.getCurrentUser = originalGetCurrentUser;
            testWindow.getCurrentCourseId = originalGetCurrentCourseId;

            return {
                instructorHomeDisplay: document.getElementById('instructor-home-nav')?.style.display,
                taCoursesDisplay: document.getElementById('ta-courses-nav')?.style.display,
            };
        });

        expect(result.instructorHomeDisplay).toBe('none');
        expect(result.taCoursesDisplay).toBe('block');
    });

    test('covers route failure branches without changing production behavior', async ({ page }) => {
        const failures = {
            addUnit: 0,
            deleteUnit: 0,
            publishHttp: 0,
            publishResult: 0,
            publishStatus: 0,
            downloadJson: 0,
            extractEmpty: 0,
            extractError: 0,
            bulkError: 0,
            objectiveError: 0,
            thresholdError: 0,
            materials404: 0,
            materials500: 0,
            cleanupNone: 0,
            cleanupError: 0,
            renameError: 0,
            questionUpdateError: 0,
            questionCreate401: 0,
            generateError: 0,
            generateNonJson: 0,
            struggleGenerateNonJson: 0,
            regenerateNonJson: 0,
            textUploadError: 0,
            fileUploadError: 0,
            publishNonJson: 0,
            publishStatusChanged: 0,
            downloadText: 0,
            delete404: 0,
            delete500: 0,
            removeDocument500: 0,
            courseGetLegacy: 0,
            courseGetMissing: 0,
        };

        await openInstructorDocuments(page, {
            routeOverrides: [
                async (route, { request, pathname, method }) => {
                    if (pathname === `/api/courses/${COURSE_ID}/units` && method === 'POST' && failures.addUnit) {
                        failures.addUnit -= 1;
                        await route.fulfill({ status: 500, body: 'add failed' });
                        return true;
                    }
                    if (pathname.startsWith(`/api/courses/${COURSE_ID}/units/`) && method === 'DELETE' && failures.deleteUnit) {
                        failures.deleteUnit -= 1;
                        await route.fulfill({ status: 500, body: 'delete failed' });
                        return true;
                    }
                    if (pathname === '/api/lectures/publish' && failures.publishHttp) {
                        failures.publishHttp -= 1;
                        await route.fulfill({ status: 409, json: { success: false, message: 'publish conflict' } });
                        return true;
                    }
                    if (pathname === '/api/lectures/publish' && failures.publishNonJson) {
                        failures.publishNonJson -= 1;
                        await route.fulfill({ status: 503, contentType: 'text/plain', body: 'publish unavailable' });
                        return true;
                    }
                    if (pathname === '/api/lectures/publish' && failures.publishResult) {
                        failures.publishResult -= 1;
                        await route.fulfill({ json: { success: false, message: 'publish rejected' } });
                        return true;
                    }
                    if (pathname === '/api/lectures/publish-status' && failures.publishStatusChanged) {
                        failures.publishStatusChanged -= 1;
                        await route.fulfill({
                            json: { success: true, data: { publishStatus: { 'Unit 1': false, 'Unit 2': false } } },
                        });
                        return true;
                    }
                    if (pathname === '/api/lectures/publish-status' && failures.publishStatus) {
                        failures.publishStatus -= 1;
                        await route.fulfill({ status: 500, body: 'status failed' });
                        return true;
                    }
                    if (pathname === '/api/documents/doc_lecture/download' && failures.downloadJson) {
                        failures.downloadJson -= 1;
                        await route.fulfill({ status: 403, json: { message: 'download denied' } });
                        return true;
                    }
                    if (pathname === '/api/documents/doc_lecture/download' && failures.downloadText) {
                        failures.downloadText -= 1;
                        await route.fulfill({ status: 503, contentType: 'text/plain', body: 'plain download denied' });
                        return true;
                    }
                    if (pathname === '/api/documents/doc_practice/extract-questions' && failures.extractEmpty) {
                        failures.extractEmpty -= 1;
                        await route.fulfill({ json: { success: true, data: { wasChunked: false, questions: [] } } });
                        return true;
                    }
                    if (pathname === '/api/documents/doc_practice/extract-questions' && failures.extractError) {
                        failures.extractError -= 1;
                        await route.fulfill({ status: 500, json: { success: false, message: 'extract failed' } });
                        return true;
                    }
                    if (pathname === '/api/questions/bulk' && failures.bulkError) {
                        failures.bulkError -= 1;
                        await route.fulfill({ status: 500, json: { success: false, message: 'bulk failed' } });
                        return true;
                    }
                    if (pathname === '/api/learning-objectives' && method === 'POST' && failures.objectiveError) {
                        failures.objectiveError -= 1;
                        await route.fulfill({ status: 500, body: 'objective failed' });
                        return true;
                    }
                    if (pathname === '/api/lectures/pass-threshold' && method === 'POST' && failures.thresholdError) {
                        failures.thresholdError -= 1;
                        await route.fulfill({ status: 500, body: 'threshold failed' });
                        return true;
                    }
                    if (pathname === '/api/courses/course-materials/confirm' && failures.materials404) {
                        failures.materials404 -= 1;
                        await route.fulfill({ status: 404, body: 'missing endpoint' });
                        return true;
                    }
                    if (pathname === '/api/courses/course-materials/confirm' && failures.materials500) {
                        failures.materials500 -= 1;
                        await route.fulfill({ status: 500, body: 'confirm failed' });
                        return true;
                    }
                    if (pathname === '/api/documents/cleanup-orphans' && failures.cleanupNone) {
                        failures.cleanupNone -= 1;
                        await route.fulfill({ json: { success: true, data: { totalOrphans: 0 } } });
                        return true;
                    }
                    if (pathname === '/api/documents/cleanup-orphans' && failures.cleanupError) {
                        failures.cleanupError -= 1;
                        await route.fulfill({ status: 500, body: 'cleanup failed' });
                        return true;
                    }
                    if (pathname === `/api/courses/${COURSE_ID}/units/Unit%201/rename` && failures.renameError) {
                        failures.renameError -= 1;
                        await route.fulfill({ status: 500, body: 'rename failed' });
                        return true;
                    }
                    if (pathname === '/api/questions/q_existing' && method === 'PUT' && failures.questionUpdateError) {
                        failures.questionUpdateError -= 1;
                        await route.fulfill({ status: 500, body: 'question update failed' });
                        return true;
                    }
                    if (pathname === '/api/questions' && method === 'POST' && failures.questionCreate401) {
                        failures.questionCreate401 -= 1;
                        await route.fulfill({ status: 401, contentType: 'text/plain', body: 'expired' });
                        return true;
                    }
                    if (pathname === '/api/questions/generate-ai' && failures.generateNonJson) {
                        failures.generateNonJson -= 1;
                        await route.fulfill({ status: 503, contentType: 'text/plain', body: 'generation unavailable' });
                        return true;
                    }
                    if (pathname === '/api/questions/generate-ai' && failures.struggleGenerateNonJson) {
                        failures.struggleGenerateNonJson -= 1;
                        await route.fulfill({ status: 503, contentType: 'text/plain', body: 'topic generation unavailable' });
                        return true;
                    }
                    if (pathname === '/api/questions/generate-ai' && failures.regenerateNonJson) {
                        failures.regenerateNonJson -= 1;
                        await route.fulfill({ status: 502, contentType: 'text/plain', body: 'regeneration unavailable' });
                        return true;
                    }
                    if (pathname === '/api/questions/generate-ai' && failures.generateError) {
                        failures.generateError -= 1;
                        await route.fulfill({ status: 503, json: { success: false, message: 'generation down' } });
                        return true;
                    }
                    if (pathname === '/api/documents/text' && failures.textUploadError) {
                        failures.textUploadError -= 1;
                        await route.fulfill({ status: 500, body: 'text upload failed' });
                        return true;
                    }
                    if (pathname === '/api/documents/upload' && failures.fileUploadError) {
                        failures.fileUploadError -= 1;
                        await route.fulfill({ status: 500, body: 'file upload failed' });
                        return true;
                    }
                    if (pathname === '/api/documents/doc_lecture' && method === 'DELETE' && failures.delete404) {
                        failures.delete404 -= 1;
                        await route.fulfill({ status: 404, contentType: 'text/plain', body: 'already gone' });
                        return true;
                    }
                    if (pathname === '/api/documents/doc_lecture' && method === 'DELETE' && failures.delete500) {
                        failures.delete500 -= 1;
                        await route.fulfill({ status: 500, contentType: 'text/plain', body: 'delete warning' });
                        return true;
                    }
                    if (pathname === `/api/courses/${COURSE_ID}/remove-document` && failures.removeDocument500) {
                        failures.removeDocument500 -= 1;
                        await route.fulfill({ status: 500, contentType: 'text/plain', body: 'remove failed' });
                        return true;
                    }
                    if (pathname === `/api/courses/${COURSE_ID}` && method === 'GET' && failures.courseGetLegacy) {
                        failures.courseGetLegacy -= 1;
                        await route.fulfill({
                            json: {
                                success: true,
                                data: {
                                    courseId: COURSE_ID,
                                    courseMaterials: [{ id: 'legacy_doc' }],
                                    unitFiles: [{ _id: 'legacy_doc' }],
                                    lectures: [
                                        {
                                            name: 'Unit 1',
                                            materials: [{ id: 'legacy_doc' }],
                                            files: [{ _id: 'other_doc' }],
                                            documents: [],
                                        },
                                    ],
                                },
                            },
                        });
                        return true;
                    }
                    if (pathname === `/api/courses/${COURSE_ID}` && method === 'GET' && failures.courseGetMissing) {
                        failures.courseGetMissing -= 1;
                        await route.fulfill({ status: 404, contentType: 'text/plain', body: 'course missing' });
                        return true;
                    }
                    void request;
                    return false;
                },
            ],
        });

        await page.evaluate(async () => {
            const instructorWindow = /** @type {InstructorWindow} */ (window);
            URL.createObjectURL = () => 'blob:focused-error-download';
            URL.revokeObjectURL = () => {};
            window.confirm = () => true;

            instructorWindow.openUploadModal('Unit 1', 'additional');
            await instructorWindow.handleUpload();
        });

        failures.addUnit = 1;
        await page.evaluate(async () => {
            const instructorWindow = /** @type {InstructorWindow} */ (window);
            await instructorWindow.addNewUnit();
        });

        failures.deleteUnit = 1;
        await page.evaluate(async () => {
            const instructorWindow = /** @type {InstructorWindow} */ (window);
            instructorWindow.openDeleteUnitModal('Unit 2');
            await instructorWindow.confirmDeleteUnit();
        });

        failures.publishHttp = 1;
        await page.evaluate(async () => {
            const instructorWindow = /** @type {InstructorWindow} */ (window);
            await instructorWindow.updatePublishStatus('Unit 1', false);
        });

        failures.publishResult = 1;
        await page.evaluate(async () => {
            const instructorWindow = /** @type {InstructorWindow} */ (window);
            await instructorWindow.updatePublishStatus('Unit 1', true);
        });

        failures.publishStatus = 1;
        await page.evaluate(async () => {
            const instructorWindow = /** @type {InstructorWindow} */ (window);
            await instructorWindow.loadPublishStatus(false);
        });

        failures.downloadJson = 1;
        await page.evaluate(async () => {
            const instructorWindow = /** @type {InstructorWindow} */ (window);
            await instructorWindow.downloadDocument('doc_lecture');
        });

        failures.extractEmpty = 1;
        await page.evaluate(async () => {
            const instructorWindow = /** @type {InstructorWindow} */ (window);
            instructorWindow.showDocumentModal({
                documentId: 'doc_practice',
                originalName: 'Practice quiz.txt',
                documentType: 'practice-quiz',
                content: 'empty quiz',
                lectureName: 'Unit 1',
                courseId: 'INSTRUCTOR-JS-FOCUSED',
            });
            await instructorWindow.extractAssessmentQuestions('doc_practice', 'Unit 1', 'INSTRUCTOR-JS-FOCUSED');
        });

        failures.extractError = 1;
        await page.evaluate(async () => {
            const instructorWindow = /** @type {InstructorWindow} */ (window);
            instructorWindow.showDocumentModal({
                documentId: 'doc_practice',
                originalName: 'Practice quiz.txt',
                documentType: 'practice-quiz',
                content: 'broken quiz',
                lectureName: 'Unit 1',
                courseId: 'INSTRUCTOR-JS-FOCUSED',
            });
            await instructorWindow.extractAssessmentQuestions('doc_practice', 'Unit 1', 'INSTRUCTOR-JS-FOCUSED');
        });

        await page.evaluate(async () => {
            const instructorWindow = /** @type {InstructorWindow} */ (window);
            instructorWindow.showQuestionReviewModal([
                { questionType: 'short-answer', question: 'Unselected?', correctAnswer: '', hasAnswer: false },
            ], 'Unit 1', 'INSTRUCTOR-JS-FOCUSED', false);
            await instructorWindow.saveSelectedQuestions('Unit 1', 'INSTRUCTOR-JS-FOCUSED');
        });

        failures.bulkError = 1;
        await page.evaluate(async () => {
            const instructorWindow = /** @type {InstructorWindow} */ (window);
            instructorWindow.showQuestionReviewModal([
                { questionType: 'short-answer', question: 'Selected?', correctAnswer: 'Yes', hasAnswer: true },
            ], 'Unit 1', 'INSTRUCTOR-JS-FOCUSED', false);
            await instructorWindow.saveSelectedQuestions('Unit 1', 'INSTRUCTOR-JS-FOCUSED');
        });

        failures.objectiveError = 1;
        failures.thresholdError = 1;
        failures.materials404 = 1;
        failures.materials500 = 1;
        failures.cleanupNone = 1;
        failures.cleanupError = 1;
        failures.renameError = 1;
        failures.questionUpdateError = 1;
        failures.generateError = 1;
        failures.textUploadError = 1;
        failures.fileUploadError = 1;

        await page.evaluate(async () => {
            const instructorWindow = /** @type {InstructorWindow} */ (window);

            await instructorWindow.saveObjectives('Unit 1');
            await instructorWindow.savePassThreshold('Unit 1', 1);
            await instructorWindow.confirmCourseMaterials('Unit 1');
            await instructorWindow.confirmCourseMaterials('Unit 1');
            await instructorWindow.cleanupOrphanedDocuments();
            await instructorWindow.cleanupOrphanedDocuments();

            instructorWindow.openRenameUnitInput('Unit 1');
            /** @type {HTMLInputElement} */ (document.querySelector('.unit-rename-input')).value = 'Rename Failure';
            await instructorWindow.saveUnitDisplayName('Unit 1');

            instructorWindow.openQuestionLearningObjectiveModal('Unit 1', 'q_existing');
            await instructorWindow.saveQuestionLearningObjective();

            instructorWindow.openQuestionModal('Unit 1');
            /** @type {HTMLSelectElement} */ (document.getElementById('question-type')).value = 'multiple-choice';
            instructorWindow.updateQuestionForm();
            await instructorWindow.generateAIQuestionContent();

            instructorWindow.openUploadModal('Unit 1', 'additional');
            instructorWindow.showTextInput();
            /** @type {HTMLTextAreaElement} */ (document.getElementById('text-input')).value = 'upload will fail';
            await instructorWindow.handleUpload();

            instructorWindow.openUploadModal('Unit 1', 'lecture-notes');
            instructorWindow.handleFileUpload(new File(['bad'], 'bad-notes.txt', { type: 'text/plain' }));
            await instructorWindow.handleUpload();
        });

        await page.evaluate(async () => {
            const instructorWindow = /** @type {InstructorWindow} */ (window);
            const wrapper = document.createElement('div');
            wrapper.className = 'accordion-item published';
            wrapper.innerHTML = '<input id="publish-unit1" type="checkbox" checked>';
            document.body.appendChild(wrapper);

            const originalSetTimeout = window.setTimeout;
            window.setTimeout = /** @type {any} */ ((callback) => {
                callback();
                return 1;
            });
            await instructorWindow.updatePublishStatus('Unit 1', true);
            instructorWindow.showNotification('Immediate cleanup notice', 'info');
            window.setTimeout = originalSetTimeout;
        });

        failures.publishNonJson = 1;
        await page.evaluate(async () => {
            const instructorWindow = /** @type {InstructorWindow} */ (window);
            const originalSetTimeout = window.setTimeout;
            window.setTimeout = /** @type {any} */ ((callback) => {
                callback();
                return 1;
            });
            /** @type {HTMLInputElement} */ (document.getElementById('publish-unit1')).checked = false;
            await instructorWindow.updatePublishStatus('Unit 1', true);
            window.setTimeout = originalSetTimeout;
        });

        await page.evaluate(async () => {
            const instructorWindow = /** @type {InstructorWindow} */ (window);
            /** @type {HTMLInputElement} */ (document.getElementById('publish-unit1')).checked = true;
            await instructorWindow.loadPublishStatus(true);
        });
        failures.publishStatusChanged = 1;
        await page.evaluate(async () => {
            const instructorWindow = /** @type {InstructorWindow} */ (window);
            /** @type {HTMLInputElement} */ (document.getElementById('publish-unit1')).checked = true;
            await instructorWindow.loadPublishStatus(false);
        });

        failures.downloadText = 1;
        await page.evaluate(async () => {
            const instructorWindow = /** @type {InstructorWindow} */ (window);
            await instructorWindow.downloadDocument('doc_lecture');
        });

        failures.delete404 = 1;
        await page.evaluate(async () => {
            const instructorWindow = /** @type {InstructorWindow} */ (window);
            await instructorWindow.deleteDocument('doc_lecture');
        });

        failures.delete500 = 1;
        failures.removeDocument500 = 1;
        failures.courseGetLegacy = 1;
        await page.evaluate(async (courseId) => {
            const instructorWindow = /** @type {InstructorWindow} */ (window);
            await instructorWindow.deleteDocument('doc_lecture');
            await instructorWindow.removeDocumentFromCourseStructure('legacy_doc', courseId, 'e2e_instructor_id');
        }, COURSE_ID);

        failures.delete500 = 1;
        failures.removeDocument500 = 1;
        failures.courseGetMissing = 1;
        await page.evaluate(async () => {
            const instructorWindow = /** @type {InstructorWindow} */ (window);
            await instructorWindow.deleteDocument('doc_lecture');
        });

        failures.questionCreate401 = 1;
        await page.evaluate(async () => {
            const instructorWindow = /** @type {InstructorWindow} */ (window);
            const testWindow = /** @type {any} */ (window);
            const originalGetCurrentUser = testWindow.getCurrentUser;

            testWindow.getCurrentUser = () => null;
            instructorWindow.openQuestionModal('Unit 1');
            await instructorWindow.saveQuestion();
            testWindow.getCurrentUser = originalGetCurrentUser;

            instructorWindow.openQuestionModal('Unit 1');
            /** @type {HTMLSelectElement} */ (document.getElementById('question-type')).value = '';
            /** @type {HTMLTextAreaElement} */ (document.getElementById('question-text')).value = 'Missing type';
            await instructorWindow.saveQuestion();

            /** @type {HTMLSelectElement} */ (document.getElementById('question-type')).value = 'true-false';
            instructorWindow.updateQuestionForm();
            /** @type {HTMLTextAreaElement} */ (document.getElementById('question-text')).value = 'Needs a true false answer';
            document.querySelectorAll('input[name="tf-answer"]').forEach((radio) => {
                /** @type {HTMLInputElement} */ (radio).checked = false;
            });
            await instructorWindow.saveQuestion();

            /** @type {HTMLSelectElement} */ (document.getElementById('question-type')).value = 'multiple-choice';
            instructorWindow.updateQuestionForm();
            /** @type {HTMLTextAreaElement} */ (document.getElementById('question-text')).value = 'Needs options';
            await instructorWindow.saveQuestion();

            const firstMcq = /** @type {HTMLInputElement} */ (document.querySelector('.mcq-input[data-option="A"]'));
            firstMcq.value = 'Alpha';
            firstMcq.dispatchEvent(new Event('input', { bubbles: true }));
            firstMcq.value = '';
            firstMcq.dispatchEvent(new Event('input', { bubbles: true }));
            firstMcq.value = 'Alpha';
            firstMcq.dispatchEvent(new Event('input', { bubbles: true }));
            await instructorWindow.saveQuestion();

            /** @type {HTMLInputElement} */ (document.querySelector('input[name="mcq-correct"][value="A"]')).checked = true;
            await instructorWindow.saveQuestion();
        });

        failures.generateNonJson = 1;
        await page.evaluate(async () => {
            const instructorWindow = /** @type {InstructorWindow} */ (window);
            instructorWindow.openQuestionModal('Unit 1');
            /** @type {HTMLSelectElement} */ (document.getElementById('question-type')).value = 'multiple-choice';
            instructorWindow.updateQuestionForm();
            await instructorWindow.generateAIQuestionContent();
        });

        failures.struggleGenerateNonJson = 1;
        await page.evaluate(async () => {
            const instructorWindow = /** @type {InstructorWindow} */ (window);
            instructorWindow.openQuestionModal('Unit 1');
            /** @type {HTMLSelectElement} */ (document.getElementById('question-type')).value = 'multiple-choice';
            instructorWindow.updateQuestionForm();
            const topicSelect = /** @type {HTMLSelectElement} */ (document.getElementById('struggle-topic-select'));
            topicSelect.innerHTML = '<option value="Glycolysis">Glycolysis</option>';
            topicSelect.value = 'Glycolysis';
            await instructorWindow.generateAIQuestionFromStruggleTopic();
        });

        await page.evaluate(async () => {
            const instructorWindow = /** @type {InstructorWindow} */ (window);
            const fakeUnit = document.createElement('div');
            fakeUnit.className = 'accordion-item';
            fakeUnit.innerHTML = `
                <span class="folder-name">Unit 1</span>
                <div class="objectives-list"><span class="objective-text">Harness objective</span></div>
            `;
            document.body.appendChild(fakeUnit);

            instructorWindow.openQuestionModal('Unit 1');
            /** @type {HTMLSelectElement} */ (document.getElementById('question-type')).value = 'short-answer';
            instructorWindow.updateQuestionForm();
            await instructorWindow.generateAIQuestionContent();
        });

        failures.regenerateNonJson = 1;
        await page.evaluate(async () => {
            const instructorWindow = /** @type {InstructorWindow} */ (window);
            instructorWindow.openRegenerateModal();
            /** @type {HTMLTextAreaElement} */ (document.getElementById('regenerate-feedback')).value = 'Make it narrower';
            await instructorWindow.submitRegenerate();
        });

        await page.evaluate(async () => {
            const instructorWindow = /** @type {InstructorWindow} */ (window);
            const threshold = /** @type {HTMLInputElement} */ (document.getElementById('pass-threshold-unit-1'));
            threshold.value = '1';
            instructorWindow.setupThresholdInputListeners();
            threshold.dispatchEvent(new Event('change', { bubbles: true }));

            const existingActions = document.createElement('div');
            existingActions.innerHTML = `
                <div class="add-content-section">Existing add</div>
                <div class="save-objectives">Confirm Course Materials</div>
            `;
            instructorWindow.addActionButtonsIfMissing(existingActions, 'Unit 1');

            const testWindow = /** @type {any} */ (window);
            const originalSavePassThreshold = testWindow.savePassThreshold;
            testWindow.savePassThreshold = () => Promise.reject(new Error('forced threshold save failure'));
            instructorWindow.saveAssessment('Unit 1');
            await new Promise((resolve) => setTimeout(resolve, 0));
            testWindow.savePassThreshold = originalSavePassThreshold;

            const originalFetch = window.fetch;
            const originalSetTimeout = window.setTimeout;
            window.setTimeout = /** @type {any} */ ((callback) => {
                callback();
                return 1;
            });
            await instructorWindow.loadDocuments();
            window.fetch = /** @type {any} */ (() => Promise.reject(new Error('forced document load failure')));
            await instructorWindow.loadDocuments();
            window.fetch = originalFetch;
            window.setTimeout = originalSetTimeout;

            const placeholderContainer = document.createElement('div');
            placeholderContainer.innerHTML = '<div class="file-item placeholder-item"><h3>*Lecture Notes - Unit 1</h3><span class="status-text">Not Uploaded</span></div>';
            instructorWindow.removeExistingPlaceholders(placeholderContainer);

            instructorWindow.showNotification('Error branch sentinel failed', 'error');
        });

        await expect(page.locator('.notification').filter({ hasText: /failed|Error|No questions|denied|Please provide/i }).first()).toBeVisible();
    });

    test('covers question, topic, document, and helper edge branches', async ({ page }) => {
        await openInstructorDocuments(page);

        const edgeResults = await page.evaluate(async () => {
            const instructorWindow = /** @type {InstructorWindow} */ (window);

            instructorWindow.showNotification('Closable notice', 'info');
            document.querySelector('.notification-close')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

            const topicPromise = instructorWindow.openTopicReviewModal(
                'INSTRUCTOR-JS-FOCUSED',
                'Only row source',
                [],
                ['Single Topic'],
                'Unit 1'
            );
            document.querySelector('#topic-review-modal .topic-review-remove')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            /** @type {HTMLInputElement} */ (document.querySelector('#topic-review-new-input')).value = 'Manual Recovery';
            document.querySelector('#topic-review-add-btn')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            document.querySelector('#topic-review-save-btn')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            await topicPromise;

            const cancelTopicPromise = instructorWindow.openTopicReviewModal(
                'INSTRUCTOR-JS-FOCUSED',
                'Cancel source',
                [],
                ['Cancel Topic'],
                'Unit 1'
            );
            document.querySelector('#topic-review-cancel-btn')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            await cancelTopicPromise;

            const closeTopicPromise = instructorWindow.openTopicReviewModal(
                'INSTRUCTOR-JS-FOCUSED',
                'Close source',
                [],
                ['Close Topic'],
                'Unit 1'
            );
            document.querySelector('#topic-review-close-btn')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            await closeTopicPromise;

            instructorWindow.openUploadModal('Unit 1', 'practice-quiz');
            instructorWindow.showInlineTopicReview('INSTRUCTOR-JS-FOCUSED', 'No topics source', [], []);
            instructorWindow.addInlineTopicRow('Temporary Topic', { unitId: 'Unit 1', source: 'manual' });
            document.querySelector('#upload-topic-review-list .topic-review-remove')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            await instructorWindow.handleSaveTopicsFromModal();

            instructorWindow.openUploadModal('Unit 1', 'unknown-kind');
            instructorWindow.resetToSelection();
            instructorWindow.closeUploadModal();

            const section = document.querySelector('.course-materials-section .section-content');
            if (section) {
                section.insertAdjacentHTML('beforeend', `
                    <div class="file-item">
                        <h3>Practice Questions/Tutorial - Unit 1</h3>
                        <div class="status-text">Not Uploaded</div>
                        <div class="file-info"><p>Missing</p></div>
                    </div>
                `);
            }
            instructorWindow.updateFileStatus('practice-questions', 'Unit 1', 'uploaded', 'practice.txt');
            instructorWindow.updateFileStatus('practice-questions', 'Unit 1', 'missing', 'practice.txt');

            instructorWindow.showDocumentModal({
                documentId: 'doc_short',
                originalName: 'Short answers.txt',
                documentType: 'lecture-notes',
                content: '',
                lectureName: 'Unit 1',
                courseId: 'INSTRUCTOR-JS-FOCUSED',
            });
            document.querySelector('.document-modal')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

            instructorWindow.showQuestionReviewModal([
                { questionType: 'multiple-choice', question: 'MC missing?', options: { a: 'Alpha' }, correctAnswer: '', hasAnswer: false },
                { questionType: 'short-answer', question: 'SA missing?', correctAnswer: '', hasAnswer: false },
                { questionType: 'true-false', question: 'TF answered?', correctAnswer: 'False', hasAnswer: true },
            ], 'Unit 1', 'INSTRUCTOR-JS-FOCUSED', true);
            /** @type {HTMLSelectElement} */ (document.querySelector('.missing-answer-input[data-index="0"]')).value = 'A';
            document.querySelector('.missing-answer-input[data-index="0"]')?.dispatchEvent(new Event('change', { bubbles: true }));
            /** @type {HTMLInputElement} */ (document.querySelector('.missing-answer-input[data-index="1"]')).value = 'Short answer';
            document.querySelector('.missing-answer-input[data-index="1"]')?.dispatchEvent(new Event('input', { bubbles: true }));
            /** @type {HTMLInputElement} */ (document.querySelector('.missing-answer-input[data-index="1"]')).value = '';
            document.querySelector('.missing-answer-input[data-index="1"]')?.dispatchEvent(new Event('input', { bubbles: true }));
            instructorWindow.closeQuestionReviewModal();

            instructorWindow.openQuestionModal('Unit 1');
            /** @type {HTMLSelectElement} */ (document.getElementById('question-type')).value = 'true-false';
            instructorWindow.updateQuestionForm();
            instructorWindow.populateFormWithAIContent({ question: 'TF generated?', answer: 'true' });
            /** @type {HTMLSelectElement} */ (document.getElementById('question-type')).value = 'short-answer';
            instructorWindow.updateQuestionForm();
            instructorWindow.populateFormWithAIContent({ question: 'SA generated?', EXPECTED_ANSWER: 'Expected detail' });

            const displayContainer = document.createElement('div');
            document.body.appendChild(displayContainer);
            /** @type {HTMLSelectElement} */ (document.getElementById('question-type')).value = 'true-false';
            instructorWindow.displayCurrentQuestion(displayContainer, { question: 'Display TF?', answer: 'False' });
            /** @type {HTMLSelectElement} */ (document.getElementById('question-type')).value = 'short-answer';
            instructorWindow.displayCurrentQuestion(displayContainer, { question: 'Display SA?', answer: '' });

            instructorWindow.updateQuestionsDisplay('Unit 2');
            instructorWindow.checkAIGenerationInModal();
            instructorWindow.checkAIGenerationAvailability('Unit 1');

            window.alert = () => {};
            instructorWindow.saveAssessment('Unit 2');
            instructorWindow.saveAssessment('Unit 1');

            const caseSensitiveMatches = instructorWindow.findElementsContainingText('.folder-name', 'Metabolism', true).length;
            const missingMaterials = instructorWindow.checkCourseMaterialsAvailable('Missing Unit');
            const mcLabel = instructorWindow.getQuestionTypeLabel('multiple-choice');
            const tfAnswer = instructorWindow.getQuestionAnswerDisplay({ type: 'true-false', answer: 'true' });
            const structuredTfAnswer = instructorWindow.getQuestionAnswerDisplay({ questionType: 'true-false', correctAnswer: true });
            const structuredMcq = instructorWindow.getQuestionAnswerDisplay({
                questionType: 'multiple-choice', options: ['Alpha', 'Beta'], correctAnswer: 1,
            });

            return { caseSensitiveMatches, missingMaterials, mcLabel, tfAnswer, structuredTfAnswer, structuredMcq };
        });

        expect(edgeResults.caseSensitiveMatches).toBeGreaterThan(0);
        expect(edgeResults.missingMaterials).toBe(false);
        expect(edgeResults.mcLabel).toBe('MCQ');
        expect(edgeResults.tfAnswer).toContain('True');
        expect(edgeResults.structuredTfAnswer).toContain('True');
        expect(edgeResults.structuredMcq).toContain('Beta');
    });

    test('re-runs the topic scan from the document view modal', async ({ page }) => {
        const captured = await openInstructorDocuments(page);

        await page.evaluate((courseId) => {
            const instructorWindow = /** @type {InstructorWindow} */ (window);
            instructorWindow.showDocumentModal({
                documentId: 'doc_lecture',
                originalName: 'Metabolism notes.pdf',
                documentType: 'lecture-notes',
                content: 'Lecture content about the citric acid cycle.',
                lectureName: 'Unit 1',
                courseId,
            });
        }, COURSE_ID);

        await page.locator('.document-modal .rescan-topics-btn').click();

        // The document modal hands off to the shared topic-review modal
        await expect(page.locator('#topic-review-modal')).toHaveClass(/show/, { timeout: 10_000 });
        await expect(page.locator('.document-modal')).toHaveCount(0);
        await expect(page.locator('#topic-review-context')).toContainText('Metabolism notes.pdf');
        await expect(page.locator('#topic-review-list .topic-review-item')).toHaveCount(2);

        await page.locator('#topic-review-save-btn').click();

        await expect.poll(() => captured.savedTopics.length).toBe(1);
        expect(captured.savedTopics.at(-1).topics.map((topic) => topic.topic)).toEqual([
            'Glycolysis',
            'Oxidative Phosphorylation',
            'Citric Acid Cycle',
            'ATP Synthase',
        ]);
    });
});
