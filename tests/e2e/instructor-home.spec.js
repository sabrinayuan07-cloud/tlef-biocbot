// @ts-check
require('dotenv').config();
const { MongoClient } = require('mongodb');
const { test, expect } = require('./fixtures/monocart');
const { TEST_USERS, storageStatePath } = require('./helpers/users');

const INSTRUCTOR_COURSES = [
    {
        courseId: 'HOME-E2E-ALPHA',
        courseName: 'Alpha Home Biology',
        courseCode: 'ALPHASTU',
        instructorCourseCode: 'ALPHAINS',
    },
    {
        courseId: 'HOME-E2E-BETA',
        courseName: 'Beta Home Biology',
        courseCode: 'BETASTU',
        instructorCourseCode: 'BETAINS',
    },
];

async function withDb(fn) {
    if (!process.env.MONGO_URI) {
        throw new Error('MONGO_URI not set; cannot run instructor home tests.');
    }

    const client = new MongoClient(process.env.MONGO_URI);
    await client.connect();
    try {
        return await fn(client.db());
    } finally {
        await client.close();
    }
}

async function getUserByUsername(username) {
    return withDb(async (db) => {
        const user = await db.collection('users').findOne({ username });
        if (!user) throw new Error(`User ${username} not found in DB.`);
        return user;
    });
}

function completeLecture(name) {
    const now = new Date();
    return {
        name,
        isPublished: true,
        learningObjectives: [`Understand ${name}`],
        passThreshold: 70,
        createdAt: now,
        updatedAt: now,
        documents: [
            { documentId: `${name}-notes`, fileName: `${name} notes.pdf`, documentType: 'lecture-notes' },
            { documentId: `${name}-practice`, fileName: `${name} practice.pdf`, documentType: 'practice-quiz' },
        ],
        assessmentQuestions: [],
    };
}

function courseDoc(base, instructorId, fixedNow) {
    // Caller may pass a shared timestamp so Alpha and Beta land on identical
    // createdAt/updatedAt — the server's sortCoursesWithInactiveLast tie-breaks
    // by courseName, giving Alpha the deterministic first slot the tests rely on.
    const now = fixedNow instanceof Date ? fixedNow : new Date();
    return {
        ...base,
        instructorId,
        instructors: [instructorId],
        tas: [],
        courseDescription: '',
        assessmentCriteria: '',
        courseMaterials: [],
        approvedStruggleTopics: [
            { topic: 'cell membranes', source: 'manual', unitId: 'Unit 1' },
        ],
        courseStructure: { weeks: 1, lecturesPerWeek: 1, totalUnits: 1 },
        isOnboardingComplete: true,
        status: 'active',
        lectures: [completeLecture('Unit 1')],
        createdAt: now,
        updatedAt: now,
    };
}

function chatSession(courseId, sessionId, studentId, mode, start, end) {
    return {
        sessionId,
        courseId,
        studentId,
        studentName: studentId,
        chatData: {
            metadata: { currentMode: mode },
            messages: [
                { type: 'user', content: 'What is diffusion?', timestamp: start.toISOString() },
                { type: 'bot', content: 'Diffusion is passive movement.', timestamp: end.toISOString() },
            ],
        },
        createdAt: start,
        updatedAt: end,
    };
}

async function seedInstructorHomeCourses() {
    const instructor = await getUserByUsername(TEST_USERS.instructor.username);
    const now = new Date();
    const oneMinuteLater = new Date(now.getTime() + 60_000);
    const twoMinutesLater = new Date(now.getTime() + 120_000);

    await withDb(async (db) => {
        await db.collection('courses').deleteMany({
            $or: [
                { instructorId: instructor.userId },
                { instructors: instructor.userId },
            ],
        });
        await db.collection('chat_sessions').deleteMany({
            courseId: { $in: INSTRUCTOR_COURSES.map((course) => course.courseId) },
        });
        await db.collection('users').updateOne(
            { userId: instructor.userId },
            { $set: { 'preferences.courseId': null } }
        );
        const seedTime = new Date();
        await db.collection('courses').insertMany(
            INSTRUCTOR_COURSES.map((course) => courseDoc(course, instructor.userId, seedTime))
        );
        await db.collection('chat_sessions').insertMany([
            chatSession('HOME-E2E-ALPHA', 'home-alpha-1', 'alpha-student', 'tutor', now, oneMinuteLater),
            chatSession('HOME-E2E-BETA', 'home-beta-1', 'beta-student-1', 'tutor', now, oneMinuteLater),
            chatSession('HOME-E2E-BETA', 'home-beta-2', 'beta-student-2', 'protege', now, twoMinutesLater),
        ]);
    });
}

async function removeInstructorCourses(username) {
    const user = await getUserByUsername(username);
    await withDb(async (db) => {
        await db.collection('courses').deleteMany({
            $or: [
                { instructorId: user.userId },
                { instructors: user.userId },
            ],
        });
        await db.collection('chat_sessions').deleteMany({
            courseId: /^HOME-E2E-/,
        });
        await db.collection('users').updateOne(
            { userId: user.userId },
            { $set: { 'preferences.courseId': null } }
        );
    });
}

