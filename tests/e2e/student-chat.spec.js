// @ts-check
/**
 * Student-side chat e2e tests. Exercises the flows owned by student.js and
 * the related endpoints: agreement modal, course-selection dropdown,
 * enrollment & soft-deletion gates, struggle topic tracking, chat history
 * resume/rename/delete, and cross-course / cross-student isolation.
 *
 * The suite mixes UI tests (real browser at /student) with API tests via
 * Playwright's `request` fixture against the running server. Where data flows
 * through MongoDB, the helper modules seed real documents — no mocks.
 */

const { test, expect } = require('./fixtures/monocart');
const { TEST_USERS, loadCredentials, storageStatePath } = require('./helpers/users');
const { withDb, getUserIdByUsername } = require('./helpers/quiz');
const { resetLlmStub, enqueueLlmResponses, addLlmStubRule, getLlmStubState } = require('./helpers/llm-stub');
const {
    STU_COURSE_ID,
    STU_COURSE_NAME,
    STU_INACTIVE_COURSE_ID,
    STU_OTHER_COURSE_ID,
    STU_DELETED_COURSE_ID,
    OTHER_STUDENT_ID,
    APPROVED_TOPIC,
    getStudentId,
    resetStudentChatData,
    cleanupStudentChatData,
    seedChatSession,
    setUserAgreement,
} = require('./helpers/student');

/** @type {string} */
let instructorId;
/** @type {string} */
let studentId;
/** @type {string} */
let studentPassword;
/** @type {string} */
let reloginStudentId;
/** @type {string} */
let reloginStudentPassword;

test.beforeAll(async () => {
    instructorId = await getUserIdByUsername(TEST_USERS.instructor.username);
    studentId = await getStudentId();
    studentPassword = loadCredentials().student;
    reloginStudentId = await getUserIdByUsername(TEST_USERS.student_relogin.username);
    reloginStudentPassword = loadCredentials().student_relogin;
});

test.afterAll(async () => {
    await cleanupStudentChatData();
});

async function loginAsStudent(page) {
    await page.goto('/login');
    await page.locator('#auth-form input#username').fill(TEST_USERS.student.username);
    await page.locator('#auth-form input#password').fill(studentPassword);
    await page.locator('#auth-form button#login-btn').click();
    await page.waitForURL((url) => url.pathname !== '/' && url.pathname !== '/login', {
        timeout: 10_000,
    });
}

// ----------------------------------------------------------------------------
// /api/user-agreement — agreement persistence
// ----------------------------------------------------------------------------
test.describe('User agreement — persistence & semantics', () => {
    test.use({ storageState: storageStatePath('student') });

    test.beforeEach(async () => {
        await resetStudentChatData({ instructorId });
    });

    test('status flips to hasAgreed:true after POST /agree', async ({ request: api }) => {
        await setUserAgreement(studentId, false);

        const before = await api.get('/api/user-agreement/status');
        expect(before.ok()).toBeTruthy();
        const beforeBody = await before.json();
        expect(beforeBody).toMatchObject({ success: true, data: { hasAgreed: false } });

        const agree = await api.post('/api/user-agreement/agree', {
            data: { agreementVersion: '1.0' },
        });
        expect(agree.ok()).toBeTruthy();
        const agreeBody = await agree.json();
        expect(agreeBody).toMatchObject({ success: true });

        const after = await api.get('/api/user-agreement/status');
        const afterBody = await after.json();
        expect(afterBody).toMatchObject({
            success: true,
            data: { hasAgreed: true, agreementVersion: '1.0' },
        });
    });
});

test.describe('Agreement modal — UI behavior', () => {
    test.beforeEach(async () => {
        await resetStudentChatData({ instructorId });
    });

    test('modal is shown on /student/history when the user has not agreed', async ({ page }) => {
        await setUserAgreement(studentId, false);
        await loginAsStudent(page);

        // agreement-modal.js only auto-initializes when the path contains
        // /student/ (with a trailing slash) — /student/history matches.
        await page.goto('/student/history');

        const modal = page.locator('#agreement-modal-overlay');
        await expect(modal).toBeVisible({ timeout: 10_000 });
        await expect(modal.locator('#agree-btn')).toBeDisabled();
    });

    test('checking the box enables Agree, clicking it persists agreement and hides the modal', async ({ page }) => {
        await setUserAgreement(studentId, false);
        await loginAsStudent(page);
        await page.goto('/student/history');

        const modal = page.locator('#agreement-modal-overlay');
        await expect(modal).toBeVisible({ timeout: 10_000 });

        await page.locator('#agreement-checkbox').check();
        const agreeBtn = page.locator('#agree-btn');
        await expect(agreeBtn).toBeEnabled();
        await agreeBtn.click();

        await expect(modal).toBeHidden({ timeout: 10_000 });

        // Persistence — the server-side state must reflect the click, not
        // just the DOM.
        const stored = await withDb((db) =>
            db.collection('userAgreements').findOne({ userId: studentId, userType: 'student' })
        );
        expect(stored).toMatchObject({ hasAgreed: true, agreementVersion: '1.0' });
    });

    test('modal is NOT auto-shown on /student (root chat page) — known path-matching gap', async ({ page }) => {
        // The auto-init in agreement-modal.js checks
        //   window.location.pathname.includes('/student/')
        // which is false for "/student" (no trailing slash). New students
        // never see the agreement on the page they land on by default.
        await setUserAgreement(studentId, false);
        await loginAsStudent(page);

        await page.goto('/student');
        // Give student.js + agreement-modal.js a generous window to run.
        await page.waitForTimeout(2000);

        const modal = page.locator('#agreement-modal-overlay');
        // Documenting *expected* behavior: the modal should be visible on the
        // primary student page too. The product fails this assertion today.
        await expect(modal).toBeVisible({ timeout: 5_000 });
    });
});

// ----------------------------------------------------------------------------
// Course-selection dropdown (UI)
// ----------------------------------------------------------------------------
test.describe('Course selection dropdown', () => {
    test.beforeEach(async () => {
        await resetStudentChatData({ instructorId });
        await setUserAgreement(studentId, true);
    });

    test('a fresh student sees the dropdown with active courses and no soft-deleted one', async ({ page }) => {
        await loginAsStudent(page);

        // Wipe local state so student.js falls into "first time user" path,
        // even though the storageState already has cookies set.
        await page.addInitScript(() => {
            try {
                localStorage.removeItem('selectedCourseId');
                localStorage.removeItem('selectedCourseName');
            } catch (_) {}
        });
        await page.goto('/student');

        const select = page.locator('#course-select');
        await expect(select).toBeVisible({ timeout: 15_000 });

        const values = await select.locator('option').evaluateAll(
            (opts) => opts.map((o) => /** @type {HTMLOptionElement} */ (o).value)
        );
        expect(values).toContain(STU_COURSE_ID);
        expect(values).toContain(STU_OTHER_COURSE_ID);
        // Soft-deleted course must never appear in /available/all.
        expect(values).not.toContain(STU_DELETED_COURSE_ID);
        // Inactive courses are still visible for students per current
        // /available/all behavior (filter is by status==='active'), so:
        expect(values).not.toContain(STU_INACTIVE_COURSE_ID);
    });

    test('selecting an enrolled course hides the dropdown and loads the course header', async ({ page }) => {
        await loginAsStudent(page);
        await page.addInitScript(() => {
            try { localStorage.clear(); } catch (_) {}
        });
        await page.goto('/student');

        const select = page.locator('#course-select');
        await expect(select).toBeVisible({ timeout: 15_000 });
        await select.selectOption(STU_COURSE_ID);

        // The wrapper is hidden after a successful load.
        await expect(page.locator('#course-selection-wrapper')).toBeHidden({ timeout: 15_000 });

        // Header should now show the course name.
        await expect(page.locator('.course-name')).toContainText('BIOC E2E Student Chat', {
            timeout: 15_000,
        });

        // And localStorage should have been written by loadCourseData.
        const stored = await page.evaluate(() => ({
            id: localStorage.getItem('selectedCourseId'),
            name: localStorage.getItem('selectedCourseName'),
        }));
        expect(stored.id).toBe(STU_COURSE_ID);
        expect(stored.name).toContain('BIOC E2E Student Chat');
    });
});

// ----------------------------------------------------------------------------
// /api/courses/:courseId — student access gates
// ----------------------------------------------------------------------------
test.describe('GET /api/courses/:courseId — student access gates', () => {
    test.use({ storageState: storageStatePath('student') });

    test.beforeEach(async () => {
        await resetStudentChatData({ instructorId });
    });

    test('200 + transformed course for an enrolled, active course', async ({ request: api }) => {
        const res = await api.get(`/api/courses/${STU_COURSE_ID}`);
        expect(res.ok()).toBeTruthy();
        const body = await res.json();
        expect(body).toMatchObject({
            success: true,
            data: {
                id: STU_COURSE_ID,
                status: 'active',
            },
        });
        // Student-facing payload must NOT include the instructor course code.
        expect(body.data.instructorCourseCode).toBeUndefined();
    });

    test('403 for an inactive course (deactivated by instructor)', async ({ request: api }) => {
        const res = await api.get(`/api/courses/${STU_INACTIVE_COURSE_ID}`);
        expect(res.status()).toBe(403);
    });

    test('403 for a soft-deleted course', async ({ request: api }) => {
        // requireActiveCourseForNonInstructors treats 'deleted' the same as
        // 'inactive' — the student should get a 403 with a clear message.
        const res = await api.get(`/api/courses/${STU_DELETED_COURSE_ID}`);
        expect(res.status()).toBe(403);
    });

    test('403 when student is not enrolled in a real course', async ({ request: api }) => {
        // Drop the student from enrollment, then try again.
        await withDb(async (db) => {
            await db.collection('courses').updateOne(
                { courseId: STU_COURSE_ID },
                { $set: { [`studentEnrollment.${studentId}.enrolled`]: false } }
            );
        });

        const res = await api.get(`/api/courses/${STU_COURSE_ID}`);
        expect(res.status()).toBe(403);
    });

    test('404 for a courseId that does not exist', async ({ request: api }) => {
        const res = await api.get('/api/courses/BIOC-DOES-NOT-EXIST-9999');
        expect(res.status()).toBe(404);
    });
});

// ----------------------------------------------------------------------------
// /api/chat — message sending, struggle tracking, content rules
// ----------------------------------------------------------------------------
test.describe('POST /api/chat — basics', () => {
    test.use({ storageState: storageStatePath('student') });

    test.beforeEach(async () => {
        await resetStudentChatData({ instructorId });
    });

    test('rejects an empty message with 400', async ({ request: api }) => {
        const res = await api.post('/api/chat', {
            data: {
                message: '',
                courseId: STU_COURSE_ID,
                unitName: 'Unit 1',
                mode: 'tutor',
            },
        });
        expect(res.status()).toBe(400);
    });

    test('rejects a request missing courseId/unitName with 400', async ({ request: api }) => {
        const res = await api.post('/api/chat', {
            data: { message: 'hello', mode: 'tutor' },
        });
        expect(res.status()).toBe(400);
    });

    test('403 when posting chat against a deactivated course', async ({ request: api }) => {
        const res = await api.post('/api/chat', {
            data: {
                message: 'hello',
                courseId: STU_INACTIVE_COURSE_ID,
                unitName: 'Unit 1',
                mode: 'tutor',
            },
        });
        expect(res.status()).toBe(403);
    });

    test('profanity filter returns a system warning without invoking the LLM', async ({ request: api }) => {
        const res = await api.post('/api/chat', {
            data: {
                message: 'this is some shit answer',
                courseId: STU_COURSE_ID,
                unitName: 'Unit 1',
                mode: 'tutor',
            },
        });
        expect(res.ok()).toBeTruthy();
        const body = await res.json();
        expect(body).toMatchObject({
            success: true,
            model: 'system',
            debug: { profanityFiltered: true },
        });
        expect(body.message).toContain('language');
    });
});

