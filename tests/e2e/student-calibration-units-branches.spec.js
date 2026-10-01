// @ts-check
/**
 * Focused branch coverage for public/student/scripts/student.js lines 3840-4523.
 *
 * This section owns published-unit detection, unit dropdown behavior, and
 * loading assessment questions for the selected unit.
 */

const { test, expect } = require('./fixtures/monocart');
const { TEST_USERS, storageStatePath } = require('./helpers/users');

/** @typedef {import('@playwright/test').Page} Page */
/** @typedef {import('@playwright/test').Route} Route */

const COURSE_ID = 'BIOC-E2E-STUDENT-CALIBRATION-BRANCHES';
const COURSE_NAME = 'BIOC E2E Student Calibration Branches';
const STUDENT_ID = 'user_e2e_student_calibration_branches';

test.use({ storageState: storageStatePath('student') });

function baseChatData(unitName = 'Unit 1', messages = []) {
    return {
        metadata: {
            courseId: COURSE_ID,
            courseName: COURSE_NAME,
            studentId: STUDENT_ID,
            studentName: TEST_USERS.student.displayName,
            unitName,
            currentMode: 'tutor',
            totalMessages: messages.length,
            version: '1.0',
        },
        messages,
        practiceTests: null,
        studentAnswers: { answers: [] },
        sessionInfo: {
            sessionId: `e2e_calibration_${unitName.replace(/\s+/g, '_')}`,
            startTime: new Date().toISOString(),
            duration: '0 minutes',
        },
        lastActivityTimestamp: new Date().toISOString(),
    };
}

function question(overrides = {}) {
    return {
        questionId: 'q_calibration_branch',
        questionType: 'multiple-choice',
        question: 'Which option should be selected?',
        options: { A: 'Alpha', B: 'Beta' },
        correctAnswer: 'A',
        explanation: '',
        ...overrides,
    };
}

function unit(name, overrides = {}) {
    return {
        name,
        displayName: name,
        isPublished: true,
        passThreshold: 0,
        documents: [],
        assessmentQuestions: [],
        ...overrides,
    };
}

function courseDoc(overrides = {}) {
    return {
        courseId: COURSE_ID,
        courseName: COURSE_NAME,
        name: COURSE_NAME,
        status: 'active',
        lectures: [unit('Unit 1')],
        ...overrides,
    };
}

/**
 * @param {Page} page
 * @param {Object} options
 * @param {ReturnType<typeof courseDoc>} [options.course]
 * @param {Object} [options.questionsResponse]
 * @param {ReturnType<typeof baseChatData>} [options.chatData]
 * @param {string | null} [options.selectedCourseId]
 * @param {string} [options.selectedUnitName]
 * @returns {Promise<{ calls: string[], setCourseStatus: (status: number) => void }>}
 */
async function openStudentWithMocks(page, options = {}) {
    const calls = /** @type {string[]} */ ([]);
    let courseStatus = 200;
    const selectedCourseId = options.selectedCourseId === undefined ? COURSE_ID : options.selectedCourseId;
    const selectedUnitName = options.selectedUnitName || 'Unit 1';
    const seededChat = options.chatData || baseChatData(selectedUnitName);
    const currentCourse = options.course || courseDoc();
    const questionsResponse = options.questionsResponse || { success: true, data: { questions: [] } };

    await page.route('**/api/**', async (route) => {
        calls.push(new URL(route.request().url()).pathname + new URL(route.request().url()).search);
        await fulfillApi(route, currentCourse, questionsResponse, courseStatus);
    });

    await page.addInitScript(({ selectedCourseId, selectedUnitName, seededChat }) => {
        localStorage.clear();
        sessionStorage.clear();
        localStorage.setItem('studentMode', 'tutor');
        if (selectedCourseId) {
            localStorage.setItem('selectedCourseId', selectedCourseId);
            localStorage.setItem('selectedCourseName', seededChat.metadata.courseName);
            localStorage.setItem('selectedUnitName', selectedUnitName);
            localStorage.setItem(`biocbot_current_chat_${seededChat.metadata.studentId}`, JSON.stringify(seededChat));
            localStorage.setItem(
                `biocbot_session_${seededChat.metadata.studentId}_${selectedCourseId}_${selectedUnitName}`,
                seededChat.sessionInfo.sessionId
            );
        }
    }, { selectedCourseId, selectedUnitName, seededChat });

    await page.goto('/student');
    await page.waitForFunction(() => {
        const studentWindow = /** @type {Window & Record<string, unknown>} */ (/** @type {unknown} */ (window));
        return typeof studentWindow.checkPublishedUnitsAndLoadQuestions === 'function';
    });

    return {
        calls,
        setCourseStatus(status) {
            courseStatus = status;
        },
    };
}

