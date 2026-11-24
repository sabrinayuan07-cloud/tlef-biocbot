// @ts-check
/**
 * Student-facing quiz UI tests. Drives the actual /student/quiz page through
 * a real browser session — login, filter, submit, feedback, materials,
 * disabled state, and nav visibility.
 */

const { test, expect } = require('./fixtures/monocart');
const { TEST_USERS, loadCredentials } = require('./helpers/users');
const {
    QUIZ_COURSE_ID,
    DOC_ID,
    withDb,
    getUserIdByUsername,
    resetQuizCourse,
    cleanupQuizCourse,
} = require('./helpers/quiz');

const studentUser = TEST_USERS.student;
let studentPassword;
let instructorId;

test.beforeAll(async () => {
    studentPassword = loadCredentials().student;
    instructorId = await getUserIdByUsername(TEST_USERS.instructor.username);
});

test.afterAll(async () => {
    await cleanupQuizCourse();
});

async function loginAsStudent(page) {
    await page.goto('/login');
    await page.locator('#auth-form input#username').fill(studentUser.username);
    await page.locator('#auth-form input#password').fill(studentPassword);
    await page.locator('#auth-form button#login-btn').click();
    await page.waitForURL((url) => url.pathname !== '/' && url.pathname !== '/login', {
        timeout: 10_000,
    });
}

async function gotoQuizPage(page) {
    // URL param wins over preferences/localStorage in getCurrentCourseId,
    // so we don't need to mutate the student's stored course context.
    await page.goto(`/student/quiz?courseId=${QUIZ_COURSE_ID}`);
}

test.describe('Quiz nav visibility', () => {
    // checkQuizNavVisibility() resolves the course through the student-page
    // getCurrentCourseId() override (preferences → localStorage → course
    // list), which ignores the URL param. Seed localStorage so the check is
    // deterministic instead of racing the nav item's default-visible state.
    test.beforeEach(async ({ page }) => {
        await page.addInitScript((courseId) => {
            localStorage.setItem('selectedCourseId', courseId);
        }, QUIZ_COURSE_ID);
    });

    test('nav item is hidden when quiz is disabled', async ({ page }) => {
        await resetQuizCourse({ instructorId, quizSettings: { enabled: false } });

        await loginAsStudent(page);
        await page.goto(`/student?courseId=${QUIZ_COURSE_ID}`);

        // checkQuizNavVisibility() runs after auth.ready — wait for the fetch
        // to resolve and the style to be applied.
        const navItem = page.locator('#quiz-nav-item');
        await expect(navItem).toBeHidden({ timeout: 10_000 });
    });

    test('nav item is visible when quiz is enabled', async ({ page }) => {
        await resetQuizCourse({ instructorId, quizSettings: { enabled: true } });

        await loginAsStudent(page);
        await page.goto(`/student?courseId=${QUIZ_COURSE_ID}`);

        const navItem = page.locator('#quiz-nav-item');
        await expect(navItem).toBeVisible({ timeout: 10_000 });
    });
});

test.describe('Quiz page — disabled course', () => {
    test('shows the disabled-state message when quiz practice is off', async ({ page }) => {
        await resetQuizCourse({ instructorId, quizSettings: { enabled: false } });

        await loginAsStudent(page);
        await gotoQuizPage(page);

        await expect(page.locator('#quiz-disabled')).toBeVisible({ timeout: 10_000 });
        await expect(page.locator('#question-card')).toBeHidden();
    });
});

test.describe('Quiz page — answering questions', () => {
    test.beforeEach(async () => {
        await resetQuizCourse({ instructorId, quizSettings: { enabled: true } });
    });

    test('a correct multiple-choice answer shows positive feedback and records an attempt', async ({ page }) => {
        await loginAsStudent(page);
        await gotoQuizPage(page);

        // Narrow to the one MC question so we know which answer to pick.
        await page.locator('#type-filter').selectOption('multiple-choice');

        const questionCard = page.locator('#question-card');
        await expect(questionCard).toBeVisible({ timeout: 10_000 });
        await expect(page.locator('#question-type-badge')).toHaveText('Multiple Choice');
        await expect(page.locator('#mc-options')).toBeVisible();

        // ATP — option B is correct.
        await page.locator('input[name="mc-answer"][value="B"]').check();
        await page.locator('#submit-btn').click();

        const feedback = page.locator('#feedback-container');
        await expect(feedback).toBeVisible({ timeout: 10_000 });
        await expect(feedback).toContainText(/correct/i);

        // The wrong-answer-only blocks must stay hidden on a correct answer
        await expect(page.locator('#materials-container')).toBeHidden();
        await expect(page.locator('#quiz-chat-container')).toBeHidden();

        // The attempt was persisted server-side as correct:true.
        await expect.poll(async () => {
            // Counted here: the result is encrypted when the server has encryption on.
            const attempts = await withDb((db) =>
                db.collection('quizAttempts').find({
                    courseId: QUIZ_COURSE_ID,
                    questionType: 'multiple-choice',
                }).toArray()
            );
            return attempts.filter((attempt) => attempt.correct === true).length;
        }, { timeout: 10_000 }).toBe(1);
    });

    test('a wrong multiple-choice answer surfaces materials when access is allowed', async ({ page }) => {
        await loginAsStudent(page);
        await gotoQuizPage(page);

        await page.locator('#type-filter').selectOption('multiple-choice');
        await expect(page.locator('#question-card')).toBeVisible({ timeout: 10_000 });

        // Wrong answer
        await page.locator('input[name="mc-answer"][value="A"]').check();
        await page.locator('#submit-btn').click();

        const feedback = page.locator('#feedback-container');
        await expect(feedback).toBeVisible({ timeout: 10_000 });
        await expect(feedback).toContainText(/incorrect/i);

        const materials = page.locator('#materials-container');
        await expect(materials).toBeVisible({ timeout: 10_000 });
        // The seeded document for Unit 1 must appear in the list.
        await expect(materials).toContainText('Unit 1 Notes.txt');

        // And the quiz-help chat is offered on a wrong answer
        await expect(page.locator('#quiz-chat-container')).toBeVisible();
    });

    test('a correct true/false answer shows positive feedback', async ({ page }) => {
        await loginAsStudent(page);
        await gotoQuizPage(page);

        await page.locator('#type-filter').selectOption('true-false');
        await expect(page.locator('#question-card')).toBeVisible({ timeout: 10_000 });
        await expect(page.locator('#tf-options')).toBeVisible();

        await page.locator('input[name="tf-answer"][value="true"]').check();
        await page.locator('#submit-btn').click();

        const feedback = page.locator('#feedback-container');
        await expect(feedback).toBeVisible({ timeout: 10_000 });
        await expect(feedback).toContainText(/correct/i);
    });

    test('with material access disabled, a wrong answer does NOT reveal materials', async ({ page }) => {
        await resetQuizCourse({
            instructorId,
            quizSettings: { enabled: true, allowLectureMaterialAccess: false },
        });

        await loginAsStudent(page);
        await gotoQuizPage(page);

        await page.locator('#type-filter').selectOption('multiple-choice');
        await expect(page.locator('#question-card')).toBeVisible({ timeout: 10_000 });

        await page.locator('input[name="mc-answer"][value="A"]').check();
        await page.locator('#submit-btn').click();

        await expect(page.locator('#feedback-container')).toBeVisible({ timeout: 10_000 });
        await expect(page.locator('#feedback-container')).toContainText(/incorrect/i);

        // Materials section stays hidden when the instructor disabled access
        await expect(page.locator('#materials-container')).toBeHidden();
    });
});