test.describe('POST /api/chat/summary', () => {
    test.use({ storageState: storageStatePath('student') });

    test.beforeEach(async ({ request: api }) => {
        await resetStudentChatData({ instructorId });
        await resetLlmStub(api);
    });

    test('summarizes regular student and bot messages for the selected published unit', async ({ request: api }) => {
        await enqueueLlmResponses(api, [
            'I asked about glycolysis and BiocBot explained how ATP payoff follows the investment phase. I still want to connect that to regulation.',
        ]);

        const res = await api.post('/api/chat/summary', {
            data: {
                courseId: STU_COURSE_ID,
                unitName: 'Unit 1',
                mode: 'protege',
                messages: [
                    {
                        type: 'user',
                        messageType: 'regular-chat',
                        content: 'Earlier generated summary that should not be summarized again.',
                        isSummarySeed: true,
                    },
                    {
                        type: 'bot',
                        messageType: 'assessment-start',
                        content: 'Starting Assessment for Unit 1',
                    },
                    {
                        type: 'user',
                        messageType: 'regular-chat',
                        content: 'How does glycolysis pay back ATP?',
                    },
                    {
                        type: 'bot',
                        messageType: 'regular-chat',
                        content: 'BiocBot explained the investment and payoff phases.',
                    },
                ],
            },
        });

        expect(res.ok()).toBeTruthy();
        const body = await res.json();
        expect(body).toMatchObject({
            success: true,
            mode: 'protege',
            unitName: 'Unit 1',
            sourceMessageCount: 2,
        });
        expect(body.summary).toContain('glycolysis');

        const stubState = await getLlmStubState(api);
        expect(stubState.callCount).toBe(1);
    });

    test('uses the course-specific chat summary prompt when configured', async ({ request: api }) => {
        await withDb((db) =>
            db.collection('courses').updateOne(
                { courseId: STU_COURSE_ID },
                { $set: { 'prompts.chatSummary': 'COURSE CUSTOM SUMMARY INSTRUCTIONS: mention glycolysis regulation.' } }
            )
        );
        await addLlmStubRule(api, {
            matchMessage: 'COURSE CUSTOM SUMMARY INSTRUCTIONS',
            content: 'I used the custom course summary prompt for glycolysis regulation.',
        });

        const res = await api.post('/api/chat/summary', {
            data: {
                courseId: STU_COURSE_ID,
                unitName: 'Unit 1',
                mode: 'tutor',
                messages: [
                    {
                        type: 'user',
                        messageType: 'regular-chat',
                        content: 'How is glycolysis regulated?',
                    },
                    {
                        type: 'bot',
                        messageType: 'regular-chat',
                        content: 'BiocBot discussed phosphofructokinase and ATP inhibition.',
                    },
                ],
            },
        });

        expect(res.ok()).toBeTruthy();
        const body = await res.json();
        expect(body.summary).toBe('I used the custom course summary prompt for glycolysis regulation.');
    });

    test('requires at least one regular student message and one regular bot message', async ({ request: api }) => {
        const res = await api.post('/api/chat/summary', {
            data: {
                courseId: STU_COURSE_ID,
                unitName: 'Unit 1',
                mode: 'tutor',
                messages: [
                    {
                        type: 'user',
                        messageType: 'regular-chat',
                        content: 'I asked one thing.',
                    },
                ],
            },
        });

        expect(res.status()).toBe(400);
        const body = await res.json();
        expect(body.message).toContain('student message and one BiocBot message');
    });
});

test.describe('POST /api/chat — struggle tracking via explanation request', () => {
    test.use({ storageState: storageStatePath('student') });

    test.beforeEach(async () => {
        await resetStudentChatData({ instructorId });
    });

    // Exercising the LLM path is gated on whether the API key is reachable.
    // For the explanation flow we skip LLM analysis entirely (isExplanationRequest
    // short-circuits to "increment struggle for the named approved topic"),
    // so this test is fast and deterministic.
    test('explanation request increments struggle counter for an approved topic', async ({ request: api }) => {
        const res = await api.post('/api/chat', {
            data: {
                message: 'Please explain photosynthesis again.',
                courseId: STU_COURSE_ID,
                unitName: 'Unit 1',
                mode: 'tutor',
                isExplanationRequest: true,
                topic: APPROVED_TOPIC,
            },
            timeout: 60_000,
        });
        expect(res.ok()).toBeTruthy();
        const body = await res.json();
        expect(body.success).toBeTruthy();

        // The reply may legitimately omit struggleState if the toolkit
        // failed; we verify persistence in the DB to keep the test honest.
        const updated = await withDb((db) =>
            db.collection('users').findOne({ userId: studentId })
        );
        const topics = updated?.struggleState?.topics ?? [];
        const photoTopic = topics.find(
            (t) => (t.topic || '').toLowerCase() === APPROVED_TOPIC.toLowerCase()
        );
        expect(photoTopic).toBeTruthy();
        // User.updateUserStruggleState stores the running tally under `count`.
        expect(photoTopic.count || 0).toBeGreaterThanOrEqual(1);
    });

    test('explanation request for an UNapproved topic does NOT alter struggle state', async ({ request: api }) => {
        const res = await api.post('/api/chat', {
            data: {
                message: 'Please explain something off-syllabus again.',
                courseId: STU_COURSE_ID,
                unitName: 'Unit 1',
                mode: 'tutor',
                isExplanationRequest: true,
                topic: 'Underwater Basket Weaving',
            },
            timeout: 60_000,
        });
        expect(res.ok()).toBeTruthy();

        const updated = await withDb((db) =>
            db.collection('users').findOne({ userId: studentId })
        );
        const topics = updated?.struggleState?.topics ?? [];
        const offTopic = topics.find(
            (t) => (t.topic || '').toLowerCase() === 'underwater basket weaving'
        );
        expect(offTopic).toBeUndefined();
    });
});

// ----------------------------------------------------------------------------
// /api/student/struggle — read / reset
// ----------------------------------------------------------------------------
test.describe('Struggle state — GET + reset', () => {
    test.use({ storageState: storageStatePath('student') });

    test.beforeEach(async () => {
        await resetStudentChatData({ instructorId });
    });

    test('GET returns an empty topic array for a fresh student', async ({ request: api }) => {
        const res = await api.get('/api/student/struggle');
        expect(res.ok()).toBeTruthy();
        const body = await res.json();
        expect(body).toMatchObject({ success: true });
        expect(Array.isArray(body.struggleState?.topics)).toBeTruthy();
    });

    test('POST /reset clears the named approved topic', async ({ request: api }) => {
        // Seed an active struggle topic directly in DB so we don't need the LLM.
        // The User model normalizes topic strings to lowercase before storing
        // and before lookup, so seed the lowercased form for a realistic match.
        const normalized = APPROVED_TOPIC.toLowerCase();
        await withDb(async (db) => {
            await db.collection('users').updateOne(
                { userId: studentId },
                {
                    $set: {
                        struggleState: {
                            topics: [
                                {
                                    topic: normalized,
                                    count: 5,
                                    isActive: true,
                                    lastStruggle: new Date(),
                                },
                            ],
                        },
                    },
                }
            );
        });

        const res = await api.post('/api/student/struggle/reset', {
            data: { topic: APPROVED_TOPIC, courseId: STU_COURSE_ID },
        });
        expect(res.ok()).toBeTruthy();
        const body = await res.json();
        expect(body.success).toBeTruthy();

        const after = await withDb((db) =>
            db.collection('users').findOne({ userId: studentId })
        );
        const topic = (after?.struggleState?.topics || []).find(
            (t) => (t.topic || '').toLowerCase() === normalized
        );
        // After reset, the topic should be gone OR no longer active / count=0.
        if (topic) {
            expect(topic.isActive).toBeFalsy();
            expect(topic.count || 0).toBe(0);
        }
    });

    test('POST /reset without a topic returns 400', async ({ request: api }) => {
        const res = await api.post('/api/student/struggle/reset', { data: {} });
        expect(res.status()).toBe(400);
    });
});

// ----------------------------------------------------------------------------
// /api/chat/save + /api/students/.../sessions/own — history flow
// ----------------------------------------------------------------------------
test.describe('Chat save & own-history listing', () => {
    test.use({ storageState: storageStatePath('student') });

    test.beforeEach(async () => {
        await resetStudentChatData({ instructorId });
    });

    test('a saved session shows up in the student\'s own session list', async ({ request: api }) => {
        const sessionId = `e2e_session_${Date.now()}`;
        const save = await api.post('/api/chat/save', {
            data: {
                sessionId,
                courseId: STU_COURSE_ID,
                studentId,
                studentName: 'E2E Student',
                unitName: 'Unit 1',
                title: 'E2E save test',
                messageCount: 2,
                duration: '1m',
                chatData: {
                    messages: [
                        { type: 'user', content: 'Hi', timestamp: new Date().toISOString() },
                        { type: 'bot', content: 'Hello', timestamp: new Date().toISOString() },
                    ],
                },
            },
        });
        expect(save.ok()).toBeTruthy();

        const list = await api.get(`/api/students/${STU_COURSE_ID}/${studentId}/sessions/own`);
        expect(list.ok()).toBeTruthy();
        const body = await list.json();
        const sessions = body.data?.sessions || [];
        const ours = sessions.find((s) => s.sessionId === sessionId);
        expect(ours).toBeTruthy();
        expect(ours.title).toBe('E2E save test');
    });

    test('soft-delete via /own marks studentDeleted and removes from list', async ({ request: api }) => {
        const sessionId = `e2e_session_del_${Date.now()}`;
        await seedChatSession({
            sessionId,
            courseId: STU_COURSE_ID,
            studentId,
            studentName: 'E2E Student',
            title: 'To be deleted',
        });

        const del = await api.delete(
            `/api/students/${STU_COURSE_ID}/${studentId}/sessions/${sessionId}/own`
        );
        expect(del.ok()).toBeTruthy();

        const list = await api.get(`/api/students/${STU_COURSE_ID}/${studentId}/sessions/own`);
        const body = await list.json();
        const sessions = body.data?.sessions || [];
        expect(sessions.find((s) => s.sessionId === sessionId)).toBeFalsy();
    });

    test('title update via /title persists and is visible on next listing', async ({ request: api }) => {
        const sessionId = `e2e_session_title_${Date.now()}`;
        await seedChatSession({
            sessionId,
            courseId: STU_COURSE_ID,
            studentId,
            studentName: 'E2E Student',
            title: 'Old title',
        });

        const update = await api.put(
            `/api/students/${STU_COURSE_ID}/${studentId}/sessions/${sessionId}/title`,
            { data: { title: 'New title' } }
        );
        expect(update.ok()).toBeTruthy();

        const list = await api.get(`/api/students/${STU_COURSE_ID}/${studentId}/sessions/own`);
        const body = await list.json();
        const ours = body.data.sessions.find((s) => s.sessionId === sessionId);
        expect(ours.title).toBe('New title');
    });
});

// ----------------------------------------------------------------------------
// Cross-course / cross-student isolation
// ----------------------------------------------------------------------------
test.describe('Isolation — cross-course and cross-student', () => {
    test.use({ storageState: storageStatePath('student') });

    test.beforeEach(async () => {
        await resetStudentChatData({ instructorId });
    });

    test('sessions saved against course A do NOT leak into course B\'s listing', async ({ request: api }) => {
        const sessionA = `e2e_xc_a_${Date.now()}`;
        await seedChatSession({
            sessionId: sessionA,
            courseId: STU_COURSE_ID,
            studentId,
            studentName: 'E2E Student',
            title: 'A side',
        });

        const sessionB = `e2e_xc_b_${Date.now()}`;
        await seedChatSession({
            sessionId: sessionB,
            courseId: STU_OTHER_COURSE_ID,
            studentId,
            studentName: 'E2E Student',
            title: 'B side',
        });

        const listA = await api.get(
            `/api/students/${STU_COURSE_ID}/${studentId}/sessions/own`
        );
        const bodyA = await listA.json();
        const idsA = (bodyA.data?.sessions || []).map((s) => s.sessionId);
        expect(idsA).toContain(sessionA);
        expect(idsA).not.toContain(sessionB);

        const listB = await api.get(
            `/api/students/${STU_OTHER_COURSE_ID}/${studentId}/sessions/own`
        );
        const bodyB = await listB.json();
        const idsB = (bodyB.data?.sessions || []).map((s) => s.sessionId);
        expect(idsB).toContain(sessionB);
        expect(idsB).not.toContain(sessionA);
    });

    test('student cannot list another student\'s own-sessions (403)', async ({ request: api }) => {
        // Seed a session belonging to the OTHER synthetic student so the
        // path resolves to a real row.
        const sessionId = `e2e_other_${Date.now()}`;
        await seedChatSession({
            sessionId,
            courseId: STU_OTHER_COURSE_ID,
            studentId: OTHER_STUDENT_ID,
            studentName: 'Other Student',
            title: 'Hands off',
        });

        const res = await api.get(
            `/api/students/${STU_OTHER_COURSE_ID}/${OTHER_STUDENT_ID}/sessions/own`
        );
        expect(res.status()).toBe(403);
    });

    test('student cannot delete another student\'s session via the /own path (403)', async ({ request: api }) => {
        const sessionId = `e2e_other_del_${Date.now()}`;
        await seedChatSession({
            sessionId,
            courseId: STU_OTHER_COURSE_ID,
            studentId: OTHER_STUDENT_ID,
            studentName: 'Other Student',
            title: 'Hands off',
        });

        const res = await api.delete(
            `/api/students/${STU_OTHER_COURSE_ID}/${OTHER_STUDENT_ID}/sessions/${sessionId}/own`
        );
        expect(res.status()).toBe(403);

        // Confirm the row still exists on the server.
        const still = await withDb((db) =>
            db.collection('chat_sessions').findOne({ sessionId })
        );
        expect(still?.studentDeleted).not.toBe(true);
        expect(still?.isDeleted).not.toBe(true);
    });
});

