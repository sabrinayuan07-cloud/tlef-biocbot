// @ts-check
/**
 * Focused browser coverage for public/student/scripts/student.js.
 *
 * These tests intentionally exercise client-side branches that are not covered
 * by the broader student API/history suite.
 */

const { test, expect } = require('./fixtures/monocart');
const { TEST_USERS, storageStatePath } = require('./helpers/users');
const { withDb, getUserIdByUsername } = require('./helpers/quiz');
const {
    STU_COURSE_ID,
    STU_OTHER_COURSE_ID,
    getStudentId,
    resetStudentChatData,
    cleanupStudentChatData,
    setUserAgreement,
} = require('./helpers/student');

/**
 * @typedef {Window & {
 *   addMessage?: (
 *     content: string,
 *     type?: string,
 *     showActions?: boolean,
 *     showFlag?: boolean,
 *     sourceAttribution?: Record<string, unknown> | null
 *   ) => void,
 *   renderPracticeQuestion?: (question: Record<string, unknown>) => void
 * }} StudentWindow
 */

let instructorId;
let studentId;

test.use({ storageState: storageStatePath('student') });

test.beforeAll(async () => {
    instructorId = await getUserIdByUsername(TEST_USERS.instructor.username);
    studentId = await getStudentId();
});

test.afterAll(async () => {
    await cleanupStudentChatData();
});

test.beforeEach(async () => {
    await resetStudentChatData({ instructorId });
    await setUserAgreement(studentId, true);
});

async function openStudentChat(page, options = {}) {
    const {
        courseId = STU_COURSE_ID,
        courseName = 'BIOC E2E Student Chat',
        unitName = 'Unit 1',
        chatData = null,
    } = options;

    await page.addInitScript(({ courseId, courseName, unitName, studentId, chatData }) => {
        try {
            localStorage.clear();
            localStorage.setItem('selectedCourseId', courseId);
            localStorage.setItem('selectedCourseName', courseName);
            localStorage.setItem('selectedUnitName', unitName);

            const initialChatData = chatData || {
                metadata: {
                    courseId,
                    courseName,
                    studentId,
                    studentName: 'E2E Student',
                    unitName,
                    currentMode: 'tutor',
                    totalMessages: 0,
                    version: '1.0',
                },
                messages: [],
                practiceTests: null,
                studentAnswers: { answers: [] },
                sessionInfo: {
                    sessionId: `e2e_${courseId}_${unitName}`,
                    startTime: new Date().toISOString(),
                    duration: '0 minutes',
                },
                lastActivityTimestamp: new Date().toISOString(),
            };
            localStorage.setItem(`biocbot_current_chat_${studentId}`, JSON.stringify(initialChatData));
            localStorage.setItem(`biocbot_session_${studentId}_${courseId}_${unitName}`, initialChatData.sessionInfo.sessionId);
        } catch (_) {}
    }, { courseId, courseName, unitName, studentId, chatData });

    await page.goto('/student');
}

async function waitForStudentFunctions(page, names) {
    await page.waitForFunction((names) => names.every((name) => {
        const studentWindow = /** @type {StudentWindow & Record<string, unknown>} */ (/** @type {unknown} */ (window));
        return typeof studentWindow[name] === 'function';
    }), names);
}

async function waitForDirectChatReady(page) {
    await expect(page.locator('#chat-messages')).toContainText('No Questions Available', { timeout: 15_000 });
    await expect(page.locator('#chat-input')).toBeEnabled();
    await page.waitForTimeout(750);
}

