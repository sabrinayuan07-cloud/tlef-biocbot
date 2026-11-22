// @ts-check
/**
 * Focused browser coverage for public/instructor/scripts/onboarding.js.
 *
 * These tests load the real onboarding page and exercise client behavior with
 * mocked API edges so Monocart can cover helper/error branches without changing
 * production code or depending on expensive document/AI processing.
 */

const { test, expect } = require('./fixtures/monocart');
const { storageStatePath } = require('./helpers/users');

const COURSE_ID = 'ONBOARDING-JS-FOCUSED';
const INSTRUCTOR_ID = 'e2e_onboarding_focused_instructor';
const OBJECTIVE = 'Explain how enzymes reduce activation energy.';
const VALID_API_KEY = 'sk-test-onboarding-focused';

/**
 * @typedef {{
 *   onboardingCreates: Record<string, any>[],
 *   onboardingUpdates: Record<string, any>[],
 *   completions: Record<string, any>[],
 *   joins: Record<string, any>[],
 *   textUploads: Record<string, any>[],
 *   fileUploads: number,
 *   approvedTopicSaves: Record<string, any>[],
 *   deletedDocuments: string[],
 *   removedDocumentTypes: Record<string, any>[],
 *   learningObjectiveSaves: Record<string, any>[],
 *   questionSaves: Record<string, any>[],
 *   thresholdSaves: Record<string, any>[],
 *   autoLinkRequests: Record<string, any>[],
 *   aiRequests: Record<string, any>[],
 * }} OnboardingCaptures
 */

test.use({ storageState: storageStatePath('instructor') });