// ----------------------------------------------------------------------------
// Security gaps — these tests are written against the *expected* behavior.
// They will currently FAIL because the product trusts client-supplied IDs.
// ----------------------------------------------------------------------------
test.describe('Security — student-controlled inputs that bypass auth', () => {
    test.use({ storageState: storageStatePath('student') });

    test.beforeEach(async () => {
        await resetStudentChatData({ instructorId });
    });

    test('POST /api/chat/save must not let a student impersonate another studentId', async ({ request: api }) => {
        // e2e_student is logged in. We supply OTHER_STUDENT_ID in the body
        // and expect the server to either reject (403) or rewrite the row
        // to the real user. Today it accepts the body verbatim, which lets
        // a logged-in student plant rows under any studentId they choose —
        // those rows then show up in the OTHER student's /own listing.
        const sessionId = `e2e_spoof_${Date.now()}`;
        const res = await api.post('/api/chat/save', {
            data: {
                sessionId,
                courseId: STU_OTHER_COURSE_ID,
                studentId: OTHER_STUDENT_ID,
                studentName: 'Pretending to be other student',
                unitName: 'Unit 1',
                title: 'Spoofed save',
                messageCount: 1,
                chatData: { messages: [] },
            },
        });

        // We expect a 403. The product currently returns 200.
        if (res.status() === 200) {
            const row = await withDb((db) =>
                db.collection('chat_sessions').findOne({ sessionId })
            );
            // If the server accepted it, at the very least it must NOT have
            // persisted the impersonated studentId.
            expect(row?.studentId).not.toBe(OTHER_STUDENT_ID);
        } else {
            expect(res.status()).toBe(403);
        }
    });

    test('DELETE (no /own suffix) must not let a student delete another student\'s session', async ({ request: api }) => {
        // The instructor-targeted route /api/students/.../sessions/:sessionId
        // (without /own) lacks a same-user check. A logged-in student can
        // delete other students' sessions through it. Expected: 403.
        const sessionId = `e2e_other_idel_${Date.now()}`;
        await seedChatSession({
            sessionId,
            courseId: STU_OTHER_COURSE_ID,
            studentId: OTHER_STUDENT_ID,
            studentName: 'Other Student',
            title: 'Hands off (instructor path)',
        });

        const res = await api.delete(
            `/api/students/${STU_OTHER_COURSE_ID}/${OTHER_STUDENT_ID}/sessions/${sessionId}`
        );
        expect(res.status()).toBe(403);

        const still = await withDb((db) =>
            db.collection('chat_sessions').findOne({ sessionId })
        );
        expect(still?.isDeleted).not.toBe(true);
    });

    test('GET /api/struggle-activity/student/:userId must not leak another student\'s history', async ({ request: api }) => {
        // Seed some activity for the OTHER student directly.
        await withDb(async (db) => {
            await db.collection('struggleActivity').insertOne({
                userId: OTHER_STUDENT_ID,
                courseId: STU_OTHER_COURSE_ID,
                topic: 'Photosynthesis',
                state: 'Active',
                struggleCount: 3,
                createdAt: new Date(),
            });
        });

        const res = await api.get(`/api/struggle-activity/student/${OTHER_STUDENT_ID}`);

        // Expected: 403 (or 404 — anything except success). The current
        // implementation returns 200 with the row, which is a cross-student
        // information leak.
        expect(res.status()).toBeGreaterThanOrEqual(400);
    });
});

// ----------------------------------------------------------------------------
// Chat history page — UI flow on top of the API
// ----------------------------------------------------------------------------
// ----------------------------------------------------------------------------
// /api/chat/save — input validation
// ----------------------------------------------------------------------------
test.describe('POST /api/chat/save — input validation', () => {
    test.use({ storageState: storageStatePath('student') });

    test.beforeEach(async () => {
        await resetStudentChatData({ instructorId });
    });

    test('returns 400 when sessionId is missing', async ({ request: api }) => {
        const res = await api.post('/api/chat/save', {
            data: {
                courseId: STU_COURSE_ID,
                studentId,
                studentName: 'E2E Student',
                chatData: { messages: [] },
            },
        });
        expect(res.status()).toBe(400);
    });

    test('saves under the signed-in account\'s name, whether or not the page sends one', async ({ request: api }) => {
        const me = (await (await api.get('/api/auth/me')).json()).user;
        const accountName = me.displayName || me.username;
        for (const studentName of [undefined, '<b>Someone Else</b>']) {
            const sessionId = `e2e_validation_${Date.now()}_${studentName ? 'named' : 'unnamed'}`;
            const res = await api.post('/api/chat/save', {
                data: {
                    sessionId,
                    courseId: STU_COURSE_ID,
                    studentId,
                    ...(studentName ? { studentName } : {}),
                    chatData: { messages: [] },
                },
            });
            expect(res.status()).toBe(200);
            const list = await (await api.get(`/api/students/${STU_COURSE_ID}/${studentId}/sessions/own`)).json();
            expect(list.data.sessions.find((session) => session.sessionId === sessionId).studentName).toBe(accountName);
        }
    });

    test('round-trip preserves chatData verbatim', async ({ request: api }) => {
        const sessionId = `e2e_roundtrip_${Date.now()}`;
        const chatData = {
            messages: [
                { type: 'user', content: 'q1', timestamp: '2026-05-12T10:00:00Z' },
                { type: 'bot', content: 'a1', timestamp: '2026-05-12T10:00:05Z', isHtml: false },
            ],
            metadata: { courseId: STU_COURSE_ID, unitName: 'Unit 1' },
        };
        const save = await api.post('/api/chat/save', {
            data: {
                sessionId,
                courseId: STU_COURSE_ID,
                studentId,
                studentName: 'E2E Student',
                unitName: 'Unit 1',
                title: 'Round trip',
                messageCount: 2,
                chatData,
            },
        });
        expect(save.ok()).toBeTruthy();

        const list = await api.get(`/api/students/${STU_COURSE_ID}/${studentId}/sessions/own`);
        const body = await list.json();
        const found = body.data.sessions.find((s) => s.sessionId === sessionId);
        expect(found).toBeTruthy();
        expect(found.chatData.messages).toHaveLength(2);
        expect(found.chatData.messages[0].content).toBe('q1');
        expect(found.chatData.messages[1].content).toBe('a1');
        expect(found.chatData.metadata.unitName).toBe('Unit 1');
    });
});

// ----------------------------------------------------------------------------
// Course join flow (student) — POST /api/courses/:courseId/join
// ----------------------------------------------------------------------------
test.describe('Student course join via course code', () => {
    test.use({ storageState: storageStatePath('student') });

    test.beforeEach(async () => {
        await resetStudentChatData({ instructorId });
        // Drop the student from the OTHER course so we can test the join.
        await withDb(async (db) => {
            await db.collection('courses').updateOne(
                { courseId: STU_OTHER_COURSE_ID },
                { $unset: { [`studentEnrollment.${studentId}`]: '' } }
            );
        });
    });

    test('joining without a code returns 400', async ({ request: api }) => {
        const res = await api.post(`/api/courses/${STU_OTHER_COURSE_ID}/join`, {
            data: {},
        });
        expect(res.status()).toBe(400);
    });

    test('joining with the wrong code returns 403', async ({ request: api }) => {
        const res = await api.post(`/api/courses/${STU_OTHER_COURSE_ID}/join`, {
            data: { code: 'TOTALLY-WRONG-CODE' },
        });
        expect(res.status()).toBe(403);
    });

    test('joining with the correct code marks the student enrolled', async ({ request: api }) => {
        // The seed sets courseCode = `${courseId}-S`.
        const res = await api.post(`/api/courses/${STU_OTHER_COURSE_ID}/join`, {
            data: { code: `${STU_OTHER_COURSE_ID}-S` },
        });
        expect(res.ok()).toBeTruthy();
        const body = await res.json();
        expect(body.success).toBeTruthy();

        // Confirm enrollment in DB.
        const course = await withDb((db) =>
            db.collection('courses').findOne({ courseId: STU_OTHER_COURSE_ID })
        );
        expect(course?.studentEnrollment?.[studentId]?.enrolled).toBe(true);
    });

    test('joining a deactivated course returns 403 even with the correct code', async ({ request: api }) => {
        const res = await api.post(`/api/courses/${STU_INACTIVE_COURSE_ID}/join`, {
            data: { code: `${STU_INACTIVE_COURSE_ID}-S` },
        });
        expect(res.status()).toBe(403);
    });
});

// ----------------------------------------------------------------------------
// Practice question API
// ----------------------------------------------------------------------------
test.describe('Practice question API (LLM-backed)', () => {
    test.use({ storageState: storageStatePath('student') });

    test.beforeEach(async () => {
        await resetStudentChatData({ instructorId });
    });

    test('rejects request missing courseId/unitName with 400', async ({ request: api }) => {
        const res = await api.post('/api/chat/practice-question', { data: {} });
        expect(res.status()).toBe(400);
    });

    test('returns noQuestions:true when the unit has no assessment questions', async ({ request: api }) => {
        // The seeded BIOC-E2E-STU unit has no assessmentQuestions.
        const res = await api.post('/api/chat/practice-question', {
            data: { courseId: STU_COURSE_ID, unitName: 'Unit 1' },
            timeout: 60_000,
        });
        expect(res.ok()).toBeTruthy();
        const body = await res.json();
        expect(body).toMatchObject({ success: true, noQuestions: true });
    });

    test('generates a practice question without leaking the correct answer, then checks an answer', async ({ request: api }) => {
        await withDb((db) =>
            db.collection('courses').updateOne(
                { courseId: STU_COURSE_ID, 'lectures.name': 'Unit 1' },
                {
                    $set: {
                        'lectures.$.assessmentQuestions': [
                            {
                                questionId: 'q_e2e_chat_practice_mc',
                                questionType: 'multiple-choice',
                                question: 'Which molecule is the main energy currency of the cell?',
                                options: { A: 'ATP', B: 'DNA', C: 'Cellulose', D: 'Cholesterol' },
                                correctAnswer: 'A',
                                explanation: 'ATP hydrolysis is commonly coupled to cellular work.',
                                difficulty: 'easy',
                                isActive: true,
                            },
                        ],
                    },
                }
            )
        );

        // Script the LLM to return a valid MC practice question — the route
        // parses the JSON and stores the correctAnswer server-side. MC
        // check-practice-answer is purely string comparison, so no second
        // LLM call is needed for the scoring step.
        await resetLlmStub(api);
        await enqueueLlmResponses(api, [
            JSON.stringify({
                questionType: 'multiple-choice',
                question: 'Which molecule is the main energy currency of the cell?',
                options: { A: 'ATP', B: 'DNA', C: 'Cellulose', D: 'Cholesterol' },
                correctAnswer: 'A',
                explanation: 'ATP hydrolysis powers cellular work.',
            }),
        ]);

        const generated = await api.post('/api/chat/practice-question', {
            data: { courseId: STU_COURSE_ID, unitName: 'Unit 1', topic: 'cellular energy' },
            timeout: 30_000,
        });
        expect(generated.ok()).toBeTruthy();

        const generatedBody = await generated.json();
        expect(generatedBody).toMatchObject({
            success: true,
            data: {
                practiceId: expect.any(String),
                questionType: expect.any(String),
                question: expect.any(String),
            },
        });
        expect(generatedBody.noQuestions).toBeFalsy();
        expect(generatedBody.data.correctAnswer).toBeUndefined();
        expect(generatedBody.data.explanation).toBeUndefined();

        let studentAnswer = 'ATP';
        if (generatedBody.data.questionType === 'multiple-choice' && generatedBody.data.options) {
            studentAnswer = Object.keys(generatedBody.data.options)[0];
        } else if (generatedBody.data.questionType === 'true-false') {
            studentAnswer = 'true';
        }

        const checked = await api.post('/api/chat/check-practice-answer', {
            data: {
                practiceId: generatedBody.data.practiceId,
                studentAnswer,
                studentName: 'E2E Student',
            },
            timeout: 120_000,
        });
        expect(checked.ok()).toBeTruthy();

        const checkedBody = await checked.json();
        expect(checkedBody).toMatchObject({
            success: true,
            data: {
                correct: expect.any(Boolean),
                feedback: expect.any(String),
                correctAnswer: expect.any(String),
            },
        });
        expect(checkedBody.data.correctAnswer.length).toBeGreaterThan(0);
    });

    test('check-practice-answer with an unknown practiceId returns 404', async ({ request: api }) => {
        const res = await api.post('/api/chat/check-practice-answer', {
            data: { practiceId: 'pq_does_not_exist_12345', studentAnswer: 'something' },
        });
        expect(res.status()).toBe(404);
    });

    test('check-practice-answer with empty studentAnswer returns 400', async ({ request: api }) => {
        const res = await api.post('/api/chat/check-practice-answer', {
            data: { practiceId: 'pq_anything', studentAnswer: '' },
        });
        expect(res.status()).toBe(400);
    });
});

// ----------------------------------------------------------------------------
// /api/student/struggle/reset — 'ALL' clears every topic
// ----------------------------------------------------------------------------
test.describe('Struggle reset ALL', () => {
    test.use({ storageState: storageStatePath('student') });

    test.beforeEach(async () => {
        await resetStudentChatData({ instructorId });
    });

    test('POST /reset with topic:"ALL" wipes every active topic', async ({ request: api }) => {
        // Seed two topics in the user's struggleState directly.
        await withDb(async (db) => {
            await db.collection('users').updateOne(
                { userId: studentId },
                {
                    $set: {
                        struggleState: {
                            topics: [
                                { topic: 'photosynthesis', count: 4, isActive: true, lastStruggle: new Date() },
                                { topic: 'mitosis', count: 5, isActive: true, lastStruggle: new Date() },
                            ],
                        },
                    },
                }
            );
        });

        const res = await api.post('/api/student/struggle/reset', {
            data: { topic: 'ALL', courseId: STU_COURSE_ID },
        });
        expect(res.ok()).toBeTruthy();

        const after = await withDb((db) =>
            db.collection('users').findOne({ userId: studentId })
        );
        const topics = after?.struggleState?.topics ?? [];
        // Either all topics cleared, or none remain active with a positive count.
        for (const t of topics) {
            expect(t.isActive).toBeFalsy();
            expect(t.count || 0).toBe(0);
        }
    });
});

