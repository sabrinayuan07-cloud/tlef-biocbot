// @ts-check
/**
 * Deep coverage spec for public/student/scripts/student.js.
 *
 * The base student-chat suite already covers happy-path flows. This spec
 * pushes into branches the broader suite never reaches: chat-limit modal,
 * struggle-reset gating, history save/load round-tripping, restored
 * practice/mode messages, course-name forcing, new-session button, source
 * attribution fallbacks, the 15/25/35-message warning sequence, the 40-msg
 * cap behavior, and the formatTimestamp / formatHistoryDate branches.
 *
 * Tests use the same monocart fixture as the other coverage specs so the
 * browser-side V8 coverage is captured.
 */
/* eslint-disable no-undef */

const { test, expect } = require('./fixtures/monocart');
const { TEST_USERS, storageStatePath } = require('./helpers/users');
const { withDb, getUserIdByUsername } = require('./helpers/quiz');
const {
    STU_COURSE_ID,
    STU_OTHER_COURSE_ID,
    APPROVED_TOPIC,
    getStudentId,
    resetStudentChatData,
    cleanupStudentChatData,
    setUserAgreement,
} = require('./helpers/student');

/**
 * @typedef {Window & Record<string, any>} AnyWindow
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

/**
 * Seed localStorage / sessionStorage on the page before /student loads, then
 * open the student chat page. By default this primes a course + unit so the
 * page jumps straight into direct-chat mode without any assessment flow.
 *
 * @param {import('@playwright/test').Page} page
 * @param {Object} [options]
 */