function focusedCourse(overrides = {}) {
    return {
        courseId: COURSE_ID,
        courseName: 'Onboarding JS Focused Coverage',
        courseCode: 'FOCUS-STU',
        instructorCourseCode: 'JOIN-FOCUS',
        instructorId: INSTRUCTOR_ID,
        instructors: [INSTRUCTOR_ID],
        status: 'active',
        isOnboardingComplete: false,
        approvedStruggleTopics: [
            { topic: 'Enzyme kinetics', unitId: 'Unit 1', source: 'manual', createdAt: '2026-01-01T00:00:00.000Z' },
        ],
        courseStructure: { weeks: 1, lecturesPerWeek: 1, totalUnits: 1 },
        lectures: [{
            name: 'Unit 1',
            isPublished: false,
            learningObjectives: [],
            passThreshold: 0,
            documents: [],
            assessmentQuestions: [],
        }],
        ...overrides,
    };
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {{
 *   admin?: boolean,
 *   instructorCourses?: Record<string, any>[],
 *   joinableCourses?: Record<string, any>[],
 *   course?: Record<string, any>,
 *   courseGetOk?: boolean,
 *   approvedTopicsOk?: boolean,
 *   extractTopicsOk?: boolean,
 *   aiOk?: boolean,
 *   autoLinkOk?: boolean,
 * }} [options]
 */
async function installOnboardingRoutes(page, options = {}) {
    const course = options.course || focusedCourse();
    const joinableCourses = options.joinableCourses || [
        focusedCourse({ courseId: 'JOIN-ACTIVE', courseName: 'Joinable Active Course', instructorCourseCode: 'ACTIVE1' }),
        focusedCourse({ courseId: 'JOIN-ACTIVE', courseName: 'Duplicate Active Course', instructorCourseCode: 'ACTIVE1' }),
        focusedCourse({ courseId: 'JOIN-INACTIVE', courseName: 'Joinable Inactive Course', status: 'inactive' }),
    ];

    /** @type {OnboardingCaptures} */
    const captured = {
        onboardingCreates: [],
        onboardingUpdates: [],
        completions: [],
        joins: [],
        textUploads: [],
        fileUploads: 0,
        approvedTopicSaves: [],
        deletedDocuments: [],
        removedDocumentTypes: [],
        learningObjectiveSaves: [],
        questionSaves: [],
        thresholdSaves: [],
        autoLinkRequests: [],
        aiRequests: [],
    };

    let aiCallCount = 0;

    await page.route('**/api/**', async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        const pathname = url.pathname;
        const method = request.method();
        const body = () => {
            try {
                return request.postDataJSON();
            } catch {
                return {};
            }
        };

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
                        username: 'e2e_onboarding_focused',
                        displayName: 'Focused Onboarding Instructor',
                        role: 'instructor',
                        permissions: { systemAdmin: !!options.admin },
                    },
                },
            });
            return;
        }

        if (pathname === '/api/settings/can-delete-all') {
            await route.fulfill({ json: { success: true, canDeleteAll: !!options.admin } });
            return;
        }

        if (pathname === `/api/onboarding/instructor/${INSTRUCTOR_ID}`) {
            await route.fulfill({ json: { success: true, data: { courses: options.instructorCourses || [] } } });
            return;
        }

        if (pathname === '/api/courses/available/joinable') {
            await route.fulfill({ json: { success: true, data: joinableCourses } });
            return;
        }

        if (pathname === '/api/onboarding' && method === 'POST') {
            const payload = body();
            captured.onboardingCreates.push(payload);
            course.courseId = payload.courseId || course.courseId;
            await route.fulfill({ json: { success: true, data: { courseId: course.courseId } } });
            return;
        }

        if (pathname.startsWith('/api/onboarding/') && method === 'PUT') {
            captured.onboardingUpdates.push(body());
            await route.fulfill({ json: { success: true, data: course } });
            return;
        }

        if (pathname.startsWith('/api/onboarding/') && method === 'GET') {
            await route.fulfill({ json: { success: true, data: course } });
            return;
        }

        if (pathname === '/api/onboarding/complete' && method === 'POST') {
            captured.completions.push(body());
            await route.fulfill({ json: { success: true } });
            return;
        }

        if (pathname.startsWith('/api/courses/') && pathname.endsWith('/instructors') && method === 'POST') {
            captured.joins.push(body());
            await route.fulfill({ json: { success: true, data: course } });
            return;
        }

        if (/^\/api\/courses\/[^/]+$/.test(pathname) && method === 'GET') {
            if (options.courseGetOk === false) {
                await route.fulfill({ status: 500, json: { success: false, message: 'forced course lookup failure' } });
                return;
            }
            await route.fulfill({ json: { success: true, data: course } });
            return;
        }

        if (pathname === '/api/documents/text' && method === 'POST') {
            captured.textUploads.push(body());
            await route.fulfill({ json: { success: true, data: { documentId: `text-doc-${captured.textUploads.length}` } } });
            return;
        }

        if (pathname === '/api/documents/upload' && method === 'POST') {
            captured.fileUploads += 1;
            await route.fulfill({ json: { success: true, data: { documentId: `file-doc-${captured.fileUploads}` } } });
            return;
        }

        if (pathname.startsWith('/api/documents/') && method === 'DELETE') {
            captured.deletedDocuments.push(pathname.split('/').pop() || '');
            await route.fulfill({ json: { success: true } });
            return;
        }

        if (pathname.includes('/lectures/') && pathname.endsWith('/documents') && method === 'DELETE') {
            captured.removedDocumentTypes.push(body());
            await route.fulfill({ json: { success: true } });
            return;
        }

        if (pathname.endsWith('/approved-topics') && method === 'GET') {
            if (options.approvedTopicsOk === false) {
                await route.fulfill({ status: 500, json: { success: false, message: 'forced approved-topic failure' } });
                return;
            }
            await route.fulfill({
                json: {
                    success: true,
                    data: {
                        topics: course.approvedStruggleTopics || [],
                        topicLabels: (course.approvedStruggleTopics || []).map(topic => topic.topic || topic),
                    },
                },
            });
            return;
        }

        if (pathname.endsWith('/approved-topics') && method === 'PUT') {
            captured.approvedTopicSaves.push(body());
            await route.fulfill({ json: { success: true, data: { topics: body().topics || [] } } });
            return;
        }

        if (pathname.endsWith('/extract-topics') && method === 'POST') {
            if (options.extractTopicsOk === false) {
                await route.fulfill({ status: 500, json: { success: false, message: 'forced extract failure' } });
                return;
            }
            await route.fulfill({ json: { success: true, data: { topics: ['ATP synthase', 'Enzyme kinetics'] } } });
            return;
        }

        if (pathname === '/api/learning-objectives' && method === 'POST') {
            captured.learningObjectiveSaves.push(body());
            await route.fulfill({ json: { success: true, data: body() } });
            return;
        }

        if (pathname === '/api/questions' && method === 'POST') {
            captured.questionSaves.push(body());
            await route.fulfill({ json: { success: true, data: { questionId: `q-${captured.questionSaves.length}` } } });
            return;
        }

        if (pathname === '/api/lectures/pass-threshold' && method === 'POST') {
            captured.thresholdSaves.push(body());
            await route.fulfill({ json: { success: true, data: body() } });
            return;
        }

        if (pathname === '/api/questions/auto-link-learning-objectives' && method === 'POST') {
            captured.autoLinkRequests.push(body());
            if (options.autoLinkOk === false) {
                await route.fulfill({ status: 500, json: { success: false, message: 'forced auto-link failure' } });
                return;
            }
            const payload = body();
            await route.fulfill({
                json: {
                    success: true,
                    message: 'Auto-link complete.',
                    data: {
                        linkedCount: payload.questions.length,
                        unassignedCount: 0,
                        matchedQuestions: payload.questions.map(question => ({
                            questionId: question.questionId,
                            learningObjective: OBJECTIVE,
                        })),
                    },
                },
            });
            return;
        }

        if (pathname === '/api/questions/generate-ai' && method === 'POST') {
            captured.aiRequests.push(body());
            if (options.aiOk === false) {
                await route.fulfill({ status: 500, json: { success: false, message: 'forced AI failure' } });
                return;
            }
            aiCallCount += 1;
            const payload = body();
            await route.fulfill({
                json: {
                    success: true,
                    data: {
                        question: aiCallCount === 1
                            ? 'Which enzyme property is described by Km?'
                            : 'Which enzyme property changes after feedback?',
                        options: {
                            A: 'Substrate affinity',
                            B: 'Cell diameter',
                            C: 'Membrane charge',
                            D: 'DNA length',
                            correctAnswer: 'A',
                        },
                        answer: 'A',
                        selectedLearningObjective: payload.regenerate ? '' : OBJECTIVE,
                        wasRegenerated: !!payload.regenerate,
                    },
                },
            });
            return;
        }

        await route.fulfill({ json: { success: true, data: {} } });
    });

    return captured;
}