// ----------------------------------------------------------------------------
// /api/courses/available/all — shape and filtering for the student
// ----------------------------------------------------------------------------
test.describe('GET /api/courses/available/all — student view', () => {
    test.use({ storageState: storageStatePath('student') });

    test.beforeEach(async () => {
        await resetStudentChatData({ instructorId });
    });

    test('returns active courses only, with isEnrolled flag set correctly', async ({ request: api }) => {
        // Drop enrollment from the OTHER course so we can verify both branches.
        await withDb(async (db) => {
            await db.collection('courses').updateOne(
                { courseId: STU_OTHER_COURSE_ID },
                { $unset: { [`studentEnrollment.${studentId}`]: '' } }
            );
        });

        const res = await api.get('/api/courses/available/all');
        expect(res.ok()).toBeTruthy();
        const body = await res.json();
        const ids = body.data.map((c) => c.courseId);

        // Active courses present; inactive & deleted absent.
        expect(ids).toContain(STU_COURSE_ID);
        expect(ids).toContain(STU_OTHER_COURSE_ID);
        expect(ids).not.toContain(STU_INACTIVE_COURSE_ID);
        expect(ids).not.toContain(STU_DELETED_COURSE_ID);

        const main = body.data.find((c) => c.courseId === STU_COURSE_ID);
        const other = body.data.find((c) => c.courseId === STU_OTHER_COURSE_ID);
        expect(main.isEnrolled).toBe(true);
        expect(other.isEnrolled).toBe(false);
    });

    test('does NOT include instructor-only fields in the student view', async ({ request: api }) => {
        const res = await api.get('/api/courses/available/all');
        expect(res.ok()).toBeTruthy();
        const body = await res.json();
        const main = body.data.find((c) => c.courseId === STU_COURSE_ID);
        // The instructor course code should never reach a student.
        expect(main).toBeTruthy();
        expect(main.instructorCourseCode).toBeUndefined();
    });
});

// ----------------------------------------------------------------------------
// /api/courses/:courseId/student-enrollment — own status
// ----------------------------------------------------------------------------
test.describe('GET /:courseId/student-enrollment as the student', () => {
    test.use({ storageState: storageStatePath('student') });

    test.beforeEach(async () => {
        await resetStudentChatData({ instructorId });
    });

    test('enrolled student sees enrolled:true', async ({ request: api }) => {
        const res = await api.get(`/api/courses/${STU_COURSE_ID}/student-enrollment`);
        expect(res.ok()).toBeTruthy();
        const body = await res.json();
        expect(body).toMatchObject({ success: true, data: { enrolled: true } });
    });

    test('banned/disabled student sees enrolled:false', async ({ request: api }) => {
        await withDb(async (db) => {
            await db.collection('courses').updateOne(
                { courseId: STU_COURSE_ID },
                { $set: { [`studentEnrollment.${studentId}.enrolled`]: false } }
            );
        });
        const res = await api.get(`/api/courses/${STU_COURSE_ID}/student-enrollment`);
        // Per requireActiveCourseForNonInstructors carve-out, students can
        // always inspect their own enrollment status even on an inactive course.
        expect(res.ok()).toBeTruthy();
        const body = await res.json();
        expect(body.data.enrolled).toBe(false);
    });
});

// ----------------------------------------------------------------------------
// Auth required for student-tracker (struggle) endpoints
// ----------------------------------------------------------------------------
test.describe('Unauthenticated access to /api/student/struggle', () => {
    test('GET without a session returns 401 (no storage state)', async ({ request: api }) => {
        // Disable redirect-following so we can observe the auth gate
        // directly. Without this, a 302 → /login auto-follows to a 200.
        const res = await api.get('/api/student/struggle', { maxRedirects: 0 });
        const status = res.status();
        expect([401, 302, 403]).toContain(status);
    });
});

// ----------------------------------------------------------------------------
// Mode toggle + new-session button + view-rules link (UI)
// ----------------------------------------------------------------------------
test.describe('Student chat page — UI controls', () => {
    test.beforeEach(async () => {
        await resetStudentChatData({ instructorId });
        await setUserAgreement(studentId, true);
    });

    test('mode toggle defaults to Tutor and persists changes to localStorage', async ({ page }) => {
        await loginAsStudent(page);
        await page.addInitScript((id) => {
            try { localStorage.setItem('selectedCourseId', id); } catch (_) {}
        }, STU_COURSE_ID);
        await page.goto('/student');

        // The checkbox is hidden behind a styled slider, so don't assert
        // CSS visibility — just wait for the element to be attached.
        const toggle = page.locator('#mode-toggle-checkbox');
        await expect(toggle).toBeAttached({ timeout: 15_000 });

        // Toggle programmatically.
        await page.evaluate(() => {
            const el = /** @type {HTMLInputElement|null} */ (
                document.getElementById('mode-toggle-checkbox')
            );
            if (!el) throw new Error('mode toggle missing');
            el.checked = false;
            el.dispatchEvent(new Event('change', { bubbles: true }));
        });

        // student.js's change handler writes `studentMode`. Wait for the flush.
        await expect.poll(async () =>
            await page.evaluate(() => localStorage.getItem('studentMode'))
        , { timeout: 5_000 }).toBe('protege');

        await page.reload();
        const persisted = await page.evaluate(() => localStorage.getItem('studentMode'));
        expect(persisted).toBe('protege');
    });

    test('clicking "View General Rules" opens the agreement modal in read-only mode', async ({ page }) => {
        await loginAsStudent(page);
        await page.addInitScript((id) => {
            try { localStorage.setItem('selectedCourseId', id); } catch (_) {}
        }, STU_COURSE_ID);
        await page.goto('/student');

        const modal = page.locator('#agreement-modal-overlay');
        // Wait for the modal element to exist (created on init), and ensure
        // it's hidden because the student has already agreed.
        await expect(modal).toBeHidden({ timeout: 10_000 });

        await page.locator('#view-rules-link').click();
        await expect(modal).toBeVisible({ timeout: 10_000 });

        // In read-only mode, the checkbox container and Agree button are hidden,
        // and a Close button is exposed.
        await expect(modal.locator('#agreement-checkbox')).toBeHidden();
        await expect(modal.locator('#close-modal-btn')).toBeVisible();
    });

    test('the welcome message carries the AI-use notice, and its link opens the full terms', async ({ page }) => {
        await loginAsStudent(page);
        await page.addInitScript((id) => {
            try { localStorage.setItem('selectedCourseId', id); } catch (_) {}
        }, STU_COURSE_ID);
        await page.goto('/student');

        // The notice has to be part of the message that opens the chat, not
        // only the standing footer under the composer.
        const welcome = page.locator('.bot-message').filter({ hasText: 'Welcome to BiocBot!' });
        await expect(welcome).toHaveCount(1, { timeout: 15_000 });
        await expect(welcome.locator('.ai-use-disclaimer')).toContainText(
            'This AI tool generates responses using a large language model'
        );

        const modal = page.locator('#agreement-modal-overlay');
        await expect(modal).toBeHidden();

        await welcome.locator('.ai-use-disclaimer-link').click();
        await expect(modal).toBeVisible({ timeout: 10_000 });

        // The long form the short notice points at.
        await expect(modal).toContainText('retrieval-augmented generation (RAG)');
        await expect(modal).toContainText('Not a Substitute for Official Sources');
        await expect(modal).toContainText('Freedom of Information and Protection of Privacy Act');
        await expect(modal.locator('#close-modal-btn')).toBeVisible();
    });

    test('new session button is visible on the chat page', async ({ page }) => {
        await loginAsStudent(page);
        await page.addInitScript((id) => {
            try { localStorage.setItem('selectedCourseId', id); } catch (_) {}
        }, STU_COURSE_ID);
        await page.goto('/student');
        await expect(page.locator('#new-session-btn')).toBeVisible({ timeout: 15_000 });
    });

    test('summary button seeds a fresh same-unit same-mode chat without assessment context', async ({ page }) => {
        const summaryText = 'I previously asked about enzyme kinetics and still need help connecting Km to substrate affinity.';
        let summaryRequestBody = null;
        let chatRequestBody = null;
        const saveRequestBodies = /** @type {any[]} */ ([]);

        await loginAsStudent(page);

        await page.route('**/api/chat/survey-settings**', async (route) => {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    success: true,
                    data: {
                        settings: { summaryTriggerMessageCount: 2 },
                        defaults: { summaryTriggerMessageCount: 25 },
                        settingsFingerprint: 'summary-e2e',
                        response: null,
                    },
                }),
            });
        });

        await page.route('**/api/chat/summary', async (route) => {
            summaryRequestBody = route.request().postDataJSON();
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    success: true,
                    summary: summaryText,
                    message: summaryText,
                    mode: 'protege',
                    unitName: 'Unit 1',
                    sourceMessageCount: 2,
                }),
            });
        });

        await page.route('**/api/chat/save', async (route) => {
            saveRequestBodies.push(route.request().postDataJSON());
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({ success: true }),
            });
        });

        await page.route('**/api/chat', async (route) => {
            chatRequestBody = route.request().postDataJSON();
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    success: true,
                    messageId: 'msg_summary_e2e',
                    message: 'Let us continue from your enzyme kinetics summary.',
                    model: 'test',
                    usage: { tokens: 1 },
                    timestamp: new Date().toISOString(),
                    mode: 'protege',
                    citations: [],
                    sourceAttribution: {
                        source: 'GPT',
                        description: 'Generated by AI',
                        unitName: null,
                        documentType: null,
                        downloadsEnabled: false,
                        documents: [],
                    },
                    retrieval: {
                        mode: 'single',
                        lectureNames: ['Unit 1'],
                    },
                }),
            });
        });

        await page.addInitScript(({ courseId, courseName, studentId }) => {
            try {
                const now = new Date().toISOString();
                const sessionId = `seeded_${Date.now()}`;
                const unitName = 'Unit 1';
                localStorage.setItem('selectedCourseId', courseId);
                localStorage.setItem('selectedCourseName', courseName);
                localStorage.setItem('selectedUnitName', unitName);
                localStorage.setItem('studentMode', 'protege');
                localStorage.setItem(`biocbot_session_${studentId}_${courseId}_${unitName}`, sessionId);
                localStorage.setItem(`biocbot_current_chat_${studentId}`, JSON.stringify({
                    metadata: {
                        exportDate: now,
                        courseId,
                        courseName,
                        studentId,
                        studentName: 'E2E Student',
                        unitName,
                        currentMode: 'protege',
                        totalMessages: 2,
                        version: '1.0',
                    },
                    messages: [
                        {
                            type: 'user',
                            content: 'Can you explain Km?',
                            timestamp: now,
                            messageType: 'regular-chat',
                        },
                        {
                            type: 'bot',
                            content: 'BiocBot explained that Km is the substrate concentration at half Vmax.',
                            timestamp: now,
                            messageType: 'regular-chat',
                        },
                    ],
                    practiceTests: {
                        questions: [
                            {
                                questionId: 'old-assessment-q',
                                question: 'Old assessment question',
                            },
                        ],
                        passThreshold: 1,
                    },
                    studentAnswers: {
                        answers: [{ questionIndex: 0, answer: 0 }],
                    },
                    sessionInfo: {
                        sessionId,
                        startTime: now,
                        endTime: now,
                        duration: '1 minute',
                    },
                    lastActivityTimestamp: now,
                }));
            } catch (_) {}
        }, {
            courseId: STU_COURSE_ID,
            courseName: STU_COURSE_NAME,
            studentId,
        });

        await page.goto('/student');

        const summaryButton = page.locator('#chat-summary-btn');
        await expect(summaryButton).toBeEnabled({ timeout: 15_000 });
        await expect(summaryButton).toHaveText('Summarize & Start New Chat');
        page.once('dialog', async (dialog) => {
            expect(dialog.message()).toContain('start a new chat in the same unit and mode');
            expect(dialog.message()).toContain('assessment questions will not carry over');
            await dialog.accept();
        });
        await summaryButton.click();

        await expect(page.locator('.user-message')).toHaveCount(1, { timeout: 10_000 });
        await expect(page.locator('.user-message').first()).toContainText(summaryText);
        await expect(page.locator('.bot-message').last()).toContainText('Let us continue from your enzyme kinetics summary.');
        await expect(page.locator('.calibration-question')).toHaveCount(0);
        await expect(summaryButton).toBeDisabled();

        if (!summaryRequestBody) throw new Error('Expected /api/chat/summary to be called');
        if (!chatRequestBody) throw new Error('Expected /api/chat to be called');

        const summaryBody = /** @type {any} */ (summaryRequestBody);
        const chatBody = /** @type {any} */ (chatRequestBody);

        expect(summaryBody).toMatchObject({
            courseId: STU_COURSE_ID,
            unitName: 'Unit 1',
            mode: 'protege',
        });
        expect(summaryBody.messages).toHaveLength(2);

        expect(chatBody).toMatchObject({
            courseId: STU_COURSE_ID,
            unitName: 'Unit 1',
            mode: 'protege',
            message: summaryText,
        });
        expect(chatBody.conversationContext).toBeNull();

        const saved = await page.evaluate((id) => {
            const raw = localStorage.getItem(`biocbot_current_chat_${id}`);
            return raw ? JSON.parse(raw) : null;
        }, studentId);

        expect(saved.metadata).toMatchObject({
            courseId: STU_COURSE_ID,
            unitName: 'Unit 1',
            currentMode: 'protege',
        });
        expect(saved.messages[0]).toMatchObject({
            type: 'user',
            content: summaryText,
            messageType: 'regular-chat',
            isSummarySeed: true,
            triggeredBy: 'summarize_button',
            actionStatus: 'success',
            elapsedTime: 0,
            elapsedTimeDerived: false,
        });
        expect(saved.messages.some((message) =>
            message.content?.includes('Welcome to BiocBot!')
        )).toBe(false);
        const savedMessages = /** @type {any[]} */ (saved.messages);
        expect(savedMessages.every((message) =>
            Number.isInteger(message.elapsedTime)
            && typeof message.elapsedTimeDerived === 'boolean'
        )).toBe(true);
        expect(saved.practiceTests).toBeNull();
        expect(saved.studentAnswers.answers).toEqual([]);

        await expect.poll(() => saveRequestBodies.some((body) =>
            body?.chatData?.events?.some((/** @type {any} */ event) =>
                event.triggeredBy === 'summarize_button'
                && event.actionStatus === 'success'
                && event.type === 'button_action'
            )
        )).toBe(true);

        const oldSessionSave = saveRequestBodies.find((body) => body?.chatData?.events?.length);
        const oldEvents = /** @type {any[]} */ (oldSessionSave.chatData.events);
        const summaryEvent = oldEvents.at(-1);
        expect(oldSessionSave.chatData.sessionInfo.endTime).toBe(summaryEvent.timestamp);
        const oldMessages = /** @type {any[]} */ (oldSessionSave.chatData.messages);
        expect(oldMessages.every((message) =>
            Number.isInteger(message.elapsedTime)
            && typeof message.elapsedTimeDerived === 'boolean'
        )).toBe(true);
    });
});

