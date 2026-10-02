// @ts-check
const { test, expect } = require('./fixtures/monocart');
const { storageStatePath } = require('./helpers/users');

const COURSE_ID = 'INSTRUCTOR-JS-DEEP';
const INSTRUCTOR_ID = 'e2e_instructor_id';

/**
 * @typedef {Window & Record<string, any>} InstructorWindow
 */

function course() {
    return {
        courseId: COURSE_ID,
        courseName: 'Instructor JS Deep Branches',
        courseCode: 'DEEP-STU',
        instructorCourseCode: 'DEEP-INS',
        instructorId: INSTRUCTOR_ID,
        instructors: [INSTRUCTOR_ID],
        tas: [],
        isOnboardingComplete: true,
        courseStructure: { weeks: 1, lecturesPerWeek: 1, totalUnits: 1 },
        lectures: [{
            name: 'Unit 1',
            displayName: 'Deep Unit',
            isPublished: false,
            learningObjectives: [],
            passThreshold: 0,
            documents: [],
            assessmentQuestions: [],
        }],
    };
}

test.use({ storageState: storageStatePath('instructor') });

async function installRoutes(page, options = {}) {
    const state = {
        textUploads: [],
        fileUploads: 0,
        savedTopics: 0,
        failCourseGet: Boolean(options.failCourseGet),
        failTopicSave: Boolean(options.failTopicSave),
        failLearningObjectives: Boolean(options.failLearningObjectives),
        failQuestions: Boolean(options.failQuestions),
        failThreshold: Boolean(options.failThreshold),
        rejectDocuments: Boolean(options.rejectDocuments),
        objectives: options.objectives || [],
        emptyInstructorCourses: Boolean(options.emptyInstructorCourses),
        failInstructorLookup: Boolean(options.failInstructorLookup),
    };

    await page.route('**/api/**', async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        const pathname = url.pathname;
        const method = request.method();

        if (pathname === '/api/settings/llm-tag') {
            await route.fulfill({ json: { success: true, llmIndex: 1, reasoningIndex: 1 } });
            return;
        }

        if (pathname === '/api/auth/me') {
            await route.fulfill({
                json: {
                    success: true,
                    user: {
                        userId: INSTRUCTOR_ID,
                        username: 'e2e_instructor',
                        displayName: 'Deep Instructor',
                        role: 'instructor',
                        permissions: { systemAdmin: true },
                    },
                },
            });
            return;
        }

        if (pathname === `/api/onboarding/${COURSE_ID}`) {
            await route.fulfill({ json: { success: true, data: course() } });
            return;
        }

        if (pathname === `/api/onboarding/instructor/${INSTRUCTOR_ID}`) {
            if (state.failInstructorLookup) {
                await route.abort('failed');
                return;
            }
            if (state.emptyInstructorCourses) {
                await route.fulfill({ json: { success: true, data: { courses: [] } } });
                return;
            }
            await route.fulfill({ json: { success: true, data: { courses: [course()] } } });
            return;
        }

        if (pathname === `/api/courses/${COURSE_ID}` && method === 'GET') {
            if (state.rejectDocuments) {
                await route.abort('failed');
                return;
            }
            if (state.failCourseGet) {
                await route.fulfill({ status: 500, body: 'course read failed' });
                return;
            }
            await route.fulfill({ json: { success: true, data: course() } });
            return;
        }

        if (pathname === `/api/courses/${COURSE_ID}/approved-topics` && method === 'GET') {
            await route.fulfill({ json: { success: true, data: { topics: [] } } });
            return;
        }

        if (pathname === `/api/courses/${COURSE_ID}/approved-topics` && method === 'PUT') {
            state.savedTopics += 1;
            if (state.failTopicSave) {
                await route.fulfill({ status: 500, json: { success: false, message: 'topic save failed' } });
                return;
            }
            await route.fulfill({ json: { success: true, data: { topics: request.postDataJSON().topics } } });
            return;
        }

        if (pathname === `/api/courses/${COURSE_ID}/extract-topics`) {
            await route.fulfill({ json: { success: true, data: { topicLabels: [] } } });
            return;
        }

        if (pathname === '/api/documents/text') {
            state.textUploads.push(request.postDataJSON());
            await route.fulfill({
                json: {
                    success: true,
                    message: 'URL imported',
                    data: { documentId: 'doc_url', title: 'Imported URL', filename: 'url.txt', qdrantProcessed: false },
                },
            });
            return;
        }

        if (pathname === '/api/documents/upload') {
            state.fileUploads += 1;
            const documentId = state.fileUploads === 1 ? 'doc_external_upload' : 'doc_practice_upload';
            const title = state.fileUploads === 1 ? 'Imported URL' : undefined;
            await route.fulfill({
                json: {
                    success: true,
                    message: 'Practice uploaded',
                    data: { documentId, title, filename: 'practice.txt', qdrantProcessed: true },
                },
            });
            return;
        }

        if (pathname === '/api/learning-objectives') {
            if (state.failLearningObjectives) {
                await route.fulfill({ status: 500, body: 'objectives failed' });
                return;
            }
            await route.fulfill({ json: { success: true, data: { objectives: state.objectives } } });
            return;
        }

        if (pathname === '/api/questions/lecture') {
            if (state.failQuestions) {
                await route.fulfill({ status: 500, body: 'questions failed' });
                return;
            }
            await route.fulfill({ json: { success: true, data: { questions: [] } } });
            return;
        }

        if (pathname === '/api/lectures/pass-threshold') {
            if (state.failThreshold) {
                await route.fulfill({ status: 404, body: 'threshold missing' });
                return;
            }
            await route.fulfill({ json: { success: true, data: { passThreshold: 1 } } });
            return;
        }

        if (pathname === '/api/lectures/publish-status') {
            await route.fulfill({ json: { success: true, data: { publishStatus: { 'Unit 1': false } } } });
            return;
        }

        if (pathname === `/api/courses/ta/${INSTRUCTOR_ID}`) {
            await route.fulfill({ json: { success: true, data: [] } });
            return;
        }

        await route.fulfill({ json: { success: true, data: {} } });
    });

    return state;
}

