// @ts-check
/**
 * Deep branch coverage for public/student/scripts/student.js.
 *
 * These tests load the real script in a compact browser harness and force
 * specific uncovered branches from coverage-reports/e2e/coverage-report.json.
 */

const { test, expect } = require('./fixtures/monocart');
const { storageStatePath } = require('./helpers/users');

const STUDENT_ID = 'student_js_deep_student';
const COURSE_ID = 'student-js-deep-course';
const COURSE_NAME = 'Student JS Deep Coverage';
const UNIT_NAME = 'Unit 1';

test.use({ storageState: storageStatePath('student') });

/**
 * @typedef {Window & {
 *   __fetchMocks: Record<string, any>,
 *   __fetchLog: Array<{ url: string, method: string, body: any }>,
 *   __alerts: string[],
 *   currentStruggleState?: { topics?: Array<{ topic: string, isActive: boolean }> },
 *   loadChatData?: (chatData: any) => void,
 *   calculateStudentMode?: () => Promise<void>,
 *   checkForChatDataToLoad?: () => Promise<void>,
 *   sendMessageToLLM?: (message: string, checkSummaryAttempt?: boolean, signal?: AbortSignal | null, isExplanationRequest?: any) => Promise<any>
 * }} DeepStudentWindow
 */

/**
 * @param {import('@playwright/test').Page} page
 * @param {Partial<{ fetchMocks: Record<string, any>, omitCourse: boolean }>} options
 */