/**
 * @param {Route} route
 * @param {ReturnType<typeof courseDoc>} currentCourse
 * @param {Object} questionsResponse
 * @param {number} courseStatus
 */
async function fulfillApi(route, currentCourse, questionsResponse, courseStatus) {
    const request = route.request();
    const url = new URL(request.url());
    const pathname = url.pathname;

    if (pathname === '/api/auth/me') {
        await route.fulfill({
            json: {
                success: true,
                user: {
                    userId: STUDENT_ID,
                    username: TEST_USERS.student.username,
                    role: 'student',
                    displayName: TEST_USERS.student.displayName,
                    preferences: {},
                },
            },
        });
        return;
    }

    if (pathname === '/api/user-agreement/status') {
        await route.fulfill({ json: { success: true, data: { hasAgreed: true, agreementVersion: '1.0' } } });
        return;
    }

    if (pathname === '/api/settings/llm-tag') {
        await route.fulfill({ json: { success: true, llmIndex: null, reasoningIndex: null } });
        return;
    }

    if (pathname === '/api/quiz/status') {
        await route.fulfill({ json: { success: true, enabled: false } });
        return;
    }

    if (pathname === `/api/courses/${COURSE_ID}/student-enrollment`) {
        await route.fulfill({ json: { success: true, data: { enrolled: true, status: 'active' } } });
        return;
    }

    if (pathname === `/api/courses/${COURSE_ID}`) {
        if (courseStatus === 404) {
            await route.fulfill({
                status: 404,
                contentType: 'application/json',
                body: JSON.stringify({ success: false, message: 'Course not found' }),
            });
            return;
        }
        await route.fulfill({ json: { success: true, data: currentCourse } });
        return;
    }

    if (pathname === '/api/courses/available/all') {
        await route.fulfill({
            json: {
                success: true,
                data: [{ courseId: COURSE_ID, courseName: COURSE_NAME, isEnrolled: true }],
            },
        });
        return;
    }

    if (pathname === '/api/questions/lecture') {
        await route.fulfill({ json: questionsResponse });
        return;
    }

    if (pathname === '/api/student/struggle') {
        await route.fulfill({ json: { success: true, struggleState: { topics: [] } } });
        return;
    }

    if (pathname === '/api/chat/save') {
        await route.fulfill({ json: { success: true } });
        return;
    }

    if (pathname === '/api/flags/count' || pathname === '/api/flags') {
        await route.fulfill({ json: { success: true, count: 0, data: [] } });
        return;
    }

    await route.fulfill({ json: { success: true, data: {} } });
}

test('renders no-units empty state when course data has no lectures', async ({ page }) => {
    await openStudentWithMocks(page, { course: courseDoc({ lectures: undefined }) });

    await expect(page.locator('#chat-messages')).toContainText('No units published at this time', { timeout: 10_000 });
    await expect(page.locator('#chat-input')).toBeDisabled();
    await expect(page.locator('#send-button')).toBeDisabled();
    await expect(page.locator('.mode-toggle-container')).toBeHidden();
});

test('clears stale selected course when published-unit course lookup returns 404', async ({ page }) => {
    const harness = await openStudentWithMocks(page);
    await expect(page.locator('#unit-select')).toHaveValue('Unit 1', { timeout: 10_000 });

    harness.setCourseStatus(404);
    const availableCallsBefore = harness.calls.filter((call) => call === '/api/courses/available/all').length;

    await page.evaluate(() => {
        const studentWindow = /** @type {Window & { checkPublishedUnitsAndLoadQuestions?: () => void }} */ (window);
        studentWindow.checkPublishedUnitsAndLoadQuestions?.();
    });

    await expect.poll(() => page.evaluate(() => localStorage.getItem('selectedCourseId'))).toBeNull();
    await expect.poll(() => harness.calls.filter((call) => call === '/api/courses/available/all').length)
        .toBeGreaterThan(availableCallsBefore);
});

test('skips duplicate published-unit checks while a check is already running', async ({ page }) => {
    const harness = await openStudentWithMocks(page);
    await expect(page.locator('#unit-select')).toHaveValue('Unit 1', { timeout: 10_000 });

    const courseCallsBefore = harness.calls.filter((call) => call === `/api/courses/${COURSE_ID}`).length;
    await page.evaluate(() => {
        const studentWindow = /** @type {Window & { isCheckingPublishedUnits?: boolean, checkPublishedUnitsAndLoadQuestions?: () => void }} */ (window);
        studentWindow.isCheckingPublishedUnits = true;
        studentWindow.checkPublishedUnitsAndLoadQuestions?.();
    });
    await page.waitForTimeout(250);

    expect(harness.calls.filter((call) => call === `/api/courses/${COURSE_ID}`).length).toBe(courseCallsBefore);
    await expect.poll(() => page.evaluate(() => {
        const studentWindow = /** @type {Window & { isCheckingPublishedUnits?: boolean }} */ (window);
        return studentWindow.isCheckingPublishedUnits;
    })).toBe(true);
});

