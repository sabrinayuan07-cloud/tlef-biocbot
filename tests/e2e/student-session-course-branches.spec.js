// @ts-check
/**
 * Focused branch coverage for public/student/scripts/student.js lines 2623-3838.
 *
 * This window owns new-session handling, flag submission, course selection,
 * course loading/display fallbacks, and small identity helpers.
 */

const { test, expect } = require('./fixtures/monocart');
const { TEST_USERS, storageStatePath } = require('./helpers/users');

/** @typedef {import('@playwright/test').Page} Page */
/** @typedef {import('@playwright/test').Route} Route */

const COURSE_ID = 'BIOC-E2E-STUDENT-SESSION-BRANCHES';
const COURSE_NAME = 'BIOC E2E Session Branches';
const SECOND_COURSE_ID = 'BIOC-E2E-STUDENT-SESSION-BRANCHES-2';
const STUDENT_ID = 'user_e2e_student_session_branches';

test.use({ storageState: storageStatePath('student') });

function chatData() {
    return {
        metadata: {
            courseId: COURSE_ID,
            courseName: COURSE_NAME,
            studentId: STUDENT_ID,
            studentName: TEST_USERS.student.displayName,
            unitName: 'Unit 1',
            currentMode: 'tutor',
            totalMessages: 1,
            version: '1.0',
        },
        messages: [
            {
                type: 'bot',
                content: 'seeded branch chat',
                messageType: 'regular-chat',
                timestamp: new Date().toISOString(),
            },
        ],
        practiceTests: null,
        studentAnswers: { answers: [] },
        sessionInfo: {
            sessionId: 'e2e_session_branches',
            startTime: new Date().toISOString(),
            duration: '0 minutes',
        },
        lastActivityTimestamp: new Date().toISOString(),
    };
}

function courseDoc(overrides = {}) {
    return {
        courseId: COURSE_ID,
        courseName: COURSE_NAME,
        name: COURSE_NAME,
        status: 'active',
        lectures: [
            {
                name: 'Unit 1',
                displayName: 'Unit 1',
                isPublished: true,
                passThreshold: 0,
                documents: [],
                assessmentQuestions: [],
            },
        ],
        ...overrides,
    };
}

/**
 * @param {Page} page
 * @param {Object} [options]
 * @param {boolean} [options.seedSelectedCourse]
 * @param {boolean} [options.seedCourseName]
 * @param {Object} [options.availableCourses]
 * @param {Object} [options.authResponse]
 * @param {Object} [options.courseResponse]
 * @param {Object} [options.enrollmentResponse]
 * @param {Object} [options.flagResponse]
 * @param {Object} [options.joinResponse]
 * @returns {Promise<{
 *   calls: string[],
 *   alerts: string[],
 *   prompts: string[],
 *   setAvailableCourses: (value: Object) => void,
 *   setAuthResponse: (value: Object) => void,
 *   setCourseResponse: (value: Object) => void,
 *   setEnrollmentResponse: (value: Object) => void,
 *   setFlagResponse: (value: Object) => void,
 *   setJoinResponse: (value: Object) => void,
 * }>}
 */