async function openDocuments(page, options = {}) {
    const state = await installRoutes(page, options);
    if (options.fromStorage) {
        await page.addInitScript((courseId) => localStorage.setItem('selectedCourseId', courseId), COURSE_ID);
        await page.goto('/instructor/documents?unit=Unit%201');
    } else {
        await page.goto(`/instructor/documents?courseId=${COURSE_ID}`);
    }
    await expect(page.locator('#course-title')).toHaveText('Instructor JS Deep Branches', { timeout: 15_000 });
    await expect(page.locator('.accordion-item[data-unit-name="Unit 1"]')).toBeVisible();
    await page.waitForFunction(() => typeof /** @type {InstructorWindow} */ (window).openUploadModal === 'function');
    return state;
}

test.describe('instructor.js deep branch coverage', () => {
    test('covers storage course selection, empty/error loaders, missing materials, and AI guard branches', async ({ page }) => {
        const state = await openDocuments(page, {
            fromStorage: true,
            failCourseGet: true,
            failLearningObjectives: true,
            failQuestions: true,
            failThreshold: true,
        });

        await expect(page).toHaveURL(/courseId=INSTRUCTOR-JS-DEEP/);
        await expect(page.locator('.placeholder-item')).toHaveCount(2);
        await page.locator('.accordion-header').first().click();

        const result = await page.evaluate(async () => {
            const instructorWindow = /** @type {InstructorWindow} */ (window);

            await instructorWindow.loadLearningObjectives();
            await instructorWindow.loadAssessmentQuestions();
            await instructorWindow.loadPassThresholds();
            await instructorWindow.loadDocuments();
            await instructorWindow.confirmCourseMaterials('Unit 1');

            instructorWindow.openQuestionModal('Unit 1');
            instructorWindow.checkAIGenerationInModal();
            /** @type {HTMLSelectElement} */ (document.getElementById('question-type')).value = 'multiple-choice';
            instructorWindow.updateQuestionForm();
            await instructorWindow.generateAIQuestionContent();

            const topicSelect = /** @type {HTMLSelectElement} */ (document.getElementById('struggle-topic-select'));
            topicSelect.innerHTML = '<option value="Glycolysis">Glycolysis</option>';
            topicSelect.value = 'Glycolysis';
            await instructorWindow.generateAIQuestionFromStruggleTopic();

            const aiButton = document.createElement('button');
            aiButton.id = 'generate-ai-unit1';
            document.body.appendChild(aiButton);
            const lectureItem = /** @type {HTMLElement|undefined} */ (Array.from(document.querySelectorAll('.file-item'))
                .find(item => item.querySelector('h3')?.textContent?.includes('Lecture Notes')));
            const lectureStatus = lectureItem?.querySelector('.status-text');
            if (lectureItem && lectureStatus) {
                lectureItem.classList.remove('placeholder-item');
                lectureItem.dataset.documentType = 'lecture_notes';
                lectureItem.dataset.status = 'processed';
                // Deliberately contradictory display text proves the AI gate
                // reads the machine status instead of scraping the badge.
                lectureStatus.textContent = 'Not Uploaded';
            }
            instructorWindow.checkAIGenerationAvailability('Unit 1');
            const materialsAvailable = instructorWindow.checkCourseMaterialsAvailable('Unit 1');

            const content = /** @type {HTMLElement} */ (document.querySelector('.accordion-content'));
            content.classList.add('collapsed');
            instructorWindow.focusUnitFromURL();

            const unit = /** @type {HTMLElement} */ (document.querySelector('.accordion-item[data-unit-name="Unit 1"]'));
            const section = /** @type {HTMLElement} */ (unit.querySelector('.course-materials-section .section-content'));
            section.querySelectorAll('.add-content-section, .save-objectives').forEach((el) => el.remove());
            instructorWindow.ensureActionButtonsExist();

            return {
                aiDisabled: aiButton.disabled,
                aiTitle: aiButton.title,
                materialsAvailable,
                expanded: !content.classList.contains('collapsed'),
                actions: section.querySelectorAll('.add-content-section, .save-objectives').length,
                addMaterialActions: Array.from(section.querySelectorAll('.add-content-btn'))
                    .map(button => button.textContent?.replace(/\s+/g, ' ').trim()),
            };
        });

        expect(state.savedTopics).toBe(0);
        state.failLearningObjectives = false;
        state.objectives = [];
        state.failQuestions = false;
        state.failThreshold = true;

        const loaderResult = await page.evaluate(async () => {
            const instructorWindow = /** @type {InstructorWindow} */ (window);

            await instructorWindow.loadLearningObjectives();
            await instructorWindow.loadAssessmentQuestions();
            const questionsContainer = document.getElementById('assessment-questions-unit-1');
            if (questionsContainer) questionsContainer.innerHTML = '<div class="question-item">One?</div>';
            await instructorWindow.loadPassThresholds();
            const thresholdAfterApiMiss = /** @type {HTMLInputElement} */ (document.getElementById('pass-threshold-unit-1')).value;

            const objectivesList = document.getElementById('objectives-list-unit-1');
            objectivesList?.remove();
            const thresholdInput = document.getElementById('pass-threshold-unit-1');
            thresholdInput?.remove();
            await instructorWindow.loadPassThresholds();

            return { thresholdAfterApiMiss };
        });

        state.objectives = ['Trace glycolysis'];
        await page.evaluate(async () => {
            const instructorWindow = /** @type {InstructorWindow} */ (window);
            await instructorWindow.loadLearningObjectives();
        });

        state.emptyInstructorCourses = true;
        const noCourseResult = await page.evaluate(async () => {
            const instructorWindow = /** @type {InstructorWindow} */ (window);
            const previous = window.location.href;
            window.history.replaceState({}, '', '/instructor/documents');
            localStorage.removeItem('selectedCourseId');
            await instructorWindow.loadCourseData();
            const title = document.getElementById('course-title')?.textContent;
            window.history.replaceState({}, '', previous);
            return { title };
        });

        state.emptyInstructorCourses = false;
        state.failInstructorLookup = true;
        await page.evaluate(async () => {
            const instructorWindow = /** @type {InstructorWindow} */ (window);
            const previous = window.location.href;
            window.history.replaceState({}, '', '/instructor/documents');
            localStorage.removeItem('selectedCourseId');
            await instructorWindow.loadCourseData();
            window.history.replaceState({}, '', previous);
        });

        expect(loaderResult.thresholdAfterApiMiss).toBe('0');
        expect(noCourseResult.title).toMatch(/No Course|Instructor JS Deep Branches/);
        expect(result.aiDisabled).toBe(false);
        expect(result.aiTitle).toContain('Generate questions');
        expect(result.materialsAvailable).toBe(true);
        expect(result.expanded).toBe(true);
        expect(result.actions).toBeGreaterThan(0);
        expect(result.addMaterialActions).toEqual([
            'Add Lecture Notes',
            'Add Practice Questions/Tutorial',
            'Add Additional Material',
        ]);
        await expect(page.locator('.notification').filter({ hasText: /Missing mandatory materials|Please upload course materials|Error loading/i }).first()).toBeVisible();
    });

    test('covers default uploaded filename, empty topic review, topic-save error, and practice upload naming', async ({ page }) => {
        const state = await openDocuments(page, { failTopicSave: true });

        await page.evaluate(async () => {
            const instructorWindow = /** @type {InstructorWindow} */ (window);
            instructorWindow.openUploadModal('Unit 1', 'external-link');
            instructorWindow.showFileUpload();
            instructorWindow.handleFileUpload(new File(['external link body'], 'external.txt', { type: 'text/plain' }));
            await instructorWindow.handleUpload();
        });

        await expect(page.locator('#topic-review-section')).toBeVisible();
        await expect(page.locator('#upload-topic-review-list')).toContainText('No new topics detected');
        await page.locator('#save-topics-btn').click();
        await expect(page.locator('.notification').filter({ hasText: 'Could not save topics' }).last()).toBeVisible();

        await page.evaluate(async () => {
            const instructorWindow = /** @type {InstructorWindow} */ (window);
            instructorWindow.openUploadModal('Unit 1', 'practice-quiz');
            instructorWindow.showFileUpload();
            instructorWindow.handleFileUpload(new File(['1. A practice question'], 'practice.txt', { type: 'text/plain' }));
            await instructorWindow.handleUpload();
        });

        await expect(page.locator('.file-item[data-document-id="doc_practice_upload"] h3')).toHaveText('practice.txt');
        await expect(page.locator('.file-item[data-document-id="doc_practice_upload"] .document-type-badge')).toHaveText('Practice Questions/Tutorial');
        expect(state.textUploads).toHaveLength(0);
        expect(state.fileUploads).toBe(2);
        expect(state.savedTopics).toBeGreaterThanOrEqual(1);
    });

    test('covers document loader rejection fallback and no-instructor course lookup branch', async ({ page }) => {
        await openDocuments(page, { rejectDocuments: true });

        const result = await page.evaluate(async () => {
            const instructorWindow = /** @type {InstructorWindow} */ (window);
            await instructorWindow.loadDocuments();

            const testWindow = /** @type {any} */ (window);
            const originalGetCurrentInstructorId = testWindow.getCurrentInstructorId;
            const originalLocation = window.location.href;
            testWindow.getCurrentInstructorId = () => '';
            window.history.replaceState({}, '', '/instructor/documents');
            localStorage.removeItem('selectedCourseId');
            await instructorWindow.loadCourseData();
            testWindow.getCurrentInstructorId = originalGetCurrentInstructorId;
            window.history.replaceState({}, '', originalLocation);

            return {
                title: document.getElementById('course-title')?.textContent,
                placeholders: document.querySelectorAll('.placeholder-item').length,
            };
        });

        expect(result.placeholders).toBeGreaterThanOrEqual(2);
        expect(result.title).toBe('Instructor JS Deep Branches');
        await expect(page.locator('.notification').filter({ hasText: 'Error loading documents' }).last()).toBeVisible();
    });
});