test('selects the most recently updated unit and strips embedded option prefixes', async ({ page }) => {
    await openStudentWithMocks(page, {
        course: courseDoc({
            lectures: [
                unit('Unit 1', {
                    updatedAt: '2025-01-01T00:00:00.000Z',
                    assessmentQuestions: [question({ question: 'Older unit question?' })],
                }),
                unit('Unit 2', {
                    displayName: 'Recent Unit',
                    updatedAt: '2025-02-01T00:00:00.000Z',
                    assessmentQuestions: [
                        question({
                            question: 'Recent embedded question?',
                            options: { A: 'A,Alpha prefixed', B: 'B,Beta prefixed' },
                        }),
                    ],
                }),
            ],
        }),
    });

    await expect(page.locator('#unit-select')).toHaveValue('Unit 2', { timeout: 10_000 });
    await expect(page.locator('#chat-messages')).toContainText('Recent embedded question?');
    await expect(page.locator('#chat-messages')).toContainText('Alpha prefixed');
    await expect(page.locator('#chat-messages')).not.toContainText('A,Alpha prefixed');
});

test('unit dropdown label omits the number prefix when showUnitNumber is false', async ({ page }) => {
    await openStudentWithMocks(page, {
        course: courseDoc({
            lectures: [unit('Unit 1', { displayName: 'Biology', showUnitNumber: false })],
        }),
    });

    await expect(page.locator('#unit-select')).toHaveValue('Unit 1', { timeout: 10_000 });
    await expect(page.locator('#unit-select option[value="Unit 1"]')).toHaveText('Biology');
});

test('unit dropdown label keeps the number prefix when showUnitNumber is true (default)', async ({ page }) => {
    await openStudentWithMocks(page, {
        course: courseDoc({
            lectures: [unit('Unit 1', { displayName: 'Biology' })],
        }),
    });

    await expect(page.locator('#unit-select')).toHaveValue('Unit 1', { timeout: 10_000 });
    await expect(page.locator('#unit-select option[value="Unit 1"]')).toHaveText('1. Biology');
});

test('uses unit number ordering when updated timestamps are unavailable', async ({ page }) => {
    await openStudentWithMocks(page, {
        course: courseDoc({
            lectures: [
                unit('Unit 2', { assessmentQuestions: [question({ question: 'Lower numbered unit?' })] }),
                unit('Unit 10', { assessmentQuestions: [question({ question: 'Higher numbered unit?' })] }),
            ],
        }),
    });

    await expect(page.locator('#unit-select')).toHaveValue('Unit 10', { timeout: 10_000 });
    await expect(page.locator('#chat-messages')).toContainText('Higher numbered unit?');
});

test('restores a recent saved unit without starting a fresh assessment', async ({ page }) => {
    const savedMessage = 'RECENT_SAVED_UNIT_BRANCH_MESSAGE';

    await openStudentWithMocks(page, {
        selectedUnitName: 'Unit 1',
        chatData: baseChatData('Unit 1', [
            {
                type: 'bot',
                content: savedMessage,
                messageType: 'regular-chat',
                timestamp: new Date().toISOString(),
            },
        ]),
        course: courseDoc({
            lectures: [
                unit('Unit 1', { assessmentQuestions: [question({ question: 'Saved unit assessment should not start?' })] }),
                unit('Unit 2', {
                    updatedAt: '2025-03-01T00:00:00.000Z',
                    assessmentQuestions: [question({ question: 'Most recent unit should not replace saved unit?' })],
                }),
            ],
        }),
    });

    await expect(page.locator('#unit-select')).toHaveValue('Unit 1', { timeout: 10_000 });
    await expect(page.locator('#chat-messages')).toContainText(savedMessage);
    await expect(page.locator('#chat-input')).toBeVisible();
    await expect(page.locator('.mode-toggle-container')).toBeVisible();
    await expect(page.locator('#chat-messages')).not.toContainText('Most recent unit should not replace saved unit?');
});

