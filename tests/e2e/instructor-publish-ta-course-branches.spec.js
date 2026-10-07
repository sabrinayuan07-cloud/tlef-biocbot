// @ts-check

const { test, expect } = require('./fixtures/monocart');
const { storageStatePath } = require('./helpers/users');

const COURSE_ID = 'INSTRUCTOR-BRANCH-WINDOW';
const INSTRUCTOR_ID = 'e2e_instructor_id';
const TA_ID = 'e2e_ta_id';

/**
 * @typedef {Window & Record<string, any>} InstructorWindow
 */

function branchCourse(overrides = {}) {
    const now = new Date('2026-02-03T04:05:06.000Z');
    return {
        courseId: COURSE_ID,
        courseName: 'Instructor Branch Window',
        courseCode: 'BRANCH-STU',
        instructorCourseCode: 'BRANCH-INS',
        instructorId: INSTRUCTOR_ID,
        instructors: [INSTRUCTOR_ID],
        tas: [TA_ID],
        taPermissions: {},
        courseStructure: { weeks: 2, lecturesPerWeek: 1, totalUnits: 2 },
        isOnboardingComplete: true,
        status: 'active',
        approvedStruggleTopics: [],
        lectures: [
            {
                name: 'Unit 1',
                displayName: 'Unit 1',
                isPublished: true,
                learningObjectives: ['Explain enzymes'],
                passThreshold: 1,
                createdAt: now,
                updatedAt: now,
                documents: [],
                assessmentQuestions: [],
            },
            {
                name: 'Unit 2',
                displayName: 'Unit 2',
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

async function installBranchRoutes(page, options = {}) {
    const role = options.role || 'instructor';
    const userId = role === 'ta' ? TA_ID : INSTRUCTOR_ID;
    const course = options.course || branchCourse();
    const controls = {
        publishMode: 'success',
        publishStatusMode: 'normal',
        taCourses: [{ courseId: COURSE_ID, courseName: course.courseName }],
        taPermissions: { materials: true, questions: true, settings: true, transcripts: true, flags: true, roster: true },
        instructorCourses: [course],
        instructorCoursesMode: 'success',
        instructorCoursesStatus: 200,
        taCoursesStatus: 200,
        taCoursesSuccess: true,
        taPermissionsByCourse: null,
        taPermissionResultsByCourse: null,
        courseByIdStatus: 200,
        courseByIdCalls: 0,
        publishCalls: 0,
        publishStatusCalls: 0,
    };
    Object.assign(controls, options.controls || {});

    await page.route('**/api/**', async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        const pathname = url.pathname;
        const method = request.method();

        if (pathname === '/api/settings/llm-tag') {
            await route.fulfill({ json: { success: true, llmIndex: 0, reasoningIndex: 0 } });
            return;
        }

        if (pathname === '/api/auth/me') {
            await route.fulfill({
                json: {
                    success: true,
                    user: {
                        userId,
                        username: role === 'ta' ? 'e2e_ta' : 'e2e_instructor',
                        displayName: role === 'ta' ? 'Branch TA' : 'Branch Instructor',
                        role,
                        preferences: options.userPreferences || {},
                    },
                },
            });
            return;
        }

        if (pathname === `/api/onboarding/${COURSE_ID}`) {
            await route.fulfill({ json: { success: true, data: course } });
            return;
        }

        if (pathname.startsWith('/api/onboarding/instructor/')) {
            if (controls.instructorCoursesMode === 'network-error') {
                await route.abort('failed');
                return;
            }
            if (controls.instructorCoursesStatus !== 200) {
                await route.fulfill({ status: controls.instructorCoursesStatus, body: 'instructor courses unavailable' });
                return;
            }
            await route.fulfill({ json: { success: true, data: { courses: controls.instructorCourses } } });
            return;
        }

        if (pathname === `/api/courses/ta/${TA_ID}`) {
            if (controls.taCoursesStatus !== 200) {
                await route.fulfill({ status: controls.taCoursesStatus, body: 'ta courses unavailable' });
                return;
            }
            await route.fulfill({
                json: {
                    success: controls.taCoursesSuccess,
                    message: controls.taCoursesSuccess ? undefined : 'ta courses rejected',
                    data: controls.taCourses,
                },
            });
            return;
        }

        if (pathname === `/api/courses/ta/${INSTRUCTOR_ID}`) {
            if (controls.taCoursesStatus !== 200) {
                await route.fulfill({ status: controls.taCoursesStatus, body: 'ta courses unavailable' });
                return;
            }
            await route.fulfill({
                json: {
                    success: controls.taCoursesSuccess,
                    message: controls.taCoursesSuccess ? undefined : 'ta courses rejected',
                    data: controls.taCourses,
                },
            });
            return;
        }

        const taPermissionsMatch = pathname.match(/^\/api\/courses\/([^/]+)\/ta-permissions\/([^/]+)$/);
        if (taPermissionsMatch && [TA_ID, INSTRUCTOR_ID].includes(taPermissionsMatch[2])) {
            const courseId = decodeURIComponent(taPermissionsMatch[1]);
            const resultByCourse = controls.taPermissionResultsByCourse || {};
            const permissionsByCourse = controls.taPermissionsByCourse || {};
            if (Object.prototype.hasOwnProperty.call(resultByCourse, courseId)) {
                await route.fulfill({ json: resultByCourse[courseId] });
                return;
            }
            const permissions = Object.prototype.hasOwnProperty.call(permissionsByCourse, courseId)
                ? permissionsByCourse[courseId]
                : controls.taPermissions;
            await route.fulfill({
                json: {
                    success: true,
                    data: { permissions },
                },
            });
            return;
        }

        if (pathname === `/api/courses/${COURSE_ID}/ta-permissions/${TA_ID}`) {
            await route.fulfill({
                json: {
                    success: true,
                    data: { permissions: controls.taPermissions },
                },
            });
            return;
        }

        if (pathname === `/api/courses/${COURSE_ID}/ta-permissions/${INSTRUCTOR_ID}`) {
            await route.fulfill({
                json: {
                    success: true,
                    data: { permissions: controls.taPermissions },
                },
            });
            return;
        }

        if (pathname === `/api/courses/${COURSE_ID}` && method === 'GET') {
            controls.courseByIdCalls += 1;
            if (controls.courseByIdStatus !== 200) {
                await route.fulfill({ status: controls.courseByIdStatus, body: 'course unavailable' });
                return;
            }
            await route.fulfill({ json: { success: true, data: course } });
            return;
        }

        if (pathname === '/api/lectures/publish-status') {
            controls.publishStatusCalls += 1;
            if (controls.publishStatusMode === 'fail') {
                await route.fulfill({ status: 500, body: 'publish status unavailable' });
                return;
            }
            const publishStatus = controls.publishStatusMode === 'external-change'
                ? { 'Unit 1': false, 'Unit 2': false }
                : controls.publishStatusMode === 'external-publish'
                    ? { 'Unit 1': true, 'Unit 2': false }
                : { 'Unit 1': true, 'Unit 2': false };
            await route.fulfill({ json: { success: true, data: { publishStatus } } });
            return;
        }

        if (pathname === '/api/lectures/publish') {
            controls.publishCalls += 1;
            if (controls.publishMode === 'http-error-once') {
                controls.publishMode = 'success';
                await route.fulfill({ status: 409, json: { success: false, message: 'publish conflict' } });
                return;
            }
            if (controls.publishMode === 'result-error-once') {
                controls.publishMode = 'success';
                await route.fulfill({ json: { success: false, message: 'publish rejected' } });
                return;
            }
            if (controls.publishMode === 'network-error-once') {
                controls.publishMode = 'success';
                await route.abort('failed');
                return;
            }
            await route.fulfill({ json: { success: true, message: 'Publish updated', data: request.postDataJSON() } });
            return;
        }

        if (pathname === '/api/learning-objectives') {
            await route.fulfill({ json: { success: true, data: { objectives: ['Explain enzymes'] } } });
            return;
        }

        if (pathname === '/api/questions/lecture') {
            await route.fulfill({ json: { success: true, data: { questions: [] } } });
            return;
        }

        if (pathname === '/api/lectures/pass-threshold') {
            await route.fulfill({ json: { success: true, data: { passThreshold: 0 } } });
            return;
        }

        await route.fulfill({ json: { success: true, data: {} } });
    });

    return controls;
}

async function seedPublishToggleHarness(page, checked = true) {
    await page.evaluate((isChecked) => {
        let accordion = document.querySelector('.accordion-item[data-unit-name="Unit 1"]');
        if (!accordion) {
            accordion = document.createElement('div');
            accordion.className = 'accordion-item';
            accordion.setAttribute('data-unit-name', 'Unit 1');
            document.body.appendChild(accordion);
        }
        accordion.classList.toggle('published', isChecked);
        let toggle = /** @type {HTMLInputElement | null} */ (document.getElementById('publish-unit1'));
        if (!toggle) {
            const wrapper = document.createElement('div');
            wrapper.className = 'publish-toggle';
            wrapper.innerHTML = '<input id="publish-unit1" type="checkbox">';
            accordion.appendChild(wrapper);
            toggle = /** @type {HTMLInputElement} */ (document.getElementById('publish-unit1'));
        }
        toggle.checked = isChecked;
    }, checked);
}

async function openInstructorDocuments(page, options = {}) {
    const controls = await installBranchRoutes(page, options);
    if (Object.prototype.hasOwnProperty.call(options, 'selectedCourseId')) {
        await page.addInitScript((selectedCourseId) => {
            if (selectedCourseId) {
                localStorage.setItem('selectedCourseId', selectedCourseId);
            } else {
                localStorage.removeItem('selectedCourseId');
            }
        }, options.selectedCourseId);
    }
    const url = options.withCourseParam === false
        ? '/instructor/documents'
        : `/instructor/documents?courseId=${COURSE_ID}`;
    await page.goto(url);
    if (options.expectCourseTitle !== false) {
        await expect(page.locator('#course-title')).toHaveText('Instructor Branch Window', { timeout: 15_000 });
    }
    await page.waitForFunction(() => {
        const instructorWindow = /** @type {InstructorWindow} */ (window);
        return [
            'addContentToWeek',
            'extractFilenameFromDisposition',
            'formatFileSize',
            'loadTAPermissions',
            'updatePublishStatus',
            'loadPublishStatus',
            'startPublishStatusPolling',
            'stopPublishStatusPolling',
        ].every((name) => typeof instructorWindow[name] === 'function');
    });
    return controls;
}

async function openInstructorScriptHarness(page, options = {}) {
    const controls = await installBranchRoutes(page, options);
    if (Object.prototype.hasOwnProperty.call(options, 'selectedCourseId')) {
        await page.addInitScript((selectedCourseId) => {
            if (selectedCourseId) {
                localStorage.setItem('selectedCourseId', selectedCourseId);
            } else {
                localStorage.removeItem('selectedCourseId');
            }
        }, options.selectedCourseId);
    }

    await page.route('**/instructor/branch-harness', async (route) => {
        await route.fulfill({
            contentType: 'text/html',
            body: `<!doctype html>
<html>
<head><title>Instructor Branch Harness</title></head>
<body>
    <nav>
        <li id="instructor-home-nav"></li>
        <li id="instructor-documents-nav"></li>
        <li id="instructor-onboarding-nav"></li>
        <li id="instructor-flagged-nav"></li>
        <li id="instructor-downloads-nav"></li>
        <li id="instructor-ta-hub-nav"></li>
        <li id="instructor-settings-nav"></li>
        <li id="ta-dashboard-nav" style="display: none;"></li>
        <li id="ta-courses-nav" style="display: none;"><a href="#" id="ta-my-courses-link">Course Upload</a></li>
        <li id="ta-support-nav" style="display: none;"><a href="#" id="ta-student-support-link">Student Flag</a></li>
        <li id="ta-settings-nav" style="display: none;"></li>
    </nav>
    <div id="user-display-name"></div>
    <div class="user-avatar">I</div>
    <div class="user-role"></div>
    <script src="/common/scripts/notifications.js"></script>
    <script src="/common/scripts/auth.js"></script>
    <script src="/common/scripts/ui-utils.js"></script>
    <script src="/common/scripts/topic-review.js"></script>
    <script src="/instructor/scripts/instructor-state.js"></script>
    <script src="/instructor/scripts/instructor-course.js"></script>
    <script src="/instructor/scripts/instructor-ta.js"></script>
    <script src="/instructor/scripts/instructor-publish.js"></script>
    <script src="/instructor/scripts/instructor-units.js"></script>
    <script src="/instructor/scripts/instructor-documents.js"></script>
    <script src="/instructor/scripts/instructor-upload-topics.js"></script>
    <script src="/instructor/scripts/instructor-objectives.js"></script>
    <script src="/instructor/scripts/instructor-questions.js"></script>
    <script src="/instructor/scripts/instructor-ai-generation.js"></script>
    <script src="/instructor/scripts/instructor.js"></script>
</body>
</html>`,
        });
    });

    await page.goto('/instructor/branch-harness');
    await page.waitForFunction(() => {
        const instructorWindow = /** @type {InstructorWindow} */ (window);
        return typeof instructorWindow.getCurrentCourseId === 'function'
            && typeof instructorWindow.loadTAPermissions === 'function'
            && typeof instructorWindow.updateSidebarForTA === 'function';
    });
    return controls;
}

test.describe('instructor publish, TA, course, and polling branches', () => {
    test.use({ storageState: storageStatePath('instructor') });

    test('renders no action buttons when content has no document id', async ({ page }) => {
        await openInstructorDocuments(page);

        const result = await page.evaluate(() => {
            const instructorWindow = /** @type {InstructorWindow} */ (window);
            const accordion = document.createElement('div');
            accordion.className = 'accordion-item';
            accordion.dataset.unitName = 'Harness Unit';
            accordion.innerHTML = '<div class="course-materials-section"><div class="section-content"></div></div>';
            document.body.appendChild(accordion);

            instructorWindow.addContentToWeek('Harness Unit', 'Orphan material', 'No id available', null, 'processed', 'additional');
            const item = /** @type {HTMLElement|null} */ (accordion.querySelector('.file-item'));
            return {
                buttonCount: accordion.querySelectorAll('.action-button').length,
                statusText: item?.querySelector('.status-text')?.textContent,
                dataStatus: item?.dataset.status,
            };
        });

        expect(result).toEqual({
            buttonCount: 0,
            statusText: 'Uploaded',
            dataStatus: 'processed',
        });
    });

    test('parses fallback filenames when content disposition is absent or malformed', async ({ page }) => {
        await openInstructorDocuments(page);

        const filenames = await page.evaluate(() => {
            const instructorWindow = /** @type {InstructorWindow} */ (window);
            return [
                instructorWindow.extractFilenameFromDisposition(null),
                instructorWindow.extractFilenameFromDisposition('attachment; filename*=UTF-8\'\'%E0%A4%A; filename="fallback.pdf"'),
                instructorWindow.extractFilenameFromDisposition('attachment; filename="notes.pdf"'),
                instructorWindow.extractFilenameFromDisposition('attachment; inline'),
            ];
        });

        expect(filenames).toEqual([null, 'fallback.pdf', 'notes.pdf', null]);
    });

    test('returns without adding content when the unit accordion is missing', async ({ page }) => {
        await openInstructorDocuments(page);

        const counts = await page.evaluate(() => {
            const instructorWindow = /** @type {InstructorWindow} */ (window);
            const before = document.querySelectorAll('.file-item').length;
            instructorWindow.addContentToWeek('Missing Harness Unit', 'Missing.pdf', 'No target unit', 'doc-missing');
            return {
                before,
                after: document.querySelectorAll('.file-item').length,
            };
        });

        expect(counts.after).toBe(counts.before);
    });

    test('replaces practice placeholder with uploaded document actions', async ({ page }) => {
        await openInstructorDocuments(page);

        const replacement = await page.evaluate(() => {
            const instructorWindow = /** @type {InstructorWindow} */ (window);
            const accordion = document.createElement('div');
            accordion.className = 'accordion-item';
            accordion.dataset.unitName = 'Practice Harness';
            accordion.innerHTML = `
                <div class="course-materials-section">
                    <div class="section-content">
                        <div class="file-item placeholder-item">
                            <div class="file-info">
                                <h3>*Practice Questions/Tutorial</h3>
                                <p>Placeholder</p>
                                <span class="status-text uploaded">Uploaded</span>
                            </div>
                            <div class="file-actions"></div>
                        </div>
                    </div>
                </div>`;
            document.body.appendChild(accordion);

            instructorWindow.addContentToWeek(
                'Practice Harness',
                'Practice set.pdf',
                'New practice document',
                'doc-practice',
                'processed',
                'practice-quiz',
            );

            const item = /** @type {HTMLElement} */ (accordion.querySelector('.file-item'));
            return {
                isPlaceholder: item.classList.contains('placeholder-item'),
                documentId: item.dataset.documentId,
                documentType: item.dataset.documentType,
                dataStatus: item.dataset.status,
                actionCount: item.querySelectorAll('.action-button').length,
                status: item.querySelector('.status-text')?.textContent,
            };
        });

        expect(replacement).toEqual({
            isPlaceholder: false,
            documentId: 'doc-practice',
            documentType: 'practice_q_tutorials',
            dataStatus: 'processed',
            actionCount: 3,
            status: 'Uploaded',
        });
    });

    test('inserts unmatched practice content before course action controls', async ({ page }) => {
        await openInstructorDocuments(page);

        const insertion = await page.evaluate(() => {
            const instructorWindow = /** @type {InstructorWindow} */ (window);
            const accordion = document.createElement('div');
            accordion.className = 'accordion-item';
            accordion.dataset.unitName = 'Unmatched Practice Harness';
            accordion.innerHTML = `
                <div class="course-materials-section">
                    <div class="section-content">
                        <div class="file-item placeholder-item" data-document-type="lecture_notes">
                            <div class="file-info">
                                <h3>*Lecture Notes - Unit 1</h3>
                                <p>Required lecture placeholder</p>
                                <span class="status-text not-uploaded">Not Uploaded</span>
                            </div>
                            <div class="file-actions">
                                <button class="action-button upload">Upload</button>
                            </div>
                        </div>
                        <div class="add-content-section">
                            <button class="action-button add-content">Add Content</button>
                        </div>
                    </div>
                </div>`;
            document.body.appendChild(accordion);

            instructorWindow.addContentToWeek(
                'Unmatched Practice Harness',
                'Practice worksheet.pdf',
                'Uploaded successfully - worksheet.pdf',
                'doc-new-practice',
                undefined,
                'practice-quiz',
            );

            const content = /** @type {HTMLElement} */ (accordion.querySelector('.section-content'));
            const children = Array.from(content.children).map((element) => {
                const row = /** @type {HTMLElement} */ (element);
                return {
                    className: row.className,
                    title: row.querySelector('.file-info h3')?.textContent || row.querySelector('button')?.textContent || '',
                    documentId: row.dataset.documentId || null,
                    documentType: row.dataset.documentType || null,
                    statusText: row.querySelector('.status-text')?.textContent || null,
                    statusClass: row.querySelector('.status-text')?.className || null,
                    actions: Array.from(row.querySelectorAll('.action-button')).map((button) => button.textContent?.trim()),
                    isPlaceholder: row.classList.contains('placeholder-item'),
                };
            });

            return {
                children,
                placeholderCount: accordion.querySelectorAll('.placeholder-item').length,
            };
        });

        expect(insertion.placeholderCount).toBe(1);
        expect(insertion.children).toEqual([
            expect.objectContaining({
                title: '*Lecture Notes - Unit 1',
                documentType: 'lecture_notes',
                isPlaceholder: true,
                actions: ['Upload'],
            }),
            expect.objectContaining({
                title: 'Practice worksheet.pdf',
                documentId: 'doc-new-practice',
                documentType: 'practice_q_tutorials',
                statusText: 'Uploaded',
                statusClass: 'status-text uploaded',
                actions: ['View', 'Download', 'Delete'],
                isPlaceholder: false,
            }),
            expect.objectContaining({
                className: 'add-content-section',
                title: 'Add Content',
            }),
        ]);
    });

    test('reverts published toggle when publish request returns an HTTP error', async ({ page }) => {
        const controls = await openInstructorDocuments(page, { controls: { publishMode: 'http-error-once' } });
        await seedPublishToggleHarness(page, true);

        await page.evaluate(async () => {
            const instructorWindow = /** @type {InstructorWindow} */ (window);
            const toggle = /** @type {HTMLInputElement} */ (document.getElementById('publish-unit1'));
            toggle.checked = false;
            await instructorWindow.updatePublishStatus('Unit 1', false);
        });

        await expect(page.locator('#publish-unit1')).toBeChecked();
        await expect(page.locator('.accordion-item[data-unit-name="Unit 1"]')).toHaveClass(/published/);
        await expect(page.locator('.notification').filter({ hasText: 'publish conflict' })).toBeVisible();
        expect(controls.publishCalls).toBeGreaterThanOrEqual(1);
    });

    test('reverts published toggle when publish response reports failure', async ({ page }) => {
        await openInstructorDocuments(page, { controls: { publishMode: 'result-error-once' } });
        await seedPublishToggleHarness(page, true);

        await page.evaluate(async () => {
            const instructorWindow = /** @type {InstructorWindow} */ (window);
            const toggle = /** @type {HTMLInputElement} */ (document.getElementById('publish-unit1'));
            toggle.checked = false;
            await instructorWindow.updatePublishStatus('Unit 1', false);
        });

        await expect(page.locator('#publish-unit1')).toBeChecked();
        await expect(page.locator('.notification').filter({ hasText: 'Failed to update publish status' })).toBeVisible();
    });

    test('reverts published toggle when publish request rejects', async ({ page }) => {
        await openInstructorDocuments(page, { controls: { publishMode: 'network-error-once' } });
        await seedPublishToggleHarness(page, true);

        await page.evaluate(async () => {
            const instructorWindow = /** @type {InstructorWindow} */ (window);
            const toggle = /** @type {HTMLInputElement} */ (document.getElementById('publish-unit1'));
            toggle.checked = false;
            await instructorWindow.updatePublishStatus('Unit 1', false);
        });

        await expect(page.locator('#publish-unit1')).toBeChecked();
        await expect(page.locator('.notification').filter({ hasText: 'Error updating publish status' })).toBeVisible();
    });

    test('shows warning when publish status request fails', async ({ page }) => {
        const controls = await openInstructorDocuments(page);
        await page.evaluate(() => {
            const instructorWindow = /** @type {InstructorWindow} */ (window);
            return instructorWindow.loadPublishStatus(false);
        });

        controls.publishStatusMode = 'fail';

        await page.evaluate(async () => {
            const instructorWindow = /** @type {InstructorWindow} */ (window);
            await instructorWindow.loadPublishStatus(false);
        });

        await expect(page.locator('.notification').filter({ hasText: 'Error loading publish status' })).toBeVisible();
    });

    test('announces external publish changes when loaded status differs', async ({ page }) => {
        const controls = await openInstructorDocuments(page);
        await seedPublishToggleHarness(page, true);
        controls.publishStatusMode = 'external-change';

        await page.evaluate(async () => {
            const instructorWindow = /** @type {InstructorWindow} */ (window);
            const toggle = /** @type {HTMLInputElement} */ (document.getElementById('publish-unit1'));
            toggle.checked = true;
            await instructorWindow.loadPublishStatus(false);
        });

        await expect(page.locator('#publish-unit1')).not.toBeChecked();
        await expect(page.locator('.notification').filter({ hasText: 'Publish status updated by another user' })).toBeVisible();
    });

    test('adds published class when external publish status turns true', async ({ page }) => {
        const controls = await openInstructorDocuments(page, { controls: { publishStatusMode: 'external-change' } });
        await seedPublishToggleHarness(page, false);

        await page.evaluate(async () => {
            const instructorWindow = /** @type {InstructorWindow} */ (window);
            await instructorWindow.loadPublishStatus(false);
        });

        controls.publishStatusMode = 'external-publish';

        await page.evaluate(async () => {
            const instructorWindow = /** @type {InstructorWindow} */ (window);
            const toggle = /** @type {HTMLInputElement} */ (document.getElementById('publish-unit1'));
            toggle.checked = false;
            await instructorWindow.loadPublishStatus(false);
        });

        await expect(page.locator('.accordion-item[data-unit-name="Unit 1"]')).toHaveClass(/published/);
    });

    // The "retrieval toggle" tests were removed: the instructor.js listener
    // that instant-saved #additive-retrieval-toggle was deleted as dead code.
    // The toggle only exists on settings.html, where settings.js owns it
    // (covered by instructor-settings.spec.js: init, save, and reset flows).

    test('skips polling when no document accordions exist', async ({ page }) => {
        await openInstructorDocuments(page);

        const intervalCalls = await page.evaluate(() => {
            const instructorWindow = /** @type {InstructorWindow} */ (window);
            document.querySelectorAll('.accordion-item').forEach((item) => item.remove());
            let calls = 0;
            const originalSetInterval = window.setInterval;
            window.setInterval = /** @type {any} */ (() => {
                calls += 1;
                return 101;
            });
            instructorWindow.startPublishStatusPolling();
            window.setInterval = originalSetInterval;
            return calls;
        });

        expect(intervalCalls).toBe(0);
    });

    test('clears existing publish poller before starting a new poller', async ({ page }) => {
        await openInstructorDocuments(page);

        const clearCalls = await page.evaluate(() => {
            const instructorWindow = /** @type {InstructorWindow} */ (window);
            let clearCount = 0;
            const originalSetInterval = window.setInterval;
            const originalClearInterval = window.clearInterval;
            window.setInterval = /** @type {any} */ (() => 202);
            window.clearInterval = /** @type {any} */ (() => {
                clearCount += 1;
            });
            instructorWindow.startPublishStatusPolling();
            instructorWindow.startPublishStatusPolling();
            window.setInterval = originalSetInterval;
            window.clearInterval = originalClearInterval;
            return clearCount;
        });

        expect(clearCalls).toBe(1);
    });

    test('stops active publish polling interval', async ({ page }) => {
        await openInstructorDocuments(page);

        const clearCalls = await page.evaluate(() => {
            const instructorWindow = /** @type {InstructorWindow} */ (window);
            let clearCount = 0;
            const originalSetInterval = window.setInterval;
            const originalClearInterval = window.clearInterval;
            window.setInterval = /** @type {any} */ (() => 303);
            window.clearInterval = /** @type {any} */ (() => {
                clearCount += 1;
            });
            instructorWindow.startPublishStatusPolling();
            instructorWindow.stopPublishStatusPolling();
            window.setInterval = originalSetInterval;
            window.clearInterval = originalClearInterval;
            return clearCount;
        });

        expect(clearCalls).toBe(1);
    });

    test('logs hidden state when polling visibility changes', async ({ page }) => {
        await openInstructorDocuments(page);
        await seedPublishToggleHarness(page, true);

        const sawHiddenLog = await page.evaluate(() => {
            const instructorWindow = /** @type {InstructorWindow} */ (window);
            const logs = [];
            const originalLog = console.log;
            console.log = (...args) => {
                logs.push(args.join(' '));
                originalLog(...args);
            };
            Object.defineProperty(document, 'hidden', { configurable: true, value: true });
            instructorWindow.startPublishStatusPolling();
            document.dispatchEvent(new Event('visibilitychange'));
            instructorWindow.stopPublishStatusPolling();
            console.log = originalLog;
            return logs.some((message) => message.includes('Page hidden'));
        });

        expect(sawHiddenLog).toBe(true);
    });

    test('uses T as the TA sidebar avatar fallback when the user initial helper is unavailable', async ({ page }) => {
        await openInstructorScriptHarness(page, {
            role: 'ta',
            controls: {
                taPermissions: { materials: true, questions: true, settings: true, transcripts: true, flags: true, roster: true },
            },
        });

        const sidebarState = await page.evaluate(async () => {
            const instructorWindow = /** @type {InstructorWindow} */ (window);
            const testWindow = /** @type {any} */ (window);
            testWindow.getCurrentUserInitial = undefined;
            testWindow.isTA = () => true;
            await instructorWindow.updateSidebarForTA();
            return {
                avatar: document.querySelector('.user-avatar')?.textContent,
                role: document.querySelector('.user-role')?.textContent,
                instructorHomeDisplay: /** @type {HTMLElement | null} */ (document.getElementById('instructor-home-nav'))?.style.display,
                taCoursesDisplay: /** @type {HTMLElement | null} */ (document.getElementById('ta-courses-nav'))?.style.display,
            };
        });

        expect(sidebarState).toEqual({
            avatar: 'T',
            role: 'Teaching Assistant',
            instructorHomeDisplay: 'none',
            taCoursesDisplay: 'block',
        });
    });

    test('hides TA links when permissions deny access', async ({ page }) => {
        await openInstructorDocuments(page, {
            controls: {
                taPermissions: { materials: false, questions: false, settings: false, transcripts: false, flags: false, roster: false },
            },
        });

        await page.evaluate(async () => {
            const instructorWindow = /** @type {InstructorWindow} */ (window);
            ['ta-my-courses-link', 'ta-student-support-link'].forEach((id) => {
                if (!document.getElementById(id)) {
                    const link = document.createElement('a');
                    link.id = id;
                    link.href = '#';
                    link.style.display = 'block';
                    document.body.appendChild(link);
                }
            });
            localStorage.setItem('selectedCourseId', 'INSTRUCTOR-BRANCH-WINDOW');
            await instructorWindow.updateTANavigationBasedOnPermissions();
        });

        await expect(page.locator('#ta-my-courses-link')).toHaveCSS('display', 'none');
        await expect(page.locator('#ta-student-support-link')).toHaveCSS('display', 'none');
    });

    test('warns when TA permission links are absent', async ({ page }) => {
        await openInstructorDocuments(page);

        const linkCount = await page.evaluate(async () => {
            const instructorWindow = /** @type {InstructorWindow} */ (window);
            document.getElementById('ta-my-courses-link')?.remove();
            document.getElementById('ta-student-support-link')?.remove();
            await instructorWindow.updateTANavigationBasedOnPermissions();
            return document.querySelectorAll('#ta-my-courses-link, #ta-student-support-link').length;
        });

        expect(linkCount).toBe(0);
    });

    test('keeps TA permissions untouched when TA id is missing', async ({ page }) => {
        await openInstructorDocuments(page);

        const permissions = await page.evaluate(async () => {
            const instructorWindow = /** @type {InstructorWindow} */ (window);
            const testWindow = /** @type {any} */ (window);
            testWindow.taPermissions = { sentinel: true };
            testWindow.getCurrentInstructorId = () => '';
            await instructorWindow.loadTAPermissions();
            return testWindow.taPermissions;
        });

        expect(permissions).toEqual({ sentinel: true });
    });

    test('clears TA permissions when courses request fails', async ({ page }) => {
        await openInstructorDocuments(page, {
            controls: {
                taCoursesStatus: 500,
            },
        });

        const permissions = await page.evaluate(async () => {
            const instructorWindow = /** @type {InstructorWindow} */ (window);
            await instructorWindow.loadTAPermissions();
            return /** @type {any} */ (window).taPermissions;
        });

        expect(permissions).toEqual({});
    });

    test('clears TA permissions when courses response is unsuccessful', async ({ page }) => {
        await openInstructorDocuments(page, {
            controls: {
                taCoursesSuccess: false,
            },
        });

        const permissions = await page.evaluate(async () => {
            const instructorWindow = /** @type {InstructorWindow} */ (window);
            await instructorWindow.loadTAPermissions();
            return /** @type {any} */ (window).taPermissions;
        });

        expect(permissions).toEqual({});
    });

    test('clears TA permissions when a successful TA courses response omits data', async ({ page }) => {
        await openInstructorScriptHarness(page, {
            role: 'ta',
            controls: {
                taCourses: undefined,
            },
        });

        const permissions = await page.evaluate(async () => {
            const instructorWindow = /** @type {InstructorWindow} */ (window);
            const testWindow = /** @type {any} */ (window);
            testWindow.taPermissions = { stale: { materials: true } };
            await instructorWindow.loadTAPermissions();
            return {
                permissions: testWindow.taPermissions,
                courses: testWindow.taCourses,
            };
        });

        expect(permissions).toEqual({ permissions: {}, courses: [] });
    });

    test('denies feature access when TA permissions are empty', async ({ page }) => {
        await openInstructorDocuments(page);

        const canAccessCourses = await page.evaluate(() => {
            const instructorWindow = /** @type {InstructorWindow} */ (window);
            /** @type {any} */ (window).taPermissions = {};
            return instructorWindow.hasPermissionForFeature('courses');
        });

        expect(canAccessCourses).toBe(false);
    });

    test('checks all TA permission course IDs when no selected course is available', async ({ page }) => {
        await openInstructorScriptHarness(page);

        const access = await page.evaluate(() => {
            const instructorWindow = /** @type {InstructorWindow} */ (window);
            const testWindow = /** @type {any} */ (window);
            window.history.replaceState({}, '', '/instructor/branch-harness');
            localStorage.removeItem('selectedCourseId');
            testWindow.getCurrentUser = () => ({ preferences: {} });
            testWindow.taCourses = [];
            testWindow.taPermissions = {
                'TA-DENIED-COURSE': { materials: false, questions: false, settings: false, transcripts: false, flags: false, roster: false },
                'TA-ALLOWED-COURSE': { materials: false, questions: false, settings: false, transcripts: false, flags: true, roster: true },
            };
            return {
                canAccessFlags: instructorWindow.hasPermissionForFeature('flags'),
                canAccessCourses: instructorWindow.hasPermissionForFeature('courses'),
            };
        });

        expect(access).toEqual({
            canAccessFlags: true,
            canAccessCourses: false,
        });
    });

    test('navigates TA courses link with selected course', async ({ page }) => {
        await openInstructorDocuments(page);

        await page.evaluate(() => {
            const instructorWindow = /** @type {InstructorWindow} */ (window);
            document.getElementById('ta-my-courses-link')?.remove();
            const link = document.createElement('a');
            link.id = 'ta-my-courses-link';
            link.href = '#';
            document.body.appendChild(link);
            localStorage.setItem('selectedCourseId', 'INSTRUCTOR-BRANCH-WINDOW');
            window.history.replaceState({}, '', '/instructor/settings');
            instructorWindow.setupTANavigationHandlers();
            link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        });

        await expect(page).toHaveURL(/\/instructor\/documents\?courseId=INSTRUCTOR-BRANCH-WINDOW/);
    });

    test('navigates TA support link with selected course', async ({ page }) => {
        await openInstructorDocuments(page);

        await page.evaluate(() => {
            const instructorWindow = /** @type {InstructorWindow} */ (window);
            document.getElementById('ta-student-support-link')?.remove();
            const link = document.createElement('a');
            link.id = 'ta-student-support-link';
            link.href = '#';
            document.body.appendChild(link);
            localStorage.setItem('selectedCourseId', 'INSTRUCTOR-BRANCH-WINDOW');
            instructorWindow.setupTANavigationHandlers();
            link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        });

        await expect(page).toHaveURL(/\/instructor\/flagged\?courseId=INSTRUCTOR-BRANCH-WINDOW/);
    });

    test('warns when TA support link is missing', async ({ page }) => {
        await openInstructorDocuments(page);

        const hasSupportLink = await page.evaluate(() => {
            const instructorWindow = /** @type {InstructorWindow} */ (window);
            document.getElementById('ta-student-support-link')?.remove();
            instructorWindow.setupTANavigationHandlers();
            return Boolean(document.getElementById('ta-student-support-link'));
        });

        expect(hasSupportLink).toBe(false);
    });

    test('alerts when TA support has no selected course', async ({ page }) => {
        await openInstructorDocuments(page, {
            controls: {
                taCourses: [],
                taPermissions: { materials: true, questions: true, settings: true, transcripts: true, flags: true, roster: true },
            },
        });

        let alertMessage = '';
        page.on('dialog', async (dialog) => {
            alertMessage = dialog.message();
            await dialog.accept();
        });

        await page.evaluate(async () => {
            const instructorWindow = /** @type {InstructorWindow} */ (window);
            const testWindow = /** @type {any} */ (window);
            if (!document.getElementById('ta-student-support-link')) {
                const link = document.createElement('a');
                link.id = 'ta-student-support-link';
                link.href = '#';
                document.body.appendChild(link);
            }
            instructorWindow.setupTANavigationHandlers();
            window.history.replaceState({}, '', '/instructor/documents');
            localStorage.removeItem('selectedCourseId');
            testWindow.taCourses = [];
            testWindow.getCurrentCourseId = async () => null;
            document.getElementById('ta-student-support-link')?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            await new Promise((resolve) => setTimeout(resolve, 0));
        });

        expect(alertMessage).toBe('No course selected. Please try again.');
    });

    test('loads an accessible selected course from localStorage when URL has no course', async ({ page }) => {
        await openInstructorScriptHarness(page, {
            selectedCourseId: COURSE_ID,
        });
        const selectedCourse = await page.evaluate(async () => {
            const instructorWindow = /** @type {InstructorWindow} */ (window);
            window.history.replaceState({}, '', '/instructor/branch-harness');
            return instructorWindow.getCurrentCourseId();
        });

        expect(selectedCourse).toBe(COURSE_ID);
    });

    test('replaces a stale stored course before instructor settings loaders can use it', async ({ page }) => {
        await openInstructorScriptHarness(page, {
            selectedCourseId: 'STALE-COURSE-FROM-ANOTHER-USER',
            controls: {
                instructorCourses: [branchCourse({ courseId: COURSE_ID })],
            },
        });

        const result = await page.evaluate(async () => {
            const instructorWindow = /** @type {InstructorWindow} */ (window);
            window.history.replaceState({}, '', '/instructor/settings');
            const resolvedCourseId = await instructorWindow.getCurrentCourseId();
            return {
                resolvedCourseId,
                storedCourseId: localStorage.getItem('selectedCourseId'),
            };
        });

        expect(result).toEqual({
            resolvedCourseId: COURSE_ID,
            storedCourseId: COURSE_ID,
        });
    });

    test('waits for auth when the instructor id is initially unavailable', async ({ page }) => {
        await openInstructorScriptHarness(page, {
            controls: {
                instructorCourses: [branchCourse({ courseId: 'AUTH-WAIT-COURSE' })],
            },
        });

        const selectedCourse = await page.evaluate(async () => {
            const instructorWindow = /** @type {InstructorWindow} */ (window);
            const testWindow = /** @type {any} */ (window);
            let authReady = false;
            window.history.replaceState({}, '', '/instructor/branch-harness');
            localStorage.removeItem('selectedCourseId');
            testWindow.getCurrentUser = () => (authReady ? { userId: 'e2e_instructor_id', preferences: {} } : null);
            testWindow.getCurrentInstructorId = () => (authReady ? 'e2e_instructor_id' : null);
            setTimeout(() => {
                authReady = true;
                document.dispatchEvent(new CustomEvent('auth:ready'));
            }, 0);
            return instructorWindow.getCurrentCourseId();
        });

        expect(selectedCourse).toBe('AUTH-WAIT-COURSE');
    });

    test('returns null when no user id is available after waiting for auth', async ({ page }) => {
        await openInstructorScriptHarness(page);

        const selectedCourse = await page.evaluate(async () => {
            const instructorWindow = /** @type {InstructorWindow} */ (window);
            const testWindow = /** @type {any} */ (window);
            window.history.replaceState({}, '', '/instructor/branch-harness');
            localStorage.removeItem('selectedCourseId');
            testWindow.getCurrentUser = () => null;
            testWindow.getCurrentInstructorId = () => null;
            setTimeout(() => document.dispatchEvent(new CustomEvent('auth:ready')), 0);
            return instructorWindow.getCurrentCourseId();
        });

        expect(selectedCourse).toBeNull();
        await expect(page).toHaveURL(/\/instructor\/branch-harness/);
    });

    test('returns the first TA course from the result.data course list', async ({ page }) => {
        await openInstructorScriptHarness(page, {
            controls: {
                taCourses: [
                    { courseId: 'TA-DATA-COURSE', courseName: 'TA Data Course' },
                    { courseId: 'TA-SECOND-COURSE', courseName: 'TA Second Course' },
                ],
            },
        });

        const selectedCourse = await page.evaluate(async () => {
            const instructorWindow = /** @type {InstructorWindow} */ (window);
            const testWindow = /** @type {any} */ (window);
            window.history.replaceState({}, '', '/instructor/branch-harness');
            localStorage.removeItem('selectedCourseId');
            testWindow.isTA = () => true;
            testWindow.getCurrentInstructorId = () => 'e2e_ta_id';
            return instructorWindow.getCurrentCourseId();
        });

        expect(selectedCourse).toBe('TA-DATA-COURSE');
    });

    test('returns the first instructor course from the result.data.courses shape', async ({ page }) => {
        await openInstructorScriptHarness(page, {
            controls: {
                instructorCourses: [
                    branchCourse({ courseId: 'INSTRUCTOR-DATA-COURSE' }),
                    branchCourse({ courseId: 'INSTRUCTOR-SECOND-COURSE' }),
                ],
            },
        });

        const selectedCourse = await page.evaluate(async () => {
            const instructorWindow = /** @type {InstructorWindow} */ (window);
            const testWindow = /** @type {any} */ (window);
            window.history.replaceState({}, '', '/instructor/branch-harness');
            localStorage.removeItem('selectedCourseId');
            testWindow.isTA = () => false;
            testWindow.getCurrentInstructorId = () => 'e2e_instructor_id';
            return instructorWindow.getCurrentCourseId();
        });

        expect(selectedCourse).toBe('INSTRUCTOR-DATA-COURSE');
    });

    test('falls back to user preference course when no courses are returned', async ({ page }) => {
        await openInstructorScriptHarness(page, {
            controls: { instructorCourses: [] },
        });

        const selectedCourse = await page.evaluate(async () => {
            const instructorWindow = /** @type {InstructorWindow} */ (window);
            const testWindow = /** @type {any} */ (window);
            window.history.replaceState({}, '', '/instructor/branch-harness');
            localStorage.removeItem('selectedCourseId');
            testWindow.getCurrentUser = () => ({ preferences: { courseId: 'PREFERENCE-COURSE' } });
            testWindow.getCurrentInstructorId = () => 'e2e_instructor_id';
            return instructorWindow.getCurrentCourseId();
        });

        expect(selectedCourse).toBe('PREFERENCE-COURSE');
    });

    test('schedules onboarding redirect when course lookup fails', async ({ page }) => {
        await openInstructorScriptHarness(page, {
            controls: {
                instructorCoursesStatus: 500,
            },
        });

        const outcome = await page.evaluate(async () => {
            const instructorWindow = /** @type {InstructorWindow} */ (window);
            const testWindow = /** @type {any} */ (window);
            const originalSetTimeout = window.setTimeout;
            let redirectDelay = null;
            testWindow.setTimeout = (handler, timeout, ...args) => {
                if (typeof handler === 'function' && timeout === 2000) {
                    redirectDelay = timeout;
                    return 1;
                }
                return originalSetTimeout(handler, timeout, ...args);
            };
            window.history.replaceState({}, '', '/instructor/branch-harness');
            localStorage.removeItem('selectedCourseId');
            testWindow.getCurrentUser = () => ({ preferences: {} });
            testWindow.getCurrentInstructorId = () => 'e2e_instructor_id';
            const courseId = await instructorWindow.getCurrentCourseId();
            testWindow.setTimeout = originalSetTimeout;
            return {
                courseId,
                redirectDelay,
                notification: document.querySelector('.notification')?.textContent,
            };
        });

        expect(outcome).toMatchObject({
            courseId: null,
            redirectDelay: 2000,
        });
        expect(outcome.notification).toContain('No course found. Please complete onboarding first.');
    });

    test('schedules onboarding redirect when course lookup rejects', async ({ page }) => {
        await openInstructorScriptHarness(page, {
            controls: {
                instructorCoursesMode: 'network-error',
            },
        });

        const outcome = await page.evaluate(async () => {
            const instructorWindow = /** @type {InstructorWindow} */ (window);
            const testWindow = /** @type {any} */ (window);
            const originalSetTimeout = window.setTimeout;
            let redirectDelay = null;
            testWindow.setTimeout = (handler, timeout, ...args) => {
                if (typeof handler === 'function' && timeout === 2000) {
                    redirectDelay = timeout;
                    return 1;
                }
                return originalSetTimeout(handler, timeout, ...args);
            };
            window.history.replaceState({}, '', '/instructor/branch-harness');
            localStorage.removeItem('selectedCourseId');
            testWindow.getCurrentUser = () => ({ preferences: {} });
            testWindow.getCurrentInstructorId = () => 'e2e_instructor_id';
            const courseId = await instructorWindow.getCurrentCourseId();
            testWindow.setTimeout = originalSetTimeout;
            return {
                courseId,
                redirectDelay,
                notification: document.querySelector('.notification')?.textContent,
            };
        });

        expect(outcome).toMatchObject({
            courseId: null,
            redirectDelay: 2000,
        });
        expect(outcome.notification).toContain('No course found. Please complete onboarding first.');
    });
});