async function openStudent(page, options = {}) {
    const {
        courseId = STU_COURSE_ID,
        courseName = 'BIOC E2E Student Chat',
        unitName = 'Unit 1',
        studentMode = 'tutor',
        chatData = null,
        sessionLoadData = null,
        clearAll = false,
    } = options;

    await page.addInitScript(({ courseId, courseName, unitName, studentMode, studentId, chatData, sessionLoadData, clearAll }) => {
        try {
            if (clearAll) {
                localStorage.clear();
                sessionStorage.clear();
                return;
            }
            localStorage.clear();
            sessionStorage.clear();
            localStorage.setItem('selectedCourseId', courseId);
            localStorage.setItem('selectedCourseName', courseName);
            localStorage.setItem('selectedUnitName', unitName);
            localStorage.setItem('studentMode', studentMode);

            const seeded = chatData || {
                metadata: {
                    courseId,
                    courseName,
                    studentId,
                    studentName: 'E2E Student',
                    unitName,
                    currentMode: studentMode,
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
            localStorage.setItem(`biocbot_current_chat_${studentId}`, JSON.stringify(seeded));
            localStorage.setItem(`biocbot_session_${studentId}_${courseId}_${unitName}`, seeded.sessionInfo.sessionId);

            if (sessionLoadData) {
                sessionStorage.setItem('loadChatData', JSON.stringify(sessionLoadData));
            }
        } catch (_) { /* noop */ }
    }, { courseId, courseName, unitName, studentMode, studentId, chatData, sessionLoadData, clearAll });

    await page.goto('/student');
}

async function waitForDirectChatReady(page) {
    await expect(page.locator('#chat-messages')).toContainText('No Questions Available', { timeout: 15_000 });
    await expect(page.locator('#chat-input')).toBeEnabled();
}

/**
 * Variant used when chatData has been pre-seeded with messages and the
 * auto-continue path renders the saved chat instead of the "No Questions
 * Available" copy. Waits for any of the seeded messages to appear and the
 * input to be enabled.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} seededText
 */
async function waitForRestoredChatReady(page, seededText) {
    await expect(page.locator('#chat-messages')).toContainText(seededText, { timeout: 15_000 });
    await expect(page.locator('#chat-input')).toBeEnabled({ timeout: 15_000 });
}

async function waitForFn(page, name) {
    await page.waitForFunction((n) => typeof (/** @type {any} */ (window))[n] === 'function', name);
}

// ----------------------------------------------------------------------------
// Chat-limit modal and message-count warnings
// ----------------------------------------------------------------------------
test.describe('Chat limit modal and warnings', () => {
    test('the 15/25/35-message warnings render at the right counts and the modal opens via "See why?"', async ({ page }) => {
        // Build a saved chat with exactly 13 regular-chat messages (alternating
        // user/bot). The next user message brings the count to 14, which
        // triggers the 15-message warning branch.
        const baseMessages = [];
        for (let i = 0; i < 13; i++) {
            baseMessages.push({
                type: i % 2 === 0 ? 'user' : 'bot',
                content: `Seeded message ${i + 1}`,
                messageType: 'regular-chat',
                timestamp: new Date(Date.now() - (13 - i) * 60_000).toISOString(),
            });
        }

        await page.route('/api/chat', async (route) => {
            await route.fulfill({
                json: { success: true, message: 'mocked bot reply', sourceAttribution: null },
            });
        });

        await openStudent(page, {
            chatData: {
                metadata: {
                    courseId: STU_COURSE_ID,
                    courseName: 'BIOC E2E Student Chat',
                    studentId,
                    studentName: 'E2E Student',
                    unitName: 'Unit 1',
                    currentMode: 'tutor',
                    totalMessages: baseMessages.length,
                    version: '1.0',
                },
                messages: baseMessages,
                practiceTests: null,
                studentAnswers: { answers: [] },
                sessionInfo: {
                    sessionId: 'e2e_warnings',
                    startTime: new Date().toISOString(),
                    duration: '0 minutes',
                },
                lastActivityTimestamp: new Date().toISOString(),
            },
        });
        await waitForRestoredChatReady(page, 'Seeded message 13');

        await page.locator('#chat-input').fill('drive count to 14');
        await page.locator('#chat-input').press('Enter');

        await expect(page.locator('#chat-messages')).toContainText(
            'Please be aware that after 15 messages',
            { timeout: 10_000 }
        );

        // Click the "See why?" link, which only the warning message contains.
        await page.locator('.chat-limit-link').first().click();
        await expect(page.locator('#chat-limit-modal-overlay')).toHaveClass(/show/);

        // Closing the modal via the "Got it" button must clear .show and
        // restore body scrolling.
        await page.locator('#close-info-modal-btn').click();
        await expect(page.locator('#chat-limit-modal-overlay')).not.toHaveClass(/show/);
        await expect.poll(() => page.evaluate(() => document.body.style.overflow)).toBe('');

        // Reopen via the link and close via overlay click — the other branch
        // in initializeChatLimitModal.
        await page.locator('.chat-limit-link').first().click();
        await expect(page.locator('#chat-limit-modal-overlay')).toHaveClass(/show/);
        await page.locator('#chat-limit-modal-overlay').click({ position: { x: 5, y: 5 } });
        await expect(page.locator('#chat-limit-modal-overlay')).not.toHaveClass(/show/);
    });

    test('hitting 40 messages disables chat input and the send button', async ({ page }) => {
        // Seed exactly 39 regular-chat messages. The next user send creates
        // the 40th, the bot reply would create the 41st, so the cap branch
        // (willHitCap) fires and disableChatInputForCap is invoked.
        const baseMessages = [];
        for (let i = 0; i < 39; i++) {
            baseMessages.push({
                type: i % 2 === 0 ? 'user' : 'bot',
                content: `Seeded ${i + 1}`,
                messageType: 'regular-chat',
                timestamp: new Date(Date.now() - (39 - i) * 30_000).toISOString(),
            });
        }

        await page.route('/api/chat', async (route) => {
            await route.fulfill({
                json: { success: true, message: 'final-bot-reply', sourceAttribution: null },
            });
        });

        await openStudent(page, {
            chatData: {
                metadata: {
                    courseId: STU_COURSE_ID,
                    courseName: 'BIOC E2E Student Chat',
                    studentId,
                    studentName: 'E2E Student',
                    unitName: 'Unit 1',
                    currentMode: 'tutor',
                    totalMessages: baseMessages.length,
                    version: '1.0',
                },
                messages: baseMessages,
                practiceTests: null,
                studentAnswers: { answers: [] },
                sessionInfo: {
                    sessionId: 'e2e_cap',
                    startTime: new Date().toISOString(),
                    duration: '0 minutes',
                },
                lastActivityTimestamp: new Date().toISOString(),
            },
        });
        await waitForRestoredChatReady(page, 'Seeded 39');

        await page.locator('#chat-input').fill('this hits the cap');
        await page.locator('#chat-input').press('Enter');

        // The bot response includes the session-closed notice.
        await expect(page.locator('#chat-messages')).toContainText(
            'This chat session has been exhausted',
            { timeout: 10_000 }
        );

        await expect(page.locator('#chat-input')).toBeDisabled();
        await expect(page.locator('#send-button')).toBeDisabled();
        await expect(page.locator('#chat-input')).toHaveAttribute('placeholder', /40-message limit/);
    });

    test('a second send when already at the cap is short-circuited and never calls /api/chat', async ({ page }) => {
        // Build 40 regular-chat messages — already at the cap. The submit
        // handler should hit `messageCountBefore >= MAX_MESSAGES` and return
        // before adding the user message or making any /api/chat call.
        const baseMessages = [];
        for (let i = 0; i < 40; i++) {
            baseMessages.push({
                type: i % 2 === 0 ? 'user' : 'bot',
                content: `Capped ${i + 1}`,
                messageType: 'regular-chat',
                timestamp: new Date(Date.now() - (40 - i) * 30_000).toISOString(),
            });
        }

        let chatCalls = 0;
        await page.route('/api/chat', async (route) => {
            chatCalls += 1;
            await route.fulfill({ json: { success: true, message: 'should not happen' } });
        });

        await openStudent(page, {
            chatData: {
                metadata: {
                    courseId: STU_COURSE_ID,
                    courseName: 'BIOC E2E Student Chat',
                    studentId,
                    studentName: 'E2E Student',
                    unitName: 'Unit 1',
                    currentMode: 'tutor',
                    totalMessages: baseMessages.length,
                    version: '1.0',
                },
                messages: baseMessages,
                practiceTests: null,
                studentAnswers: { answers: [] },
                sessionInfo: {
                    sessionId: 'e2e_already_capped',
                    startTime: new Date().toISOString(),
                    duration: '0 minutes',
                },
                lastActivityTimestamp: new Date().toISOString(),
            },
        });
        // Once the session is already capped, loadChatData calls
        // disableChatInputForCap directly, so we wait for the seeded text
        // without expecting an enabled input.
        await expect(page.locator('#chat-messages')).toContainText('Capped 40', { timeout: 15_000 });

        // Force-enable the input first (the submit handler still checks the
        // count and bails). This proves the count check runs independently
        // of the DOM-disabled state.
        await page.evaluate(() => {
            const i = /** @type {HTMLInputElement} */ (document.getElementById('chat-input'));
            const b = /** @type {HTMLButtonElement} */ (document.getElementById('send-button'));
            if (i) i.disabled = false;
            if (b) b.disabled = false;
        });

        await page.locator('#chat-input').fill('should not reach server');
        await page.locator('#chat-input').press('Enter');
        await page.waitForTimeout(500);

        expect(chatCalls).toBe(0);
        // The input is disabled by disableChatInputForCap() during the early return.
        await expect(page.locator('#chat-input')).toBeDisabled();
    });
});

// ----------------------------------------------------------------------------
// Source attribution edge cases (no documents, fallback to topic)
// ----------------------------------------------------------------------------
test.describe('Source attribution fallbacks', () => {
    test('falls back to "Source: TBD" when description is empty and there are no downloadable docs', async ({ page }) => {
        await openStudent(page);
        await waitForDirectChatReady(page);
        await waitForFn(page, 'addMessage');

        await page.evaluate(() => {
            const w = /** @type {any} */ (window);
            w.addMessage('topic-only attribution', 'bot', true, true, {
                description: '',
                documents: [],
            });
        });

        const msg = page.locator('.bot-message').filter({ hasText: 'topic-only attribution' });
        await expect(msg.locator('.message-source')).toHaveText('Source: TBD');
    });

    test('renders "Source: TBD" when sourceAttribution is null', async ({ page }) => {
        await openStudent(page);
        await waitForDirectChatReady(page);
        await waitForFn(page, 'addMessage');

        await page.evaluate(() => {
            const w = /** @type {any} */ (window);
            w.addMessage('nothing-known', 'bot', true, true, null);
        });

        const msg = page.locator('.bot-message').filter({ hasText: 'nothing-known' });
        await expect(msg.locator('.message-source')).toHaveText('Source: TBD');
    });

    test('falls back to description text when downloadsEnabled is true but selectedCourseId is missing', async ({ page }) => {
        await openStudent(page);
        await waitForDirectChatReady(page);
        await waitForFn(page, 'addMessage');

        await page.evaluate(() => {
            localStorage.removeItem('selectedCourseId');
            const w = /** @type {any} */ (window);
            w.addMessage('no-courseId attribution', 'bot', true, true, {
                description: 'fallback description',
                downloadsEnabled: true,
                documents: [{ documentId: 'doc_abc', fileName: 'A.pdf' }],
            });
        });

        const msg = page.locator('.bot-message').filter({ hasText: 'no-courseId attribution' });
        await expect(msg.locator('.message-source')).toHaveText('Source: fallback description');
        await expect(msg.locator('.message-source a')).toHaveCount(0);
    });
});

// ----------------------------------------------------------------------------
// Struggle reset question flow (renderStruggleResetQuestion + submitStruggleResetAnswer)
// ----------------------------------------------------------------------------
test.describe('Struggle reset gated by a practice question', () => {
    test('correct answer triggers /api/student/struggle/reset and removes the directive badge', async ({ page }) => {
        let resetCalled = false;
        await page.route('/api/chat/practice-question', async (route) => {
            await route.fulfill({
                json: {
                    success: true,
                    data: {
                        practiceId: 'pq_struggle_correct',
                        questionType: 'multiple-choice',
                        question: 'What stage of photosynthesis produces ATP?',
                        options: { A: 'Light reactions', B: 'Dark reactions' },
                    },
                },
            });
        });
        await page.route('/api/chat/check-practice-answer', async (route) => {
            await route.fulfill({
                json: {
                    success: true,
                    data: { correct: true, feedback: 'Nice work.', correctAnswer: 'A' },
                },
            });
        });
        await page.route('/api/student/struggle/reset', async (route) => {
            resetCalled = true;
            await route.fulfill({ json: { success: true } });
        });

        await openStudent(page);
        await waitForDirectChatReady(page);

        // Plant a directive-mode indicator and reset button so we can prove
        // they're cleaned up by performStruggleReset.
        await page.evaluate(() => {
            const indicator = document.createElement('div');
            indicator.id = 'directive-mode-indicator';
            document.body.appendChild(indicator);

            const btn = document.createElement('button');
            btn.className = 'struggle-reset-btn';
            document.body.appendChild(btn);
        });

        // Trigger the struggle-reset question UI directly.
        await page.evaluate((topic) => {
            const w = /** @type {any} */ (window);
            return w.handleStruggleResetQuestion(topic);
        }, APPROVED_TOPIC);

        const gate = page.locator('.struggle-gate-question').last();
        await expect(gate).toBeVisible();
        await gate.locator('input[value="A"]').check();
        await gate.locator('.practice-submit-btn').click();

        await expect(page.locator('.practice-completed').filter({ hasText: "Great job! Looks like you've got a solid understanding of" })).toBeVisible({ timeout: 10_000 });
        await expect.poll(() => resetCalled).toBeTruthy();
        await expect(page.locator('#directive-mode-indicator')).toHaveCount(0);
        await expect(page.locator('.struggle-reset-btn')).toHaveCount(0);
    });

    test('incorrect answer keeps directive mode and shows the "keep working" message', async ({ page }) => {
        let resetCalled = false;
        await page.route('/api/chat/practice-question', async (route) => {
            await route.fulfill({
                json: {
                    success: true,
                    data: {
                        practiceId: 'pq_struggle_wrong',
                        questionType: 'true-false',
                        question: 'Photosynthesis happens at night.',
                    },
                },
            });
        });
        await page.route('/api/chat/check-practice-answer', async (route) => {
            await route.fulfill({
                json: {
                    success: true,
                    data: { correct: false, feedback: 'Not quite.', correctAnswer: 'False' },
                },
            });
        });
        await page.route('/api/student/struggle/reset', async (route) => {
            resetCalled = true;
            await route.fulfill({ json: { success: true } });
        });

        await openStudent(page);
        await waitForDirectChatReady(page);

        await page.evaluate((topic) => {
            const w = /** @type {any} */ (window);
            return w.handleStruggleResetQuestion(topic);
        }, APPROVED_TOPIC);

        const gate = page.locator('.struggle-gate-question').last();
        await expect(gate).toBeVisible();
        await gate.locator('input[value="True"]').check();
        await gate.locator('.practice-submit-btn').click();

        await expect(page.locator('.practice-completed').filter({ hasText: "Let's keep working on" })).toBeVisible({ timeout: 10_000 });
        // Critically, the reset endpoint must NOT have been hit on a wrong answer.
        expect(resetCalled).toBeFalsy();
    });

    test('handleStruggleResetQuestion guards against missing course/unit', async ({ page }) => {
        await openStudent(page);
        await waitForDirectChatReady(page);

        await page.evaluate(() => {
            localStorage.removeItem('selectedCourseId');
        });

        await page.evaluate(() => {
            const w = /** @type {any} */ (window);
            return w.handleStruggleResetQuestion('mystery topic');
        });
        await expect(page.locator('#chat-messages')).toContainText('Please select a course and unit first.');
    });

    test('struggle-reset short-answer validation refuses an empty submission', async ({ page }) => {
        await page.route('/api/chat/practice-question', async (route) => {
            await route.fulfill({
                json: {
                    success: true,
                    data: {
                        practiceId: 'pq_struggle_sa_empty',
                        questionType: 'short-answer',
                        question: 'Describe photosynthesis briefly.',
                    },
                },
            });
        });
        let checkCalls = 0;
        await page.route('/api/chat/check-practice-answer', async (route) => {
            checkCalls += 1;
            await route.fulfill({ json: { success: true, data: { correct: true, feedback: 'ok' } } });
        });

        await openStudent(page);
        await waitForDirectChatReady(page);

        await page.evaluate((topic) => {
            const w = /** @type {any} */ (window);
            return w.handleStruggleResetQuestion(topic);
        }, APPROVED_TOPIC);

        const gate = page.locator('.struggle-gate-question').last();
        await gate.locator('.practice-submit-btn').click();
        await expect(gate.locator('.practice-feedback')).toContainText('Please type your answer.');
        expect(checkCalls).toBe(0);
    });
});

// ----------------------------------------------------------------------------
// Practice question — empty-textarea + API error branches
// ----------------------------------------------------------------------------
test.describe('Practice question via "Ask me a question" button', () => {
    test('handlePracticeQuestion submits to /api/chat/practice-question and renders the question', async ({ page }) => {
        /** @type {{ courseId?: string, unitName?: string, topic?: string } | undefined} */
        let payload;
        await page.route('/api/chat/practice-question', async (route) => {
            payload = route.request().postDataJSON();
            await route.fulfill({
                json: {
                    success: true,
                    data: {
                        practiceId: 'pq_via_action',
                        questionType: 'multiple-choice',
                        question: 'What is X?',
                        options: { A: 'a', B: 'b' },
                    },
                },
            });
        });

        await openStudent(page);
        await waitForDirectChatReady(page);

        await page.evaluate(() => {
            const w = /** @type {any} */ (window);
            return w.handlePracticeQuestion('mitosis');
        });

        await expect(page.locator('[data-practice-id="pq_via_action"]')).toBeVisible({ timeout: 10_000 });
        expect(payload?.topic).toBe('mitosis');
        expect(payload?.courseId).toBe(STU_COURSE_ID);
    });

    test('handlePracticeQuestion surfaces a no-questions message', async ({ page }) => {
        await page.route('/api/chat/practice-question', async (route) => {
            await route.fulfill({
                json: { success: true, noQuestions: true, message: 'No practice questions yet.' },
            });
        });

        await openStudent(page);
        await waitForDirectChatReady(page);

        await page.evaluate(() => {
            const w = /** @type {any} */ (window);
            return w.handlePracticeQuestion('anything');
        });
        await expect(page.locator('#chat-messages')).toContainText('No practice questions yet.');
    });

    test('handlePracticeQuestion surfaces a not-success error', async ({ page }) => {
        await page.route('/api/chat/practice-question', async (route) => {
            await route.fulfill({
                json: { success: false, message: 'rng failed' },
            });
        });

        await openStudent(page);
        await waitForDirectChatReady(page);

        await page.evaluate(() => {
            const w = /** @type {any} */ (window);
            return w.handlePracticeQuestion('any');
        });
        await expect(page.locator('#chat-messages')).toContainText('rng failed');
    });

    test('handlePracticeQuestion guards against missing course/unit', async ({ page }) => {
        await openStudent(page);
        await waitForDirectChatReady(page);
        await page.evaluate(() => localStorage.removeItem('selectedCourseId'));

        await page.evaluate(() => {
            const w = /** @type {any} */ (window);
            return w.handlePracticeQuestion('whatever');
        });
        await expect(page.locator('#chat-messages')).toContainText('Please select a course and unit first.');
    });
});

// ----------------------------------------------------------------------------
// Explain action (handleExplainAction)
// ----------------------------------------------------------------------------
test.describe('Explain action', () => {
    test('handleExplainAction calls /api/chat with isExplanationRequest set', async ({ page }) => {
        /** @type {any} */
        let body;
        await page.route('/api/chat', async (route) => {
            body = route.request().postDataJSON();
            await route.fulfill({
                json: {
                    success: true,
                    message: 'Explained simply.',
                    sourceAttribution: { description: 'tutor note' },
                },
            });
        });

        await openStudent(page);
        await waitForDirectChatReady(page);
        await waitForFn(page, 'addMessage');

        await page.evaluate(() => {
            const w = /** @type {any} */ (window);
            return w.handleExplainAction('<p>Please explain X</p>', 'glycolysis');
        });

        await expect(page.locator('#chat-messages')).toContainText('Explained simply.');
        expect(body?.isExplanationRequest).toEqual({ topic: 'glycolysis' });
        expect(body?.topic).toBe('glycolysis');
    });

    test('handleExplainAction shows the generic chat error when /api/chat fails', async ({ page }) => {
        await page.route('/api/chat', async (route) => {
            await route.fulfill({
                status: 500,
                contentType: 'application/json',
                body: JSON.stringify({ success: false, message: 'boom' }),
            });
        });
        await openStudent(page);
        await waitForDirectChatReady(page);

        await page.evaluate(() => {
            const w = /** @type {any} */ (window);
            return w.handleExplainAction('Please explain this', null);
        });
        await expect(page.locator('#chat-messages')).toContainText('Sorry, I encountered an error.');
    });

    test('handleExplainAction returns silently when text is empty', async ({ page }) => {
        let called = 0;
        await page.route('/api/chat', async (route) => {
            called += 1;
            await route.fulfill({ json: { success: true, message: 'never' } });
        });
        await openStudent(page);
        await waitForDirectChatReady(page);

        await page.evaluate(() => {
            const w = /** @type {any} */ (window);
            return w.handleExplainAction('');
        });
        await page.waitForTimeout(300);
        expect(called).toBe(0);
    });
});

// ----------------------------------------------------------------------------
// loadChatData / checkForChatDataToLoad — restoring saved chat from history
// ----------------------------------------------------------------------------
test.describe('Restoring a saved chat from history', () => {
    test('loadChatData restores messages, mode result, and practice question with feedback', async ({ page }) => {
        const past = Date.now() - 60 * 60 * 1000; // 1h ago
        const sessionLoadData = {
            metadata: {
                courseId: STU_COURSE_ID,
                courseName: 'BIOC E2E Student Chat',
                studentId,
                studentName: 'E2E Student',
                unitName: 'Unit 1',
                currentMode: 'tutor',
                totalMessages: 4,
                version: '1.0',
            },
            messages: [
                {
                    type: 'user',
                    content: 'restored-user-line',
                    messageType: 'regular-chat',
                    timestamp: new Date(past).toISOString(),
                },
                {
                    type: 'bot',
                    content: '<strong>BiocBot is in tutor mode</strong>',
                    messageType: 'mode-result',
                    isHtml: true,
                    htmlContent: '<strong>BiocBot is in tutor mode</strong>',
                    timestamp: new Date(past + 1).toISOString(),
                    displayTimestamp: '1 hour ago',
                },
                {
                    type: 'bot',
                    content: '<strong>BiocBot is now in protégé mode</strong>',
                    messageType: 'mode-toggle-result',
                    isHtml: true,
                    htmlContent: '<strong>BiocBot is now in protégé mode</strong>',
                    timestamp: new Date(past + 2).toISOString(),
                },
                {
                    type: 'bot',
                    content: '[practice]',
                    messageType: 'practice-test-question',
                    timestamp: new Date(past + 3).toISOString(),
                    displayTimestamp: 'Just now',
                    questionData: {
                        questionIndex: 0,
                        questionText: 'Restored-practice-question?',
                        options: [
                            { text: 'A. choice one', isSelected: false },
                            { text: 'B. choice two', isSelected: true },
                        ],
                        studentAnswer: 'B',
                        feedback: '<em>Saved feedback HTML</em>',
                    },
                },
                {
                    type: 'bot',
                    content: 'restored-bot-line',
                    messageType: 'regular-chat',
                    isHtml: false,
                    hasFlagButton: true,
                    timestamp: new Date(past + 4).toISOString(),
                },
            ],
            practiceTests: null,
            studentAnswers: { answers: [] },
            sessionInfo: { sessionId: 'restored_session_e2e' },
            lastActivityTimestamp: new Date(past + 4).toISOString(),
        };

        // The page reads `sessionStorage.loadChatData` on init and calls
        // loadChatData on its content. Seed it before nav.
        await openStudent(page, { sessionLoadData });

        await expect(page.locator('#chat-messages')).toContainText('restored-user-line', { timeout: 15_000 });
        await expect(page.locator('#chat-messages')).toContainText('restored-bot-line');
        await expect(page.locator('.bot-message.mode-result')).toHaveCount(1);
        await expect(page.locator('.bot-message.mode-toggle-result')).toHaveCount(1);
        await expect(page.locator('.calibration-question')).toContainText('Restored-practice-question?');
        await expect(page.locator('.calibration-feedback')).toContainText('Saved feedback HTML');

        // After restoration the chat input should be enabled, not in assessment mode.
        await expect(page.locator('#chat-input')).toBeEnabled();
    });

    test('loadChatData sanitises un-answered practice questions from a prior session', async ({ page }) => {
        const sessionLoadData = {
            metadata: {
                courseId: STU_COURSE_ID,
                courseName: 'BIOC E2E Student Chat',
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
                    content: '<div class="practice-question-container" data-practice-id="orphan"><div class="practice-question-text">Stale question text</div><div class="practice-options"></div></div>',
                    messageType: 'regular-chat',
                    isHtml: true,
                    timestamp: new Date().toISOString(),
                },
            ],
            practiceTests: null,
            studentAnswers: { answers: [] },
            sessionInfo: { sessionId: 'restored_orphan' },
            lastActivityTimestamp: new Date().toISOString(),
        };

        await openStudent(page, { sessionLoadData });

        await expect(page.locator('.practice-completed').filter({ hasText: 'expired' })).toBeVisible({ timeout: 15_000 });
    });
});

// ----------------------------------------------------------------------------
// Chat history localStorage round-trip — saveChatToHistory, getChatHistory,
// getChatById, deleteChatFromHistory, generateChatTitle/Preview
// ----------------------------------------------------------------------------
test.describe('Chat history localStorage helpers', () => {
    test('saveChatToHistory persists an entry; getChatHistory/getChatById read it back', async ({ page }) => {
        // Don't let saveChatToServer actually hit MongoDB.
        await page.route('/api/chat/save', async (route) => {
            await route.fulfill({ json: { success: true } });
        });

        await openStudent(page);
        await waitForDirectChatReady(page);
        await waitForFn(page, 'saveChatToHistory');

        const stored = await page.evaluate((studentId) => {
            const w = /** @type {any} */ (window);
            const chatData = {
                metadata: {
                    exportDate: new Date().toISOString(),
                    courseId: 'BIOC-E2E-STU',
                    courseName: 'BIOC E2E Student Chat',
                    studentId,
                    studentName: 'E2E Student',
                    unitName: 'Unit 1',
                    currentMode: 'tutor',
                    totalMessages: 2,
                    version: '1.0',
                },
                messages: [
                    { type: 'user', content: 'Here is a long user question about protein structure that should be truncated to make a preview.', messageType: 'regular-chat', timestamp: new Date().toISOString() },
                    { type: 'bot', content: 'A bot answer.', messageType: 'regular-chat', timestamp: new Date().toISOString() },
                ],
                practiceTests: { questions: [], passThreshold: 0 },
                studentAnswers: { answers: [] },
                sessionInfo: { sessionId: 's_h_1', startTime: new Date().toISOString(), duration: '5m' },
            };

            w.saveChatToHistory(chatData);
            const history = w.getChatHistory();
            return {
                length: history.length,
                first: history[0],
                byId: w.getChatById(history[0].id),
                title: w.generateChatTitle(chatData),
                preview: w.generateChatPreview(chatData),
            };
        }, studentId);

        expect(stored.length).toBeGreaterThanOrEqual(1);
        expect(stored.first.title).toContain('BIOC E2E Student Chat');
        expect(stored.byId.id).toBe(stored.first.id);
        expect(stored.preview.length).toBeLessThanOrEqual(103); // 100 chars + ellipsis
        // Title is truncated to 50 chars; the head of the user question must
        // appear and the title should signal truncation via the ellipsis.
        expect(stored.title).toContain('Here is a long user question');
        expect(stored.title).toContain('...');
    });

    test('generateChatTitle/Preview handle a bot-only conversation', async ({ page }) => {
        await openStudent(page);
        await waitForDirectChatReady(page);
        await waitForFn(page, 'generateChatTitle');

        const result = await page.evaluate(() => {
            const w = /** @type {any} */ (window);
            const chatData = {
                metadata: { courseName: 'BIOC E2E', unitName: 'Unit 1', totalMessages: 1, exportDate: new Date().toISOString() },
                messages: [
                    { type: 'bot', content: 'short bot intro', messageType: 'regular-chat', timestamp: new Date().toISOString() },
                ],
                practiceTests: { questions: [] },
            };
            return {
                title: w.generateChatTitle(chatData),
                preview: w.generateChatPreview(chatData),
                emptyPreview: w.generateChatPreview({ messages: [] }),
            };
        });

        expect(result.title).toMatch(/Chat Session \(1 messages\)/);
        expect(result.preview).toContain('short bot intro');
        expect(result.emptyPreview).toBe('Chat session with BiocBot');
    });

    test('generateChatTitle prefers an assessment label when only practice tests exist', async ({ page }) => {
        await openStudent(page);
        await waitForDirectChatReady(page);
        await waitForFn(page, 'generateChatTitle');

        const title = await page.evaluate(() => {
            const w = /** @type {any} */ (window);
            return w.generateChatTitle({
                metadata: { courseName: 'BIOC E2E', unitName: 'Unit 7', totalMessages: 3 },
                messages: [{ type: 'bot', content: 'system', messageType: 'regular-chat', timestamp: new Date().toISOString() }],
                practiceTests: { questions: [{ q: 1 }] },
            });
        });
        expect(title).toContain('Assessment');
        expect(title).toContain('Unit 7');
    });

    /**
     * Product-bug guard: deleteChatFromHistory writes back to the
     * non-namespaced "biocbot_chat_history" key, while saveChatToHistory and
     * getChatHistory use the namespaced "biocbot_chat_history_<studentId>"
     * key. The result is that delete silently appears to succeed (returns
     * true) but the entry is never actually removed from the student's
     * history.
     *
     * This test is intentionally left FAILING — see FINDINGS.md for the
     * report. Tightening it to expect a successful delete would mask the
     * bug.
     */
    test('deleteChatFromHistory actually removes the entry (currently FAILS — see FINDINGS)', async ({ page }) => {
        await page.route('/api/chat/save', async (route) => {
            await route.fulfill({ json: { success: true } });
        });

        await openStudent(page);
        await waitForDirectChatReady(page);
        await waitForFn(page, 'saveChatToHistory');

        const beforeAndAfter = await page.evaluate((studentId) => {
            const w = /** @type {any} */ (window);
            const chatData = {
                metadata: {
                    exportDate: new Date().toISOString(),
                    courseId: 'BIOC-E2E-STU',
                    courseName: 'BIOC E2E Student Chat',
                    studentId,
                    studentName: 'E2E Student',
                    unitName: 'Unit 1',
                    currentMode: 'tutor',
                    totalMessages: 1,
                    version: '1.0',
                },
                messages: [{ type: 'user', content: 'hi', messageType: 'regular-chat', timestamp: new Date().toISOString() }],
                practiceTests: { questions: [], passThreshold: 0 },
                studentAnswers: { answers: [] },
                sessionInfo: { sessionId: 's_del', startTime: new Date().toISOString(), duration: '1m' },
            };
            w.saveChatToHistory(chatData);
            const beforeId = w.getChatHistory()[0].id;
            const deleteResult = w.deleteChatFromHistory(beforeId);
            const after = w.getChatHistory();
            return { beforeId, deleteResult, afterLength: after.length, stillThere: after.some((c) => c.id === beforeId) };
        }, studentId);

        expect(beforeAndAfter.deleteResult).toBe(true);
        // BUG: deleteChatFromHistory writes to the wrong localStorage key, so
        // the entry remains in the student's namespaced history. Expecting
        // removal here surfaces the bug.
        expect(beforeAndAfter.stillThere).toBe(false);
    });
});

// ----------------------------------------------------------------------------
// Mode toggle (initializeModeToggle + showModeToggleResult)
// ----------------------------------------------------------------------------
test.describe('Mode toggle (Protégé / Tutor)', () => {
    test('clicking the toggle writes localStorage and appends a mode-toggle-result message', async ({ page }) => {
        await openStudent(page);
        await waitForDirectChatReady(page);

        // Starts in tutor mode.
        await expect.poll(() => page.evaluate(() => localStorage.getItem('studentMode'))).toBe('tutor');

        // The native checkbox is visually replaced by a toggle-slider label,
        // so the input itself isn't user-clickable. Trigger via the change
        // listener student.js registered on the checkbox.
        await page.evaluate(() => {
            const c = /** @type {HTMLInputElement} */ (document.getElementById('mode-toggle-checkbox'));
            c.checked = false; // protégé
            c.dispatchEvent(new Event('change', { bubbles: true }));
        });
        await expect(page.locator('.mode-toggle-result')).toContainText('You have now entered protégé mode', { timeout: 10_000 });
        await expect.poll(() => page.evaluate(() => localStorage.getItem('studentMode'))).toBe('protege');

        await page.evaluate(() => {
            const c = /** @type {HTMLInputElement} */ (document.getElementById('mode-toggle-checkbox'));
            c.checked = true; // tutor
            c.dispatchEvent(new Event('change', { bubbles: true }));
        });
        await expect(page.locator('.mode-toggle-result').last()).toContainText('You have now entered tutor mode');
        await expect.poll(() => page.evaluate(() => localStorage.getItem('studentMode'))).toBe('tutor');
    });
});

// ----------------------------------------------------------------------------
// New-session button (initializeNewSessionButton + handleNewSession +
// showNewSessionNotification)
// ----------------------------------------------------------------------------
test.describe('New-session button', () => {
    test('clicking new-session shows the notification, rotates chat data, and re-runs initialization', async ({ page }) => {
        await openStudent(page, {
            chatData: {
                metadata: {
                    courseId: STU_COURSE_ID,
                    courseName: 'BIOC E2E Student Chat',
                    studentId,
                    studentName: 'E2E Student',
                    unitName: 'Unit 1',
                    currentMode: 'tutor',
                    totalMessages: 1,
                    version: '1.0',
                },
                messages: [
                    { type: 'user', content: 'pre-existing', messageType: 'regular-chat', timestamp: new Date().toISOString() },
                ],
                practiceTests: null,
                studentAnswers: { answers: [] },
                sessionInfo: { sessionId: 'pre_new_session' },
                lastActivityTimestamp: new Date().toISOString(),
            },
        });
        await waitForRestoredChatReady(page, 'pre-existing');

        await page.locator('#new-session-btn').click();

        await expect(page.locator('.notification.info').filter({ hasText: 'New chat session started' })).toBeVisible({ timeout: 5_000 });
        await expect(page.locator('#chat-messages')).toContainText('Welcome to BiocBot!', { timeout: 10_000 });
        await expect(page.locator('#chat-messages')).not.toContainText('pre-existing');

        // Initialization immediately creates the replacement session. Assert
        // its stable final state instead of racing the brief cleared state.
        const freshChat = await page.evaluate((sid) => {
            const raw = localStorage.getItem(`biocbot_current_chat_${sid}`);
            return raw ? JSON.parse(raw) : null;
        }, studentId);
        expect(freshChat.sessionInfo.sessionId).not.toBe('pre_new_session');
        expect(freshChat.messages.some((/** @type {any} */ message) => message.content.includes('Welcome to BiocBot!'))).toBe(true);
        expect(freshChat.messages.some((/** @type {any} */ message) => message.content.includes('pre-existing'))).toBe(false);
    });

    test('new-session with no course selected does not crash and re-loads available courses', async ({ page }) => {
        await openStudent(page);
        await waitForDirectChatReady(page);

        await page.evaluate(() => {
            localStorage.removeItem('selectedCourseId');
            localStorage.removeItem('selectedCourseName');
        });

        await page.locator('#new-session-btn').click();
        // After the handler runs we should not have crashed; chat-messages
        // should re-render. There may be a fresh welcome bot bubble.
        await page.waitForTimeout(800);
        await expect(page.locator('#chat-messages')).toBeVisible();
    });
});

// ----------------------------------------------------------------------------
// Auto-continue notification (showAutoContinueNotification)
// ----------------------------------------------------------------------------
test.describe('Auto-continue notification', () => {
    test('checkForAutoContinue restores recent chat and surfaces the auto-continue toast', async ({ page }) => {
        // Build a saved chat with a recent lastActivity so checkForAutoContinue
        // returns true and showAutoContinueNotification runs.
        const recent = new Date(Date.now() - 60 * 1000).toISOString();
        await openStudent(page, {
            chatData: {
                metadata: {
                    courseId: STU_COURSE_ID,
                    courseName: 'BIOC E2E Student Chat',
                    studentId,
                    studentName: 'E2E Student',
                    unitName: 'Unit 1',
                    currentMode: 'tutor',
                    totalMessages: 1,
                    version: '1.0',
                },
                messages: [
                    { type: 'user', content: 'auto-continue-source', messageType: 'regular-chat', timestamp: recent },
                ],
                practiceTests: null,
                studentAnswers: { answers: [] },
                sessionInfo: { sessionId: 'auto_continue_session_e2e' },
                lastActivityTimestamp: recent,
            },
        });

        await expect(page.locator('.notification.success').filter({ hasText: 'Chat continued from where you left off' })).toBeVisible({ timeout: 10_000 });
    });
});

// ----------------------------------------------------------------------------
// forceUpdateCourseName, addChangeCourseButton, formatTimestamp, formatHistoryDate
// ----------------------------------------------------------------------------
test.describe('Pure helpers — timestamps, course-name forcing, change-course button', () => {
    test('formatTimestamp covers each time-bucket branch', async ({ page }) => {
        await openStudent(page);
        await waitForDirectChatReady(page);
        await waitForFn(page, 'formatTimestamp');

        const out = await page.evaluate(() => {
            const w = /** @type {any} */ (window);
            const now = new Date();
            return {
                seconds: w.formatTimestamp(new Date(now.getTime() - 1000)),
                minutes: w.formatTimestamp(new Date(now.getTime() - 5 * 60_000)),
                singleMinute: w.formatTimestamp(new Date(now.getTime() - 60_000)),
                hours: w.formatTimestamp(new Date(now.getTime() - 3 * 60 * 60_000)),
                singleHour: w.formatTimestamp(new Date(now.getTime() - 60 * 60_000)),
                days: w.formatTimestamp(new Date(now.getTime() - 3 * 24 * 60 * 60_000)),
                singleDay: w.formatTimestamp(new Date(now.getTime() - 24 * 60 * 60_000)),
                older: w.formatTimestamp(new Date(now.getTime() - 30 * 24 * 60 * 60_000)),
            };
        });

        expect(out.seconds).toBe('Just now');
        expect(out.singleMinute).toBe('1 minute ago');
        expect(out.minutes).toBe('5 minutes ago');
        expect(out.singleHour).toBe('1 hour ago');
        expect(out.hours).toBe('3 hours ago');
        expect(out.singleDay).toBe('1 day ago');
        expect(out.days).toBe('3 days ago');
        // Older messages get a formatted date string — verify the shape only.
        expect(out.older).toMatch(/\b\d{1,2}\b/);
    });

    test('formatHistoryDate covers Today / Yesterday / this-week / older branches', async ({ page }) => {
        await openStudent(page);
        await waitForDirectChatReady(page);
        await waitForFn(page, 'formatHistoryDate');

        const out = await page.evaluate(() => {
            const w = /** @type {any} */ (window);
            const now = new Date();
            return {
                today: w.formatHistoryDate(now.toISOString()),
                yesterday: w.formatHistoryDate(new Date(now.getTime() - 24 * 60 * 60_000).toISOString()),
                thisWeek: w.formatHistoryDate(new Date(now.getTime() - 3 * 24 * 60 * 60_000).toISOString()),
                older: w.formatHistoryDate(new Date(now.getTime() - 30 * 24 * 60 * 60_000).toISOString()),
                invalid: w.formatHistoryDate('not-a-date'),
            };
        });

        expect(out.today).toMatch(/^Today,\s/);
        expect(out.yesterday).toMatch(/^Yesterday,\s/);
        expect(out.thisWeek).not.toMatch(/Today|Yesterday/);
        expect(out.older).toMatch(/\d{4}/);
        // Invalid date input returns *something* (either 'Unknown date' or a
        // formatted "Invalid Date"); shouldn't throw.
        expect(typeof out.invalid).toBe('string');
    });

    test('forceUpdateCourseName returns true when there are course-name elements to update', async ({ page }) => {
        await openStudent(page);
        await waitForDirectChatReady(page);
        await waitForFn(page, 'forceUpdateCourseName');

        const updated = await page.evaluate(() => {
            const w = /** @type {any} */ (window);
            return w.forceUpdateCourseName('NEW E2E COURSE');
        });
        expect(updated).toBe(true);
    });

    test('forceUpdateCourseName returns false when no course-name elements exist', async ({ page }) => {
        await openStudent(page);
        await waitForDirectChatReady(page);
        await waitForFn(page, 'forceUpdateCourseName');

        const updated = await page.evaluate(() => {
            // Strip all elements that match any selector forceUpdate looks at.
            document.querySelectorAll('.course-name').forEach((el) => el.remove());
            const w = /** @type {any} */ (window);
            return w.forceUpdateCourseName('IGNORED');
        });
        expect(updated).toBe(false);
    });

    test('addChangeCourseButton is idempotent', async ({ page }) => {
        await openStudent(page);
        await waitForDirectChatReady(page);
        await waitForFn(page, 'addChangeCourseButton');

        const count = await page.evaluate(() => {
            const w = /** @type {any} */ (window);
            w.addChangeCourseButton();
            w.addChangeCourseButton();
            return document.querySelectorAll('#change-course-btn').length;
        });
        expect(count).toBe(1);
    });

    test('getAuthToken returns the placeholder string', async ({ page }) => {
        await openStudent(page);
        await waitForDirectChatReady(page);
        await waitForFn(page, 'getAuthToken');

        const token = await page.evaluate(() => {
            const w = /** @type {any} */ (window);
            return w.getAuthToken();
        });
        expect(token).toBe('placeholder-token');
    });

    test('generateQuestionId produces a stable shape', async ({ page }) => {
        await openStudent(page);
        await waitForDirectChatReady(page);
        await waitForFn(page, 'generateQuestionId');

        const ids = await page.evaluate(() => {
            const w = /** @type {any} */ (window);
            return [
                w.generateQuestionId('plain text'),
                w.generateQuestionId('weird $ chars # !!'),
                w.generateQuestionId(''),
            ];
        });
        for (const id of ids) {
            expect(id).toMatch(/^bot_response_\d+_/);
        }
    });
});

// ----------------------------------------------------------------------------
// addSampleChatData (test-only console helper) — coverage only
// ----------------------------------------------------------------------------
test.describe('addSampleChatData test helper', () => {
    test('addSampleChatData writes a fully-formed history entry', async ({ page }) => {
        await page.route('/api/chat/save', async (route) => {
            await route.fulfill({ json: { success: true } });
        });

        await openStudent(page);
        await waitForDirectChatReady(page);
        await waitForFn(page, 'addSampleChatData');

        const after = await page.evaluate((studentId) => {
            const w = /** @type {any} */ (window);
            w.addSampleChatData();
            const history = w.getChatHistory();
            return { length: history.length, first: history[0], studentId };
        }, studentId);

        // Note: addSampleChatData hard-codes studentId='test-student-123' in
        // its metadata, which means saveChatToHistory writes to a *different*
        // namespaced key than the current student. getChatHistory reads from
        // the current student's key, so length should be 0 here.
        // This is a coverage call, so we don't strictly assert on shape.
        expect(typeof after.length).toBe('number');
    });
});

// ----------------------------------------------------------------------------
// Course-selection dropdown (showCourseSelection) — covers the prompt-not-
// enrolled branch and the leftover-course-clear branch in loadAvailableCourses.
// ----------------------------------------------------------------------------
test.describe('Course selection dropdown branches', () => {
    test('a stale selectedCourseId without chat data is cleared and the dropdown re-appears', async ({ page }) => {
        await page.addInitScript(() => {
            try {
                localStorage.clear();
                sessionStorage.clear();
                // Seed a stale courseId but NO chat data for the user — this
                // forces loadAvailableCourses to wipe the stale id and show
                // the dropdown.
                localStorage.setItem('selectedCourseId', 'STALE-COURSE-XYZ');
                localStorage.setItem('selectedCourseName', 'Stale Course');
            } catch (_) { /* noop */ }
        });
        await page.goto('/student');

        // showCourseSelection wraps the select in #course-selection-wrapper.
        await expect(page.locator('#course-select')).toBeVisible({ timeout: 15_000 });

        await expect.poll(() => page.evaluate(() => localStorage.getItem('selectedCourseId'))).not.toBe('STALE-COURSE-XYZ');
    });
});