test('honors a course session window longer than the 30-minute default', async ({ page }) => {
    const savedMessage = 'SAVED_MESSAGE_45_MINUTES_AGO';
    const savedAt = new Date(Date.now() - (45 * 60 * 1000)).toISOString();
    const chatData = baseChatData('Unit 1', [{
        type: 'bot',
        content: savedMessage,
        messageType: 'regular-chat',
        timestamp: savedAt,
    }]);
    chatData.lastActivityTimestamp = savedAt;

    await openStudentWithMocks(page, {
        chatData,
        course: courseDoc({
            studentSessionTimeout: 60 * 60,
            lectures: [unit('Unit 1', {
                assessmentQuestions: [question({ question: 'Assessment should wait for the configured hour?' })],
            })],
        }),
    });

    await expect(page.locator('#unit-select')).toHaveValue('Unit 1', { timeout: 10_000 });
    await expect(page.locator('#chat-messages')).toContainText(savedMessage);
    await expect(page.locator('#chat-messages')).not.toContainText('Assessment should wait for the configured hour?');
});

test('returning after session inactivity starts a fresh assessment for the same unit', async ({ page }) => {
    const savedMessage = 'SESSION_BEFORE_INACTIVITY';
    await openStudentWithMocks(page, {
        chatData: baseChatData('Unit 1', [{
            type: 'bot',
            content: savedMessage,
            messageType: 'regular-chat',
            timestamp: new Date().toISOString(),
        }]),
        course: courseDoc({
            studentSessionTimeout: 30,
            lectures: [unit('Unit 1', {
                assessmentQuestions: [question({ question: 'Fresh assessment after inactivity?' })],
            })],
        }),
    });

    await expect(page.locator('#chat-messages')).toContainText(savedMessage, { timeout: 10_000 });

    await page.evaluate((studentId) => {
        const key = `biocbot_current_chat_${studentId}`;
        const chatData = JSON.parse(localStorage.getItem(key));
        chatData.lastActivityTimestamp = '2026-01-01T00:00:00Z';
        localStorage.setItem(key, JSON.stringify(chatData));
        window.dispatchEvent(new Event('focus'));
    }, STUDENT_ID);

    await expect(page.locator('#chat-messages')).not.toContainText(savedMessage);
    await expect(page.locator('#chat-messages')).toContainText('Fresh assessment after inactivity?');
    await expect(page.locator('#chat-input')).toBeHidden();
});

test('expires a session while the page remains visible and focused', async ({ page }) => {
    const savedMessage = 'SESSION_LEFT_OPEN_ON_FOCUSED_PAGE';
    await openStudentWithMocks(page, {
        chatData: baseChatData('Unit 1', [{
            type: 'bot',
            content: savedMessage,
            messageType: 'regular-chat',
            timestamp: new Date().toISOString(),
        }]),
        course: courseDoc({
            studentSessionTimeout: 30,
            lectures: [unit('Unit 1', {
                assessmentQuestions: [question({ question: 'Focused-page assessment restart?' })],
            })],
        }),
    });

    await expect(page.locator('#chat-messages')).toContainText(savedMessage, { timeout: 10_000 });

    await page.evaluate((studentId) => {
        const key = `biocbot_current_chat_${studentId}`;
        const chatData = JSON.parse(localStorage.getItem(key));
        chatData.lastActivityTimestamp = '2026-01-01T00:00:00Z';
        localStorage.setItem(key, JSON.stringify(chatData));
        scheduleChatSessionExpiration(chatData);
    }, STUDENT_ID);

    await expect(page.locator('#chat-messages')).not.toContainText(savedMessage);
    await expect(page.locator('#chat-messages')).toContainText('Focused-page assessment restart?');
    await expect(page.locator('#chat-input')).toBeHidden();
});

test('loads API fallback questions when selected unit has no embedded questions', async ({ page }) => {
    await openStudentWithMocks(page, {
        questionsResponse: {
            success: true,
            data: {
                questions: [
                    question({
                        questionId: 'q_api_fallback',
                        question: 'API fallback question?',
                        options: { A: 'A,First API option', B: 'Second API option' },
                        correctAnswer: 'A1',
                    }),
                ],
            },
        },
    });

    await expect(page.locator('#unit-select')).toHaveValue('Unit 1', { timeout: 10_000 });
    await expect(page.locator('#chat-messages')).toContainText('API fallback question?');
    await expect(page.locator('#chat-messages')).toContainText('First API option');
    await expect(page.locator('#chat-messages')).not.toContainText('A,First API option');
});

test('renders unit empty state when API fallback returns no questions', async ({ page }) => {
    await openStudentWithMocks(page);

    await expect(page.locator('#chat-messages')).toContainText('No Questions Available', { timeout: 10_000 });
    await expect(page.locator('#chat-input')).toBeEnabled();
    await expect(page.locator('#unit-select')).toHaveValue('Unit 1');
});