async function openStudentWithMocks(page, options = {}) {
    const calls = /** @type {string[]} */ ([]);
    const alerts = /** @type {string[]} */ ([]);
    const prompts = /** @type {string[]} */ ([]);
    let availableCourses = options.availableCourses || {
        success: true,
        data: [{ courseId: COURSE_ID, courseName: COURSE_NAME, isEnrolled: true }],
    };
    let authResponse = options.authResponse || {
        status: 200,
        body: {
            success: true,
            user: {
                userId: STUDENT_ID,
                username: TEST_USERS.student.username,
                role: 'student',
                displayName: TEST_USERS.student.displayName,
                preferences: {},
            },
        },
    };
    let courseResponse = options.courseResponse || { status: 200, body: { success: true, data: courseDoc() } };
    let enrollmentResponse = options.enrollmentResponse || { status: 200, body: { success: true, data: { enrolled: true, status: 'active' } } };
    let flagResponse = options.flagResponse || { status: 500, body: { success: false } };
    let joinResponse = options.joinResponse || { status: 200, body: { success: true } };
    const seedSelectedCourse = options.seedSelectedCourse !== false;
    const seedCourseName = options.seedCourseName !== false;
    const seededChat = chatData();

    await page.route('**/api/**', async (route) => {
        calls.push(new URL(route.request().url()).pathname + new URL(route.request().url()).search);
        await fulfillApi(route, { availableCourses, authResponse, courseResponse, enrollmentResponse, flagResponse, joinResponse });
    });

    await page.exposeFunction('__recordStudentSessionAlert', (message) => {
        alerts.push(String(message));
    });
    await page.exposeFunction('__recordStudentSessionPrompt', (message) => {
        prompts.push(String(message));
    });

    await page.addInitScript(({ seedSelectedCourse, seedCourseName, seededChat }) => {
        const testWindow = /** @type {any} */ (window);
        localStorage.clear();
        sessionStorage.clear();
        localStorage.setItem('studentMode', 'tutor');
        localStorage.setItem('userId', seededChat.metadata.studentId);
        testWindow.__studentSessionPromptValue = 'JOIN-CODE';
        testWindow.__studentSessionConfirmValue = true;
        window.prompt = (message) => {
            testWindow.__recordStudentSessionPrompt(String(message));
            return testWindow.__studentSessionPromptValue;
        };
        window.alert = (message) => {
            testWindow.__recordStudentSessionAlert(String(message));
        };
        window.confirm = () => testWindow.__studentSessionConfirmValue;

        if (seedSelectedCourse) {
            localStorage.setItem('selectedCourseId', seededChat.metadata.courseId);
            localStorage.setItem('selectedUnitName', seededChat.metadata.unitName);
            if (seedCourseName) {
                localStorage.setItem('selectedCourseName', seededChat.metadata.courseName);
            }
            localStorage.setItem(`biocbot_current_chat_${seededChat.metadata.studentId}`, JSON.stringify(seededChat));
            localStorage.setItem(
                `biocbot_session_${seededChat.metadata.studentId}_${seededChat.metadata.courseId}_${seededChat.metadata.unitName}`,
                seededChat.sessionInfo.sessionId
            );
        }
    }, { seedSelectedCourse, seedCourseName, seededChat });

    await page.goto('/student');
    await page.waitForFunction(() => {
        const w = /** @type {any} */ (window);
        return typeof w.loadAvailableCourses === 'function' &&
            typeof w.submitFlag === 'function' &&
            typeof w.addChangeCourseButton === 'function';
    });

    return {
        calls,
        alerts,
        prompts,
        setAvailableCourses(value) {
            availableCourses = value;
        },
        setAuthResponse(value) {
            authResponse = value;
        },
        setCourseResponse(value) {
            courseResponse = value;
        },
        setEnrollmentResponse(value) {
            enrollmentResponse = value;
        },
        setFlagResponse(value) {
            flagResponse = value;
        },
        setJoinResponse(value) {
            joinResponse = value;
        },
    };
}

/**
 * @param {Route} route
 * @param {{ availableCourses: Object, authResponse: Object, courseResponse: Object, enrollmentResponse: Object, flagResponse: Object, joinResponse: Object }} state
 */