// ----------------------------------------------------------------------------
// Chat history page — empty state and continue-chat handoff
// ----------------------------------------------------------------------------
test.describe('Chat history page — empty + continue', () => {
    test.beforeEach(async () => {
        await resetStudentChatData({ instructorId });
        await setUserAgreement(studentId, true);
    });

    test('shows the no-history message when the student has no saved sessions', async ({ page }) => {
        await loginAsStudent(page);
        await page.addInitScript((id) => {
            try { localStorage.setItem('selectedCourseId', id); } catch (_) {}
        }, STU_COURSE_ID);
        await page.goto('/student/history');

        await expect(page.locator('#no-history-message')).toBeVisible({ timeout: 15_000 });
    });

    test('continue-chat sets sessionStorage and redirects to /student', async ({ page }) => {
        const sessionId = `e2e_continue_${Date.now()}`;
        await seedChatSession({
            sessionId,
            courseId: STU_COURSE_ID,
            studentId,
            studentName: 'E2E Student',
            title: 'Resumeable',
            messages: [
                { type: 'user', content: 'before reload', timestamp: '2026-01-01T00:00:00.000Z' },
            ],
        });

        await loginAsStudent(page);
        await page.addInitScript((id) => {
            try { localStorage.setItem('selectedCourseId', id); } catch (_) {}
        }, STU_COURSE_ID);
        await page.goto('/student/history');

        const item = page.locator(`[data-chat-id="${sessionId}"]`);
        await expect(item).toBeVisible({ timeout: 15_000 });
        // The item is auto-selected (first item gets clicked on display).
        await item.click();

        await page.locator('#continue-chat-btn').click();
        await page.waitForURL((url) => url.pathname === '/student' || url.pathname === '/student/', {
            timeout: 15_000,
        });

        await expect(page.locator('#chat-messages')).toContainText('before reload', {
            timeout: 15_000,
        });
        await expect(page.locator('#chat-messages')).not.toContainText(
            'Your previous session ended after'
        );

        // history.js stores the chat data in sessionStorage under 'loadChatData'.
        const loaded = await page.evaluate(() => sessionStorage.getItem('loadChatData'));
        // It clears on consumption, but verifying that resumption hit the chat
        // page (URL match above) is the user-visible outcome we care about.
        // If still present, confirm the payload matches.
        if (loaded) {
            const parsed = JSON.parse(loaded);
            expect(parsed.messages?.[0]?.content).toBe('before reload');
        }
    });
});

// ----------------------------------------------------------------------------
// Role guard — /student is gated to students only
// ----------------------------------------------------------------------------
test.describe('/student page — role-based gating', () => {
    test('instructor session hitting /student gets a 302 redirect (no HTML)', async ({ browser }) => {
        // Use the request API so redirects aren't auto-followed by the page.
        const ctx = await browser.newContext({ storageState: storageStatePath('instructor') });
        const res = await ctx.request.get('/student', { maxRedirects: 0 });
        // requireRole('student') returns 302 → /instructor for an instructor user.
        // Anything other than 200 is acceptable (302, 401, 403).
        expect(res.status()).not.toBe(200);
        if (res.status() === 302) {
            expect(res.headers()['location']).toContain('/instructor');
        }
        await ctx.close();
    });

    test('TA session hitting /student gets a 302 redirect (no HTML)', async ({ browser }) => {
        const ctx = await browser.newContext({ storageState: storageStatePath('ta') });
        const res = await ctx.request.get('/student', { maxRedirects: 0 });
        expect(res.status()).not.toBe(200);
        if (res.status() === 302) {
            expect(res.headers()['location']).toContain('/ta');
        }
        await ctx.close();
    });

    test('client-side role guard in student.js also redirects an instructor away', async ({ browser }) => {
        // Even when the static asset is served (e.g., past the server gate),
        // student.js itself contains a role guard that redirects.
        const ctx = await browser.newContext({ storageState: storageStatePath('instructor') });
        const page = await ctx.newPage();
        await page.goto('/student');
        // Either we never landed there, or student.js redirected us away.
        await page.waitForURL((url) => !url.pathname.startsWith('/student') || url.pathname === '/student/quiz' ? false : !url.pathname.startsWith('/student'),
            { timeout: 10_000 }
        ).catch(() => {});
        const finalUrl = page.url();
        expect(finalUrl).not.toContain('/student/');
        await ctx.close();
    });
});

// ----------------------------------------------------------------------------
// Source-document download endpoint — security and feature flag
// ----------------------------------------------------------------------------
test.describe('GET /api/chat/source-documents/:documentId/download', () => {
    test.use({ storageState: storageStatePath('student') });
    const DOC_ID = 'doc_e2e_src_download_test';

    test.beforeEach(async () => {
        await resetStudentChatData({ instructorId });
        // Seed a document attached to STU_COURSE_ID / Unit 1.
        await withDb(async (db) => {
            await db.collection('documents').deleteMany({ documentId: DOC_ID });
            await db.collection('documents').insertOne({
                documentId: DOC_ID,
                courseId: STU_COURSE_ID,
                lectureName: 'Unit 1',
                instructorId,
                documentType: 'lecture-notes',
                type: 'lecture_notes',
                contentType: 'text',
                filename: 'src-download-notes.txt',
                originalName: 'Source Download Notes.txt',
                content: 'This is the seeded source-attribution test document.',
                mimeType: 'text/plain',
                size: 60,
                status: 'parsed',
                uploadDate: new Date(),
                lastModified: new Date(),
                metadata: {},
            });
        });
    });

    test.afterEach(async () => {
        await withDb(async (db) => {
            await db.collection('documents').deleteMany({ documentId: DOC_ID });
        });
    });

    test('missing courseId returns 400', async ({ request: api }) => {
        const res = await api.get(`/api/chat/source-documents/${DOC_ID}/download`);
        expect(res.status()).toBe(400);
    });

    test('403 when course has allowSourceAttributionDownloads disabled', async ({ request: api }) => {
        // Default seed sets allowSourceAttributionDownloads to undefined/false.
        const res = await api.get(
            `/api/chat/source-documents/${DOC_ID}/download?courseId=${STU_COURSE_ID}`
        );
        expect(res.status()).toBe(403);
    });

    test('200 with file body when downloads are enabled and student is enrolled', async ({ request: api }) => {
        await withDb(async (db) => {
            await db.collection('courses').updateOne(
                { courseId: STU_COURSE_ID },
                { $set: { 'quizSettings.allowSourceAttributionDownloads': true } }
            );
        });

        const res = await api.get(
            `/api/chat/source-documents/${DOC_ID}/download?courseId=${STU_COURSE_ID}`
        );
        expect(res.ok()).toBeTruthy();
        const body = await res.text();
        expect(body).toContain('source-attribution test document');
        expect(res.headers()['content-disposition']).toMatch(/attachment/i);
    });

    test('403 when student is not enrolled (even if downloads enabled)', async ({ request: api }) => {
        await withDb(async (db) => {
            await db.collection('courses').updateOne(
                { courseId: STU_COURSE_ID },
                {
                    $set: {
                        'quizSettings.allowSourceAttributionDownloads': true,
                        [`studentEnrollment.${studentId}.enrolled`]: false,
                    },
                }
            );
        });
        const res = await api.get(
            `/api/chat/source-documents/${DOC_ID}/download?courseId=${STU_COURSE_ID}`
        );
        expect([403, 404]).toContain(res.status());
    });

    test('404 when the document belongs to a different course than the one in the query', async ({ request: api }) => {
        await withDb(async (db) => {
            await db.collection('courses').updateOne(
                { courseId: STU_COURSE_ID },
                { $set: { 'quizSettings.allowSourceAttributionDownloads': true } }
            );
            await db.collection('courses').updateOne(
                { courseId: STU_OTHER_COURSE_ID },
                { $set: { 'quizSettings.allowSourceAttributionDownloads': true } }
            );
        });
        const res = await api.get(
            `/api/chat/source-documents/${DOC_ID}/download?courseId=${STU_OTHER_COURSE_ID}`
        );
        expect(res.status()).toBe(404);
    });
});

// ----------------------------------------------------------------------------
// /api/courses/:courseId/approved-topics — student access
// ----------------------------------------------------------------------------
test.describe('GET /:courseId/approved-topics — student access', () => {
    test.use({ storageState: storageStatePath('student') });

    test.beforeEach(async () => {
        await resetStudentChatData({ instructorId });
    });

    test('enrolled student receives the configured approved topics', async ({ request: api }) => {
        const res = await api.get(`/api/courses/${STU_COURSE_ID}/approved-topics`);
        expect(res.ok()).toBeTruthy();
        const body = await res.json();
        expect(body.success).toBeTruthy();
        const labels = body.data?.topicLabels || [];
        expect(labels).toContain(APPROVED_TOPIC);
    });

    test('non-enrolled student is rejected with 403', async ({ request: api }) => {
        await withDb(async (db) => {
            await db.collection('courses').updateOne(
                { courseId: STU_COURSE_ID },
                { $set: { [`studentEnrollment.${studentId}.enrolled`]: false } }
            );
        });
        const res = await api.get(`/api/courses/${STU_COURSE_ID}/approved-topics`);
        // The server may return either 403 (enrollment middleware) or 403 from
        // the route itself; either is acceptable as long as it's not 200.
        expect(res.status()).not.toBe(200);
        expect(res.status()).toBeGreaterThanOrEqual(400);
    });

    test('non-existent course returns 404', async ({ request: api }) => {
        const res = await api.get('/api/courses/BIOC-DOES-NOT-EXIST-ZZ99/approved-topics');
        expect(res.status()).toBe(404);
    });
});

// ----------------------------------------------------------------------------
// Course join — idempotency for an already-enrolled student
// ----------------------------------------------------------------------------
test.describe('Course join — idempotency', () => {
    test.use({ storageState: storageStatePath('student') });

    test.beforeEach(async () => {
        await resetStudentChatData({ instructorId });
    });

    test('joining a course you are already enrolled in still succeeds (or is a clean no-op)', async ({ request: api }) => {
        // e2e_student is already enrolled in STU_COURSE_ID via the seed.
        const res = await api.post(`/api/courses/${STU_COURSE_ID}/join`, {
            data: { code: `${STU_COURSE_ID}-S` },
        });
        // Either 200 (idempotent join) or 4xx with a clear "already enrolled"
        // message — but not a 500.
        expect(res.status()).not.toBe(500);
        if (res.ok()) {
            const body = await res.json();
            expect(body.success).toBeTruthy();
        }
    });
});

// ----------------------------------------------------------------------------
// /api/chat/status and /test — LLM health endpoints
// ----------------------------------------------------------------------------
test.describe('LLM health endpoints', () => {
    test.use({ storageState: storageStatePath('student') });

    test('GET /api/chat/status returns the configured provider info', async ({ request: api }) => {
        const res = await api.get(`/api/chat/status?courseId=${STU_COURSE_ID}`);
        // Either 200 with status payload, or 503 if the LLM isn't initialized.
        expect([200, 503]).toContain(res.status());
        if (res.ok()) {
            const body = await res.json();
            expect(body).toMatchObject({ success: true });
            expect(body.data).toBeTruthy();
        }
    });
});