async function openStudentScriptHarness(page, options = {}) {
    const {
        courseId = STU_COURSE_ID,
        courseName = 'BIOC E2E Harness Course',
        unitName = 'Unit 1',
        currentMode = 'tutor',
        chatData = null,
    } = options;
    const harnessState = {
        courseId,
        courseName,
        unitName,
        currentMode,
        studentId,
        chatData,
    };

    await page.route('**/__student_js_harness', async (route) => {
        await route.fulfill({
            contentType: 'text/html',
            body: `<!doctype html>
<html>
<head>
    <title>student.js harness</title>
    <link rel="stylesheet" href="/styles/style.css">
    <link rel="stylesheet" href="/styles/chat.css">
    <link rel="stylesheet" href="/styles/agreement-modal.css">
</head>
<body>
    <div class="app-container">
        <aside class="sidebar">
            <nav class="main-nav"></nav>
            <div class="new-session-container"><button id="new-session-btn" type="button">New Session</button></div>
            <div class="user-info">
                <div id="user-display-name">Student Name</div>
                <div class="user-role">Student</div>
            </div>
        </aside>
        <main class="main-content">
            <header class="chat-header">
                <h1>Chat with BiocBot</h1>
                <div class="current-course">
                    <span class="course-label">Course:</span>
                    <span class="course-name">Select Course</span>
                </div>
                <div class="unit-selection-container" id="unit-selection-container" style="display:none;">
                    <select id="unit-select"><option value="">Choose a unit...</option></select>
                </div>
            </header>
            <div class="chat-container">
                <div class="messages" id="chat-messages"></div>
                <div class="chat-input-container">
                    <form id="chat-form" autocomplete="off">
                        <input id="chat-input" name="chat-message-input" type="text" placeholder="Type your message here...">
                        <button id="send-button" type="submit">Send</button>
                    </form>
                    <a href="#" id="view-rules-link">View General Rules</a>
                    <div class="mode-toggle-container">
                        <span class="mode-label protege-label">Protege</span>
                        <input id="mode-toggle-checkbox" type="checkbox" checked>
                        <span class="mode-label tutor-label active">Tutor</span>
                    </div>
                </div>
            </div>
        </main>
    </div>
    <script>
    (() => {
        const state = ${JSON.stringify(harnessState)};
        localStorage.clear();
        sessionStorage.clear();
        localStorage.setItem('selectedCourseId', state.courseId);
        localStorage.setItem('selectedCourseName', state.courseName);
        localStorage.setItem('selectedUnitName', state.unitName);
        localStorage.setItem('studentMode', state.currentMode);

        const seededChat = state.chatData || {
            metadata: {
                exportDate: new Date().toISOString(),
                courseId: state.courseId,
                courseName: state.courseName,
                studentId: state.studentId,
                studentName: 'Harness Student',
                unitName: state.unitName,
                currentMode: state.currentMode,
                totalMessages: 0,
                version: '1.0'
            },
            messages: [],
            practiceTests: null,
            studentAnswers: { answers: [] },
            sessionInfo: {
                sessionId: 'harness_session_' + state.courseId + '_' + state.unitName,
                startTime: new Date().toISOString(),
                duration: '0 minutes'
            },
            lastActivityTimestamp: new Date().toISOString()
        };
        localStorage.setItem('biocbot_current_chat_' + state.studentId, JSON.stringify(seededChat));
        localStorage.setItem('biocbot_session_' + state.studentId + '_' + state.courseId + '_' + state.unitName, seededChat.sessionInfo.sessionId);

        window.__fetchLog = [];
        window.__alerts = [];
        window.__prompts = [];
        window.__confirms = [];
        window.__promptValue = 'JOIN-CODE';
        window.__confirmValue = true;
        window.alert = (message) => window.__alerts.push(String(message));
        window.prompt = (message) => {
            window.__prompts.push(String(message));
            return window.__promptValue;
        };
        window.confirm = (message) => {
            window.__confirms.push(String(message));
            return window.__confirmValue;
        };

        window.__currentUser = {
            userId: state.studentId,
            username: 'e2e_student',
            role: 'student',
            displayName: 'Harness Student'
        };
        window.getCurrentUser = () => window.__currentUser;
        window.initializeIdleTimer = () => {
            window.__idleInitialized = true;
        };
        window.checkForFlagUpdates = () => {
            window.__flagUpdateChecked = true;
        };
        window.applyLLMBodyTag = async () => {
            window.__bodyTagApplied = true;
        };
        window.applyLLMTagClassesToElement = (element) => {
            element.classList.add('llm-tagged');
        };
        window.agreementModal = {
            show(readOnly) {
                window.__agreementShown = readOnly;
            }
        };

        const courseDoc = {
            courseId: state.courseId,
            id: state.courseId,
            courseName: state.courseName,
            name: state.courseName,
            lectures: [{
                name: state.unitName,
                displayName: state.unitName,
                isPublished: true,
                updatedAt: new Date().toISOString(),
                passThreshold: 0,
                documents: [],
                assessmentQuestions: []
            }]
        };
        window.__fetchMocks = {
            ['/api/courses/' + state.courseId + '/student-enrollment']: {
                success: true,
                data: { enrolled: true, status: 'active' }
            },
            '/api/auth/me': {
                success: true,
                user: { userId: state.studentId, role: 'student', displayName: 'Harness Student', preferences: {} }
            },
            '/api/courses/available/all': {
                success: true,
                data: [{ courseId: state.courseId, courseName: state.courseName, isEnrolled: true }]
            },
            ['/api/courses/' + state.courseId]: {
                success: true,
                data: courseDoc
            },
            '/api/questions/lecture': {
                success: true,
                data: { questions: [] }
            },
            '/api/student/struggle': {
                success: true,
                struggleState: { topics: [] }
            },
            '/api/chat/save': { success: true },
            '/api/chat': { success: true, message: 'Harness chat reply', sourceAttribution: null },
            '/api/flags': { success: true },
            '/api/chat/practice-question': {
                success: true,
                data: {
                    practiceId: 'default_practice',
                    questionType: 'multiple-choice',
                    question: 'Default practice?',
                    options: { A: 'Alpha', B: 'Beta' }
                }
            },
            '/api/chat/check-practice-answer': {
                success: true,
                data: { correct: true, feedback: 'Correct feedback', correctAnswer: 'A' }
            },
            '/api/questions/check-answer': {
                success: true,
                data: { correct: true, feedback: 'AI says this is correct.' }
            },
            '/api/student/struggle/reset': { success: true }
        };

        window.fetch = async (input, init = {}) => {
            const url = String(input);
            const method = init.method || 'GET';
            let parsedBody = null;
            if (init.body) {
                try {
                    parsedBody = JSON.parse(init.body);
                } catch (_) {
                    parsedBody = init.body;
                }
            }
            window.__fetchLog.push({ url, method, body: parsedBody });

            let mock = window.__fetchMocks[url];
            if (mock === undefined) {
                const path = new URL(url, window.location.href).pathname;
                mock = window.__fetchMocks[path];
            }
            if (mock === undefined) {
                const entry = Object.entries(window.__fetchMocks).find(([key]) => url.includes(key));
                mock = entry && entry[1];
            }
            if (Array.isArray(mock)) {
                mock = mock.length > 1 ? mock.shift() : mock[0];
            }
            if (typeof mock === 'function') {
                mock = await mock(url, init);
            }
            if (!mock) {
                mock = { success: true, data: {} };
            }
            if (mock.throw) {
                throw new Error(mock.throw);
            }

            const status = mock.status || 200;
            const ok = Object.prototype.hasOwnProperty.call(mock, 'ok') ? mock.ok : status < 400;
            const payload = Object.prototype.hasOwnProperty.call(mock, 'json') ? mock.json : mock;
            return {
                ok,
                status,
                statusText: String(status),
                json: async () => payload,
                text: async () => mock.text || JSON.stringify(payload)
            };
        };
    })();
    </script>
    <script src="/common/scripts/biocbot-events.js"></script>
    <script src="/common/scripts/assessment-scoring.js"></script>
    <script src="/student/scripts/student-state.js"></script>
    <script src="/student/scripts/student-chat-core.js"></script>
    <script src="/student/scripts/student-chat-request.js"></script>
    <script src="/student/scripts/student-practice.js"></script>
    <script src="/student/scripts/student-session.js"></script>
    <script src="/student/scripts/student-restore.js"></script>
    <script src="/student/scripts/student-course.js"></script>
    <script src="/student/scripts/student-calibration.js"></script>
    <script src="/student/scripts/student.js"></script>
</body>
</html>`,
        });
    });

    await page.goto('/__student_js_harness');
    await page.waitForFunction(() => {
        const harnessWindow = /** @type {Window & Record<string, unknown>} */ (/** @type {unknown} */ (window));
        return typeof harnessWindow.addMessage === 'function' &&
            typeof harnessWindow.sendMessageToLLM === 'function';
    });
    await page.waitForTimeout(250);
}