async function gotoInstructorHome(page, selectedCourseId = null) {
    await page.addInitScript((courseId) => {
        if (courseId) {
            window.localStorage.setItem('selectedCourseId', courseId);
        } else {
            window.localStorage.removeItem('selectedCourseId');
        }
    }, selectedCourseId);
    await page.goto('/instructor/home');
}

async function mockRichHomeEndpoints(page, { anonymize = false } = {}) {
    let approvedTopics = [
        {
            topic: 'cell membranes',
            source: 'manual',
            unitId: 'Unit 1',
            createdAt: '2026-05-01T00:00:00.000Z',
        },
    ];

    await page.route('**/chart.umd.min.js', (route) =>
        route.fulfill({
            status: 200,
            contentType: 'application/javascript',
            body: `
                window.Chart = class {
                    constructor(_canvas, config) {
                        window.__lastWeeklyChartConfig = config;
                    }
                    destroy() {
                        window.__chartDestroyed = true;
                    }
                };
            `,
        })
    );

    await page.addInitScript(() => {
        const testWindow = /** @type {Window & typeof globalThis & { __createdObjectUrls: Array<{ type: string, size: number }> }} */ (window);
        testWindow.__createdObjectUrls = [];
        const originalCreateObjectURL = URL.createObjectURL.bind(URL);
        URL.createObjectURL = (blob) => {
            testWindow.__createdObjectUrls.push({
                type: blob instanceof Blob ? blob.type : '',
                size: blob instanceof Blob ? blob.size : 0,
            });
            return originalCreateObjectURL(blob);
        };
    });

    await page.route('**/api/settings/anonymize-students?courseId=HOME-E2E-ALPHA', (route) =>
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ success: true, enabled: anonymize }),
        })
    );

    await page.route(/\/api\/courses\/HOME-E2E-ALPHA\/students$/, (route) =>
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                success: true,
                data: {
                    students: [
                        {
                            userId: 'student-1',
                            displayName: 'Alice <script>',
                            struggleState: {
                                topics: [
                                    { topic: 'cell membranes', isActive: true },
                                    { topic: 'osmosis', isActive: false },
                                ],
                            },
                        },
                        {
                            userId: 'student-2',
                            displayName: 'Blair',
                            struggleState: {
                                topics: [{ topic: 'Cell Membranes', isActive: true }],
                            },
                        },
                    ],
                },
            }),
        })
    );

    await page.route(/\/api\/struggle-activity\/HOME-E2E-ALPHA\?limit=100$/, (route) =>
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                success: true,
                data: [
                    {
                        timestamp: '2026-05-13T18:00:00.000Z',
                        studentName: 'Alice "A"',
                        topic: 'cell membranes',
                        state: 'Active',
                    },
                    {
                        timestamp: '2026-05-13T18:05:00.000Z',
                        studentName: 'Blair',
                        topic: 'osmosis',
                        state: 'Inactive',
                    },
                ],
            }),
        })
    );

    await page.route(/\/api\/struggle-activity\/weekly\/HOME-E2E-ALPHA.*/, (route) =>
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                success: true,
                data: [
                    {
                        weekStart: '2026-05-04T00:00:00.000Z',
                        topics: [{ topic: 'cell membranes', studentCount: 1 }],
                        totalCount: 1,
                    },
                    {
                        weekStart: '2026-05-11T00:00:00.000Z',
                        topics: [
                            { topic: 'cell membranes', studentCount: 2 },
                            { topic: 'osmosis', studentCount: 1 },
                        ],
                        totalCount: 3,
                    },
                ],
            }),
        })
    );

    await page.route(/\/api\/struggle-activity\/persistence\/HOME-E2E-ALPHA$/, (route) =>
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                success: true,
                data: [
                    { topic: 'osmosis', studentCount: 12 },
                    { topic: 'cell membranes', studentCount: 6 },
                ],
            }),
        })
    );

    await page.route(/\/api\/courses\/HOME-E2E-ALPHA\/approved-topics$/, async (route) => {
        if (route.request().method() === 'PUT') {
            const body = route.request().postDataJSON();
            approvedTopics = Array.isArray(body.topics) ? body.topics : [];
            return route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({ success: true, data: { topics: approvedTopics } }),
            });
        }

        return route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                success: true,
                data: {
                    topics: approvedTopics,
                },
            }),
        });
    });

    await page.route(/\/api\/courses\/HOME-E2E-ALPHA\/approved-topics\/unit$/, async (route) => {
        const { topic, unitId } = route.request().postDataJSON();
        approvedTopics = approvedTopics.map((approvedTopic) =>
            approvedTopic.topic?.toLowerCase() === topic?.toLowerCase()
                ? { ...approvedTopic, unitId: unitId || null }
                : approvedTopic
        );
        return route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                success: true,
                data: {
                    topics: approvedTopics,
                },
            }),
        });
    });

    return {
        setApprovedTopics(topics) {
            approvedTopics = Array.isArray(topics) ? topics : [];
        },
    };
}