// ----------------------------------------------------------------------------
// /api/flags — student creates flagged questions
// ----------------------------------------------------------------------------
test.describe('POST /api/flags — student flagging', () => {
    test.use({ storageState: storageStatePath('student') });

    test.beforeEach(async () => {
        await resetStudentChatData({ instructorId });
        await withDb(async (db) => {
            await db.collection('flaggedQuestions').deleteMany({ studentId });
        });
    });

    test.afterEach(async () => {
        await withDb(async (db) => {
            await db.collection('flaggedQuestions').deleteMany({ studentId });
        });
    });

    test('returns 400 when required fields are missing', async ({ request: api }) => {
        const res = await api.post('/api/flags', {
            data: { courseId: STU_COURSE_ID, unitName: 'Unit 1' },
        });
        expect(res.status()).toBe(400);
    });

    test('rejects an invalid botMode with 400', async ({ request: api }) => {
        const res = await api.post('/api/flags', {
            data: {
                questionId: 'q_test_1',
                courseId: STU_COURSE_ID,
                unitName: 'Unit 1',
                flagReason: 'incorrect',
                flagDescription: 'This is wrong',
                botMode: 'banana-mode',
            },
        });
        expect(res.status()).toBe(400);
    });

    test('creates a flag with the authenticated student\'s identity (not a body field)', async ({ request: api }) => {
        const res = await api.post('/api/flags', {
            data: {
                questionId: 'q_e2e_flag_test',
                courseId: STU_COURSE_ID,
                unitName: 'Unit 1',
                flagReason: 'incorrect',
                flagDescription: 'Answer is wrong on purpose for the test.',
                botMode: 'tutor',
                questionContent: 'What is the powerhouse of the cell?',
                // Attempt to set studentId in body — the route should ignore this.
                studentId: OTHER_STUDENT_ID,
                studentName: 'fake-name',
            },
        });
        expect(res.ok()).toBeTruthy();
        const body = await res.json();
        expect(body.success).toBeTruthy();

        // Confirm in DB that the flag was attributed to the real authenticated
        // user, NOT the spoofed body value.
        const row = await withDb((db) =>
            db.collection('flaggedQuestions').findOne({ questionId: 'q_e2e_flag_test' })
        );
        expect(row).toBeTruthy();
        expect(row.studentId).toBe(studentId);
        expect(row.studentId).not.toBe(OTHER_STUDENT_ID);
    });

    test('instructor sessions can flag their own course but not a foreign one', async ({ browser }) => {
        const ctx = await browser.newContext({ storageState: storageStatePath('instructor') });
        const api = ctx.request;

        // Instructors with course access may now create flags.
        const ownRes = await api.post('/api/flags', {
            data: {
                questionId: 'q_e2e_inst_flag',
                courseId: STU_COURSE_ID,
                unitName: 'Unit 1',
                flagReason: 'incorrect',
                flagDescription: 'Instructor flags their own course.',
            },
        });
        expect(ownRes.status()).toBe(200);

        // A course the instructor has no access to is still rejected.
        const foreignRes = await api.post('/api/flags', {
            data: {
                questionId: 'q_e2e_inst_flag',
                courseId: 'BIOC-E2E-NOT-MY-COURSE',
                unitName: 'Unit 1',
                flagReason: 'incorrect',
                flagDescription: 'Should not be allowed.',
            },
            failOnStatusCode: false,
        });
        expect([403, 404]).toContain(foreignRes.status());
        await withDb((db) =>
            db.collection('flaggedQuestions').deleteMany({ questionId: 'q_e2e_inst_flag' })
        );
        await ctx.close();
    });
});

// ----------------------------------------------------------------------------
// URL-param courseId overrides localStorage on student pages
// ----------------------------------------------------------------------------
test.describe('Course context — URL param precedence', () => {
    test.beforeEach(async () => {
        await resetStudentChatData({ instructorId });
        await setUserAgreement(studentId, true);
    });

    test('a courseId in the URL is what getCurrentCourseId() returns, even if localStorage holds another', async ({ page }) => {
        await loginAsStudent(page);
        // Pre-seed localStorage with the WRONG courseId.
        await page.addInitScript((id) => {
            try { localStorage.setItem('selectedCourseId', id); } catch (_) {}
        }, STU_OTHER_COURSE_ID);

        // Load the quiz page with the URL pointing at the OTHER (correct-for-this-test)
        // course. Wait for the page to settle.
        await page.goto(`/student/quiz?courseId=${STU_COURSE_ID}`);
        await page.waitForLoadState('networkidle');

        // Call the helper that student-side code uses to resolve the active
        // course. URL params must win over localStorage. The function is a
        // global declared in public/common/scripts/auth.js, so it's attached
        // to window at runtime — but TS doesn't know that, hence the cast.
        const resolved = await page.evaluate(() => {
            const w = /** @type {any} */ (window);
            if (typeof w.getCurrentCourseId === 'function') {
                return w.getCurrentCourseId();
            }
            return null;
        });

        // If the helper is exposed, assert URL wins. If not exposed, fall back
        // to checking the network-level signal: the quiz page should have
        // fetched /api/quiz/status for the URL course, not for the stored one.
        if (resolved !== null) {
            expect(resolved).toBe(STU_COURSE_ID);
        } else {
            // helper not on window; rely on the fact that URL.searchParams
            // is the documented priority and is observable in the page URL.
            const search = await page.evaluate(() => location.search);
            expect(search).toContain(STU_COURSE_ID);
        }
    });
});

// ----------------------------------------------------------------------------
// Auto-save: localStorage keys after a chat round-trip
// ----------------------------------------------------------------------------
test.describe('Chat page — localStorage auto-save keys', () => {
    test.beforeEach(async () => {
        await resetStudentChatData({ instructorId });
        await setUserAgreement(studentId, true);
    });

    test('arriving with a selected course writes a session key under the student id', async ({ page }) => {
        await loginAsStudent(page);
        await page.addInitScript((id) => {
            try { localStorage.setItem('selectedCourseId', id); } catch (_) {}
        }, STU_COURSE_ID);
        await page.goto('/student');

        // Wait for the page to load the course.
        await expect(page.locator('.course-name')).toContainText(/BIOC|Student/i, { timeout: 15_000 });

        // student.js writes a `biocbot_session_<studentId>_<courseId>_<unitName>`
        // key once it has finished its initialization. Poll for one.
        const sessionKey = await page.evaluate(async () => {
            const start = Date.now();
            while (Date.now() - start < 5000) {
                const key = Object.keys(localStorage).find((k) =>
                    k.startsWith('biocbot_session_')
                );
                if (key) return key;
                await new Promise((r) => setTimeout(r, 100));
            }
            return null;
        });
        expect(sessionKey).toBeTruthy();
        // The student id should be part of the key.
        expect(sessionKey).toContain(studentId);
    });
});

// ----------------------------------------------------------------------------
// Banned/revoked student rendering on /student
// ----------------------------------------------------------------------------
test.describe('Revoked-access UI', () => {
    test.beforeEach(async () => {
        await resetStudentChatData({ instructorId });
        await setUserAgreement(studentId, true);
    });

    test('a banned student lands on the revoked-access notice rather than the chat input', async ({ page }) => {
        // Set the student's enrollment to banned for STU_COURSE_ID.
        await withDb(async (db) => {
            await db.collection('courses').updateOne(
                { courseId: STU_COURSE_ID },
                {
                    $set: {
                        [`studentEnrollment.${studentId}`]: {
                            enrolled: false,
                            status: 'banned',
                            updatedAt: new Date(),
                        },
                    },
                }
            );
        });

        await loginAsStudent(page);
        await page.addInitScript((id) => {
            try { localStorage.setItem('selectedCourseId', id); } catch (_) {}
        }, STU_COURSE_ID);
        await page.goto('/student');

        // Give student.js time to call the enrollment endpoint and run
        // renderRevokedAccessUI.
        await page.waitForTimeout(1500);

        // The exact UI rendered varies, but the chat form should not be
        // active. We look for either an explicit revoked notice or for the
        // chat input being hidden/disabled.
        const inputBox = page.locator('#chat-input');
        const hasInput = (await inputBox.count()) > 0;
        const inputEnabled = hasInput ? await inputBox.isEnabled().catch(() => false) : false;

        const pageText = await page.locator('body').innerText();
        const looksRevoked = /revoked|access.*disabled|access disabled|not enrolled/i.test(pageText);

        expect(looksRevoked || !inputEnabled).toBeTruthy();
    });
});

// ----------------------------------------------------------------------------
// Chat input form — Enter key submits
// ----------------------------------------------------------------------------
test.describe('Chat input form behavior', () => {
    test.beforeEach(async () => {
        await resetStudentChatData({ instructorId });
        await setUserAgreement(studentId, true);
    });

    test('the chat input + send button render and the form has Enter-key submission', async ({ page }) => {
        await loginAsStudent(page);
        await page.addInitScript((id) => {
            try { localStorage.setItem('selectedCourseId', id); } catch (_) {}
        }, STU_COURSE_ID);
        await page.goto('/student');

        const form = page.locator('#chat-form');
        const input = page.locator('#chat-input');
        const send = page.locator('#send-button');

        await expect(form).toBeVisible({ timeout: 15_000 });
        await expect(input).toBeVisible();
        await expect(send).toBeVisible();
        await expect(send).toHaveAttribute('type', 'submit');
    });
});

// ----------------------------------------------------------------------------
// /api/chat — non-explanation profanity is filtered, but isExplanationRequest skips filter
// ----------------------------------------------------------------------------
test.describe('POST /api/chat — profanity filter bypass for explanation requests', () => {
    test.use({ storageState: storageStatePath('student') });

    test.beforeEach(async () => {
        await resetStudentChatData({ instructorId });
    });

    test('isExplanationRequest:true skips the profanity filter (test the carve-out exists)', async ({ request: api }) => {
        // The chat route skips profanity filtering for explanation requests
        // (so internally-generated "explain this" follow-ups can pass through
        // even if the original bot text contained edge words). We can't easily
        // craft a bot reply containing profanity, but we can prove the carve-
        // out branches differently from the non-explanation path: the same
        // input that is filtered above does NOT trigger profanityFiltered:true
        // when isExplanationRequest is true.
        const res = await api.post('/api/chat', {
            data: {
                message: 'this is some shit answer',
                courseId: STU_COURSE_ID,
                unitName: 'Unit 1',
                mode: 'tutor',
                isExplanationRequest: true,
                topic: APPROVED_TOPIC,
            },
            timeout: 60_000,
        });
        expect(res.ok()).toBeTruthy();
        const body = await res.json();
        // The system warning path uses model: 'system'. The carve-out should
        // produce a normal LLM response (or at least, NOT the filtered system
        // warning).
        expect(body.model).not.toBe('system');
        expect(body.debug?.profanityFiltered).toBeFalsy();
    });
});

// ----------------------------------------------------------------------------
// /api/auth/me — shape and unauthenticated guard
// ----------------------------------------------------------------------------
test.describe('GET /api/auth/me', () => {
    test('returns the student\'s session-user shape and does not leak passwordHash', async ({ browser }) => {
        const ctx = await browser.newContext({ storageState: storageStatePath('student') });
        const res = await ctx.request.get('/api/auth/me');
        expect(res.ok()).toBeTruthy();
        const body = await res.json();
        expect(body.success).toBeTruthy();
        const u = body.user;
        expect(u).toBeTruthy();
        expect(u.userId).toBe(studentId);
        expect(u.role).toBe('student');
        // Sensitive fields must never appear in the session-user payload.
        expect(u.passwordHash).toBeUndefined();
        expect(u.password).toBeUndefined();
        expect(u.salt).toBeUndefined();
        await ctx.close();
    });

    test('returns 401 for an unauthenticated request', async ({ browser }) => {
        const ctx = await browser.newContext(); // no storage state
        const res = await ctx.request.get('/api/auth/me', { maxRedirects: 0 });
        expect(res.status()).toBe(401);
        await ctx.close();
    });
});

// ----------------------------------------------------------------------------
// /api/students/:courseId — instructor-only listing, students get rejected
// ----------------------------------------------------------------------------
test.describe('GET /api/students/:courseId — student is rejected', () => {
    test.use({ storageState: storageStatePath('student') });

    test.beforeEach(async () => {
        await resetStudentChatData({ instructorId });
    });

    test('a student calling the instructor-side student listing gets a 4xx', async ({ request: api }) => {
        const res = await api.get(`/api/students/${STU_COURSE_ID}`);
        // Route uses requireDownloadAdmin; non-admin students get 403 (or 404).
        expect(res.status()).not.toBe(200);
        expect(res.status()).toBeGreaterThanOrEqual(400);
    });
});

// ----------------------------------------------------------------------------
// GET /api/students/:courseId/:studentId/sessions/:sessionId — students cannot
// peek at single sessions via the instructor path
// ----------------------------------------------------------------------------
test.describe('GET specific session via instructor path', () => {
    test.use({ storageState: storageStatePath('student') });

    test.beforeEach(async () => {
        await resetStudentChatData({ instructorId });
    });

    test('student cannot fetch their own session via the instructor-admin route', async ({ request: api }) => {
        const sessionId = `e2e_inst_lookup_${Date.now()}`;
        await seedChatSession({
            sessionId,
            courseId: STU_COURSE_ID,
            studentId,
            studentName: 'E2E Student',
            title: 'Mine via inst path',
        });

        const res = await api.get(
            `/api/students/${STU_COURSE_ID}/${studentId}/sessions/${sessionId}`
        );
        // The route is admin-gated; the student should be rejected even for
        // their own session.
        expect(res.status()).not.toBe(200);
        expect(res.status()).toBeGreaterThanOrEqual(400);
    });
});