test.describe('Course/unit initialization and saved state', () => {
    test('rotates an autosave beyond the configured inactivity window', async ({ page }) => {
        const oldSessionId = 'e2e_stale_local_session';
        const staleChat = {
            metadata: {
                courseId: STU_COURSE_ID,
                courseName: 'BIOC E2E Student Chat',
                studentId,
                studentName: 'E2E Student',
                unitName: 'Unit 1',
                currentMode: 'tutor',
                totalMessages: 2,
                version: '1.0',
            },
            messages: [
                { type: 'user', content: 'old question', timestamp: '2026-01-01T00:00:00Z' },
                { type: 'bot', content: 'old answer', timestamp: '2026-01-01T00:00:05Z' },
            ],
            practiceTests: null,
            studentAnswers: { answers: [] },
            sessionInfo: {
                sessionId: oldSessionId,
                startTime: '2026-01-01T00:00:00Z',
                duration: '5s',
            },
            lastActivityTimestamp: '2026-01-01T00:00:05Z',
        };

        await openStudentChat(page, { chatData: staleChat });

        await expect.poll(() => page.evaluate((studentId) => {
            const raw = localStorage.getItem(`biocbot_current_chat_${studentId}`);
            return raw ? JSON.parse(raw).sessionInfo?.sessionId : null;
        }, studentId)).not.toBe(oldSessionId);
        await expect.poll(() => page.evaluate(({ studentId, courseId }) =>
            localStorage.getItem(`biocbot_session_${studentId}_${courseId}_Unit 1`),
        { studentId, courseId: STU_COURSE_ID })).not.toBe(oldSessionId);
        await expect(page.locator('#chat-messages')).not.toContainText('old question');
    });

    test('starts a visibly new session when the student returns to a stale tab', async ({ page }) => {
        await openStudentChat(page);
        await waitForDirectChatReady(page);

        const oldSessionId = 'e2e_background_tab_session';
        await page.evaluate(({ studentId, courseId, oldSessionId }) => {
            const staleChat = {
                metadata: {
                    courseId,
                    courseName: 'BIOC E2E Student Chat',
                    studentId,
                    studentName: 'E2E Student',
                    unitName: 'Unit 1',
                    currentMode: 'tutor',
                    totalMessages: 2,
                    version: '1.0',
                },
                messages: [
                    { type: 'user', content: 'STALE TAB QUESTION', timestamp: '2026-01-01T00:00:00Z' },
                    { type: 'bot', content: 'STALE TAB ANSWER', timestamp: '2026-01-01T00:00:05Z' },
                ],
                practiceTests: null,
                studentAnswers: { answers: [] },
                sessionInfo: { sessionId: oldSessionId, startTime: '2026-01-01T00:00:00Z', duration: '5s' },
                lastActivityTimestamp: '2026-01-01T00:00:05Z',
            };
            localStorage.setItem(`biocbot_current_chat_${studentId}`, JSON.stringify(staleChat));
            localStorage.setItem(`biocbot_session_${studentId}_${courseId}_Unit 1`, oldSessionId);
            document.getElementById('chat-messages').innerHTML = '<div>STALE TAB QUESTION</div>';
            const w = /** @type {any} */ (window);
            w.setChatSessionTimeoutSeconds(30);
            window.dispatchEvent(new Event('focus'));
        }, { studentId, courseId: STU_COURSE_ID, oldSessionId });

        await expect(page.locator('#chat-messages')).not.toContainText('STALE TAB QUESTION');
        await expect(page.locator('#chat-messages')).toContainText(
            'Your previous session ended after 30 seconds of inactivity. A new session has started.'
        );
        await expect(page.locator('.notification.info')).toContainText(
            'Previous session expired — new chat session started'
        );
        await expect.poll(() => page.evaluate((studentId) => {
            const raw = localStorage.getItem(`biocbot_current_chat_${studentId}`);
            return raw ? JSON.parse(raw).sessionInfo?.sessionId : null;
        }, studentId)).not.toBe(oldSessionId);
    });

    test('a unit with no assessment questions enables direct chat and preserves the selected unit', async ({ page }) => {
        await openStudentChat(page);

        await expect(page.locator('#unit-select')).toHaveValue('Unit 1', { timeout: 15_000 });
        await waitForDirectChatReady(page);
        await expect(page.locator('#chat-messages')).toContainText('Welcome to BiocBot!');
        await expect(page.locator('.bot-message').filter({ hasText: 'Welcome to BiocBot!' })).toHaveCount(1);
        await expect.poll(() => page.evaluate(() => localStorage.getItem('selectedUnitName'))).toBe('Unit 1');
    });

    test('does not restore recent saved chat data from a different course', async ({ page }) => {
        const leakedText = 'CROSS_COURSE_LOCALSTORAGE_LEAK_SENTINEL';
        await openStudentChat(page, {
            courseId: STU_COURSE_ID,
            chatData: {
                metadata: {
                    courseId: STU_OTHER_COURSE_ID,
                    courseName: 'BIOC E2E Student Chat (Other Course)',
                    studentId,
                    studentName: 'E2E Student',
                    unitName: 'Unit 1',
                    currentMode: 'tutor',
                    totalMessages: 1,
                    version: '1.0',
                },
                messages: [
                    {
                        type: 'bot',
                        content: leakedText,
                        messageType: 'regular-chat',
                        timestamp: new Date().toISOString(),
                    },
                ],
                practiceTests: null,
                studentAnswers: { answers: [] },
                sessionInfo: {
                    sessionId: 'e2e_cross_course_stale_session',
                    startTime: new Date().toISOString(),
                    duration: '0 minutes',
                },
                lastActivityTimestamp: new Date().toISOString(),
            },
        });

        await expect(page.locator('#chat-messages')).not.toContainText(leakedText, { timeout: 15_000 });
        await expect.poll(() => page.evaluate(() => localStorage.getItem('selectedCourseId'))).not.toBe(STU_OTHER_COURSE_ID);
    });
});

test.describe('Chat input request behavior', () => {
    test('empty submit does not call /api/chat or append a user message', async ({ page }) => {
        let chatCalls = 0;
        await page.route('/api/chat', async (route) => {
            chatCalls += 1;
            await route.fulfill({ json: { success: true, message: 'unexpected' } });
        });

        await openStudentChat(page);
        await waitForDirectChatReady(page);

        await page.locator('#chat-input').fill('   ');
        await page.locator('#send-button').click();
        await page.waitForTimeout(500);

        expect(chatCalls).toBe(0);
        await expect(page.locator('.user-message')).toHaveCount(0);
    });

    test('API failure removes the typing indicator and renders the generic chat error', async ({ page }) => {
        await page.route('/api/chat', async (route) => {
            await route.fulfill({
                status: 500,
                contentType: 'application/json',
                body: JSON.stringify({ success: false, message: 'simulated chat failure' }),
            });
        });

        await openStudentChat(page);
        await waitForDirectChatReady(page);

        await page.locator('#chat-input').fill('please fail');
        await page.locator('#chat-input').press('Enter');

        await expect(page.locator('#typing-indicator')).toHaveCount(0, { timeout: 10_000 });
        await expect(page.locator('#chat-messages')).toContainText('Sorry, I encountered an error processing your message.');
    });

    test('disables chat controls while a slow chat request is in flight', async ({ page }) => {
        /** @type {() => void} */
        let releaseResponse = () => {};
        const responseGate = new Promise((resolve) => {
            releaseResponse = () => resolve(undefined);
        });

        await page.route('/api/chat', async (route) => {
            await responseGate;
            await route.fulfill({
                json: {
                    success: true,
                    message: 'slow response finished',
                    sourceAttribution: { description: 'test source' },
                },
            });
        });

        await openStudentChat(page);
        await waitForDirectChatReady(page);

        await page.locator('#chat-input').fill('slow request');
        await page.locator('#chat-input').press('Enter');

        await expect(page.locator('#typing-indicator')).toBeVisible();
        await expect(page.locator('#chat-input')).toBeDisabled();
        await expect(page.locator('#send-button')).toBeDisabled();

        releaseResponse();
        await expect(page.locator('#typing-indicator')).toHaveCount(0, { timeout: 10_000 });
        await expect(page.locator('#chat-messages')).toContainText('slow response finished');
    });
});