async function openDeepHarness(page, options = {}) {
    const state = {
        studentId: STUDENT_ID,
        courseId: options.omitCourse ? '' : COURSE_ID,
        courseName: COURSE_NAME,
        unitName: UNIT_NAME,
        fetchMocks: options.fetchMocks || {},
    };

    await page.route('**/__student_js_deep_harness', async (route) => {
        await route.fulfill({
            contentType: 'text/html',
            body: `<!doctype html>
<html>
<head>
    <title>student.js deep harness</title>
    <link rel="stylesheet" href="/styles/style.css">
    <link rel="stylesheet" href="/styles/chat.css">
</head>
<body>
    <main class="main-content">
        <div class="current-course"><span class="course-name">Select Course</span></div>
        <div class="unit-selection-container"><select id="unit-select"><option value="">Choose a unit...</option></select></div>
        <div class="chat-container">
            <div class="messages" id="chat-messages"></div>
            <div class="chat-input-container">
                <form id="chat-form">
                    <input id="chat-input" name="chat-message-input" type="text">
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
        <button id="new-session-btn" type="button">New Session</button>
    </main>
    <script>
    (() => {
        const state = ${JSON.stringify(state)};
        localStorage.clear();
        sessionStorage.clear();
        if (state.courseId) {
            localStorage.setItem('selectedCourseId', state.courseId);
        }
        localStorage.setItem('selectedCourseName', state.courseName);
        localStorage.setItem('selectedUnitName', state.unitName);
        localStorage.setItem('studentMode', 'tutor');

        window.__fetchLog = [];
        window.__alerts = [];
        window.alert = (message) => window.__alerts.push(String(message));
        window.confirm = () => true;
        window.prompt = () => 'JOIN-CODE';
        window.__currentUser = {
            userId: state.studentId,
            username: 'student_js_deep',
            role: 'student',
            displayName: 'Deep Branch Student'
        };
        window.getCurrentUser = () => window.__currentUser;
        window.initializeIdleTimer = () => {};
        window.checkForFlagUpdates = () => {};
        window.applyLLMBodyTag = async () => {};
        window.applyLLMTagClassesToElement = (element) => element.classList.add('llm-tagged');
        window.agreementModal = { show(readOnly) { window.__agreementShown = readOnly; } };

        const courseDoc = {
            courseId: state.courseId || '${COURSE_ID}',
            id: state.courseId || '${COURSE_ID}',
            courseName: state.courseName,
            name: state.courseName,
            lectures: [{
                name: state.unitName,
                displayName: state.unitName,
                isPublished: true,
                updatedAt: new Date().toISOString(),
                passThreshold: 1,
                documents: [],
                assessmentQuestions: []
            }]
        };

        window.__fetchMocks = Object.assign({
            ['/api/courses/' + (state.courseId || '${COURSE_ID}') + '/student-enrollment']: {
                success: true,
                data: { enrolled: true, status: 'active' }
            },
            '/api/auth/me': {
                success: true,
                user: { userId: state.studentId, role: 'student', displayName: 'Deep Branch Student', preferences: {} }
            },
            '/api/courses/available/all': {
                success: true,
                data: [{ courseId: state.courseId || '${COURSE_ID}', courseName: state.courseName, isEnrolled: true }]
            },
            ['/api/courses/' + (state.courseId || '${COURSE_ID}')]: {
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
            '/api/chat': { success: true, message: 'Deep harness reply', sourceAttribution: null },
            '/api/flags': { success: true },
            '/api/chat/practice-question': {
                success: true,
                data: {
                    practiceId: 'deep_practice',
                    questionType: 'multiple-choice',
                    question: 'Harness practice?',
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
        }, state.fetchMocks);

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
                json: async () => {
                    if (mock.jsonThrow) throw new Error(mock.jsonThrow);
                    return payload;
                },
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

    await page.goto('/__student_js_deep_harness');
    await waitForGlobals(page, ['loadChatData', 'calculateStudentMode', 'checkForChatDataToLoad', 'sendMessageToLLM']);
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string[]} names
 */
async function waitForGlobals(page, names) {
    await page.waitForFunction((names) => names.every((name) => {
        const deepWindow = /** @type {DeepStudentWindow & Record<string, unknown>} */ (/** @type {unknown} */ (window));
        return typeof deepWindow[name] === 'function';
    }), names);
}

/**
 * @param {Partial<any>} overrides
 */
function buildChatData(overrides = {}) {
    return {
        metadata: {
            exportDate: new Date().toISOString(),
            courseId: COURSE_ID,
            courseName: COURSE_NAME,
            studentId: STUDENT_ID,
            studentName: 'Deep Branch Student',
            unitName: UNIT_NAME,
            currentMode: 'tutor',
            totalMessages: 0,
            version: '1.0',
            ...(overrides.metadata || {}),
        },
        messages: overrides.messages || [],
        practiceTests: Object.prototype.hasOwnProperty.call(overrides, 'practiceTests') ? overrides.practiceTests : null,
        studentAnswers: overrides.studentAnswers || { answers: [] },
        sessionInfo: Object.prototype.hasOwnProperty.call(overrides, 'sessionInfo')
            ? overrides.sessionInfo
            : { sessionId: 'deep-session', startTime: new Date().toISOString(), duration: '0 minutes' },
        lastActivityTimestamp: new Date().toISOString(),
    };
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {any} chatData
 */
async function loadChatDataInHarness(page, chatData) {
    await page.evaluate((chatData) => {
        const deepWindow = /** @type {DeepStudentWindow} */ (/** @type {unknown} */ (window));
        deepWindow.loadChatData?.(chatData);
    }, chatData);
    await page.waitForTimeout(650);
}

test.describe('student.js uncovered deep branches', () => {
    test('selectCalibrationAnswer restores an incomplete multiple-choice assessment and completes it', async ({ page }) => {
        await openDeepHarness(page);
        await loadChatDataInHarness(page, buildChatData({
            practiceTests: {
                questions: [{
                    id: 'mc-1',
                    question: 'Which option is correct?',
                    questionType: 'multiple-choice',
                    options: { A: 'Alpha', B: 'Beta' },
                    correctAnswer: 'A',
                }],
                passThreshold: 1,
                currentQuestionIndex: 0,
            },
            studentAnswers: { answers: [] },
        }));

        await page.locator('.calibration-option').first().click();

        await expect(page.locator('.calibration-option').first()).toHaveClass(/selected/);
        await expect(page.locator('.calibration-option').first()).toBeDisabled();
        await expect(page.locator('.mode-result')).toBeVisible({ timeout: 2_000 });
        await expect.poll(() => page.evaluate(() => localStorage.getItem('studentMode'))).toBe('protege');
    });

    test('authoritative 3/3 summary, persistence, and restoration stay identical', async ({ page }) => {
        await openDeepHarness(page);
        await loadChatDataInHarness(page, buildChatData({
            practiceTests: {
                questions: [
                    {
                        id: 'mc-zero',
                        question: 'Which phase comes first?',
                        questionType: 'multiple-choice',
                        options: { 0: 'Initiation', 1: 'Termination', 2: 'Elongation' },
                        correctAnswer: 0,
                    },
                    {
                        id: 'tf-false',
                        question: 'Is this statement true?',
                        questionType: 'true-false',
                        correctAnswer: false,
                    },
                    {
                        id: 'mc-legacy',
                        question: 'Which legacy option?',
                        questionType: 'multiple-choice',
                        options: { A: 'Alpha', B: 'Beta' },
                        correctAnswer: 'B',
                    },
                ],
                passThreshold: 3,
                currentQuestionIndex: 3,
            },
            studentAnswers: {
                answers: [{ answer: 0 }, { answer: 1 }, { answer: 1 }],
            },
        }));

        await page.evaluate(async () => {
            const deepWindow = /** @type {DeepStudentWindow} */ (/** @type {unknown} */ (window));
            await deepWindow.calculateStudentMode?.();
        });

        const result = await page.evaluate(() => {
            const deepWindow = /** @type {any} */ (window);
            const saveCall = [...deepWindow.__fetchLog]
                .reverse()
                .find(entry => entry.url === '/api/chat/save');
            return {
                displayed: document.querySelector('.assessment-summary-score')?.textContent,
                expectedAnswers: [...document.querySelectorAll('.answer-box.expected .answer-box-content')]
                    .map(element => element.textContent),
                body: saveCall?.body,
            };
        });

        expect(result.displayed).toBe('Score: 3/3');
        expect(result.expectedAnswers).toEqual(['A) Initiation', 'False', 'B) Beta']);
        const savedChatData = /** @type {any} */ (result.body.chatData);
        expect(savedChatData.metadata.currentMode).toBe('protege');
        expect(savedChatData.assessmentScore).toMatchObject({
            totalCorrect: 3,
            totalQuestions: 3,
            mode: 'protege',
            passed: true,
        });
        expect(savedChatData.practiceTests.questions.map((/** @type {any} */ q) => q.correctAnswer))
            .toEqual([0, false, 'B']);
        expect(savedChatData.practiceTests.questions.map((/** @type {any} */ q) => q.isCorrect))
            .toEqual([true, true, true]);
        expect(savedChatData.studentAnswers.answers.map((/** @type {any} */ a) => a.isCorrect))
            .toEqual([true, true, true]);
        const modeResult = savedChatData.messages.find(
            (/** @type {any} */ message) => message.messageType === 'mode-result'
        );
        expect(modeResult.content).toContain('Score: 3/3');
        expect(modeResult.content).toContain('Expected Answer: A) Initiation');
        expect(modeResult.content).toContain('Expected Answer: False');
        expect(modeResult.htmlContent).toContain('Score: 3/3');
        expect(modeResult.htmlContent).not.toContain('N/A');

        await page.evaluate((chatData) => {
            const messages = document.getElementById('chat-messages');
            if (messages) messages.innerHTML = '';
            const deepWindow = /** @type {any} */ (window);
            deepWindow.loadChatData(chatData);
        }, savedChatData);
        await expect(page.locator('.mode-result .assessment-summary-score')).toHaveText('Score: 3/3');
        await expect(page.locator('.mode-result')).toContainText('A) Initiation');
        await expect(page.locator('.mode-result')).toContainText('False');
    });

    test('submitShortAnswer alerts and returns when the restored short answer is blank', async ({ page }) => {
        await openDeepHarness(page);
        await loadChatDataInHarness(page, buildChatData({
            practiceTests: {
                questions: [{
                    id: 'sa-empty',
                    question: 'Explain the concept.',
                    questionType: 'short-answer',
                    expectedAnswer: 'A detailed answer',
                }],
                passThreshold: 1,
                currentQuestionIndex: 0,
            },
            studentAnswers: { answers: [] },
        }));

        await page.locator('.calibration-submit-btn').click();

        await expect.poll(() => page.evaluate(() => {
            const deepWindow = /** @type {DeepStudentWindow} */ (/** @type {unknown} */ (window));
            return deepWindow.__alerts;
        })).toContain('Please enter an answer before submitting.');
    });

    test('submitShortAnswer falls back when the AI answer check fails', async ({ page }) => {
        await openDeepHarness(page, {
            fetchMocks: {
                '/api/questions/check-answer': { throw: 'simulated check-answer failure' },
            },
        });
        await loadChatDataInHarness(page, buildChatData({
            practiceTests: {
                questions: [{
                    id: 'sa-fallback',
                    question: 'Explain protein folding.',
                    questionType: 'short-answer',
                    expectedAnswer: 'Proteins fold based on interactions.',
                }],
                passThreshold: 1,
                currentQuestionIndex: 0,
            },
            studentAnswers: { answers: [] },
        }));

        await page.locator('.calibration-answer-input').fill('A long enough fallback answer');
        await page.locator('.calibration-submit-btn').click();

        await expect(page.locator('.calibration-feedback')).toContainText('Unable to verify with AI');
        await expect.poll(() => page.evaluate(() => {
            const deepWindow = /** @type {any} */ (window);
            return deepWindow.studentEvaluations?.[0]?.feedback;
        })).toBe('Could not verify with AI. Marked based on length.');
    });

    test('calculateStudentMode covers tutor fallback scoring across restored question types', async ({ page }) => {
        await openDeepHarness(page);
        await loadChatDataInHarness(page, buildChatData({
            messages: [{ type: 'bot', content: 'Prior bot message', messageType: 'regular-chat', hasFlagButton: true }],
            practiceTests: {
                questions: [
                    { id: 'tf', question: 'Boolean question?', questionType: 'true-false', correctAnswer: false },
                    { id: 'mc', question: 'Choice question?', questionType: 'multiple-choice', options: { A: 'Alpha', B: 'Beta' }, correctAnswer: 'Z' },
                    { id: 'sa', question: 'Short answer?', questionType: 'short-answer', correctAnswer: 'Detailed answer' },
                    { id: 'unknown', question: 'Unknown type?', questionType: 'ordering', correctAnswer: 'same-value' },
                ],
                passThreshold: 4,
                currentQuestionIndex: 4,
            },
            studentAnswers: {
                answers: [
                    { answer: 0 },
                    { answer: 1 },
                    { answer: 'short' },
                    { answer: 'same-value' },
                ],
            },
        }));
        await page.evaluate(async () => {
            const deepWindow = /** @type {DeepStudentWindow} */ (/** @type {unknown} */ (window));
            await deepWindow.calculateStudentMode?.();
        });

        await expect(page.locator('.mode-result')).toBeVisible({ timeout: 2_000 });
        await expect(page.locator('.assessment-summary-container')).toContainText('Score: 0/4');
        await expect.poll(() => page.evaluate(() => localStorage.getItem('studentMode'))).toBe('tutor');
    });

    test('loadChatData restores special message types and disables a capped restored session', async ({ page }) => {
        await openDeepHarness(page);
        const regularMessages = Array.from({ length: 40 }, (_, index) => ({
            type: index % 2 === 0 ? 'user' : 'bot',
            content: `regular ${index}`,
            messageType: 'regular-chat',
            hasFlagButton: index % 2 === 1,
            timestamp: new Date().toISOString(),
        }));

        await loadChatDataInHarness(page, buildChatData({
            messages: [
                { type: 'bot', content: '<strong>Assessment starting</strong>', isHtml: true, messageType: 'assessment-start', hasFlagButton: false },
                {
                    type: 'bot',
                    content: 'Restored mode result fallback',
                    messageType: 'mode-result',
                    displayTimestamp: 'Yesterday',
                    timestamp: new Date().toISOString(),
                },
                {
                    type: 'bot',
                    content: 'Restored toggle fallback',
                    messageType: 'mode-toggle-result',
                    displayTimestamp: 'Today',
                    timestamp: new Date().toISOString(),
                },
                ...regularMessages,
            ],
            sessionInfo: null,
        }));

        await expect(page.locator('.mode-result')).toContainText('Restored mode result fallback');
        await expect(page.locator('.mode-toggle-result')).toContainText('Restored toggle fallback');
        await expect(page.locator('#chat-input')).toBeDisabled();
        await expect.poll(() => page.evaluate(() => {
            const key = `biocbot_session_${'student_js_deep_student'}_${'student-js-deep-course'}_${'Unit 1'}`;
            return localStorage.getItem(key)?.startsWith('autosave_');
        })).toBe(true);
    });

    test('loadChatData drops stale active struggle actions during restore', async ({ page }) => {
        await openDeepHarness(page);
        await page.evaluate(() => {
            const deepWindow = /** @type {DeepStudentWindow} */ (/** @type {unknown} */ (window));
            deepWindow.currentStruggleState = { topics: [{ topic: 'Photosynthesis', isActive: false }] };
        });

        await loadChatDataInHarness(page, buildChatData({
            messages: [{
                type: 'bot',
                content: 'Previously directive response',
                messageType: 'regular-chat',
                hasFlagButton: true,
                activeStruggleTopic: 'Photosynthesis',
            }],
        }));

        await expect(page.locator('#chat-messages')).toContainText('Previously directive response');
        await expect(page.locator('#chat-messages')).not.toContainText('I understand Photosynthesis now');
    });

    test('checkForChatDataToLoad catches corrupt sessionStorage history payloads', async ({ page }) => {
        await openDeepHarness(page);
        await page.evaluate(async () => {
            const deepWindow = /** @type {DeepStudentWindow} */ (/** @type {unknown} */ (window));
            sessionStorage.setItem('loadChatData', '{bad json');
            await deepWindow.checkForChatDataToLoad?.();
        });

        await expect.poll(() => page.evaluate(() => sessionStorage.getItem('loadChatData'))).toBe('{bad json');
        await expect(page.locator('#chat-messages')).not.toContainText('Error loading chat history');
    });

    test('sendMessageToLLM throws the no-course branch before calling /api/chat', async ({ page }) => {
        await openDeepHarness(page, { omitCourse: true });

        const result = await page.evaluate(async () => {
            const deepWindow = /** @type {DeepStudentWindow} */ (/** @type {unknown} */ (window));
            try {
                await deepWindow.sendMessageToLLM?.('hello');
                return { ok: true, message: '' };
            } catch (error) {
                return { ok: false, message: error instanceof Error ? error.message : String(error) };
            }
        });

        expect(result).toEqual({ ok: false, message: 'No course selected. Please select a course first.' });
        await expect.poll(() => page.evaluate(() => {
            const deepWindow = /** @type {DeepStudentWindow} */ (/** @type {unknown} */ (window));
            return deepWindow.__fetchLog.filter((entry) => entry.url === '/api/chat').length;
        })).toBe(0);
    });

    test('sendMessageToLLM surfaces unsuccessful chat JSON without a server message', async ({ page }) => {
        await openDeepHarness(page, {
            fetchMocks: {
                '/api/chat': { success: false },
            },
        });

        const result = await page.evaluate(async () => {
            const deepWindow = /** @type {DeepStudentWindow} */ (/** @type {unknown} */ (window));
            try {
                await deepWindow.sendMessageToLLM?.('hello');
                return { ok: true, message: '' };
            } catch (error) {
                return { ok: false, message: error instanceof Error ? error.message : String(error) };
            }
        });

        expect(result).toEqual({ ok: false, message: 'Failed to get response from LLM' });
    });
});