async function fulfillApi(route, state) {
    const request = route.request();
    const url = new URL(request.url());
    const pathname = url.pathname;

    if (pathname === '/api/auth/me') {
        if (state.authResponse.abort) {
            await route.abort('failed');
            return;
        }
        await route.fulfill({
            status: Number(state.authResponse.status || 200),
            contentType: 'application/json',
            body: JSON.stringify(state.authResponse.body || state.authResponse),
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
        if (state.enrollmentResponse.abort) {
            await route.abort('failed');
            return;
        }
        await route.fulfill({
            status: Number(state.enrollmentResponse.status || 200),
            contentType: 'application/json',
            body: JSON.stringify(state.enrollmentResponse.body || state.enrollmentResponse),
        });
        return;
    }

    if (pathname === `/api/courses/${COURSE_ID}` || pathname === `/api/courses/${SECOND_COURSE_ID}`) {
        const status = Number(state.courseResponse.status || 200);
        await route.fulfill({
            status,
            contentType: 'application/json',
            body: JSON.stringify(state.courseResponse.body || {}),
        });
        return;
    }

    if (pathname === '/api/courses/available/all') {
        const status = Number(state.availableCourses.status || 200);
        await route.fulfill({
            status,
            contentType: 'application/json',
            body: JSON.stringify(state.availableCourses.body || state.availableCourses),
        });
        return;
    }

    if (pathname === `/api/courses/${SECOND_COURSE_ID}/join`) {
        if (state.joinResponse.abort) {
            await route.abort('failed');
            return;
        }
        await route.fulfill({
            status: Number(state.joinResponse.status || 200),
            contentType: 'application/json',
            body: JSON.stringify(state.joinResponse.body || state.joinResponse),
        });
        return;
    }

    if (pathname === '/api/questions/lecture') {
        await route.fulfill({ json: { success: true, data: { questions: [] } } });
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

    if (pathname === '/api/flags') {
        await route.fulfill({
            status: Number(state.flagResponse.status || 200),
            contentType: 'application/json',
            body: JSON.stringify(state.flagResponse.body || state.flagResponse),
        });
        return;
    }

    if (pathname === '/api/flags/count') {
        await route.fulfill({ json: { success: true, count: 0, data: [] } });
        return;
    }

    await route.fulfill({ json: { success: true, data: {} } });
}

test('starts a new session with a fetched course name and closes the notification', async ({ page }) => {
    await openStudentWithMocks(page, { seedCourseName: false });
    await expect(page.locator('#chat-messages')).toContainText('seeded branch chat', { timeout: 10_000 });

    await page.evaluate(() => localStorage.removeItem('selectedCourseName'));
    await page.locator('#new-session-btn').click();

    const notification = page.locator('.notification.info').filter({ hasText: 'New chat session started' });
    await expect(notification).toBeVisible({ timeout: 5_000 });
    await expect.poll(() => page.evaluate(() => localStorage.getItem('selectedCourseName'))).toBe(COURSE_NAME);

    await notification.locator('.notification-close').click();
    await expect(notification).toHaveCount(0);
});

test('auto-removes the new-session notification after its timeout', async ({ page }) => {
    await openStudentWithMocks(page);

    await page.evaluate(() => {
        document.querySelector('.notification-container')?.remove();
        const w = /** @type {any} */ (window);
        w.showNewSessionNotification();
    });

    await expect(page.locator('.notification.info')).toContainText('New chat session started');
    // showNewSessionNotification() now delegates to the shared showNotification()
    // (#617), whose auto-dismiss timeout is 5s rather than this function's old
    // standalone 3s + 300ms fade.
    await expect(page.locator('.notification.info')).toHaveCount(0, { timeout: 6_000 });
});

test('formats timestamps across elapsed-time buckets', async ({ page }) => {
    await openStudentWithMocks(page);

    const labels = await page.evaluate(() => {
        const w = /** @type {any} */ (window);
        const now = Date.now();
        return [
            w.formatTimestamp(new Date(now - 2 * 60 * 1000)),
            w.formatTimestamp(new Date(now - 2 * 60 * 60 * 1000)),
            w.formatTimestamp(new Date(now - 2 * 24 * 60 * 60 * 1000)),
            w.formatTimestamp(new Date(now - 10 * 24 * 60 * 60 * 1000)),
        ];
    });

    expect(labels[0]).toBe('2 minutes ago');
    expect(labels[1]).toBe('2 hours ago');
    expect(labels[2]).toBe('2 days ago');
    expect(labels[3]).toMatch(/^\w{3} \d{1,2}, /);
});

test('submits flag failures without removing the user-facing thank-you state', async ({ page }) => {
    await openStudentWithMocks(page);

    const message = page.locator('.bot-message').first();
    await expect(message).toContainText('seeded branch chat');
    await expect(message.locator('.flag-button')).toBeVisible();
    await message.locator('.flag-button').click();
    await message.locator('.flag-option', { hasText: 'Incorrect' }).evaluate((element) => {
        /** @type {HTMLElement} */ (element).click();
    });

    await expect(message).toContainText('Thank you for reporting this response as incorrect information');
    await expect(message.locator('.message-flag-container')).toHaveCount(0);
    await expect(message.locator('.timestamp')).toHaveText('Flagged just now');
});

test('successful flag submission schedules flag refresh', async ({ page }) => {
    const harness = await openStudentWithMocks(page);
    harness.setFlagResponse({ status: 200, body: { success: true } });

    await page.evaluate(() => {
        const w = /** @type {any} */ (window);
        w.__studentSessionFlagRefreshes = 0;
        w.checkForFlagUpdates = () => {
            w.__studentSessionFlagRefreshes += 1;
        };
        return w.submitFlag('Flag refresh branch response', 'unclear');
    });

    await expect.poll(() => page.evaluate(() => /** @type {any} */ (window).__studentSessionFlagRefreshes)).toBe(1);
});

test('course join dropdown handles failed join, network error, and prompt cancel', async ({ page }) => {
    const harness = await openStudentWithMocks(page);
    await page.evaluate(() => {
        const w = /** @type {any} */ (window);
        w.checkPublishedUnitsAndLoadQuestions = () => {};
    });

    // Page auto-init runs loadAvailableCourses() → loadCourseData() which
    // wipes #chat-messages and renders the seeded chat. If a scenario below
    // races against an in-flight auto-init, the dropdown we just rendered
    // gets clobbered mid-test. Scenarios 1 and 2 happen to mask this because
    // their `expect.poll(...alert)` step gives init enough time to finish;
    // scenario 3 (prompt cancel — no alert) runs back-to-back and loses the
    // race intermittently. Wait for the seeded chat to land before we start.
    await expect(page.locator('#chat-messages')).toContainText('seeded branch chat');

    async function renderJoinDropdown() {
        await page.evaluate((secondCourseId) => {
            const w = /** @type {any} */ (window);
            w.showCourseSelection([
                { courseId: secondCourseId, courseName: 'Join Target', isEnrolled: false },
            ]);
        }, SECOND_COURSE_ID);
        await expect(page.locator('#course-select')).toBeVisible();
    }

    harness.setJoinResponse({ status: 200, body: { success: false, message: 'Bad join code' } });
    await renderJoinDropdown();
    await page.evaluate(() => {
        const w = /** @type {any} */ (window);
        w.__studentSessionPromptValue = 'BAD-CODE';
    });
    await page.locator('#course-select').selectOption(SECOND_COURSE_ID);
    await expect.poll(() => harness.alerts.includes('Bad join code')).toBe(true);
    await expect(page.locator('#course-select')).toHaveValue('');

    harness.setJoinResponse({ abort: true });
    await renderJoinDropdown();
    await page.evaluate(() => {
        const w = /** @type {any} */ (window);
        w.__studentSessionPromptValue = 'NETWORK-CODE';
    });
    await page.locator('#course-select').selectOption(SECOND_COURSE_ID);
    await expect.poll(() => harness.alerts.includes('Error joining course. Please try again.')).toBe(true);

    await renderJoinDropdown();
    await page.evaluate(() => {
        const w = /** @type {any} */ (window);
        w.__studentSessionPromptValue = null;
    });
    await page.locator('#course-select').selectOption(SECOND_COURSE_ID);
    await expect(page.locator('#course-select')).toHaveValue('');
    expect(harness.prompts.length).toBeGreaterThanOrEqual(3);
});

test('loadAvailableCourses clears a stored course when enrollment is revoked', async ({ page }) => {
    await openStudentWithMocks(page, {
        seedSelectedCourse: false,
        enrollmentResponse: { status: 200, body: { success: true, data: { enrolled: false, status: 'inactive' } } },
    });

    await page.evaluate(({ courseId, courseName, studentId }) => {
        localStorage.setItem('selectedCourseId', courseId);
        localStorage.setItem('selectedCourseName', courseName);
        localStorage.setItem(`biocbot_session_${studentId}_${courseId}_Unit 1`, 'e2e_session_branches');
        const w = /** @type {any} */ (window);
        return w.loadAvailableCourses();
    }, { courseId: COURSE_ID, courseName: COURSE_NAME, studentId: STUDENT_ID });

    await expect(page.locator('#course-select')).toBeVisible({ timeout: 10_000 });
    await expect.poll(() => page.evaluate(() => localStorage.getItem('selectedCourseId'))).toBeNull();
    await expect.poll(() => page.evaluate(() => localStorage.getItem('selectedCourseName'))).toBeNull();
    await expect.poll(() => page.evaluate(({ studentId, courseId }) => {
        return localStorage.getItem(`biocbot_session_${studentId}_${courseId}_Unit 1`);
    }, { studentId: STUDENT_ID, courseId: COURSE_ID })).toBeNull();
});

for (const scenario of [
    {
        name: 'course verification returns success false',
        courseResponse: { status: 200, body: { success: false, data: null } },
    },
    {
        name: 'course verification returns non-OK',
        courseResponse: { status: 503, body: { success: false, message: 'unavailable' } },
    },
]) {
    test(`loadAvailableCourses clears a stored course when ${scenario.name}`, async ({ page }) => {
        await openStudentWithMocks(page, { courseResponse: scenario.courseResponse });

        await expect(page.locator('#course-select')).toBeVisible({ timeout: 10_000 });
        await expect.poll(() => page.evaluate(() => localStorage.getItem('selectedCourseId'))).toBeNull();
        await expect.poll(() => page.evaluate(() => localStorage.getItem('selectedCourseName'))).toBeNull();
    });
}

test('loadAvailableCourses clears a stored course when enrollment verification aborts', async ({ page }) => {
    const harness = await openStudentWithMocks(page);
    // Let the page's initial loadAvailableCourses call finish before changing
    // its mock responses and invoking a second call.
    await expect(page.locator('#chat-messages')).toContainText('seeded branch chat', { timeout: 10_000 });
    harness.setEnrollmentResponse({ abort: true });
    harness.setAvailableCourses({
        success: true,
        data: [
            { courseId: COURSE_ID, courseName: COURSE_NAME, isEnrolled: true },
            { courseId: SECOND_COURSE_ID, courseName: 'Second Course', isEnrolled: true },
        ],
    });

    await page.evaluate(({ courseId, courseName, studentId }) => {
        localStorage.setItem('selectedCourseId', courseId);
        localStorage.setItem('selectedCourseName', courseName);
        localStorage.setItem(`biocbot_current_chat_${studentId}`, JSON.stringify({
            metadata: { courseId, studentId, unitName: 'Unit 1' },
            messages: [{ type: 'bot', content: 'saved chat' }],
        }));
        const w = /** @type {any} */ (window);
        return w.loadAvailableCourses();
    }, { courseId: COURSE_ID, courseName: COURSE_NAME, studentId: STUDENT_ID });

    await expect(page.locator('#course-select')).toBeVisible();
    await expect.poll(() => page.evaluate(() => localStorage.getItem('selectedCourseId'))).toBeNull();
    await expect.poll(() => page.evaluate(() => localStorage.getItem('selectedCourseName'))).toBeNull();
});

test('loadAvailableCourses renders no-courses and fetch-error empty states', async ({ page }) => {
    const harness = await openStudentWithMocks(page, { seedSelectedCourse: false });
    // Prevent the startup request from racing the branch-specific requests.
    await expect(page.locator('#course-select:visible, #chat-messages .message').first()).toBeVisible({ timeout: 10_000 });

    harness.setAvailableCourses({ success: true, data: [] });
    await page.evaluate(() => {
        localStorage.removeItem('selectedCourseId');
        localStorage.removeItem('selectedCourseName');
        const chatMessages = document.getElementById('chat-messages');
        if (chatMessages) {
            chatMessages.innerHTML = '';
        }
        const w = /** @type {any} */ (window);
        return w.loadAvailableCourses();
    });
    await expect(page.locator('#chat-messages')).toContainText('No Courses Available');

    harness.setAvailableCourses({ status: 500, body: { success: false, message: 'Nope' } });
    await page.evaluate(() => {
        const chatMessages = document.getElementById('chat-messages');
        if (chatMessages) {
            chatMessages.innerHTML = '';
        }
        const w = /** @type {any} */ (window);
        return w.loadAvailableCourses();
    });
    await expect(page.locator('#chat-messages')).toContainText('No Courses Available');

    harness.setAvailableCourses({ success: true });
    await page.evaluate(() => {
        const chatMessages = document.getElementById('chat-messages');
        if (chatMessages) {
            chatMessages.innerHTML = '';
        }
        const w = /** @type {any} */ (window);
        return w.loadAvailableCourses();
    });
    await expect(page.locator('#chat-messages')).toContainText('No Courses Available');
});

test('loadAvailableCourses shows the dropdown for multiple courses when storage still has a course', async ({ page }) => {
    const harness = await openStudentWithMocks(page, { seedSelectedCourse: false });
    harness.setAvailableCourses({
        success: true,
        data: [
            { courseId: COURSE_ID, courseName: COURSE_NAME, isEnrolled: true },
            { courseId: SECOND_COURSE_ID, courseName: 'Second Course', isEnrolled: true },
        ],
    });

    await page.evaluate((courseId) => {
        localStorage.removeItem('selectedCourseId');
        const nativeFetch = window.fetch.bind(window);
        window.fetch = (input, init) => {
            const url = input instanceof Request ? input.url : String(input);
            if (url.includes('/api/courses/available/all')) {
                localStorage.setItem('selectedCourseId', courseId);
            }
            return nativeFetch(input, init);
        };
        const chatMessages = document.getElementById('chat-messages');
        if (chatMessages) {
            chatMessages.innerHTML = '';
        }
        const w = /** @type {any} */ (window);
        return w.loadAvailableCourses();
    }, COURSE_ID);

    await expect(page.locator('#course-select')).toBeVisible();
    await expect(page.locator('#course-select option')).toHaveText([
        'Choose a course...',
        COURSE_NAME,
        'Second Course',
    ]);
    await expect.poll(() => page.evaluate(() => localStorage.getItem('selectedCourseId'))).toBe(COURSE_ID);
});

test('showCourseSelection hides the dropdown after enrolled selection and successful join', async ({ page }) => {
    const harness = await openStudentWithMocks(page);

    await page.evaluate((secondCourseId) => {
        const w = /** @type {any} */ (window);
        w.showCourseSelection([
            { courseId: secondCourseId, courseName: 'Already Enrolled Course', isEnrolled: true },
        ]);
    }, SECOND_COURSE_ID);
    await page.locator('#course-select').selectOption(SECOND_COURSE_ID);
    await expect(page.locator('#course-selection-wrapper')).toBeHidden();
    await expect.poll(() => page.evaluate(() => localStorage.getItem('selectedCourseId'))).toBe(SECOND_COURSE_ID);

    harness.setJoinResponse({ status: 200, body: { success: true } });
    await page.evaluate((secondCourseId) => {
        const w = /** @type {any} */ (window);
        w.__studentSessionPromptValue = 'JOIN-CODE';
        w.showCourseSelection([
            { courseId: secondCourseId, courseName: 'Joinable Course', isEnrolled: false },
        ]);
    }, SECOND_COURSE_ID);
    await page.locator('#course-select').selectOption(SECOND_COURSE_ID);
    await expect.poll(() => harness.alerts.includes('Successfully joined the course!')).toBe(true);
    await expect(page.locator('#course-selection-wrapper')).toBeHidden();
});

test('loadCourseData course-change path clears prior session state and triggers delayed question load', async ({ page }) => {
    await openStudentWithMocks(page);
    // Startup auto-continues the seeded session a few hundred ms after auth is
    // ready: loadChatData() restores selectedCourseId/selectedUnitName from that
    // chat's metadata and repaints #chat-messages. Without waiting for it, the
    // restore lands during this test's own loadCourseData() await and puts the
    // *old* course back, so the course-change assertions below fail. The
    // repainted message is the signal that the restore has finished.
    await expect(page.locator('#chat-messages')).toContainText('seeded branch chat', { timeout: 10_000 });

    const result = await page.evaluate(async ({ courseId, secondCourseId, studentId }) => {
        const w = /** @type {any} */ (window);
        localStorage.setItem('userId', studentId);
        localStorage.setItem('selectedCourseId', courseId);
        localStorage.setItem('selectedUnitName', 'Unit 1');
        localStorage.setItem(`biocbot_current_chat_${studentId}`, JSON.stringify({ messages: [{ type: 'bot', content: 'old' }] }));
        const chatMessages = document.getElementById('chat-messages');
        if (chatMessages) {
            chatMessages.innerHTML = '<p>old course message</p>';
        }
        w.__studentSessionQuestionLoads = 0;
        w.__studentSessionTimeouts = [];
        w.checkPublishedUnitsAndLoadQuestions = () => {
            w.__studentSessionQuestionLoads += 1;
        };
        window.setTimeout = /** @type {any} */ ((handler, timeout) => {
            w.__studentSessionTimeouts.push(timeout);
            if (typeof handler === 'function') {
                handler();
            }
            return 0;
        });

        await w.loadCourseData(secondCourseId, true);

        return {
            selectedCourseId: localStorage.getItem('selectedCourseId'),
            selectedUnitName: localStorage.getItem('selectedUnitName'),
            currentChat: localStorage.getItem(`biocbot_current_chat_${studentId}`),
            newSession: localStorage.getItem(`biocbot_session_${studentId}_${secondCourseId}_this unit`),
            chatHtml: document.getElementById('chat-messages')?.innerHTML || '',
            questionLoads: w.__studentSessionQuestionLoads,
            timeouts: w.__studentSessionTimeouts,
        };
    }, { courseId: COURSE_ID, secondCourseId: SECOND_COURSE_ID, studentId: STUDENT_ID });

    expect(result.selectedCourseId).toBe(SECOND_COURSE_ID);
    expect(result.selectedUnitName).toBeNull();
    expect(result.currentChat).toBeNull();
    expect(result.newSession).toMatch(/^autosave_/);
    expect(result.chatHtml).toBe('');
    expect(result.timeouts).toContain(200);
    expect(result.questionLoads).toBeGreaterThanOrEqual(1);
});

test('loadCourseData clears a 404 selection and renders load errors for invalid course payloads', async ({ page }) => {
    const harness = await openStudentWithMocks(page);

    harness.setCourseResponse({ status: 404, body: { success: false, message: 'missing' } });
    await page.evaluate((courseId) => {
        localStorage.setItem('selectedCourseId', courseId);
        const w = /** @type {any} */ (window);
        return w.loadCourseData(courseId);
    }, COURSE_ID);
    await expect.poll(() => page.evaluate(() => localStorage.getItem('selectedCourseId'))).toBeNull();

    harness.setCourseResponse({ status: 200, body: { success: false } });
    await page.evaluate((courseId) => {
        document.getElementById('chat-messages').innerHTML = '';
        const w = /** @type {any} */ (window);
        return w.loadCourseData(courseId);
    }, COURSE_ID);
    await expect(page.locator('#chat-messages')).toContainText('Error Loading Course');
});

test('confirmed change-course clears selected course and reloads the selector', async ({ page }) => {
    await openStudentWithMocks(page);

    await page.evaluate(() => {
        const w = /** @type {any} */ (window);
        w.addChangeCourseButton();
        w.__studentSessionConfirmValue = true;
    });
    await expect(page.locator('#change-course-btn')).toHaveCount(1);

    await page.locator('#change-course-btn').click();
    await expect.poll(() => page.evaluate(() => localStorage.getItem('selectedCourseId'))).toBeNull();
    await expect(page.locator('#change-course-btn')).toHaveCount(0);
    await expect(page.locator('#course-select')).toBeVisible();
});

test('current student id falls back to a generated session id when auth helper throws', async ({ page }) => {
    await openStudentWithMocks(page);

    const generated = await page.evaluate(() => {
        const w = /** @type {any} */ (window);
        w.getCurrentUser = () => {
            throw new Error('auth unavailable');
        };
        sessionStorage.removeItem('sessionId');
        return w.getCurrentStudentId();
    });

    expect(generated).toMatch(/^session_\d+_/);
    await expect.poll(() => page.evaluate(() => sessionStorage.getItem('sessionId'))).toBe(generated);
});

test('student name falls back when the auth request fails', async ({ page }) => {
    await openStudentWithMocks(page);

    // getCurrentStudentName now reads the shared auth.js state via
    // waitForCurrentUser() instead of fetching /api/auth/me itself, so
    // simulate a failed auth bootstrap by resolving to no user.
    await expect.poll(() => page.evaluate(() => {
        const w = /** @type {any} */ (window);
        w.waitForCurrentUser = () => Promise.resolve(null);
        return w.getCurrentStudentName();
    })).toBe('Student Name');
});

test('updateCourseDisplay reaches the span.course-name fallback and updates student identity text', async ({ page }) => {
    await openStudentWithMocks(page);

    const result = await page.evaluate(() => {
        const w = /** @type {any} */ (window);
        document.querySelectorAll('.course-name').forEach((element) => element.remove());
        document.querySelectorAll('.user-role').forEach((element) => element.remove());
        document.querySelectorAll('.message.bot-message').forEach((element) => element.remove());
        document.body.insertAdjacentHTML('beforeend', `
            <section id="course-display-branch-harness">
                <span class="course-name">Old Span Course</span>
                <div class="user-role">Student - Old Span Course</div>
                <div id="user-display-name">Old Student</div>
                <div class="message bot-message"><p>Old welcome</p></div>
            </section>
        `);

        const originalQuerySelector = Document.prototype.querySelector;
        const selectors = /** @type {string[]} */ ([]);
        Document.prototype.querySelector = function(selector) {
            selectors.push(String(selector));
            if (selector === '.course-name' && selectors.filter((value) => value === '.course-name').length === 1) {
                return null;
            }
            return originalQuerySelector.call(this, selector);
        };

        try {
            w.updateCourseDisplay({ name: 'Fallback Span Biology' }, 'Fallback Student');
        } finally {
            Document.prototype.querySelector = originalQuerySelector;
        }

        return {
            selectors,
            courseText: document.querySelector('#course-display-branch-harness span.course-name')?.textContent,
            roleText: document.querySelector('#course-display-branch-harness .user-role')?.textContent,
            studentText: document.getElementById('user-display-name')?.textContent,
            welcomeText: document.querySelector('#course-display-branch-harness .bot-message p')?.textContent,
        };
    });

    expect(result.selectors).toContain('span.course-name');
    expect(result.courseText).toBe('Fallback Span Biology');
    expect(result.roleText).toBe('Student - Fallback Span Biology');
    expect(result.studentText).toBe('Fallback Student');
    expect(result.welcomeText).toContain('Fallback Span Biology');
});

test('updateCourseDisplay reaches the current-course fallback selector', async ({ page }) => {
    await openStudentWithMocks(page);

    const result = await page.evaluate(() => {
        const w = /** @type {any} */ (window);
        document.querySelectorAll('.course-name').forEach((element) => element.remove());
        document.body.insertAdjacentHTML('beforeend', `
            <section id="current-course-branch-harness">
                <div class="current-course"><strong class="course-name">Old Current Course</strong></div>
            </section>
        `);

        const originalQuerySelector = Document.prototype.querySelector;
        const selectors = /** @type {string[]} */ ([]);
        Document.prototype.querySelector = function(selector) {
            selectors.push(String(selector));
            if (selector === '.course-name' || selector === 'span.course-name') {
                return null;
            }
            return originalQuerySelector.call(this, selector);
        };

        try {
            w.updateCourseDisplay({ courseName: 'Current Course Fallback Biology' });
        } finally {
            Document.prototype.querySelector = originalQuerySelector;
        }

        return {
            selectors,
            courseText: document.querySelector('#current-course-branch-harness .current-course .course-name')?.textContent,
        };
    });

    expect(result.selectors).toContain('.current-course .course-name');
    expect(result.courseText).toBe('Current Course Fallback Biology');
});

test('updateCourseDisplay delegates to forceUpdateCourseName when no direct course-name selector resolves', async ({ page }) => {
    await openStudentWithMocks(page);

    const result = await page.evaluate(() => {
        const w = /** @type {any} */ (window);
        document.querySelectorAll('.course-name').forEach((element) => element.remove());
        document.body.insertAdjacentHTML('beforeend', '<div id="forced-course-name">Not forced</div>');

        const originalQuerySelector = Document.prototype.querySelector;
        const originalForceUpdate = w.forceUpdateCourseName;
        Document.prototype.querySelector = function(selector) {
            if (selector === '.course-name' || selector === 'span.course-name' || selector === '.current-course .course-name') {
                return null;
            }
            return originalQuerySelector.call(this, selector);
        };
        w.forceUpdateCourseName = (courseName) => {
            const status = document.getElementById('forced-course-name');
            if (status) {
                status.textContent = `forced: ${courseName}`;
            }
            return true;
        };

        try {
            w.updateCourseDisplay({ courseName: 'Forced Fallback Biology' });
        } finally {
            w.forceUpdateCourseName = originalForceUpdate;
            Document.prototype.querySelector = originalQuerySelector;
        }

        return document.getElementById('forced-course-name')?.textContent;
    });

    expect(result).toBe('forced: Forced Fallback Biology');
});

test('current course id follows preferences, storage, course list, and error fallbacks', async ({ page }) => {
    const harness = await openStudentWithMocks(page, { seedSelectedCourse: false });

    // getCurrentCourseId now reads the shared auth.js state via
    // waitForCurrentUser() rather than fetching /api/auth/me directly.
    await page.evaluate((courseId) => {
        const w = /** @type {any} */ (window);
        w.waitForCurrentUser = () => Promise.resolve({ preferences: { courseId } });
    }, SECOND_COURSE_ID);
    await expect.poll(() => page.evaluate(() => {
        const w = /** @type {any} */ (window);
        return w.getCurrentCourseId();
    })).toBe(SECOND_COURSE_ID);

    await page.evaluate(() => {
        const w = /** @type {any} */ (window);
        w.waitForCurrentUser = () => Promise.resolve({ preferences: {} });
    });
    await page.evaluate((courseId) => localStorage.setItem('selectedCourseId', courseId), COURSE_ID);
    await expect.poll(() => page.evaluate(() => {
        const w = /** @type {any} */ (window);
        return w.getCurrentCourseId();
    })).toBe(COURSE_ID);

    await page.evaluate(() => localStorage.removeItem('selectedCourseId'));
    harness.setAvailableCourses({ success: true, data: [{ courseId: SECOND_COURSE_ID, courseName: 'Single Course' }] });
    await expect.poll(() => page.evaluate(() => {
        const w = /** @type {any} */ (window);
        return w.getCurrentCourseId();
    })).toBe(SECOND_COURSE_ID);

    await page.evaluate(() => localStorage.removeItem('selectedCourseId'));
    harness.setAvailableCourses({
        success: true,
        data: [
            { courseId: COURSE_ID, courseName: COURSE_NAME },
            { courseId: SECOND_COURSE_ID, courseName: 'Second Course' },
        ],
    });
    await expect.poll(() => page.evaluate(() => {
        const w = /** @type {any} */ (window);
        return w.getCurrentCourseId();
    })).toBeNull();

    harness.setAvailableCourses({ success: true, data: [] });
    await expect.poll(() => page.evaluate(() => {
        const w = /** @type {any} */ (window);
        return w.getCurrentCourseId();
    })).toBeNull();

    harness.setAvailableCourses({ success: false, message: 'Course list unavailable', data: [] });
    await expect.poll(() => page.evaluate(() => {
        const w = /** @type {any} */ (window);
        return w.getCurrentCourseId();
    })).toBeNull();

    harness.setAvailableCourses({ status: 500, body: { success: false } });
    await expect.poll(() => page.evaluate(() => {
        const w = /** @type {any} */ (window);
        return w.getCurrentCourseId();
    })).toBeNull();
});