test.describe('Source attribution and flag menus', () => {
    test('renders source fallback text, multiple downloads, and missing document metadata', async ({ page }) => {
        await openStudentChat(page);
        await waitForDirectChatReady(page);
        await waitForStudentFunctions(page, ['addMessage']);

        await page.evaluate(() => {
            const studentWindow = /** @type {StudentWindow} */ (window);

            studentWindow.addMessage?.(
                'Downloads disabled response',
                'bot',
                true,
                true,
                {
                    description: 'Instructor materials only',
                    downloadsEnabled: false,
                    documents: [{ documentId: 'doc_hidden', fileName: 'Hidden.pdf' }],
                }
            );
            studentWindow.addMessage?.(
                'Downloadable response',
                'bot',
                true,
                true,
                {
                    description: 'Should prefer documents',
                    downloadsEnabled: true,
                    documents: [
                        { documentId: 'doc_alpha', fileName: 'Alpha.pdf', documentType: 'Lecture Notes', lectureName: 'Unit 1' },
                        { documentId: 'doc_missing_name', documentType: 'Practice Questions' },
                        { fileName: 'Ignored because missing id' },
                    ],
                }
            );
        });

        const disabledMessage = page.locator('.bot-message').filter({ hasText: 'Downloads disabled response' });
        await expect(disabledMessage.locator('.message-source')).toHaveText('Source: Instructor materials only');
        await expect(disabledMessage.locator('.message-source a')).toHaveCount(0);

        const downloadableMessage = page.locator('.bot-message').filter({ hasText: 'Downloadable response' });
        await expect(downloadableMessage.locator('.message-source a')).toHaveCount(2);
        await expect(downloadableMessage.locator('.message-source')).toContainText('Alpha.pdf — Lecture Notes (Unit 1)');
        await expect(downloadableMessage.locator('.message-source')).toContainText('Source Document — Practice Questions');
        await expect(downloadableMessage.locator('.message-source a').first()).toHaveAttribute(
            'href',
            new RegExp(`/api/chat/source-documents/doc_alpha/download\\?courseId=${STU_COURSE_ID}`)
        );
    });

    test('flag menu closes on outside click and submits the selected reason', async ({ page }) => {
        /** @type {{ flagReason?: string, courseId?: string } | undefined} */
        let flagPayload;
        await page.route('/api/flags', async (route) => {
            flagPayload = route.request().postDataJSON();
            await route.fulfill({ json: { success: true } });
        });

        await openStudentChat(page);
        await waitForDirectChatReady(page);
        await waitForStudentFunctions(page, ['addMessage']);
        await page.evaluate(() => {
            const studentWindow = /** @type {StudentWindow} */ (window);
            studentWindow.addMessage?.('Flaggable bot response', 'bot', false, true, null);
        });

        const message = page.locator('.bot-message').filter({ hasText: 'Flaggable bot response' }).last();
        await message.locator('.flag-button').click();
        const flagMenu = page.locator('.flag-menu').last();
        await expect(flagMenu).toHaveClass(/show/);

        await page.locator('body').click({ position: { x: 5, y: 5 } });
        await expect(flagMenu).not.toHaveClass(/show/);

        await message.locator('.flag-button').click();
        await expect(flagMenu).toHaveClass(/show/);
        await flagMenu.locator('.flag-option', { hasText: 'Unclear' }).click();

        await expect(page.locator('#chat-messages')).toContainText('Thank you for reporting this response as unclear or confusing content');
        await expect.poll(() => flagPayload?.flagReason).toBe('unclear');
        if (!flagPayload) {
            throw new Error('Expected flag payload to be submitted');
        }
        expect(flagPayload.courseId).toBe(STU_COURSE_ID);
    });
});

test.describe('Practice question UI', () => {
    test('validates unanswered multiple-choice and short-answer practice questions before calling the API', async ({ page }) => {
        let checkCalls = 0;
        await page.route('/api/chat/check-practice-answer', async (route) => {
            checkCalls += 1;
            await route.fulfill({ json: { success: true, data: { correct: true, feedback: 'ok', correctAnswer: 'A' } } });
        });

        await openStudentChat(page);
        await waitForDirectChatReady(page);
        await waitForStudentFunctions(page, ['renderPracticeQuestion']);

        await page.evaluate(() => {
            const studentWindow = /** @type {StudentWindow} */ (window);

            studentWindow.renderPracticeQuestion?.({
                practiceId: 'pq_mc_validation',
                questionType: 'multiple-choice',
                question: 'Which option is correct?',
                options: { A: 'Alpha', B: 'Beta' },
            });
            studentWindow.renderPracticeQuestion?.({
                practiceId: 'pq_sa_validation',
                questionType: 'short-answer',
                question: 'Explain briefly.',
            });
        });

        const mc = page.locator('[data-practice-id="pq_mc_validation"]');
        await mc.locator('.practice-submit-btn').click();
        await expect(mc.locator('.practice-feedback')).toContainText('Please select an answer.');

        const shortAnswer = page.locator('[data-practice-id="pq_sa_validation"]');
        await shortAnswer.locator('.practice-submit-btn').click();
        await expect(shortAnswer.locator('.practice-feedback')).toContainText('Please type your answer.');

        expect(checkCalls).toBe(0);
    });

    test('renders true/false completion and recovers from check-answer API failure', async ({ page }) => {
        await page.route('/api/chat/check-practice-answer', async (route) => {
            const body = route.request().postDataJSON();
            if (body.practiceId === 'pq_tf_success') {
                await route.fulfill({
                    json: {
                        success: true,
                        data: {
                            correct: false,
                            feedback: 'Review the definition again.',
                            correctAnswer: 'True',
                        },
                    },
                });
                return;
            }

            await route.fulfill({ json: { success: false, message: 'check failed' } });
        });

        await openStudentChat(page);
        await waitForDirectChatReady(page);
        await waitForStudentFunctions(page, ['renderPracticeQuestion']);

        await page.evaluate(() => {
            const studentWindow = /** @type {StudentWindow} */ (window);

            studentWindow.renderPracticeQuestion?.({
                practiceId: 'pq_tf_success',
                questionType: 'true-false',
                question: 'BiocBot is deterministic.',
            });
            studentWindow.renderPracticeQuestion?.({
                practiceId: 'pq_mc_failure',
                questionType: 'multiple-choice',
                question: 'Which answer should fail?',
                options: { A: 'One', B: 'Two' },
            });
        });

        const tf = page.locator('[data-practice-id="pq_tf_success"]');
        await tf.locator('input[value="False"]').check();
        await tf.locator('.practice-submit-btn').click();
        await expect(page.locator('.practice-completed').filter({ hasText: 'Review the definition again.' })).toBeVisible();

        const failed = page.locator('[data-practice-id="pq_mc_failure"]');
        await failed.locator('input[value="A"]').check();
        await failed.locator('.practice-submit-btn').click();
        await expect(failed.locator('.practice-feedback')).toContainText('check failed');
        await expect(failed.locator('.practice-submit-btn')).toBeEnabled();
    });
});