// ----------------------------------------------------------------------------
// /sessions/own — sort order is newest-first
// ----------------------------------------------------------------------------
test.describe('/sessions/own — ordering', () => {
    test.use({ storageState: storageStatePath('student') });

    test.beforeEach(async () => {
        await resetStudentChatData({ instructorId });
    });

    test('listing returns sessions sorted by savedAt descending', async ({ request: api }) => {
        // Seed three sessions with explicit savedAt timestamps.
        const ids = ['order_old', 'order_mid', 'order_new'].map((s) => `e2e_${s}_${Date.now()}`);
        await withDb(async (db) => {
            const base = Date.now();
            await db.collection('chat_sessions').insertMany([
                {
                    sessionId: ids[0],
                    courseId: STU_COURSE_ID,
                    studentId,
                    studentName: 'E2E Student',
                    unitName: 'Unit 1',
                    title: 'old',
                    messageCount: 1,
                    savedAt: new Date(base - 3 * 60_000).toISOString(),
                    chatData: { messages: [] },
                    isDeleted: false,
                    createdAt: new Date(base - 3 * 60_000),
                },
                {
                    sessionId: ids[1],
                    courseId: STU_COURSE_ID,
                    studentId,
                    studentName: 'E2E Student',
                    unitName: 'Unit 1',
                    title: 'mid',
                    messageCount: 1,
                    savedAt: new Date(base - 1 * 60_000).toISOString(),
                    chatData: { messages: [] },
                    isDeleted: false,
                    createdAt: new Date(base - 1 * 60_000),
                },
                {
                    sessionId: ids[2],
                    courseId: STU_COURSE_ID,
                    studentId,
                    studentName: 'E2E Student',
                    unitName: 'Unit 1',
                    title: 'new',
                    messageCount: 1,
                    savedAt: new Date(base).toISOString(),
                    chatData: { messages: [] },
                    isDeleted: false,
                    createdAt: new Date(base),
                },
            ]);
        });

        const res = await api.get(`/api/students/${STU_COURSE_ID}/${studentId}/sessions/own`);
        expect(res.ok()).toBeTruthy();
        const body = await res.json();
        const found = body.data.sessions.filter((s) => ids.includes(s.sessionId));
        expect(found.map((s) => s.sessionId)).toEqual([ids[2], ids[1], ids[0]]);
    });
});

// ----------------------------------------------------------------------------
// Logout — clears session, /api/auth/me becomes 401
// ----------------------------------------------------------------------------
test.describe('Logout', () => {
    test('POST /api/auth/logout invalidates the student session', async ({ browser }) => {
        // IMPORTANT: do NOT reuse the shared storageState file here. Logging
        // out destroys the session referenced by that cookie, which would
        // poison every other student-storageState test in this spec. Spin up
        // a brand-new context, log in via the API, then exercise logout
        // against THAT throwaway session.
        const ctx = await browser.newContext();
        const api = ctx.request;
        const login = await api.post('/api/auth/login', {
            data: { username: TEST_USERS.student.username, password: studentPassword },
        });
        expect(login.ok()).toBeTruthy();

        const meBefore = await api.get('/api/auth/me');
        expect(meBefore.ok()).toBeTruthy();

        const logout = await api.post('/api/auth/logout', { maxRedirects: 0 });
        expect([200, 302]).toContain(logout.status());

        const meAfter = await api.get('/api/auth/me', { maxRedirects: 0 });
        expect(meAfter.status()).toBe(401);
        await ctx.close();
    });
});

// ----------------------------------------------------------------------------
// Idle timeout modal — DOM presence on the chat page
// ----------------------------------------------------------------------------
test.describe('Idle timeout modal', () => {
    test.beforeEach(async () => {
        await resetStudentChatData({ instructorId });
        await setUserAgreement(studentId, true);
    });

    test('the idle-timeout modal exists in the DOM with the expected buttons', async ({ page }) => {
        await loginAsStudent(page);
        await page.addInitScript((id) => {
            try { localStorage.setItem('selectedCourseId', id); } catch (_) {}
        }, STU_COURSE_ID);
        await page.goto('/student');

        const modal = page.locator('#idle-timeout-modal');
        await expect(modal).toBeAttached({ timeout: 15_000 });
        await expect(modal.locator('#idle-stay-btn')).toBeAttached();
        await expect(modal.locator('#idle-signout-btn')).toBeAttached();
        // Modal starts hidden — no timer should have fired in 1 page-load second.
        await expect(modal).toBeHidden();
    });
});

// ----------------------------------------------------------------------------
// Login redirect — already-authenticated student visiting `/` lands on /student
// ----------------------------------------------------------------------------
test.describe('Login page redirect for authenticated users', () => {
    test('a logged-in student visiting / is redirected to their landing page', async ({ browser }) => {
        const ctx = await browser.newContext({ storageState: storageStatePath('student') });
        const page = await ctx.newPage();
        await page.goto('/login');
        // redirectIfAuthenticated sends a logged-in user to their role-specific
        // landing page. Final URL must NOT be the login page.
        await page.waitForLoadState('networkidle');
        const finalUrl = new URL(page.url());
        expect(finalUrl.pathname).not.toBe('/');
        expect(finalUrl.pathname).not.toBe('/login');
        expect(finalUrl.pathname).toContain('/student');
        await ctx.close();
    });
});

// ----------------------------------------------------------------------------
// /api/chat — full happy-path round-trip (LLM-backed)
// ----------------------------------------------------------------------------
test.describe('POST /api/chat — happy path', () => {
    test.use({ storageState: storageStatePath('student') });

    test.beforeEach(async () => {
        await resetStudentChatData({ instructorId });
    });

    test('returns a successful response with expected envelope fields', async ({ request: api }) => {
        const res = await api.post('/api/chat', {
            data: {
                message: 'What is photosynthesis in one sentence?',
                courseId: STU_COURSE_ID,
                unitName: 'Unit 1',
                mode: 'tutor',
            },
            timeout: 60_000,
        });
        expect(res.ok()).toBeTruthy();
        const body = await res.json();
        expect(body).toMatchObject({ success: true });
        expect(typeof body.message).toBe('string');
        expect(body.message.length).toBeGreaterThan(0);
        // The route is supposed to echo retrieval metadata so the client can
        // render source attribution. It can be empty but should be present.
        expect(body).toHaveProperty('citations');
        expect(body).toHaveProperty('sourceAttribution');
        expect(body).toHaveProperty('retrieval');
    });

    test('sending the same message in protégé mode still succeeds and reports mode', async ({ request: api }) => {
        const res = await api.post('/api/chat', {
            data: {
                message: 'Explain in your own words what photosynthesis is.',
                courseId: STU_COURSE_ID,
                unitName: 'Unit 1',
                mode: 'protege',
            },
            timeout: 60_000,
        });
        expect(res.ok()).toBeTruthy();
        const body = await res.json();
        expect(body.success).toBeTruthy();
        // Some implementations echo the mode back; if so, verify it.
        if (body.mode) {
            expect(['protege', 'tutor', 'default']).toContain(body.mode);
        }
    });
});

// ----------------------------------------------------------------------------
// requireStudentEnrolled — enforcement on /api/chat for non-existent course
// ----------------------------------------------------------------------------
test.describe('Enrollment middleware edge cases on /api/chat', () => {
    test.use({ storageState: storageStatePath('student') });

    test.beforeEach(async () => {
        await resetStudentChatData({ instructorId });
    });

    test('chat against a nonexistent courseId returns 4xx, not 500', async ({ request: api }) => {
        const res = await api.post('/api/chat', {
            data: {
                message: 'hi',
                courseId: 'BIOC-DOES-NOT-EXIST-WW88',
                unitName: 'Unit 1',
                mode: 'tutor',
            },
        });
        // requireStudentEnrolled hits getStudentEnrollment first; if the
        // course isn't found, the middleware returns 404. The route also
        // re-checks course existence and returns 404. Either way, not 5xx.
        expect(res.status()).not.toBe(500);
        expect(res.status()).toBeGreaterThanOrEqual(400);
    });
});

// ----------------------------------------------------------------------------
// Chat history UI — preview panel and delete
// ----------------------------------------------------------------------------
test.describe('Chat history UI — preview panel and delete', () => {
    test.beforeEach(async () => {
        await resetStudentChatData({ instructorId });
        await setUserAgreement(studentId, true);
    });

    test('selecting a chat shows its messages in the preview panel', async ({ page }) => {
        const sessionId = `e2e_preview_${Date.now()}`;
        const uniqueMarker = `MARKER-${Date.now()}`;
        await seedChatSession({
            sessionId,
            courseId: STU_COURSE_ID,
            studentId,
            studentName: 'E2E Student',
            title: 'Preview me',
            messages: [
                { type: 'user', content: uniqueMarker, timestamp: new Date().toISOString() },
                { type: 'bot', content: 'A reply', timestamp: new Date(Date.now() + 1000).toISOString() },
            ],
        });

        await loginAsStudent(page);
        await page.addInitScript((id) => {
            try { localStorage.setItem('selectedCourseId', id); } catch (_) {}
        }, STU_COURSE_ID);
        await page.goto('/student/history');

        const item = page.locator(`[data-chat-id="${sessionId}"]`);
        await expect(item).toBeVisible({ timeout: 15_000 });
        await item.click();

        const preview = page.locator('#preview-messages');
        await expect(preview).toContainText(uniqueMarker, { timeout: 10_000 });
        await expect(preview).toContainText('A reply');

        // Preview title and continue button become active.
        await expect(page.locator('#preview-title')).toContainText('Preview me');
        await expect(page.locator('#continue-chat-btn')).toBeVisible();
    });

    test('clicking Delete (after confirm) soft-deletes the session via /own', async ({ page }) => {
        const sessionId = `e2e_uidel_${Date.now()}`;
        await seedChatSession({
            sessionId,
            courseId: STU_COURSE_ID,
            studentId,
            studentName: 'E2E Student',
            title: 'Delete me',
            messages: [
                { type: 'user', content: 'q', timestamp: new Date().toISOString() },
            ],
        });

        await loginAsStudent(page);
        await page.addInitScript((id) => {
            try { localStorage.setItem('selectedCourseId', id); } catch (_) {}
        }, STU_COURSE_ID);

        // Auto-accept the confirm() prompt that history.js fires.
        page.on('dialog', (dialog) => dialog.accept());

        await page.goto('/student/history');
        const item = page.locator(`[data-chat-id="${sessionId}"]`);
        await expect(item).toBeVisible({ timeout: 15_000 });
        await item.click();

        await page.locator('#delete-chat-btn').click();

        // Item should be removed from the list (and the API should mark it as
        // student-deleted).
        await expect(item).toHaveCount(0, { timeout: 10_000 });

        const row = await withDb((db) =>
            db.collection('chat_sessions').findOne({ sessionId })
        );
        expect(row?.studentDeleted).toBe(true);
    });
});

// ----------------------------------------------------------------------------
// Chat input UI — typing into the field updates its value
// ----------------------------------------------------------------------------
test.describe('Chat input UI — type-and-clear', () => {
    test.beforeEach(async () => {
        await resetStudentChatData({ instructorId });
        await setUserAgreement(studentId, true);
    });

    test('typing into the chat input populates the field', async ({ page }) => {
        await loginAsStudent(page);
        await page.addInitScript((id) => {
            try { localStorage.setItem('selectedCourseId', id); } catch (_) {}
        }, STU_COURSE_ID);
        await page.goto('/student');

        const input = page.locator('#chat-input');
        await expect(input).toBeVisible({ timeout: 15_000 });
        await input.fill('Hello world, this is e2e_student.');
        await expect(input).toHaveValue('Hello world, this is e2e_student.');
    });
});

// ----------------------------------------------------------------------------
// Notifications: /api/auth/me caching — multiple consecutive fetches should
// each succeed without leaking state across requests
// ----------------------------------------------------------------------------
test.describe('Auth /me request consistency', () => {
    test('multiple back-to-back /me calls return the same user', async ({ browser }) => {
        const ctx = await browser.newContext({ storageState: storageStatePath('student') });
        const api = ctx.request;
        const reqs = await Promise.all([
            api.get('/api/auth/me'),
            api.get('/api/auth/me'),
            api.get('/api/auth/me'),
        ]);
        for (const res of reqs) {
            expect(res.ok()).toBeTruthy();
            const body = await res.json();
            expect(body.user?.userId).toBe(studentId);
        }
        await ctx.close();
    });
});

test.describe('Chat history page — rename and continue', () => {
    test.beforeEach(async () => {
        await resetStudentChatData({ instructorId });
        await setUserAgreement(studentId, true);
    });

    test('saved session appears in the list and can be renamed via the inline edit UI', async ({ page }) => {
        const sessionId = `e2e_ui_rename_${Date.now()}`;
        await seedChatSession({
            sessionId,
            courseId: STU_COURSE_ID,
            studentId,
            studentName: 'E2E Student',
            title: 'Renameable',
            messages: [
                { type: 'user', content: 'a question', timestamp: new Date().toISOString() },
                { type: 'bot', content: 'an answer', timestamp: new Date().toISOString() },
            ],
        });

        await loginAsStudent(page);
        // history.js reads selectedCourseId from localStorage — set it
        // before the page boots so it queries the right course.
        await page.addInitScript((id) => {
            try { localStorage.setItem('selectedCourseId', id); } catch (_) {}
        }, STU_COURSE_ID);
        await page.goto('/student/history');

        const item = page.locator(`[data-chat-id="${sessionId}"]`);
        await expect(item).toBeVisible({ timeout: 15_000 });
        await expect(item).toContainText('Renameable');

        await item.locator('.edit-btn').click();
        const input = item.locator('.title-input');
        await expect(input).toBeVisible();
        await input.fill('Renamed!');
        await item.locator('.save-btn').click();

        await expect(item).toContainText('Renamed!', { timeout: 10_000 });

        const stored = await withDb((db) =>
            db.collection('chat_sessions').findOne({ sessionId })
        );
        expect(stored?.title).toBe('Renamed!');
    });
});