test.describe('Instructor home dashboard', () => {
    test.use({ storageState: storageStatePath('instructor') });

    test.beforeEach(async () => {
        await seedInstructorHomeCourses();
    });

    // Prevent HOME-E2E-* courses from leaking into other spec files (e.g.
    // instructor-onboarding's joinable-dropdown assertions) when the full
    // suite is run end-to-end (as in CI). seedInstructorHomeCourses inserts
    // these on every beforeEach but never removes them.
    test.afterAll(async () => {
        await removeInstructorCourses(TEST_USERS.instructor.username);
    });

    test('renders multiple instructor courses and reloads dashboard stats when selection changes', async ({ page }) => {
        await gotoInstructorHome(page);

        await expect(page.locator('#course-selection-container')).toBeVisible({ timeout: 15_000 });
        await expect(page.locator('#course-name-display')).toHaveText('Alpha Home Biology');
        await expect(page.locator('#student-course-code-display')).toHaveText('ALPHASTU');
        await expect(page.locator('#instructor-course-code-display')).toHaveText('ALPHAINS');
        await expect(page.locator('#statistics-section')).toBeVisible();
        await expect(page.locator('#stat-total-sessions')).toHaveText('1');

        await page.locator('#change-course-btn').click();
        await expect(page.locator('#course-selector')).toBeVisible();
        await expect(page.locator('#course-select-dropdown')).toContainText('Alpha Home Biology');
        await expect(page.locator('#course-select-dropdown')).toContainText('Beta Home Biology');

        await page.locator('#course-select-dropdown').selectOption('HOME-E2E-BETA');

        await expect(page.locator('#course-name-display')).toHaveText('Beta Home Biology');
        await expect(page.locator('#student-course-code-display')).toHaveText('BETASTU');
        await expect(page.locator('#instructor-course-code-display')).toHaveText('BETAINS');
        await expect(page).toHaveURL(/courseId=HOME-E2E-BETA/);
        await expect(page.locator('#stat-total-students')).toHaveText('2');
        await expect(page.locator('#stat-total-sessions')).toHaveText('2');
        await expect(page.locator('#view-flags-btn')).toHaveAttribute('href', '/instructor/flagged?courseId=HOME-E2E-BETA');
        await expect.poll(() => page.evaluate(() => window.localStorage.getItem('selectedCourseId')))
            .toBe('HOME-E2E-BETA');
    });

    test('does not use a stale unauthorized selected course from localStorage', async ({ page }) => {
        await gotoInstructorHome(page);
        await expect(page.locator('#course-name-display')).toHaveText('Alpha Home Biology', { timeout: 15_000 });
        await page.evaluate(() => {
            window.localStorage.setItem('selectedCourseId', 'HOME-E2E-NOT-OWNED');
            window.history.replaceState({}, '', '/instructor/home');
        });

        /** @type {string[]} */
        const staleCourseRequests = [];
        page.on('request', (request) => {
            const url = new URL(request.url());
            if (url.pathname.startsWith('/api/') && request.url().includes('HOME-E2E-NOT-OWNED')) {
                staleCourseRequests.push(`${url.pathname}${url.search}`);
            }
        });

        await page.goto('/instructor/home');

        await expect(page.locator('#course-name-display')).toHaveText('Alpha Home Biology', { timeout: 15_000 });
        await expect(page).not.toHaveURL(/HOME-E2E-NOT-OWNED/);
        await expect(page.locator('#course-select-dropdown')).toContainText('Alpha Home Biology');
        expect(staleCourseRequests, 'stale localStorage course ID should not drive instructor API requests')
            .toEqual([]);
        await expect.poll(() => page.evaluate(() => window.localStorage.getItem('selectedCourseId')))
            .toBe('HOME-E2E-ALPHA');
    });

    test('keeps selected course visible but hides statistics when the statistics API fails', async ({ page }) => {
        await page.route('**/api/courses/statistics**', (route) =>
            route.fulfill({
                status: 500,
                contentType: 'application/json',
                body: JSON.stringify({ success: false, message: 'forced stats failure' }),
            })
        );

        await page.goto('/instructor/home?courseId=HOME-E2E-ALPHA');
        await expect(page.locator('#course-name-display')).toHaveText('Alpha Home Biology', { timeout: 15_000 });
        await expect(page.locator('#statistics-section')).toBeHidden();
        await expect(page.locator('#view-flags-btn')).toHaveAttribute('href', '/instructor/flagged?courseId=HOME-E2E-ALPHA');
    });

    test('renders struggle panels, weekly chart, CSV export, and approved topic unit assignment', async ({ page }) => {
        // The weekly fixture ends on May 11. Pin the browser clock so the
        // production chart's gap-filling-through-today behavior does not move
        // the fixture off the most-recent eight-week page as real time passes.
        await page.clock.setFixedTime(new Date('2026-05-17T12:00:00.000Z'));
        const homeMock = await mockRichHomeEndpoints(page, { anonymize: true });

        await page.goto('/instructor/home?courseId=HOME-E2E-ALPHA');

        await expect(page.locator('#struggle-topics-section')).toBeVisible({ timeout: 15_000 });
        await expect(page.locator('#struggle-topics-content')).toContainText('Cell membranes');
        await expect(page.locator('#struggle-topics-content')).toContainText('2 students (2 active)');
        await expect(page.locator('#struggle-topics-content')).toContainText('Student');
        await expect(page.locator('#struggle-topics-content')).not.toContainText('Alice <script>');

        await expect(page.locator('#live-struggle-container')).toBeVisible();
        await expect(page.locator('#struggle-name-th')).toBeHidden();
        await expect(page.locator('#live-struggle-tbody')).toContainText('Cell membranes');
        await page.locator('#filter-active-only').check();
        await expect(page.locator('#live-struggle-tbody')).toContainText('Cell membranes');
        await expect(page.locator('#live-struggle-tbody')).not.toContainText('Osmosis');

        const csvDownload = page.waitForEvent('download');
        await page.locator('#download-csv-btn').click();
        expect((await csvDownload).suggestedFilename()).toMatch(/^struggle_activity_/);

        await expect(page.locator('#weekly-struggle-chart-container')).toBeVisible();
        await expect(page.locator('#chart-next-weeks')).toBeDisabled();
        await expect.poll(() => page.evaluate(() => {
            const testWindow = /** @type {Window & typeof globalThis & { __lastWeeklyChartConfig?: { data?: { datasets?: unknown[] } } }} */ (window);
            return testWindow.__lastWeeklyChartConfig?.data?.datasets?.length;
        }))
            .toBe(2);
        // The chart renders an HTML tooltip (Chart.js `external`) instead of the
        // canvas-drawn one so long topic lists can scroll. Drive the handler with
        // a synthetic Chart.js tooltip model and assert what it puts in the DOM.
        const tooltipState = await page.evaluate(() => {
            const testWindow = /** @type {any} */ (window);
            const tooltipConfig = testWindow.__lastWeeklyChartConfig?.options?.plugins?.tooltip;
            const canvas = document.getElementById('weekly-struggle-chart');
            if (!tooltipConfig?.external || !canvas) {
                throw new Error('Weekly chart external tooltip handler was not configured');
            }

            tooltipConfig.external({
                chart: { canvas },
                tooltip: {
                    opacity: 1,
                    caretX: 40,
                    caretY: 40,
                    title: [tooltipConfig.callbacks.title([{ label: 'May 11' }])],
                    labelColors: [
                        { backgroundColor: '#dc3545' },
                        { backgroundColor: '#4a90e2' },
                        { backgroundColor: '#ffc107' },
                    ],
                    dataPoints: [
                        { dataset: { label: 'Osmosis', backgroundColor: '#dc3545' }, raw: 1, formattedValue: '1' },
                        { dataset: { label: 'Cell membranes', backgroundColor: '#4a90e2' }, raw: 2, formattedValue: '2' },
                        { dataset: { label: 'Photosynthesis', backgroundColor: '#ffc107' }, raw: 0, formattedValue: '0' },
                    ],
                },
            });

            const tooltip = document.querySelector('.chart-tooltip');
            const body = tooltip?.querySelector('.chart-tooltip-body');
            if (!tooltip || !body) {
                throw new Error('External tooltip handler did not render a tooltip');
            }

            return {
                canvasTooltipEnabled: tooltipConfig.enabled,
                title: tooltip.querySelector('.chart-tooltip-title')?.textContent,
                rows: Array.from(body.querySelectorAll('.chart-tooltip-row')).map((row) => row.textContent),
                footer: tooltip.querySelector('.chart-tooltip-footer')?.textContent,
                bodyOverflowY: getComputedStyle(body).overflowY,
            };
        });
        expect(tooltipState.canvasTooltipEnabled).toBe(false);
        expect(tooltipState.title).toBe('Week of May 11');
        // Zero-count topics are dropped and the rest are sorted busiest-first.
        expect(tooltipState.rows).toEqual(['Cell membranes: 2', 'Osmosis: 1']);
        expect(tooltipState.footer).toBe('Total active: 3 students');
        expect(tooltipState.bodyOverflowY).toBe('auto');
        await page.locator('#chart-prev-weeks').dispatchEvent('click');
        await page.locator('#chart-next-weeks').dispatchEvent('click');

        await expect(page.locator('#approved-topics-section')).toBeVisible();
        await expect(page.locator('#approved-topics-content')).toContainText('cell membranes');

        // The DOM showing "cell membranes" doesn't guarantee the JS global
        // (window.courseApprovedTopicDetails) the duplicate-check reads has
        // been populated — multiple async paths render this section.
        const hasCellMembranesInGlobal = () =>
            Array.isArray(/** @type {any} */ (window).courseApprovedTopicDetails)
            && /** @type {any} */ (window).courseApprovedTopicDetails.some(
                (/** @type {any} */ t) => t && typeof t.topic === 'string' && t.topic.toLowerCase() === 'cell membranes'
            );
        await page.waitForFunction(hasCellMembranesInGlobal);

        // Keep the duplicate setup and addApprovedTopic() call in one browser
        // turn. This page has overlapping mocked loaders that can refresh
        // window.courseApprovedTopicDetails between separate Playwright
        // operations; the behavior under test is the duplicate guard, so set
        // that guard's state directly before invoking it.
        await page.evaluate(async () => {
            const input = /** @type {HTMLInputElement|null} */ (document.getElementById('new-topic-input'));
            if (!input) {
                throw new Error('Approved-topic input was not rendered before duplicate check');
            }
            const topics = [{ topic: 'cell membranes', source: 'manual', unitId: 'Unit 1' }];
            /** @type {any} */ (window).setApprovedTopicGlobals?.('HOME-E2E-ALPHA', topics);
            if (!/** @type {any} */ (window).courseApprovedTopicDetails) {
                /** @type {any} */ (window).courseApprovedTopicDetails = topics;
                /** @type {any} */ (window).courseApprovedTopics = topics.map((topic) => topic.topic);
            }
            input.value = 'cell membranes';
            input.dispatchEvent(new Event('input', { bubbles: true }));
            await /** @type {any} */ (window).addApprovedTopic();
        });
        await expect(page.locator('.notification.error')).toContainText('This topic already exists.', { timeout: 10_000 });

        await page.evaluate(async () => {
            const input = /** @type {HTMLInputElement|null} */ (document.getElementById('new-topic-input'));
            const unitSelect = /** @type {HTMLSelectElement|null} */ (document.getElementById('new-topic-unit-select'));
            if (!input || !unitSelect) {
                throw new Error('Approved-topic form was not rendered before addApprovedTopic()');
            }
            input.value = 'osmosis';
            input.dispatchEvent(new Event('input', { bubbles: true }));
            unitSelect.value = 'Unit 1';
            unitSelect.dispatchEvent(new Event('change', { bubbles: true }));
            await /** @type {any} */ (window).addApprovedTopic();
        });
        await expect(page.locator('.notification.success', { hasText: 'Added topic "osmosis"' })).toBeVisible();

        const approvedTopicsWithOsmosis = [
            { topic: 'cell membranes', source: 'manual', unitId: 'Unit 1' },
            { topic: 'osmosis', source: 'manual', unitId: 'Unit 1' },
        ];
        homeMock.setApprovedTopics(approvedTopicsWithOsmosis);
        await page.evaluate((topics) => {
            /** @type {any} */ (window).setApprovedTopicGlobals('HOME-E2E-ALPHA', topics);
            /** @type {any} */ (window).renderApprovedGlobalTopics(topics, 'HOME-E2E-ALPHA');
        }, approvedTopicsWithOsmosis);
        await expect(page.locator('#approved-topics-content')).toContainText('osmosis');

        // Edit-topic flow. startEditTopic swaps the chip label for a transient
        // <input>, and commitEditTopic/cancelEditTopic call
        // renderApprovedGlobalTopics which rebuilds the chip container's
        // innerHTML. This page also has overlapping mocked loaders that can
        // re-render the section between separate Playwright operations; under
        // load one of them fires between `startEditTopic` and a follow-up
        // `.fill()`/`.press()`, permanently detaching the edit input so the next
        // step waits out the full timeout. Drive each edit — start, type, and
        // the real keydown handler — in a single browser turn so no async
        // re-render can interleave mid-edit. The assertions afterwards still
        // exercise the resulting re-render.
        //
        // Escape cancels the edit: the value reverts to 'cell membranes'.
        await page.evaluate(() => {
            const label = document.querySelector('.approved-topic-chip[data-topic="cell membranes"] .topic-chip-label');
            if (!label) throw new Error('cell membranes topic label not found before edit (escape)');
            /** @type {any} */ (window).startEditTopic(label);
            const input = /** @type {HTMLInputElement|null} */ (document.querySelector('.topic-chip-edit-input'));
            if (!input) throw new Error('edit input not rendered before escape');
            input.value = 'cell transport';
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        });
        await expect(page.locator('#approved-topics-content')).toContainText('cell membranes');

        // Enter commits the edit: the value becomes 'cell transport'.
        await page.evaluate(() => {
            const label = document.querySelector('.approved-topic-chip[data-topic="cell membranes"] .topic-chip-label');
            if (!label) throw new Error('cell membranes topic label not found before edit (enter)');
            /** @type {any} */ (window).startEditTopic(label);
            const input = /** @type {HTMLInputElement|null} */ (document.querySelector('.topic-chip-edit-input'));
            if (!input) throw new Error('edit input not rendered before enter');
            input.value = 'cell transport';
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        });
        await expect(page.locator('#approved-topics-content')).toContainText('cell transport');

        await expect(page.locator('#persistence-topics-section')).toBeVisible();
        const txtDownload = page.waitForEvent('download');
        await page.locator('#download-persistence-topics-btn').click();
        expect((await txtDownload).suggestedFilename()).toMatch(/Alpha_Home_Biology_cumulative_topics\.txt/);

        await page.locator('.persistence-topic-card[data-topic="osmosis"]').evaluate(el => /** @type {HTMLElement} */ (el).click());
        await expect(page.locator('#topic-unit-assignment-modal')).toHaveClass(/show/);
        await page.locator('#topic-unit-select').selectOption('');
        await page.locator('#topic-unit-save-btn').click();
        await expect(page.locator('#topic-unit-assignment-modal')).not.toHaveClass(/show/);

        page.once('dialog', (dialog) => dialog.accept());
        await page.locator('.topic-chip-remove').first().click();
        await expect(page.locator('.notification.success', { hasText: 'Removed topic' })).toBeVisible();

        // Normalize the starting state and fire the inline handler in the
        // same browser turn. This avoids asserting the wrong side of
        // classList.toggle() if previous DOM churn left the item collapsed.
        const topicCollapsed = await page.locator('.struggle-topic-item').first().evaluate(item => {
            item.classList.remove('collapsed');
            const header = /** @type {HTMLElement|null} */ (item.querySelector('.topic-header'));
            /** @type {any} */ (window).toggleTopic(header);
            return item.classList.contains('collapsed');
        });
        expect(topicCollapsed).toBe(true);
        const sectionCollapsed = await page.locator('#approved-topics-section').evaluate(section => {
            section.classList.remove('section-collapsed');
            /** @type {HTMLElement|null} */ (section.querySelector('.section-header'))?.click();
            return section.classList.contains('section-collapsed');
        });
        expect(sectionCollapsed).toBe(true);
    });

    test('validates instructor course-code joins and recovers after an API error', async ({ page }) => {
        let joinAttempts = 0;

        await page.route('**/api/courses/available/joinable', (route) =>
            route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    success: true,
                    data: [
                        {
                            courseId: 'HOME-E2E-JOIN',
                            courseName: 'Joinable Home Biology',
                            status: 'active',
                        },
                    ],
                }),
            })
        );
        await page.route(/\/api\/courses\/HOME-E2E-JOIN$/, (route) =>
            route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    success: true,
                    data: {
                        courseId: 'HOME-E2E-JOIN',
                        courseName: 'Joinable Home Biology',
                        courseCode: 'JOINSTU',
                        instructorCourseCode: 'JOININS',
                        status: 'active',
                        approvedStruggleTopics: [],
                        lectures: [completeLecture('Unit 1')],
                    },
                }),
            })
        );
        await page.route(/\/api\/courses\/HOME-E2E-JOIN\/instructors$/, async (route) => {
            joinAttempts += 1;
            const body = route.request().postDataJSON();
            if (body.code !== 'JOININS') {
                return route.fulfill({
                    status: 403,
                    contentType: 'application/json',
                    body: JSON.stringify({ success: false, message: 'Invalid instructor course code' }),
                });
            }
            return route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({ success: true, data: { courseId: 'HOME-E2E-JOIN' } }),
            });
        });

        await page.goto('/instructor/home?courseId=HOME-E2E-ALPHA');
        await expect(page.locator('#course-name-display')).toHaveText('Alpha Home Biology', { timeout: 15_000 });

        await page.locator('#change-course-btn').click();
        await page.locator('#join-course-select-dropdown').selectOption('HOME-E2E-JOIN');
        await expect(page.locator('#selected-course-details')).toBeVisible();
        await expect(page.locator('#instructor-code-entry-group')).toBeVisible();

        // Use programmatic clicks (evaluate(el => el.click())) through this
        // flow. The join button and course-code input carry a 0.28s
        // .field-error-shake animation after a failed attempt, which can block
        // the click actionability check's stability requirement.
        await page.locator('#join-course-btn').evaluate(el => /** @type {HTMLElement} */ (el).click());
        await expect(page.locator('#instructor-course-code-feedback')).toContainText('Instructor course code is required');
        await expect(page.locator('#instructor-course-code-input')).toHaveAttribute('aria-invalid', 'true');

        await page.locator('#instructor-course-code-input').fill('WRONG');
        await page.locator('#join-course-btn').evaluate(el => /** @type {HTMLElement} */ (el).click());
        await expect(page.locator('#instructor-course-code-feedback')).toContainText('Invalid instructor course code');
        await expect(page.locator('#join-course-btn')).toBeEnabled();

        // This fill used to time out with "element is not visible": the home
        // page initialized twice (auth:ready plus its 500ms fallback timer), and
        // the second init's setSelectedCourse() -> hideCourseSelector() closed
        // the whole course selector mid-test. public/instructor/scripts/home.js
        // now guards against the double init, so a plain fill is deterministic.
        await page.locator('#instructor-course-code-input').fill('JOININS');
        await page.locator('#join-course-btn').evaluate(el => /** @type {HTMLElement} */ (el).click());
        await expect(page.locator('#course-name-display')).toHaveText('Joinable Home Biology', { timeout: 15_000 });
        await expect(page.locator('#student-course-code-display')).toHaveText('JOINSTU');
        await expect(page.locator('.notification.success')).toContainText('Successfully joined the course!');
        expect(joinAttempts).toBe(2);
    });

    test('hides course codes and completion panels for malformed selected course payloads', async ({ page }) => {
        await page.route(/\/api\/courses\/HOME-E2E-ALPHA$/, (route) =>
            route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    success: true,
                    data: {
                        courseId: 'HOME-E2E-ALPHA',
                        courseName: 'Malformed Home Biology',
                        status: 'active',
                    },
                }),
            })
        );
        await page.route('**/api/courses/statistics**', (route) =>
            route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    success: true,
                    data: {
                        totalStudents: 0,
                        totalSessions: 0,
                        modeDistribution: { tutor: 0, protege: 0 },
                        averageSessionLength: '0s',
                        averageMessageLength: 0,
                    },
                }),
            })
        );

        await page.goto('/instructor/home?courseId=HOME-E2E-ALPHA');

        await expect(page.locator('#course-name-display')).toHaveText('Malformed Home Biology', { timeout: 15_000 });
        await expect(page.locator('#student-course-code-label')).toBeHidden();
        await expect(page.locator('#instructor-course-code-label')).toBeHidden();
        await expect(page.locator('#statistics-section')).toBeHidden();
        await expect(page.locator('#missing-items-section')).toBeHidden();
        await expect(page.locator('#complete-section')).toBeHidden();
    });

    test('covers home dashboard helper fallbacks and recovery branches', async ({ page }) => {
        await mockRichHomeEndpoints(page);
        await page.goto('/instructor/home?courseId=HOME-E2E-ALPHA');
        await expect(page.locator('#course-name-display')).toHaveText('Alpha Home Biology', { timeout: 15_000 });

        const helperState = await page.evaluate(async () => {
            const testWindow = /** @type {any} */ (window);
            const notices = [];
            testWindow.showNotification = (message, type) => notices.push({ message, type });

            const missingItems = [
                {
                    courseId: 'HOME-E2E-ALPHA',
                    courseName: '<Alpha & Biology>',
                    unitName: 'Unit & 1',
                    missingItem: 'Lecture <Note>',
                },
                {
                    courseId: 'HOME-E2E-ALPHA',
                    courseName: '<Alpha & Biology>',
                    unitName: 'Unit & 1',
                    missingItem: 'Practice Question/Tutorial',
                },
            ];
            testWindow.displayMissingItems(missingItems);
            const missingHtml = document.getElementById('missing-items-list')?.innerHTML || '';

            testWindow.displayMissingItems([]);
            const completeDisplay = document.getElementById('complete-section')?.style.display;

            testWindow.showInfoMessage('Helper info notice');
            testWindow.showSuccessMessage('Helper success notice');
            // showInfoMessage/showSuccessMessage now delegate to the shared
            // showNotification() (#617) instead of a separate inline
            // implementation, so they go through the mock above like
            // everything else here - there's no real .notification.info
            // element to close in this test, hence trivially true. Actual
            // close-button rendering is covered by the shared
            // notifications.js's own test coverage.
            /** @type {HTMLButtonElement | null} */ (document.querySelector('.notification.info .notification-close'))?.click();
            const infoClosed = !document.querySelector('.notification.info');

            const labels = testWindow.getApprovedTopicLabels([
                'Photosynthesis',
                { topic: 'photosynthesis', unitId: 'None', source: '' },
                { topic: 'Respiration', unitId: 'Unit 2', source: 'generated' },
                { topic: '' },
                null,
            ]);

            // Struggle-table times keep PST / PDT before B.C.'s change and stay
            // on UTC-7 after it, even in browsers whose tz data predates 2026b.
            const ptTimes = [
                '2026-01-15T20:00:00Z',
                '2026-07-15T20:00:00Z',
                '2026-11-01T09:00:00Z',
                '2026-11-15T20:00:00Z',
            ].map((iso) => testWindow.formatTimestampPT(iso));

            testWindow.localStorage.setItem('selectedCourseId', 'HOME-E2E-ALPHA');
            testWindow.history.replaceState({}, '', '/instructor/home?courseId=HOME-E2E-ALPHA');
            testWindow.clearSelectedCourse();
            const selectedAfterClear = testWindow.localStorage.getItem('selectedCourseId');
            const urlAfterClear = testWindow.location.href;
            await testWindow.downloadPersistenceTopics();

            testWindow.localStorage.setItem('selectedCourseId', 'HOME-E2E-ALPHA');
            testWindow.history.replaceState({}, '', '/instructor/home?courseId=HOME-E2E-ALPHA');
            testWindow.persistenceTopics = [];
            await testWindow.downloadPersistenceTopics();

            const modal = testWindow.ensureTopicUnitAssignmentModal();
            modal.classList.add('show');
            modal.dataset.topic = 'Respiration';
            modal.querySelector('.topic-unit-modal-close')?.click();
            const closeButtonClosed = !modal.classList.contains('show') && modal.dataset.topic === '';
            modal.classList.add('show');
            modal.dataset.topic = 'Respiration';
            modal.querySelector('#topic-unit-cancel-btn')?.click();
            const cancelClosed = !modal.classList.contains('show') && modal.dataset.topic === '';
            modal.classList.add('show');
            modal.dataset.topic = 'Respiration';
            modal.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            const backdropClosed = !modal.classList.contains('show') && modal.dataset.topic === '';

            return {
                missingHtml,
                completeDisplay,
                infoClosed,
                labels,
                ptTimes,
                notices,
                selectedAfterClear,
                urlAfterClear,
                closeButtonClosed,
                cancelClosed,
                backdropClosed,
            };
        });

        expect(helperState.missingHtml).toContain('&lt;Alpha &amp; Biology&gt;');
        expect(helperState.missingHtml).toContain('Lecture &lt;Note&gt;, Practice Question/Tutorial');
        expect(helperState.completeDisplay).toBe('block');
        expect(helperState.infoClosed).toBe(true);
        expect(helperState.labels).toEqual(['Photosynthesis', 'Respiration']);
        expect(helperState.ptTimes).toEqual([
            'Jan 15, 2026, 12:00 PM',
            'Jul 15, 2026, 1:00 PM',
            'Nov 1, 2026, 2:00 AM',
            'Nov 15, 2026, 1:00 PM',
        ]);
        expect(helperState.notices).toEqual([
            // showInfoMessage/showSuccessMessage now delegate to the shared
            // showNotification() (#617), so they're captured by the mock
            // too - previously they used a separate inline implementation
            // invisible to it.
            { message: 'Helper info notice', type: 'info' },
            { message: 'Helper success notice', type: 'success' },
            { message: 'No course selected', type: 'error' },
            { message: 'No cumulative topics to download', type: 'info' },
        ]);
        expect(helperState.selectedAfterClear).toBeNull();
        expect(helperState.urlAfterClear).not.toContain('courseId=');
        expect(helperState.closeButtonClosed).toBe(true);
        expect(helperState.cancelClosed).toBe(true);
        expect(helperState.backdropClosed).toBe(true);

        await page.route('**/api/settings/can-delete-all', (route) => route.abort());
        await expect.poll(() => page.evaluate(() => {
            const testWindow = /** @type {any} */ (window);
            return testWindow.checkCourseCodeBypassPermission();
        })).toBe(false);

        await page.route('**/api/courses/available/all', (route) =>
            route.fulfill({ status: 500, contentType: 'application/json', body: '{}' })
        );
        await page.evaluate(() => {
            const testWindow = /** @type {any} */ (window);
            return testWindow.loadAvailableCourses();
        });
        await expect(page.locator('#course-select-dropdown')).toHaveText('Error loading courses');

        await page.route('**/api/courses/available/joinable', (route) =>
            route.fulfill({ status: 500, contentType: 'application/json', body: '{}' })
        );
        await page.evaluate(() => {
            const testWindow = /** @type {any} */ (window);
            return testWindow.loadJoinableCourses();
        });
        await expect(page.locator('#join-course-select-dropdown')).toHaveText('Error loading joinable courses');

        await page.route(/\/api\/courses\/HOME-E2E-INACCESSIBLE$/, (route) =>
            route.fulfill({
                status: 403,
                contentType: 'application/json',
                body: JSON.stringify({ success: false, message: 'Forbidden' }),
            })
        );
        await page.evaluate(() => {
            window.localStorage.setItem('selectedCourseId', 'HOME-E2E-INACCESSIBLE');
            window.history.replaceState({}, '', '/instructor/home');
            const testWindow = /** @type {any} */ (window);
            return testWindow.loadCurrentCourse();
        });
        // After the instructor-home stale-course fix, an unowned storage
        // courseId is intercepted by the owned-courses pre-check instead of
        // by a 403 from /api/courses/:id. The instructor still has Alpha &
        // Beta seeded, so loadCurrentCourse falls back to the first owned
        // course rather than dropping back to the course selector.
        await expect(page.locator('#course-name-display')).toHaveText('Alpha Home Biology', { timeout: 15_000 });
        await expect.poll(() => page.evaluate(() => window.localStorage.getItem('selectedCourseId')))
            .toBe('HOME-E2E-ALPHA');

        const taOnboarding = await page.evaluate(async () => {
            const testWindow = /** @type {any} */ (window);
            const originalIsTA = testWindow.isTA;
            const originalInstructor = testWindow.getCurrentInstructorId;
            const originalFetch = testWindow.authenticatedFetch;
            testWindow.isTA = () => true;
            testWindow.getCurrentInstructorId = () => 'ta-helper';
            testWindow.authenticatedFetch = async () => new Response(JSON.stringify({
                success: true,
                data: [{ courseId: 'TA-HELPER' }],
            }), { status: 200, headers: { 'Content-Type': 'application/json' } });
            const hasTaCourse = await testWindow.checkOnboardingStatus();
            testWindow.authenticatedFetch = async () => new Response('{}', { status: 500 });
            const failedTaFetch = await testWindow.checkOnboardingStatus();
            testWindow.isTA = originalIsTA;
            testWindow.getCurrentInstructorId = originalInstructor;
            testWindow.authenticatedFetch = originalFetch;
            return { hasTaCourse, failedTaFetch };
        });

        expect(taOnboarding).toEqual({ hasTaCourse: true, failedTaFetch: false });
    });
});

test.describe('Instructor home empty state', () => {
    test.use({ storageState: storageStatePath('instructor_fresh') });

    test.beforeEach(async () => {
        await removeInstructorCourses(TEST_USERS.instructor_fresh.username);
    });

    test('shows onboarding prompt instead of dashboard panels when the instructor has no courses', async ({ page }) => {
        await gotoInstructorHome(page);

        await expect(page.locator('#onboarding-prompt-section')).toBeVisible({ timeout: 15_000 });
        await expect(page.locator('#go-to-onboarding-btn')).toHaveAttribute('href', '/instructor/onboarding');
        await expect(page.locator('.flagged-section')).toBeHidden();
        await expect(page.locator('.disclaimer-section')).toBeHidden();
        await expect(page.locator('#course-selection-container')).toBeHidden();
    });
});