test.describe('Assessment calibration', () => {
    test('mixed assessment question types can fail into tutor mode', async ({ page }) => {
        await withDb(async (db) => {
            await db.collection('courses').updateOne(
                { courseId: STU_COURSE_ID, 'lectures.name': 'Unit 1' },
                {
                    $set: {
                        'lectures.$.passThreshold': 3,
                        'lectures.$.assessmentQuestions': [
                            {
                                questionId: 'e2e_mixed_mc',
                                questionType: 'multiple-choice',
                                question: 'Which letter is correct?',
                                options: { A: 'Correct', B: 'Incorrect' },
                                correctAnswer: 'A',
                                explanation: 'A is correct.',
                            },
                            {
                                questionId: 'e2e_mixed_tf',
                                questionType: 'true-false',
                                question: 'This statement is true.',
                                correctAnswer: 'True',
                                explanation: 'It is true.',
                            },
                            {
                                questionId: 'e2e_mixed_sa',
                                questionType: 'short-answer',
                                question: 'Explain the concept.',
                                correctAnswer: 'A detailed explanation',
                                explanation: 'Expected detail.',
                            },
                        ],
                    },
                }
            );
        });

        await page.route('/api/questions/check-answer', async (route) => {
            await route.fulfill({
                json: {
                    success: true,
                    data: { correct: false, feedback: 'Needs more detail.' },
                },
            });
        });

        await openStudentChat(page);

        await expect(page.locator('.assessment-start')).toHaveAttribute('data-timestamp', /^\d+$/);
        await expect(page.locator('#calibration-question-0')).toContainText('Which letter is correct?', { timeout: 15_000 });
        await page.locator('#calibration-question-0 .calibration-option', { hasText: 'B. Incorrect' }).click();

        await expect(page.locator('#calibration-question-1')).toContainText('This statement is true.');
        await page.locator('#calibration-question-1 .calibration-option', { hasText: 'False' }).click();

        await expect(page.locator('#calibration-question-2')).toContainText('Explain the concept.');
        await page.locator('#calibration-question-2 .calibration-answer-input').fill('too short');
        await page.locator('#calibration-question-2 .calibration-submit-btn').click();

        await expect(page.locator('.mode-result')).toContainText('BiocBot is in tutor mode', { timeout: 10_000 });
        await expect.poll(() => page.evaluate(() => localStorage.getItem('studentMode'))).toBe('tutor');
        await expect(page.locator('#chat-input')).toBeEnabled();
    });
});