async function gotoFocusedOnboarding(page, options = {}) {
    const captured = await installOnboardingRoutes(page, options);
    await page.goto('/instructor/onboarding.html');
    await expect(page.locator('#course-select option[value="custom"]')).toHaveCount(1);
    return captured;
}

async function createCustomCourse(page) {
    await page.locator('#step-1 button.btn-primary', { hasText: 'Get Started' }).click();
    await page.locator('#course-select').selectOption('custom');
    await page.locator('#custom-course-name').fill('Focused Biology: Enzymes & ATP!');
    await page.locator('#course-api-key').fill(VALID_API_KEY);
    await page.locator('#weeks-count').fill('1');
    await page.locator('#lectures-per-week').fill('1');
    await page.locator('#continue-btn').click();
    await expect(page.locator('#step-3.onboarding-step.active')).toBeVisible();
}

async function addObjective(page, text = OBJECTIVE) {
    await page.locator('#objective-input').fill(text);
    await page.locator('.add-objective-btn').click();
    await expect(page.locator('#objectives-list .objective-display-item')).toContainText(text);
}

async function addTrueFalseQuestion(page) {
    await page.locator('.add-question-btn').click();
    await page.locator('#question-type').selectOption('true-false');
    await page.locator('#question-text').fill('Enzymes are consumed during reactions.');
    await page.locator('input[name="tf-answer"][value="false"]').check();
    await page.locator('#question-modal button.btn-primary', { hasText: 'Save Question' }).click();
    await expect(page.locator('#question-modal')).not.toHaveClass(/show/);
}