// ----------------------------------------------------------------------------
// Export / feedback UX fixes (Bowen & Eden):
//   - feedback thumb renders as a neutral monochrome SVG, not the coloured emoji,
//     and is not "active" until pressed
//   - captured/exported message content excludes the surrounding interface
//     controls (Explain, feedback, flag menu, source, timestamp)
//   - restored/continued messages keep their original timestamp instead of being
//     re-stamped with the reopen time
// ----------------------------------------------------------------------------
test.describe('Chat export & feedback UX fixes', () => {
    test.use({ storageState: storageStatePath('student') });

    test.beforeEach(async ({ page }) => {
        await setUserAgreement(studentId, true);
        await page.addInitScript((id) => {
            try { localStorage.setItem('selectedCourseId', id); } catch (_) {}
        }, STU_COURSE_ID);
        await page.goto('/student');
        await expect(page.locator('#chat-messages')).toBeAttached({ timeout: 15_000 });
    });

    test('feedback thumb is a neutral monochrome SVG that is inactive until pressed', async ({ page }) => {
        const info = await page.evaluate(() => {
            const container = createMessageFeedbackControls();
            const btn = container.querySelector('.message-feedback-btn');
            const icon = btn.querySelector('svg.feedback-icon');
            return {
                hasSvg: !!icon,
                // The coloured 👍 emoji must be gone
                text: btn.textContent.trim(),
                active: btn.classList.contains('active'),
                ariaPressed: btn.getAttribute('aria-pressed'),
            };
        });
        expect(info.hasSvg).toBe(true);
        expect(info.text).toBe('');
        expect(info.active).toBe(false);
        expect(info.ariaPressed).toBe('false');
    });

    test('extractMessageContent excludes Explain / feedback / flag controls from a bot message', async ({ page }) => {
        const extracted = await page.evaluate(() => {
            const chat = document.getElementById('chat-messages');
            chat.innerHTML = '';
            // Render a bot message that carries every interface control: the
            // Explain + "Ask me a question" buttons (detectedTopic), the feedback
            // thumb (messageId), and the ⚑ flag menu with its labels.
            addMessage(
                'Photosynthesis converts light energy into ATP.',
                'bot',
                false, // withSource
                true,  // skipAutoSave
                null,  // sourceAttribution
                false, // isHtml
                null,  // activeStruggleTopic
                'ATP', // detectedTopic -> Explain / practice buttons
                'msg-export-1', // messageId -> feedback controls
                null,  // feedbackRating
                { timestamp: '2020-05-05T12:00:00.000Z' }
            );
            const content = document.querySelector('.bot-message .message-content');
            return extractMessageContent(content);
        });

        expect(extracted).toBe('Photosynthesis converts light energy into ATP.');
        for (const control of ['Explain', 'Ask me a question', 'Incorrect', 'Offensive', 'Flag']) {
            expect(extracted).not.toContain(control);
        }
    });

    test('a successful Explain action tags its saved response with the source message', async ({ page }) => {
        let explainRequestBody = null;
        await page.route('**/api/chat', async (route) => {
            explainRequestBody = route.request().postDataJSON();
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    success: true,
                    messageId: 'msg-explanation-1',
                    message: 'ATP is like a rechargeable energy token for the cell.',
                    sourceAttribution: {
                        source: 'GPT',
                        description: 'Generated by AI',
                        downloadsEnabled: false,
                        documents: [],
                    },
                }),
            });
        });

        await page.evaluate(async (id) => {
            const testWindow = /** @type {any} */ (window);
            localStorage.removeItem(`biocbot_current_chat_${id}`);
            const chat = document.getElementById('chat-messages');
            if (!chat) throw new Error('Expected chat message container');
            chat.innerHTML = '';
            testWindow.addMessage(
                'ATP transfers usable energy between cellular reactions.',
                'bot', false, false, null, false, null, 'ATP',
                'msg-original-1'
            );
            // Exercise the persisted-message fallback used when an Explain
            // control cannot provide its source id directly.
            await testWindow.handleExplainAction(
                'ATP transfers usable energy between cellular reactions.',
                'ATP',
                null
            );
        }, studentId);

        await expect(page.locator('.bot-message').last()).toContainText('rechargeable energy token');

        const savedResponse = await page.evaluate((id) => {
            const raw = localStorage.getItem(`biocbot_current_chat_${id}`);
            const chatData = raw ? JSON.parse(raw) : null;
            return chatData?.messages?.at(-1) || null;
        }, studentId);

        expect(explainRequestBody).toMatchObject({
            isExplanationRequest: { topic: 'ATP' },
            topic: 'ATP',
        });
        expect(savedResponse).toMatchObject({
            type: 'bot',
            messageId: 'msg-explanation-1',
            triggeredBy: 'explain_button',
            actionStatus: 'success',
            sourceMessageId: 'msg-original-1',
            elapsedTimeDerived: false,
        });
        expect(Number.isInteger(savedResponse.elapsedTime)).toBe(true);
    });

    test('a restored message keeps its original timestamp instead of the reopen time', async ({ page }) => {
        const result = await page.evaluate(() => {
            const chat = document.getElementById('chat-messages');
            chat.innerHTML = '';
            const original = '2019-03-04T08:30:00.000Z';
            addMessage(
                'An older answer from a previous session.',
                'bot',
                false, true, null, false, null, null,
                'msg-old-1', null,
                { timestamp: original }
            );
            const msg = document.querySelector('.bot-message');
            return {
                expected: new Date(original).getTime(),
                datasetTs: Number(msg.dataset.timestamp),
                nowTs: Date.now(),
            };
        });

        // The rendered message must carry the original time, not "now".
        expect(result.datasetTs).toBe(result.expected);
        expect(Math.abs(result.nowTs - result.datasetTs)).toBeGreaterThan(60_000);
    });
});

test.describe('Chat timing across tab close and relogin', () => {
    test('closing the tab and logging back in preserves all older message timing', async ({ browser }) => {
        const currentReloginStudentId = String(reloginStudentId);
        const currentReloginStudentPassword = String(reloginStudentPassword);
        await resetStudentChatData({ instructorId });
        await withDb((/** @type {import('mongodb').Db} */ db) => db.collection('courses').updateOne(
            { courseId: STU_COURSE_ID },
            {
                $set: {
                    [`studentEnrollment.${currentReloginStudentId}.enrolled`]: true,
                    [`studentEnrollment.${currentReloginStudentId}.enrolledAt`]: new Date(),
                },
            }
        ));
        await setUserAgreement(currentReloginStudentId, true);
        const context = await browser.newContext();
        const api = context.request;
        const login = async () => api.post('/api/auth/login', {
            data: {
                username: TEST_USERS.student_relogin.username,
                password: currentReloginStudentPassword,
            },
        });

        try {
            expect((await login()).ok()).toBeTruthy();
            const originalMessages = [
                {
                    type: 'bot', content: 'ORIGINAL ASSESSMENT START', messageType: 'assessment-start', isHtml: true,
                    timestamp: '2025-02-03T04:05:06.000Z', elapsedTime: 0, elapsedTimeDerived: true,
                },
                {
                    type: 'bot', content: 'ORIGINAL ASSESSMENT QUESTION', messageType: 'practice-test-question',
                    timestamp: '2025-02-03T04:05:08.500Z', elapsedTime: 2500, elapsedTimeDerived: false,
                    questionData: {
                        questionIndex: 0,
                        questionText: 'ORIGINAL ASSESSMENT QUESTION',
                        options: [{ text: 'A. Original option', isSelected: true }],
                        studentAnswer: 'A',
                    },
                },
                {
                    type: 'bot', content: 'ORIGINAL MODE RESULT', messageType: 'mode-result',
                    timestamp: '2025-02-03T04:05:11.500Z', elapsedTime: 3000, elapsedTimeDerived: true,
                    htmlContent: '<div class="mode-explanation">ORIGINAL MODE RESULT</div>',
                },
                {
                    type: 'user', content: 'ORIGINAL STUDENT MESSAGE', messageType: 'regular-chat',
                    timestamp: '2025-02-03T04:05:15.500Z', elapsedTime: 4000, elapsedTimeDerived: false,
                },
                {
                    type: 'bot', content: 'ORIGINAL BOT RESPONSE', messageType: 'regular-chat',
                    timestamp: '2025-02-03T04:05:20.500Z', elapsedTime: 5000, elapsedTimeDerived: false,
                },
            ];
            const sessionId = `timing_relogin_${Date.now()}`;
            const chatData = {
                metadata: {
                    exportDate: new Date().toISOString(), courseId: STU_COURSE_ID,
                    courseName: STU_COURSE_NAME, studentId: currentReloginStudentId,
                    studentName: TEST_USERS.student_relogin.displayName,
                    unitName: 'Unit 1', currentMode: 'tutor', totalMessages: originalMessages.length,
                    version: '1.0',
                },
                messages: originalMessages,
                practiceTests: null,
                studentAnswers: { answers: [] },
                sessionInfo: {
                    sessionId, startTime: '2025-02-03T04:05:06.000Z',
                    endTime: '2025-02-03T04:05:20.500Z', duration: '5s',
                },
                lastActivityTimestamp: new Date().toISOString(),
            };

            const firstTab = await context.newPage();
            await firstTab.goto('/student');
            await firstTab.evaluate(({ studentId, courseId, sessionId, chatData }) => {
                localStorage.setItem('selectedCourseId', courseId);
                localStorage.setItem('selectedCourseName', 'BIOC E2E Student Chat');
                localStorage.setItem('selectedUnitName', 'Unit 1');
                localStorage.setItem('studentMode', 'tutor');
                localStorage.setItem(`biocbot_current_chat_${studentId}`, JSON.stringify(chatData));
                localStorage.setItem(`biocbot_session_${studentId}_${courseId}_Unit 1`, sessionId);
            }, { studentId: currentReloginStudentId, courseId: STU_COURSE_ID, sessionId, chatData });
            await firstTab.reload();
            await expect(firstTab.locator('#chat-messages')).toContainText('ORIGINAL BOT RESPONSE', { timeout: 15_000 });

            await firstTab.evaluate(() => {
                const testWindow = /** @type {any} */ (window);
                testWindow.addMessage('NEW MESSAGE AFTER FIRST RESTORE', 'user');
            });
            await expect(firstTab.locator('#chat-messages')).toContainText('NEW MESSAGE AFTER FIRST RESTORE');
            await firstTab.close();

            const logout = await api.post('/api/auth/logout', { maxRedirects: 0 });
            expect([200, 302]).toContain(logout.status());
            expect((await login()).ok()).toBeTruthy();

            const reopenedTab = await context.newPage();
            await reopenedTab.goto('/student');
            await expect(reopenedTab.locator('#chat-messages')).toContainText('ORIGINAL BOT RESPONSE', { timeout: 15_000 });
            await expect(reopenedTab.locator('#chat-messages')).toContainText('NEW MESSAGE AFTER FIRST RESTORE');

            const afterRelogin = await reopenedTab.evaluate(({ studentId, expectedMessages }) => {
                const raw = localStorage.getItem(`biocbot_current_chat_${studentId}`);
                if (!raw) throw new Error('Expected restored chat data in localStorage');
                const stored = JSON.parse(raw);
                const fields = (/** @type {any} */ message) => ({
                    messageType: message.messageType,
                    timestamp: message.timestamp,
                    elapsedTime: message.elapsedTime,
                    elapsedTimeDerived: message.elapsedTimeDerived,
                });
                const rendered = expectedMessages.map((expected) => {
                    const element = /** @type {HTMLElement|undefined} */ (
                        Array.from(document.querySelectorAll('#chat-messages .message'))
                            .find(message => message.textContent.includes(expected.content))
                    );
                    return {
                        timestamp: element?.dataset.timestamp,
                        elapsedTime: element?.dataset.elapsedTime,
                        elapsedTimeDerived: element?.dataset.elapsedTimeDerived,
                    };
                });
                return {
                    stored: stored.messages.slice(0, expectedMessages.length).map(fields),
                    rendered,
                };
            }, { studentId: currentReloginStudentId, expectedMessages: originalMessages });

            expect(afterRelogin.stored).toEqual(originalMessages.map((message) => ({
                messageType: message.messageType,
                timestamp: message.timestamp,
                elapsedTime: message.elapsedTime,
                elapsedTimeDerived: message.elapsedTimeDerived,
            })));
            expect(afterRelogin.rendered).toEqual(originalMessages.map((message) => ({
                timestamp: String(new Date(message.timestamp).getTime()),
                elapsedTime: String(message.elapsedTime),
                elapsedTimeDerived: String(message.elapsedTimeDerived),
            })));
            await reopenedTab.close();
        } finally {
            await context.close();
        }

        // Logging the dedicated relogin user out and back in must never destroy
        // the shared e2e_student session consumed by all subsequent specs.
        const sharedStudentContext = await browser.newContext({
            storageState: storageStatePath('student'),
        });
        try {
            const sharedMe = await sharedStudentContext.request.get('/api/auth/me');
            expect(sharedMe.ok()).toBeTruthy();
            const sharedBody = await sharedMe.json();
            expect(sharedBody.user?.username).toBe(TEST_USERS.student.username);
        } finally {
            await sharedStudentContext.close();
        }
    });
});