test.describe('student.js compact browser harness', () => {
    test('renders message actions, flag replacement, source downloads, and restored history shapes', async ({ page }) => {
        await openStudentScriptHarness(page);

        await page.evaluate(() => {
            const w = /** @type {any} */ (window);
            w.addMessage(
                "Hello! I'm BiocBot, your AI study assistant for this course.",
                'bot',
                true,
                true,
                { description: 'Should be suppressed' }
            );
            w.addMessage(
                'Source-rich bot response',
                'bot',
                true,
                false,
                {
                    description: 'Fallback source text',
                    downloadsEnabled: true,
                    documents: [
                        { documentId: 'doc alpha', fileName: 'Alpha.pdf', lectureName: 'Unit 1' },
                        { documentId: 'doc-beta' },
                        { fileName: 'Missing id ignored.pdf' },
                    ],
                },
                false,
                'photosynthesis',
                'glycolysis'
            );
            w.addMessage('<div class="custom-html">HTML block</div>', 'bot', false, false, null, true);
            w.showTypingIndicator();
            w.removeTypingIndicator();

            w.renderRestoredModeResult({
                content: 'saved mode',
                htmlContent: '<div class="mode-explanation">Restored tutor result</div>',
                timestamp: new Date().toISOString(),
                displayTimestamp: '5 minutes ago',
            });
            w.renderRestoredModeToggleResult({
                content: 'toggle mode',
                htmlContent: '<p>Restored toggle result</p>',
                timestamp: new Date().toISOString(),
            });
            w.renderRestoredPracticeQuestion({
                content: '[practice]',
                messageType: 'practice-test-question',
                timestamp: new Date().toISOString(),
                displayTimestamp: 'Just now',
                questionData: {
                    questionIndex: 2,
                    questionText: 'Restored harness question?',
                    options: [
                        { text: 'A. first', isSelected: false },
                        { text: 'B. second', isSelected: true },
                    ],
                    studentAnswer: 'B',
                    feedback: '<strong>Saved feedback</strong>',
                },
            });
            w.renderRestoredPracticeQuestion({
                content: 'fallback restored practice text',
                timestamp: new Date().toISOString(),
                questionData: null,
            });
        });

        const sourced = page.locator('.bot-message').filter({ hasText: 'Source-rich bot response' }).last();
        await expect(sourced.locator('.message-source a')).toHaveCount(2);
        await expect(sourced.locator('.message-source')).toContainText('Alpha.pdf (Unit 1)');
        await expect(sourced.locator('.message-action-btn', { hasText: 'Explain' })).toBeVisible();
        await expect(sourced.locator('.practice-question-btn')).toHaveText('Ask me a question');
        await expect(sourced.locator('.struggle-reset-btn')).toContainText('I understand Photosynthesis now');
        await expect(sourced).toHaveClass(/llm-tagged/);

        await sourced.locator('.flag-button').click();
        await sourced.locator('.flag-menu .flag-option', { hasText: 'Typo/Error' }).click();
        await expect(page.locator('.bot-message').filter({ hasText: 'Thank you for reporting this response as typo or error' })).toBeVisible();
        await expect.poll(() => page.evaluate(() => {
            const w = /** @type {any} */ (window);
            return w.__fetchLog.findLast((entry) => entry.url === '/api/flags')?.body?.flagReason;
        })).toBe('typo');

        await expect(page.locator('.bot-message.mode-result')).toContainText('Restored tutor result');
        await expect(page.locator('.bot-message.mode-toggle-result')).toContainText('Restored toggle result');
        await expect(page.locator('#calibration-question-2')).toContainText('Restored harness question?');
        await expect(page.locator('.calibration-feedback')).toContainText('Saved feedback');
        await expect(page.locator('.bot-message').filter({ hasText: 'fallback restored practice text' })).toBeVisible();

        const collected = await page.evaluate(async (sid) => {
            const w = /** @type {any} */ (window);
            const chatData = await w.collectAllChatData();
            w.saveChatToHistory({
                metadata: {
                    exportDate: new Date().toISOString(),
                    courseId: localStorage.getItem('selectedCourseId'),
                    courseName: 'BIOC Harness',
                    studentId: sid,
                    studentName: 'Harness Student',
                    unitName: 'Unit 1',
                    currentMode: 'tutor',
                    totalMessages: 1,
                    version: '1.0',
                },
                messages: [{ type: 'user', content: 'history question', timestamp: new Date().toISOString() }],
                practiceTests: null,
                studentAnswers: { answers: [] },
                sessionInfo: { duration: '1m' },
            });
            const history = w.getChatHistory();
            w.updateLastActivityTimestamp();
            const updated = JSON.parse(localStorage.getItem('biocbot_current_chat_' + sid));
            w.clearCurrentChatData();
            return {
                collectedMessages: chatData.messages.length,
                historyLength: history.length,
                byIdFound: Boolean(w.getChatById(history[0].id)),
                updatedHasActivity: Boolean(updated.lastActivityTimestamp),
                currentCleared: localStorage.getItem('biocbot_current_chat_' + sid) === null,
            };
        }, studentId);

        expect(collected.collectedMessages).toBeGreaterThan(3);
        expect(collected.historyLength).toBeGreaterThanOrEqual(1);
        expect(collected.byIdFound).toBe(true);
        expect(collected.updatedHasActivity).toBe(true);
        expect(collected.currentCleared).toBe(true);
    });

    test('preserves timestamps and elapsed timing through repeated history reloads', async ({ page }) => {
        await openStudentScriptHarness(page);

        const timing = await page.evaluate(async (studentId) => {
            const w = /** @type {any} */ (window);
            const originalMessages = [
                {
                    type: 'user', content: 'Original question', messageType: 'regular-chat',
                    timestamp: '2025-01-02T03:04:05.000Z', elapsedTime: 0, elapsedTimeDerived: false,
                },
                {
                    type: 'bot', content: '<strong>Starting assessment</strong>', messageType: 'assessment-start', isHtml: true,
                    timestamp: '2025-01-02T03:04:06.250Z', elapsedTime: 1250, elapsedTimeDerived: true,
                },
                {
                    type: 'bot', content: 'Saved assessment question', messageType: 'practice-test-question',
                    timestamp: '2025-01-02T03:04:08.750Z', elapsedTime: 2500, elapsedTimeDerived: false,
                    questionData: {
                        questionIndex: 0,
                        questionText: 'Saved assessment question',
                        options: [{ text: 'A. Stored answer', isSelected: true }],
                        studentAnswer: 'A',
                    },
                },
                {
                    type: 'bot', content: 'Saved mode result', messageType: 'mode-result',
                    timestamp: '2025-01-02T03:04:12.750Z', elapsedTime: 4000, elapsedTimeDerived: true,
                    htmlContent: '<div class="mode-explanation">Saved mode result</div>',
                },
            ];
            const chatData = {
                metadata: {
                    courseId: localStorage.getItem('selectedCourseId'),
                    courseName: 'BIOC Harness', studentId,
                    unitName: 'Unit 1', currentMode: 'tutor', totalMessages: originalMessages.length,
                },
                messages: originalMessages,
                practiceTests: null,
                studentAnswers: { answers: [] },
                sessionInfo: { sessionId: 'timing-session' },
                lastActivityTimestamp: new Date().toISOString(),
            };

            localStorage.setItem(
                `biocbot_current_chat_${studentId}`,
                JSON.stringify(chatData)
            );
            localStorage.setItem(
                `biocbot_session_${studentId}_${chatData.metadata.courseId}_Unit 1`,
                'timing-session'
            );

            const snapshot = (/** @type {any[]} */ messages) => messages.map(message => ({
                messageType: message.messageType,
                timestamp: message.timestamp,
                elapsedTime: message.elapsedTime,
                elapsedTimeDerived: message.elapsedTimeDerived,
            }));

            w.loadChatData(chatData);
            await new Promise(resolve => setTimeout(resolve, 650));
            const firstCollection = await w.collectAllChatData();
            const firstDom = Array.from(document.querySelectorAll('#chat-messages .message')).map((element) => {
                const messageElement = /** @type {HTMLElement} */ (element);
                return {
                    timestamp: messageElement.dataset.timestamp,
                    elapsedTime: messageElement.dataset.elapsedTime,
                    elapsedTimeDerived: messageElement.dataset.elapsedTimeDerived,
                };
            });

            w.loadChatData(firstCollection);
            await new Promise(resolve => setTimeout(resolve, 650));
            const secondCollection = await w.collectAllChatData();

            return {
                expected: snapshot(originalMessages),
                first: snapshot(firstCollection.messages),
                second: snapshot(secondCollection.messages),
                firstSessionId: firstCollection.sessionInfo.sessionId,
                secondSessionId: secondCollection.sessionInfo.sessionId,
                firstDom,
            };
        }, studentId);

        expect(timing.first).toEqual(timing.expected);
        expect(timing.second).toEqual(timing.expected);
        expect(timing.firstSessionId).toBe('timing-session');
        expect(timing.secondSessionId).toBe('timing-session');
        expect(timing.firstDom.every((message) =>
            /^\d+$/.test(String(message.timestamp))
            && /^\d+$/.test(String(message.elapsedTime))
            && /^(true|false)$/.test(String(message.elapsedTimeDerived))
        )).toBe(true);
    });

    test('submits chat context with practice history and renders directive-mode actions', async ({ page }) => {
        const seededChat = {
            metadata: {
                exportDate: new Date().toISOString(),
                courseId: STU_COURSE_ID,
                courseName: 'BIOC E2E Harness Course',
                studentId,
                studentName: 'Harness Student',
                unitName: 'Unit 1',
                currentMode: 'tutor',
                totalMessages: 4,
                version: '1.0',
            },
            messages: [
                { type: 'user', content: 'How does glycolysis start?', messageType: 'regular-chat', timestamp: new Date().toISOString() },
                { type: 'bot', content: 'It starts with phosphorylation.', messageType: 'regular-chat', timestamp: new Date().toISOString() },
            ],
            practiceTests: {
                questions: [{ question: 'ATP is used first?', correctAnswer: 'True' }],
                passThreshold: 50,
            },
            studentAnswers: {
                answers: [{ answer: 'False', isCorrect: false }],
            },
            sessionInfo: {
                sessionId: 'context_session',
                startTime: new Date().toISOString(),
                duration: '2m',
            },
            lastActivityTimestamp: new Date().toISOString(),
        };

        await openStudentScriptHarness(page, { chatData: seededChat });
        await expect(page.locator('#chat-messages')).toContainText('It starts with phosphorylation.', { timeout: 10_000 });
        await expect(page.locator('#chat-messages')).not.toContainText('Loading your previous chat...');
        await page.evaluate(() => {
            const w = /** @type {any} */ (window);
            w.currentCalibrationQuestions = [{
                question: 'ATP is used first?',
                type: 'true-false',
                correctAnswer: 'True',
                unitName: 'Unit 1',
                passThreshold: 50,
            }];
            w.studentAnswers = [1];
            w.currentPassThreshold = 50;
            w.__fetchMocks['/api/chat'] = {
                success: true,
                message: 'Directive response with topic actions.',
                sourceAttribution: { description: 'Harness source' },
                struggleState: {
                    topics: [{ topic: 'glycolysis', isActive: true }],
                },
                struggleDebug: {
                    directiveModeActive: true,
                    identifiedTopic: 'glycolysis',
                },
            };
        });

        await page.locator('#chat-input').fill('Explain glycolysis more');
        await page.locator('#chat-input').press('Enter');

        await expect(page.locator('#chat-messages')).toContainText('Directive response with topic actions.', { timeout: 10_000 });
        await expect(page.locator('#directive-mode-indicator')).toBeVisible();
        const directiveMessage = page.locator('.bot-message').filter({ hasText: 'Directive response with topic actions.' }).last();
        await expect(directiveMessage.locator('.struggle-reset-btn')).toContainText('I understand Glycolysis now');
        await expect(directiveMessage.locator('.practice-question-btn')).toHaveText('Ask me a question');

        const request = await page.evaluate(() => {
            const w = /** @type {any} */ (window);
            return w.__fetchLog.findLast((entry) => entry.url === '/api/chat')?.body;
        });

        expect(request.message).toBe('Explain glycolysis more');
        expect(request.mode).toBe('tutor');
        expect(request.conversationContext.hasPracticeTest).toBe(true);
        expect(request.conversationContext.conversationMessages.some((msg) => msg.content.includes('How does glycolysis start?'))).toBe(true);
        expect(request.conversationContext.conversationMessages.some((msg) => msg.content.includes('My Answer:'))).toBe(true);
        expect(await page.evaluate(() => /** @type {any} */ (window).__bodyTagApplied)).toBe(true);

        const missingCourseError = await page.evaluate(async () => {
            const w = /** @type {any} */ (window);
            localStorage.removeItem('selectedCourseId');
            try {
                await w.sendMessageToLLM('no course');
                return null;
            } catch (error) {
                return error.message;
            }
        });
        expect(missingCourseError).toContain('No course selected');
    });

    test('covers course-selection, revoked-access, and enrollment-join browser branches', async ({ page }) => {
        await openStudentScriptHarness(page);

        await page.evaluate(() => {
            const w = /** @type {any} */ (window);
            w.__fetchMocks['/api/courses/available/all'] = {
                success: true,
                data: [
                    { courseId: 'JOINABLE', courseName: 'Joinable Course', isEnrolled: false },
                    { courseId: 'ENROLLED', courseName: 'Enrolled Course', isEnrolled: true },
                ],
            };
            w.__fetchMocks['/api/courses/JOINABLE/join'] = { success: true };
            w.__fetchMocks['/api/courses/JOINABLE/student-enrollment'] = {
                success: true,
                data: { enrolled: true, status: 'active' },
            };
            w.__fetchMocks['/api/courses/JOINABLE'] = {
                success: true,
                data: {
                    courseId: 'JOINABLE',
                    courseName: 'Joinable Course',
                    name: 'Joinable Course',
                    lectures: [{ name: 'Unit 1', displayName: 'Unit 1', isPublished: true, assessmentQuestions: [] }],
                },
            };
            w.renderRevokedAccessUI();
        });

        await expect(page.locator('.chat-container')).toHaveCSS('display', 'none');
        await expect(page.locator('body')).toContainText('Access disabled');
        await expect(page.locator('#new-session-btn')).toBeDisabled();
        await expect(page.locator('#revoked-course-select')).toBeVisible();

        await page.evaluate(() => {
            const w = /** @type {any} */ (window);
            const chatContainer = /** @type {HTMLElement} */ (document.querySelector('.chat-container'));
            chatContainer.style.display = 'block';
            w.showCourseSelection([
                { courseId: 'JOINABLE', courseName: 'Joinable Course', isEnrolled: false },
                { courseId: 'ENROLLED', courseName: 'Enrolled Course', isEnrolled: true },
            ]);
        });

        await expect(page.locator('#course-select')).toBeVisible();
        await expect(page.locator('#course-selection-host > #course-selection-wrapper')).toHaveCount(1);
        await page.locator('#course-select').click();
        await page.locator('#course-select').selectOption('JOINABLE');
        await expect.poll(() => page.evaluate(() => /** @type {any} */ (window).__prompts.length)).toBe(1);
        await expect.poll(() => page.evaluate(() => {
            const w = /** @type {any} */ (window);
            return w.__fetchLog.findLast((entry) => entry.url === '/api/courses/JOINABLE/join')?.body?.code;
        })).toBe('JOIN-CODE');
        await expect.poll(() => page.evaluate(() => /** @type {any} */ (window).__alerts.includes('Successfully joined the course!'))).toBe(true);

        await page.evaluate(() => {
            const w = /** @type {any} */ (window);
            w.showNoCoursesMessage();
            w.showCourseLoadError();
            w.addChangeCourseButton();
            w.addChangeCourseButton();
        });
        await expect(page.locator('#chat-messages')).toContainText('No Courses Available');
        await expect(page.locator('#chat-messages')).toContainText('Error Loading Course');
        await expect(page.locator('#change-course-btn')).toHaveCount(1);

        await page.locator('#view-rules-link').click();
        expect(await page.evaluate(() => /** @type {any} */ (window).__agreementShown)).toBe(true);
    });

    test('exercises practice, struggle reset, identity, and date fallback branches', async ({ page }) => {
        await openStudentScriptHarness(page);

        await page.evaluate(() => {
            const w = /** @type {any} */ (window);
            w.__fetchMocks['/api/chat/check-practice-answer'] = [
                {
                    success: true,
                    data: { correct: true, feedback: 'Short answer accepted.', correctAnswer: 'explanation' },
                },
                { throw: 'network down' },
            ];
            w.renderPracticeQuestion({
                practiceId: 'short_success',
                questionType: 'short-answer',
                question: 'Explain the short answer.',
            });
            w.renderPracticeQuestion({
                practiceId: 'short_network_error',
                questionType: 'short-answer',
                question: 'This request will fail.',
            });
        });

        const shortSuccess = page.locator('[data-practice-id="short_success"]');
        await shortSuccess.locator('.practice-sa-input').fill('a detailed explanation');
        await shortSuccess.locator('.practice-submit-btn').click();
        await expect(page.locator('.practice-completed').filter({ hasText: 'Short answer accepted.' })).toBeVisible();

        const shortFailure = page.locator('[data-practice-id="short_network_error"]');
        await shortFailure.locator('.practice-sa-input').fill('another detailed explanation');
        await shortFailure.locator('.practice-submit-btn').click();
        await expect(shortFailure.locator('.practice-feedback')).toContainText('Error connecting to server.');
        await expect(shortFailure.locator('.practice-submit-btn')).toBeEnabled();

        await page.evaluate(() => {
            const w = /** @type {any} */ (window);
            w.__fetchMocks['/api/chat/practice-question'] = { success: true, noQuestions: true, message: 'No reset questions.' };
            w.__confirmValue = true;
            return w.handleStruggleResetQuestion('glycolysis');
        });
        await expect.poll(() => page.evaluate(() => {
            const w = /** @type {any} */ (window);
            return Boolean(w.__fetchLog.find((entry) => entry.url === '/api/student/struggle/reset'));
        })).toBe(true);

        await page.evaluate(() => {
            const w = /** @type {any} */ (window);
            w.__fetchMocks['/api/chat/practice-question'] = { throw: 'practice generator unavailable' };
            return w.handlePracticeQuestion('enzymes');
        });
        await expect(page.locator('#chat-messages')).toContainText('Sorry, I encountered an error generating a practice question.');

        const helperResults = await page.evaluate(async (sid) => {
            const w = /** @type {any} */ (window);
            const durationCases = [
                w.calculateSessionDuration({ messages: [] }),
                w.calculateSessionDuration({
                    messages: [
                        { type: 'user', timestamp: new Date(Date.now() - 65_000).toISOString() },
                        { type: 'bot', timestamp: new Date().toISOString() },
                    ],
                }),
                w.calculateSessionDuration({
                    messages: [
                        { type: 'user', timestamp: new Date(Date.now() - 3_600_000).toISOString() },
                        { type: 'user', timestamp: new Date().toISOString() },
                    ],
                }),
                w.calculateSessionDuration({
                    messages: [
                        { type: 'bot', content: 'Welcome to BiocBot! I can see you have access to published units.', elapsedTime: 0, elapsedTimeDerived: false },
                        { type: 'user', timestamp: 'not-a-date', elapsedTime: 6_000, elapsedTimeDerived: true },
                        { type: 'bot', timestamp: 'also-not-a-date', elapsedTime: 65_000, elapsedTimeDerived: true },
                    ],
                }),
            ];

            w.__currentUser = null;
            localStorage.setItem('userId', 'local-user-id');
            const localId = w.getCurrentStudentId();
            localStorage.removeItem('userId');
            sessionStorage.removeItem('sessionId');
            const generatedId = w.getCurrentStudentId();

            // getCurrentCourseId now reads the shared auth.js state via
            // waitForCurrentUser() instead of fetching /api/auth/me itself.
            w.waitForCurrentUser = () => Promise.resolve({
                displayName: 'Preference Student',
                preferences: { courseId: 'PREF-COURSE' },
            });
            const preferenceCourse = await w.getCurrentCourseId();
            w.waitForCurrentUser = () => Promise.resolve(null);
            localStorage.removeItem('selectedCourseId');
            w.__fetchMocks['/api/courses/available/all'] = {
                success: true,
                data: [{ courseId: 'ONLY-COURSE', courseName: 'Only Course' }],
            };
            const onlyCourse = await w.getCurrentCourseId();
            localStorage.removeItem('selectedCourseId');
            w.__fetchMocks['/api/courses/available/all'] = {
                success: true,
                data: [
                    { courseId: 'ONE', courseName: 'One' },
                    { courseId: 'TWO', courseName: 'Two' },
                ],
            };
            const multipleCourses = await w.getCurrentCourseId();

            localStorage.setItem('biocbot_current_chat_' + sid, '{not-json');
            const invalidChatData = w.getCurrentChatData();
            const derivedElapsedMessages = w.ensureMessageElapsedTimes([
                { type: 'user', timestamp: '2026-07-14T03:00:00.000Z' },
                { type: 'bot', timestamp: '2026-07-14T03:00:01.250Z' },
                { type: 'user', timestamp: 'not-a-date' },
            ]);

            return {
                durationCases,
                derivedElapsedMessages,
                earliestSessionStart: w.getSessionStartTime([
                    { type: 'user', timestamp: '2026-07-14T03:00:00.000Z' },
                    { type: 'bot', timestamp: '2026-07-10T18:57:57.042Z' },
                    { type: 'bot', timestamp: 'not-a-date' },
                ]),
                localId,
                generatedId,
                preferenceCourse,
                onlyCourse,
                multipleCourses,
                invalidChatData,
                badHistoryDate: w.formatHistoryDate('not-a-real-date'),
                sessionStartFallback: w.getSessionStartTime([]),
            };
        }, studentId);

        expect(helperResults.durationCases[0]).toBe('0s');
        expect(helperResults.durationCases[1]).toMatch(/1m|65s|5s/);
        expect(helperResults.durationCases[2]).toMatch(/1h|0s/);
        expect(helperResults.durationCases[3]).toBe('1m 5s');
        expect(helperResults.derivedElapsedMessages).toMatchObject([
            { elapsedTime: 0, elapsedTimeDerived: true },
            { elapsedTime: 1250, elapsedTimeDerived: true },
            { elapsedTime: 0, elapsedTimeDerived: true },
        ]);
        expect(helperResults.earliestSessionStart).toBe('2026-07-10T18:57:57.042Z');
        expect(helperResults.localId).toBe('local-user-id');
        expect(helperResults.generatedId).toMatch(/^session_/);
        expect(helperResults.preferenceCourse).toBe('PREF-COURSE');
        expect(helperResults.onlyCourse).toBe('ONLY-COURSE');
        expect(helperResults.multipleCourses).toBeNull();
        expect(helperResults.invalidChatData).toBeNull();
        expect(typeof helperResults.badHistoryDate).toBe('string');
        expect(new Date(helperResults.sessionStartFallback).toString()).not.toBe('Invalid Date');
    });
});