test.describe('instructor onboarding focused script coverage', () => {
    test('covers course-picker states, admin join bypass, and topic review helpers', async ({ page }) => {
        await gotoFocusedOnboarding(page, { admin: true });

        await expect(page.locator('#course-select optgroup[label="Active Courses"] option')).toHaveCount(1);
        await expect(page.locator('#course-select optgroup[label="Inactive Courses"] option')).toHaveCount(1);
        await expect(page.locator('#course-select option[value="JOIN-INACTIVE"]')).toHaveText('Joinable Inactive Course (Inactive)');

        await page.locator('#step-1 button.btn-primary', { hasText: 'Get Started' }).click();
        await page.locator('#course-select').selectOption('JOIN-ACTIVE');
        await expect(page.locator('#join-course-section')).toBeVisible();
        await expect(page.locator('#instructor-course-code-group')).toBeHidden();
        await expect(page.locator('#selected-course-details')).toContainText('without entering an instructor code');

        const helperResult = await page.evaluate(() => {
            const testWindow = /** @type {any} */ (window);
            testWindow.currentCourseData = {
                lectures: [{ name: 'Unit 1' }, { name: 'Unit 2' }],
            };
            return {
                labels: testWindow.dedupeTopics([' ATP  synthase ', 'atp synthase', { topic: '  Glycolysis ' }, null]),
                entries: testWindow.dedupeTopicEntries([
                    { topic: 'ATP synthase', unitId: ' Unit 1 ', source: 'scraped' },
                    { topic: 'atp synthase', unitId: 'Unit 2', source: 'bad-source' },
                    'Glycolysis',
                    { topic: '' },
                ], { unitId: 'Unit 2' }),
                escaped: testWindow.escapeHTML('<ATP & NADH>'),
                fallbackUnitOptions: testWindow.getTopicUnitOptions('Unit 3'),
            };
        });

        expect(helperResult.labels).toEqual(['ATP synthase', 'Glycolysis']);
        expect(helperResult.entries).toEqual([
            expect.objectContaining({ topic: 'ATP synthase', unitId: 'Unit 1', source: 'scraped' }),
            expect.objectContaining({ topic: 'Glycolysis', unitId: 'Unit 2', source: 'manual' }),
        ]);
        expect(helperResult.escaped).toBe('&lt;ATP &amp; NADH&gt;');
        expect(helperResult.fallbackUnitOptions).toContain('Unit 3');

        await page.evaluate(() => {
            const testWindow = /** @type {any} */ (window);
            testWindow.__topicPromise = testWindow.openTopicReviewModal(
                'JOIN-ACTIVE',
                'Lecture Notes',
                [{ topic: 'Existing Topic', unitId: 'Unit 1', source: 'manual' }],
                ['Scraped Topic', 'existing topic'],
                'Unit 2'
            ).then((topics) => {
                testWindow.__topicResult = topics;
            });
        });
        await expect(page.locator('#topic-review-modal')).toHaveClass(/show/);
        await page.locator('#topic-review-list .topic-review-remove').first().click();
        await page.locator('#topic-review-new-input').fill('Manual Topic');
        await page.locator('#topic-review-new-unit-select').selectOption('Unit 2');
        await page.locator('#topic-review-add-btn').click();
        await page.locator('#topic-review-save-btn').click();
        const reviewedTopics = await page.evaluate(async () => {
            const testWindow = /** @type {any} */ (window);
            await testWindow.__topicPromise;
            return testWindow.__topicResult;
        });
        expect(reviewedTopics.map(topic => topic.topic)).toEqual(['Scraped Topic', 'Manual Topic']);
    });

    test('covers required join-code feedback and successful existing-course join', async ({ page }) => {
        const captured = await gotoFocusedOnboarding(page, { admin: false });

        await page.locator('#step-1 button.btn-primary', { hasText: 'Get Started' }).click();
        await page.locator('#course-select').selectOption('JOIN-ACTIVE');
        await expect(page.locator('#instructor-course-code-group')).toBeVisible();

        await page.locator('#join-course-btn').click();
        await expect(page.locator('#instructor-course-code-error')).toContainText('required');
        await expect(page.locator('#instructor-course-code')).toHaveAttribute('aria-invalid', 'true');

        await page.locator('#instructor-course-code').fill('active1');
        await expect(page.locator('#instructor-course-code-error')).toBeHidden();
        await page.locator('#join-course-btn').click();

        await expect.poll(() => captured.joins.length).toBe(1);
        expect(captured.joins[0]).toMatchObject({
            instructorId: INSTRUCTOR_ID,
            code: 'ACTIVE1',
        });
        await expect.poll(() => captured.completions.length).toBe(1);
    });

    test('covers custom setup, repeated same-type uploads, inline topic save, and upload error recovery', async ({ page }) => {
        const course = focusedCourse({
            lectures: [{
                name: 'Unit 1',
                learningObjectives: [OBJECTIVE],
                documents: [{ documentId: 'old-lecture-doc', documentType: 'lecture-notes' }],
                assessmentQuestions: [],
            }],
        });
        const captured = await gotoFocusedOnboarding(page, {
            course,
            approvedTopicsOk: false,
            extractTopicsOk: false,
        });

        await createCustomCourse(page);
        expect(captured.onboardingCreates[0].courseId).toMatch(/^FOCUSED-BIOLOGY-ENZ/);

        await addObjective(page);
        await page.locator('#substep-objectives button.btn-primary', { hasText: 'Continue to Course Materials' }).click();
        await expect(page.locator('#substep-materials.guided-substep.active')).toBeVisible();

        await page.locator('.material-item.required button.upload-btn').first().click();
        await page.locator('#material-name').fill('Enzyme Kinetics Lecture');
        await page.locator('#text-input').fill('Lecture content for enzyme kinetics.');
        await page.locator('#upload-btn').click();
        await expect(page.locator('#topic-review-section')).toBeVisible();
        await expect(page.locator('#upload-topic-review-list')).toContainText('No topics detected yet');

        await page.locator('#upload-topic-new-input').fill('Manual upload topic');
        await page.locator('#upload-topic-add-btn').click();
        await page.locator('#save-topics-btn').click();
        await expect(page.locator('#upload-modal')).toBeHidden();

        await page.locator('.material-item.required button.upload-btn').first().click();
        await page.locator('#material-name').fill('Enzyme Regulation Lecture');
        await page.locator('#text-input').fill('A second lecture document for enzyme regulation.');
        await page.locator('#upload-btn').click();
        await expect(page.locator('#topic-review-section')).toBeVisible();
        await page.locator('#save-topics-btn').click();
        await expect(page.locator('#upload-modal')).toBeHidden();

        await expect(page.locator('#lecture-status')).toHaveText('2 Uploaded');
        expect(captured.deletedDocuments).toEqual([]);
        expect(captured.removedDocumentTypes).toEqual([]);
        expect(captured.textUploads).toHaveLength(2);
        expect(captured.textUploads[0]).toEqual(expect.objectContaining({
            lectureName: 'Unit 1',
            documentType: 'lecture-notes',
            title: 'Enzyme Kinetics Lecture',
        }));
        expect(captured.textUploads[1]).toEqual(expect.objectContaining({
            lectureName: 'Unit 1',
            documentType: 'lecture-notes',
            title: 'Enzyme Regulation Lecture',
        }));
        expect(captured.textUploads[0].courseId).toBe(captured.onboardingCreates[0].courseId);
        expect(captured.approvedTopicSaves[0].topics).toEqual([
            expect.objectContaining({ topic: 'Manual upload topic', source: 'manual' }),
        ]);

        await page.evaluate(() => {
            const testWindow = /** @type {any} */ (window);
            testWindow.openUploadModal('Unit 1', 'additional');
        });
        await page.locator('#file-input').setInputFiles({
            name: 'bad.exe',
            mimeType: 'application/octet-stream',
            buffer: Buffer.from('not a supported file'),
        });
        await expect(page.locator('.notification-message', { hasText: /Please select a valid file type/ }).last()).toBeVisible();

        await page.locator('#upload-modal .modal-close').click();
        await page.evaluate(() => {
            const testWindow = /** @type {any} */ (window);
            testWindow.openUploadModal('Unit 1', 'additional');
        });
        await page.locator('#file-input').setInputFiles({
            name: 'supplement.txt',
            mimeType: 'text/plain',
            buffer: Buffer.from('supplemental enzyme notes'),
        });
        await expect(page.locator('#file-name')).toHaveText('supplement.txt');
        await expect(page.locator('#file-size')).toHaveText('25 Bytes');
        await page.locator('#upload-btn').click();
        await expect(page.locator('#topic-review-section')).toBeVisible();
        await page.locator('#save-topics-btn').click();
        await expect.poll(() => captured.fileUploads).toBe(1);
    });

    test('covers question creation, AI generation/regeneration, objective editing, and auto-linking', async ({ page }) => {
        const captured = await gotoFocusedOnboarding(page);

        await createCustomCourse(page);
        await addObjective(page);
        await page.locator('.progress-card[data-substep="questions"]').click();
        await expect(page.locator('#substep-questions.guided-substep.active')).toBeVisible();

        await page.locator('.add-question-btn').click();
        await page.locator('#question-type').selectOption('multiple-choice');
        await expect(page.locator('#ai-generate-btn')).toBeEnabled();
        await page.locator('#ai-generate-btn').click();
        await expect(page.locator('#question-text')).toHaveValue('Which enzyme property is described by Km?');
        await expect(page.locator('#learning-objective-note')).toContainText('AI selected');

        await page.locator('#ai-generate-btn').click();
        await expect(page.locator('#regenerate-modal')).toHaveClass(/show/);
        await page.locator('#regenerate-submit-btn').click();
        await expect(page.locator('.notification-message', { hasText: /Please provide feedback/ }).last()).toBeVisible();
        await page.locator('#regenerate-feedback').fill('Make the prompt focus on feedback inhibition.');
        await page.locator('#regenerate-submit-btn').click();
        await expect(page.locator('#regenerate-modal')).not.toHaveClass(/show/);
        await expect(page.locator('#question-text')).toHaveValue('Which enzyme property changes after feedback?');

        await page.locator('#question-modal button.btn-primary', { hasText: 'Save Question' }).click();
        await expect(page.locator('#assessment-questions-onboarding .question-item')).toHaveCount(1);

        await page.locator('.edit-question-btn').click();
        await expect(page.locator('#question-learning-objective-modal')).toHaveClass(/show/);
        await page.locator('#edit-learning-objective-select').selectOption(OBJECTIVE);
        await page.locator('#question-learning-objective-modal button.btn-primary', { hasText: 'Save' }).click();
        await expect(page.locator('#assessment-questions-onboarding')).toContainText(OBJECTIVE);

        await page.locator('.auto-link-btn').click();
        await expect(page.locator('#auto-link-confirmation-modal')).toHaveClass(/show/);
        await page.locator('#auto-link-confirmation-modal button.btn-primary', { hasText: 'Yes' }).click();
        await expect.poll(() => captured.autoLinkRequests.length).toBe(1);
        expect(captured.autoLinkRequests[0].questions[0]).toMatchObject({
            questionType: 'multiple-choice',
            learningObjective: OBJECTIVE,
        });

        page.once('dialog', dialog => dialog.accept());
        await page.locator('.delete-question-btn').click();
        await expect(page.locator('#assessment-questions-onboarding')).toContainText('No assessment questions created yet');
    });

    test('covers final onboarding serialization, save-assessment paths, and AI fallback content', async ({ page }) => {
        const captured = await gotoFocusedOnboarding(page, { aiOk: false });

        await createCustomCourse(page);
        await addObjective(page);
        await page.locator('.progress-card[data-substep="questions"]').click();
        await addTrueFalseQuestion(page);

        await page.locator('#pass-threshold-onboarding').fill('1');
        await page.locator('.save-btn', { hasText: 'Save Assessment' }).click();
        await expect.poll(() => captured.questionSaves.length).toBe(1);
        await expect.poll(() => captured.thresholdSaves.length).toBe(1);

        await page.locator('#lecture-status').evaluate(element => { /** @type {HTMLElement} */ (element).dataset.status = 'uploaded'; });
        await page.locator('#practice-status').evaluate(element => { /** @type {HTMLElement} */ (element).dataset.status = 'processed'; });
        await page.locator('#substep-questions button.btn-primary', { hasText: 'Complete Unit 1 & Continue' }).click();

        await expect.poll(() => captured.onboardingUpdates.length).toBe(1);
        await expect.poll(() => captured.learningObjectiveSaves.length).toBe(1);
        await expect.poll(() => captured.completions.length).toBe(1);
        expect(captured.onboardingUpdates[0]).toMatchObject({
            instructorId: INSTRUCTOR_ID,
            learningOutcomes: [OBJECTIVE],
        });
        expect(captured.onboardingUpdates[0].courseId).toBe(captured.onboardingCreates[0].courseId);
        expect(captured.learningObjectiveSaves[0]).toMatchObject({
            lectureName: 'Unit 1',
            objectives: [OBJECTIVE],
        });

        await page.locator('.add-question-btn').click();
        await page.locator('#question-type').selectOption('short-answer');
        await page.locator('#ai-generate-btn').click();
        await expect(page.locator('#question-text')).toHaveValue(/Explain a key concept from the Unit 1 lecture notes/);
        await expect(page.locator('#sa-answer')).toHaveValue(/Students should demonstrate understanding/);
    });

    test('covers completed-onboarding display and legacy utility helpers', async ({ page }) => {
        const completedCourse = focusedCourse({
            courseId: 'COMPLETED-ONBOARDING-FOCUSED',
            isOnboardingComplete: true,
            lectures: [{
                name: 'Unit 1',
                learningObjectives: [OBJECTIVE],
                documents: [{ documentId: 'lecture-doc', documentType: 'lecture-notes' }],
                assessmentQuestions: [],
            }],
        });
        const captured = await installOnboardingRoutes(page, { course: completedCourse });

        await page.goto('/instructor/onboarding.html?courseId=COMPLETED-ONBOARDING-FOCUSED');
        await expect(page.locator('#onboarding-complete')).toBeVisible();
        await expect(page.locator('#onboarding-complete .btn-primary')).toHaveAttribute(
            'href',
            '/instructor/documents?courseId=COMPLETED-ONBOARDING-FOCUSED'
        );

        completedCourse.isOnboardingComplete = false;
        completedCourse.courseId = 'DIRECT-NO-OBJECTIVES';
        completedCourse.lectures = [{
            name: 'Unit 1',
            isPublished: false,
            learningObjectives: [],
            passThreshold: 0,
            documents: [],
            assessmentQuestions: [],
        }];
        await page.goto('/instructor/onboarding.html?courseId=DIRECT-NO-OBJECTIVES');
        await expect(page.locator('#substep-objectives.guided-substep.active')).toBeVisible();

        completedCourse.courseId = 'DIRECT-NO-DOCUMENTS';
        completedCourse.lectures[0].learningObjectives = [OBJECTIVE];
        await page.goto('/instructor/onboarding.html?courseId=DIRECT-NO-DOCUMENTS');
        await expect(page.locator('#substep-materials.guided-substep.active')).toBeVisible();

        completedCourse.courseId = 'DIRECT-HAS-DOCUMENTS';
        completedCourse.lectures[0].documents = [{ documentId: 'direct-doc', documentType: 'lecture-notes' }];
        await page.goto('/instructor/onboarding.html?courseId=DIRECT-HAS-DOCUMENTS');
        await expect(page.locator('#substep-questions.guided-substep.active')).toBeVisible();

        const helperResult = await page.evaluate(async () => {
            const testWindow = /** @type {any} */ (window);

            testWindow.showOnboardingFlow();
            testWindow.showStep(2);
            testWindow.previousStep();
            testWindow.showStep(3);
            testWindow.showSubstep('materials');
            testWindow.previousSubstep('objectives');

            const courseSelect = /** @type {HTMLSelectElement} */ (document.getElementById('course-select'));
            courseSelect.innerHTML = `
                <option value="">Choose a course...</option>
                <option value="JOIN-ACTIVE">Joinable Active Course</option>
                <option value="custom">Enter custom course name...</option>
            `;
            courseSelect.value = 'JOIN-ACTIVE';
            const existingCourse = await testWindow.checkExistingCourse();
            const detail = await testWindow.getCourseDetails('COMPLETED-ONBOARDING-FOCUSED');

            const customName = /** @type {HTMLInputElement} */ (document.getElementById('custom-course-name'));
            testWindow.showFieldError(customName, 'Forced helper validation error');
            testWindow.showSuccessMessage('Helper success notification');
            testWindow.showErrorMessage('Helper error notification');

            const objectiveInput = /** @type {HTMLInputElement} */ (document.getElementById('objective-input'));
            objectiveInput.value = '';
            await testWindow.addObjective();
            objectiveInput.value = 'Legacy helper objective';
            await testWindow.addObjective();
            const objectiveCountAfterAdd = document.querySelectorAll('#objectives-list .objective-display-item').length;
            testWindow.removeObjective(document.querySelector('#objectives-list .remove-objective'));
            const objectiveCountAfterRemove = document.querySelectorAll('#objectives-list .objective-display-item').length;

            let questionInput = /** @type {HTMLInputElement|null} */ (document.getElementById('question-input'));
            if (!questionInput) {
                questionInput = document.createElement('input');
                questionInput.id = 'question-input';
                document.body.appendChild(questionInput);
            }
            questionInput.value = '';
            await testWindow.addQuestion();
            questionInput.value = 'Legacy probing question?';
            await testWindow.addQuestion();
            const probingCountAfterAdd = document.querySelectorAll('#assessment-questions-onboarding .objective-display-item').length;
            await testWindow.removeQuestion(document.querySelector('#assessment-questions-onboarding .remove-objective'));
            const probingCountAfterRemove = document.querySelectorAll('#assessment-questions-onboarding .objective-display-item').length;

            await testWindow.saveUnit1URL(
                'COMPLETED-ONBOARDING-FOCUSED',
                'Unit 1',
                'additional',
                'https://example.test/enzyme',
                'Example URL',
                'e2e_onboarding_focused_instructor'
            );
            await testWindow.saveUnit1ProbingQuestion(
                'COMPLETED-ONBOARDING-FOCUSED',
                'Unit 1',
                'What does Km represent?',
                'e2e_onboarding_focused_instructor'
            );
            await testWindow.removeUnit1ProbingQuestion(
                'COMPLETED-ONBOARDING-FOCUSED',
                'Unit 1',
                'What does Km represent?',
                'e2e_onboarding_focused_instructor'
            );
            await testWindow.saveUnit1LearningObjective(
                'COMPLETED-ONBOARDING-FOCUSED',
                'Unit 1',
                'Describe enzyme inhibition.',
                'e2e_onboarding_focused_instructor'
            );
            await testWindow.removeUnit1LearningObjective(
                'COMPLETED-ONBOARDING-FOCUSED',
                'Unit 1',
                'Describe enzyme inhibition.',
                'e2e_onboarding_focused_instructor'
            );

            return {
                step: document.querySelector('#step-3')?.classList.contains('active'),
                existingCourse,
                detail,
                sizes: [
                    testWindow.formatFileSize(0),
                    testWindow.formatFileSize(1024),
                    testWindow.formatFileSize(1536),
                ],
                fieldError: document.querySelector('#custom-course-section .error-message')?.textContent,
                objectiveCountAfterAdd,
                objectiveCountAfterRemove,
                probingCountAfterAdd,
                probingCountAfterRemove,
            };
        });

        expect(helperResult.step).toBeTruthy();
        expect(helperResult.existingCourse).toMatchObject({
            courseId: 'JOIN-ACTIVE',
            courseName: 'Joinable Active Course',
        });
        expect(helperResult.detail).toMatchObject({
            courseId: 'DIRECT-HAS-DOCUMENTS',
            isOnboardingComplete: false,
        });
        expect(helperResult.sizes).toEqual(['0 Bytes', '1 KB', '1.5 KB']);
        expect(helperResult.fieldError).toBe('Forced helper validation error');
        expect(helperResult.objectiveCountAfterAdd).toBeGreaterThan(0);
        expect(helperResult.objectiveCountAfterRemove).toBe(helperResult.objectiveCountAfterAdd - 1);
        expect(helperResult.probingCountAfterAdd).toBe(1);
        expect(helperResult.probingCountAfterRemove).toBe(0);
        expect(captured.textUploads).toEqual([
            expect.objectContaining({
                documentType: 'additional',
                title: 'Example URL',
                content: expect.stringContaining('https://example.test/enzyme'),
            }),
            expect.objectContaining({
                documentType: 'probing-question',
                content: 'What does Km represent?',
            }),
        ]);
        expect(captured.learningObjectiveSaves[0]).toMatchObject({
            lectureName: 'Unit 1',
            objectives: ['Describe enzyme inhibition.'],
        });
    });
});
