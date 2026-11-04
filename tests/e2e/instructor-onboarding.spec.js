// @ts-check
require('dotenv').config();
const path = require('path');
const { MongoClient } = require('mongodb');
const { test, expect, request } = require('./fixtures/monocart');
const { TEST_USERS, loadCredentials } = require('./helpers/users');
const { resetLlmStub, addLlmStubRule } = require('./helpers/llm-stub');

const user = TEST_USERS.instructor_fresh;
const ownerUser = TEST_USERS.instructor;

const LECTURE_FIXTURE = path.join(__dirname, 'fixtures', 'sample-lecture.txt');
const PRACTICE_FIXTURE = path.join(__dirname, 'fixtures', 'sample-practice-quiz.txt');
const COURSE_NAME = 'BIOC E2E - Onboarding Test';
const VALID_API_KEY = 'sk-test-onboarding-ui';
const LEARNING_OBJECTIVE = 'Identify the four main classes of biomolecules.';
const SECOND_LEARNING_OBJECTIVE = 'Explain how peptide bonds form between amino acids.';
const REMOVED_LEARNING_OBJECTIVE = 'This learning objective should be removed before completion.';
const JOINABLE_COURSE_ID_PREFIX = 'e2e-joinable-onboarding';
const SEEDED_COURSE_ID_PREFIX = 'e2e-seeded-onboarding';
const SEEDED_DOCUMENTS = [
    {
        documentId: 'e2e-seeded-lecture-document',
        title: 'Lecture Notes - Unit 1',
        documentType: 'lecture-notes',
        status: 'uploaded',
        uploadedAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
    },
    {
        documentId: 'e2e-seeded-practice-document',
        title: 'Practice Questions/Tutorial - Unit 1',
        documentType: 'practice-quiz',
        status: 'uploaded',
        uploadedAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
    },
];
const QUESTIONS = {
    trueFalse: {
        type: 'true-false',
        text: 'Water is the universal solvent in biological systems.',
        answer: 'true',
    },
    multipleChoice: {
        type: 'multiple-choice',
        text: 'Which of the following is NOT one of the four main classes of biomolecules?',
        options: { A: 'Carbohydrates', B: 'Lipids', C: 'Minerals', D: 'Nucleic acids' },
        correct: 'C',
    },
    shortAnswer: {
        type: 'short-answer',
        text: 'Name the chemical bond that links two amino acids together.',
        expected: 'Peptide bond, formed via a condensation (dehydration) reaction.',
    },
};

let password;

test.beforeAll(() => {
    const credentials = loadCredentials();
    password = credentials.instructor_fresh;
    if (!password) {
        throw new Error(
            'No credentials.instructor_fresh found. Global-setup should have generated it.'
        );
    }
});

async function withDb(callback) {
    if (!process.env.MONGO_URI) {
        throw new Error('MONGO_URI not set; cannot access MongoDB for onboarding test.');
    }
    const client = new MongoClient(process.env.MONGO_URI);
    await client.connect();
    try {
        return await callback(client.db());
    } finally {
        await client.close();
    }
}

async function getTestUserDoc(db, username) {
    const userDoc = await db.collection('users').findOne({ username });
    if (!userDoc) {
        throw new Error(`Test user "${username}" was not found in MongoDB.`);
    }
    return userDoc;
}

async function hardDeleteCoursesFor(username) {
    await withDb(async (db) => {
        const userDoc = await db.collection('users').findOne({ username });
        if (!userDoc) return;
        await db.collection('courses').deleteMany({ instructorId: userDoc.userId });
    });
}

async function cleanupSeededCourses() {
    await withDb(async (db) => {
        await db.collection('courses').deleteMany({
            courseId: {
                $regex: `^(${JOINABLE_COURSE_ID_PREFIX}|${SEEDED_COURSE_ID_PREFIX})-`,
            },
        });
    });
}

async function seedCourseFor(username, overrides = {}) {
    return await withDb(async (db) => {
        const userDoc = await getTestUserDoc(db, username);
        const now = new Date();
        const courseId = overrides.courseId || `${SEEDED_COURSE_ID_PREFIX}-${Date.now()}`;
        const course = {
            courseId,
            courseName: overrides.courseName || `E2E Seeded Onboarding ${Date.now()}`,
            courseCode: overrides.courseCode || 'STU123',
            instructorCourseCode: overrides.instructorCourseCode || 'INST123',
            instructorId: userDoc.userId,
            instructors: overrides.instructors || [userDoc.userId],
            tas: [],
            courseDescription: '',
            assessmentCriteria: '',
            courseMaterials: [],
            approvedStruggleTopics: overrides.approvedStruggleTopics || [],
            courseStructure: overrides.courseStructure || {
                weeks: 1,
                lecturesPerWeek: 1,
                totalUnits: 1,
            },
            isOnboardingComplete: overrides.isOnboardingComplete || false,
            status: overrides.status || 'active',
            lectures: overrides.lectures || [{
                name: 'Unit 1',
                isPublished: false,
                learningObjectives: overrides.learningObjectives || [],
                passThreshold: 2,
                createdAt: now,
                updatedAt: now,
                documents: overrides.documents || [],
                assessmentQuestions: overrides.assessmentQuestions || [],
            }],
            createdAt: now,
            updatedAt: now,
        };

        await db.collection('courses').insertOne(course);
        return course;
    });
}

async function loginViaUI(page) {
    await page.goto('/login');
    await page.locator('#auth-form input#username').fill(user.username);
    await page.locator('#auth-form input#password').fill(password);
    await page.locator('#auth-form button#login-btn').click();
    await page.waitForURL((url) => url.pathname !== '/' && url.pathname !== '/login', {
        timeout: 10_000,
    });
}

async function loginViaApi(apiCtx) {
    const loginRes = await apiCtx.post('/api/auth/login', {
        data: { username: user.username, password },
    });
    expect(loginRes.ok()).toBeTruthy();
}

async function apiContextFromPage(page) {
    const apiCtx = await request.newContext({ baseURL: page.url().split('/instructor')[0] });
    await loginViaApi(apiCtx);
    return apiCtx;
}

async function gotoOnboardingStart(page) {
    await loginViaUI(page);
    await page.goto('/instructor/onboarding');
    await expect(page.locator('#step-1.onboarding-step.active')).toBeVisible();
}

async function startCustomCourse(page, courseName = COURSE_NAME) {
    await gotoOnboardingStart(page);
    await page.locator('#step-1 button.btn-primary', { hasText: 'Get Started' }).click();
    await expect(page.locator('#step-2.onboarding-step.active')).toBeVisible();
    await expect(page.locator('#course-select option[value="custom"]')).toHaveCount(1);
    await page.locator('#course-select').selectOption('custom');
    await page.locator('#custom-course-name').fill(courseName);
    await page.locator('#course-api-key').fill(VALID_API_KEY);
    await page.locator('#weeks-count').fill('1');
    await page.locator('#lectures-per-week').fill('1');
    await page.locator('#continue-btn').click();
    await expect(page.locator('#step-3.onboarding-step.active')).toBeVisible();
    await expect(page.locator('#substep-objectives.guided-substep.active')).toBeVisible();
}

async function addLearningObjectiveText(page, objectiveText) {
    const existingCount = await page.locator('#objectives-list .objective-display-item').count();
    await page.locator('#objective-input').fill(objectiveText);
    await page.locator('.add-objective-btn').click();
    await expect(page.locator('#objectives-list .objective-display-item')).toHaveCount(existingCount + 1);
}

async function addLearningObjective(page) {
    await addLearningObjectiveText(page, LEARNING_OBJECTIVE);
}

async function uploadRequiredMaterial(page, buttonIndex, statusLocator, fixturePath) {
    await page.locator('.material-item.required button.upload-btn').nth(buttonIndex).click();
    await expect(page.locator('#upload-modal')).toBeVisible();
    await page.locator('#file-input').setInputFiles(fixturePath);
    await page.locator('#upload-btn').click();

    // AI processing -> topic review section appears
    await expect(page.locator('#topic-review-section')).toBeVisible({ timeout: 120_000 });
    await page.locator('#save-topics-btn').click();

    await expect(page.locator('#upload-modal')).toBeHidden({ timeout: 10_000 });
    await expect(statusLocator).not.toHaveText(/Not Uploaded/i);
}

async function mockFastSuccessfulUploads(page) {
    let uploadCount = 0;

    await page.route('**/api/documents/upload', async route => {
        uploadCount += 1;
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                success: true,
                data: {
                    documentId: `e2e-mocked-upload-${uploadCount}`,
                },
            }),
        });
    });

    await page.route('**/api/courses/*/extract-topics', async route => {
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                success: true,
                data: {
                    topics: [`E2E Mock Topic ${uploadCount}`],
                },
            }),
        });
    });
}

async function addQuestion(page, spec) {
    await page.locator('.add-question-btn').click();
    await expect(page.locator('#question-modal')).toBeVisible();

    await page.locator('#question-type').selectOption(spec.type);
    await page.locator('#question-text').fill(spec.text);

    if (spec.type === 'true-false') {
        await page.locator(`input[name="tf-answer"][value="${spec.answer}"]`).check();
    } else if (spec.type === 'multiple-choice') {
        // The option list starts at just A - Enter inserts the next lettered
        // row right before it can be filled (#524).
        const entries = Object.entries(spec.options);
        for (let i = 0; i < entries.length; i++) {
            if (i > 0) {
                const [prevLetter] = entries[i - 1];
                await page.locator(`.mcq-input[data-option="${prevLetter}"]`).press('Enter');
            }
            const [letter, value] = entries[i];
            await page.locator(`.mcq-input[data-option="${letter}"]`).fill(value);
        }
        await page.locator(`input[name="mcq-correct"][value="${spec.correct}"]`).check();
    } else if (spec.type === 'short-answer') {
        await page.locator('#sa-answer').fill(spec.expected);
    }

    await page.locator('#question-modal button.btn-primary', { hasText: 'Save Question' }).click();
    await expect(page.locator('#question-modal')).toBeHidden({ timeout: 10_000 });
}

async function getOnlyCourseDetail(apiCtx) {
    const coursesRes = await apiCtx.get('/api/courses');
    expect(coursesRes.ok()).toBeTruthy();
    const { data: courses } = await coursesRes.json();
    expect(courses).toHaveLength(1);

    const courseDetailRes = await apiCtx.get(`/api/onboarding/${courses[0].id}`);
    expect(courseDetailRes.ok()).toBeTruthy();
    const detail = await courseDetailRes.json();
    expect(detail.success).toBeTruthy();

    const unit1 = detail.data.lectures.find(lecture => lecture.name === 'Unit 1');
    expect(unit1, 'Expected Unit 1 to exist on the saved course.').toBeTruthy();

    return { course: detail.data, unit1 };
}

/**
 * @param {import('@playwright/test').Locator} locator
 */
async function expectFormControlInvalid(locator) {
    const isValid = await locator.evaluate((field) => {
        if (
            field instanceof HTMLInputElement ||
            field instanceof HTMLSelectElement ||
            field instanceof HTMLTextAreaElement
        ) {
            return field.checkValidity();
        }

        throw new Error('Expected an input, select, or textarea with checkValidity().');
    });

    expect(isValid).toBe(false);
}

function findSavedQuestion(questions, questionText) {
    const question = questions.find(savedQuestion => savedQuestion.question === questionText);
    expect(question, `Expected saved question: "${questionText}"`).toBeTruthy();
    return question;
}

test.describe('instructor onboarding', () => {
    // Diagnostic: serial mode dropped to surface every real failure in one run
    // instead of cascade-skipping after the first failing test. Restore if
    // tests are confirmed to depend on shared cross-test state.

    test.beforeEach(async () => {
        await cleanupSeededCourses();
        await hardDeleteCoursesFor(user.username);
    });

    test.afterEach(async () => {
        await cleanupSeededCourses();
    });

    test('enforces required onboarding validation gates', async ({ page }) => {
        test.setTimeout(90_000);

        await gotoOnboardingStart(page);
        await page.locator('#step-1 button.btn-primary', { hasText: 'Get Started' }).click();
        await expect(page.locator('#step-2.onboarding-step.active')).toBeVisible();

        // Product requirement: course setup must not advance without selecting a course.
        await page.locator('#continue-btn').click();
        await expect(page.locator('#step-2.onboarding-step.active')).toBeVisible();
        await expect(page.locator('#course-select')).toBeFocused();
        await expectFormControlInvalid(page.locator('#course-select'));

        // Product requirement: custom courses must have a course name and valid structure.
        await expect(page.locator('#course-select option[value="custom"]')).toHaveCount(1);
        await page.locator('#course-select').selectOption('custom');
        await page.locator('#weeks-count').fill('1');
        await page.locator('#lectures-per-week').fill('1');
        await page.locator('#course-api-key').fill(VALID_API_KEY);
        await page.locator('#continue-btn').click();
        await expect(page.locator('#step-2.onboarding-step.active')).toBeVisible();
        await expect(page.locator('#custom-course-name').locator('..').locator('.error-message')).toHaveText('Please enter a course name or pick a section above');

        await page.locator('#custom-course-name').fill(COURSE_NAME);
        await page.locator('#weeks-count').fill('0');
        await page.locator('#lectures-per-week').fill('6');
        await page.locator('#continue-btn').click();
        await expect(page.locator('#step-2.onboarding-step.active')).toBeVisible();
        await expectFormControlInvalid(page.locator('#weeks-count'));
        await expectFormControlInvalid(page.locator('#lectures-per-week'));

        await page.locator('#weeks-count').fill('1');
        await page.locator('#lectures-per-week').fill('1');
        await page.locator('#continue-btn').click();
        await expect(page.locator('#step-3.onboarding-step.active')).toBeVisible();
        await expect(page.locator('#substep-objectives.guided-substep.active')).toBeVisible();

        // Product requirement: Unit 1 setup must not continue to materials without a learning objective.
        await page.locator('#substep-objectives button.btn-primary', { hasText: 'Continue to Course Materials' }).click();
        await expect(page.locator('#substep-objectives.guided-substep.active')).toBeVisible();
        await expect(page.getByText('Please add at least one learning objective before continuing.')).toBeVisible();

        await addLearningObjective(page);
        await page.locator('#substep-objectives button.btn-primary', { hasText: 'Continue to Course Materials' }).click();
        await expect(page.locator('#substep-materials.guided-substep.active')).toBeVisible();

        // Product requirement: Unit 1 setup must not continue to questions until both required uploads exist.
        await page.locator('#substep-materials button.btn-primary', { hasText: 'Continue to Probing Questions' }).click();
        await expect(page.locator('#substep-materials.guided-substep.active')).toBeVisible();
        await expect(page.getByText('Please upload required materials (Lecture Notes and Practice Questions) before continuing.')).toBeVisible();

        // Product requirement: question modal must reject incomplete question answers.
        await page.locator('.progress-card[data-substep="questions"]').click();
        await expect(page.locator('#substep-questions.guided-substep.active')).toBeVisible();
        await page.locator('.add-question-btn').click();
        await expect(page.locator('#question-modal')).toBeVisible();
        await page.locator('#question-type').selectOption('multiple-choice');
        await page.locator('#question-text').fill(QUESTIONS.multipleChoice.text);
        await page.locator('.mcq-input[data-option="A"]').fill('Carbohydrates');
        await page.locator('#question-modal button.btn-primary', { hasText: 'Save Question' }).click();
        await expect(page.locator('#question-modal')).toBeVisible();
        await expect(page.getByText('Please provide at least 2 answer options.')).toBeVisible();
    });

    test('resumes an incomplete course instead of creating a duplicate', async ({ page }) => {
        test.setTimeout(60_000);

        await startCustomCourse(page, `${COURSE_NAME} Resume`);
        const apiCtx = await apiContextFromPage(page);
        try {
            const coursesRes = await apiCtx.get('/api/courses');
            expect(coursesRes.ok()).toBeTruthy();
            const { data: coursesAfterCreate } = await coursesRes.json();
            expect(coursesAfterCreate).toHaveLength(1);
            expect(coursesAfterCreate[0].name).toBe(`${COURSE_NAME} Resume`);

            await page.goto('/instructor/home');
            await page.goto('/instructor/onboarding');

            // Product requirement: returning to onboarding with an incomplete course resumes that course.
            await expect(page.locator('#step-3.onboarding-step.active')).toBeVisible();
            await expect(page.locator('#substep-objectives.guided-substep.active')).toBeVisible();

            const coursesAfterResumeRes = await apiCtx.get('/api/courses');
            expect(coursesAfterResumeRes.ok()).toBeTruthy();
            const { data: coursesAfterResume } = await coursesAfterResumeRes.json();
            expect(coursesAfterResume).toHaveLength(1);
            expect(coursesAfterResume[0].id).toBe(coursesAfterCreate[0].id);
        } finally {
            await apiCtx.dispose();
        }
    });

    test('resumes incomplete onboarding at course materials when objectives already exist', async ({ page }) => {
        test.setTimeout(45_000);

        const seededCourse = await seedCourseFor(user.username, {
            courseId: `${SEEDED_COURSE_ID_PREFIX}-resume-materials-${Date.now()}`,
            courseName: `${COURSE_NAME} Resume Materials`,
            learningObjectives: [LEARNING_OBJECTIVE],
        });

        await loginViaUI(page);
        await page.goto('/instructor/onboarding');

        // Product requirement: an incomplete course with objectives but no documents resumes at materials.
        await expect(page.locator('#step-3.onboarding-step.active')).toBeVisible();
        await expect(page.locator('#substep-materials.guided-substep.active')).toBeVisible();

        const apiCtx = await apiContextFromPage(page);
        try {
            const coursesAfterResumeRes = await apiCtx.get('/api/courses');
            expect(coursesAfterResumeRes.ok()).toBeTruthy();
            const { data: coursesAfterResume } = await coursesAfterResumeRes.json();
            expect(coursesAfterResume).toHaveLength(1);
            expect(coursesAfterResume[0].id).toBe(seededCourse.courseId);
        } finally {
            await apiCtx.dispose();
        }
    });

    test('resumes incomplete onboarding at questions when objectives and documents already exist', async ({ page }) => {
        test.setTimeout(45_000);

        const seededCourse = await seedCourseFor(user.username, {
            courseId: `${SEEDED_COURSE_ID_PREFIX}-resume-questions-${Date.now()}`,
            courseName: `${COURSE_NAME} Resume Questions`,
            learningObjectives: [LEARNING_OBJECTIVE],
            documents: SEEDED_DOCUMENTS,
        });

        await loginViaUI(page);
        await page.goto('/instructor/onboarding');

        // Product requirement: an incomplete course with objectives and required documents resumes at questions.
        await expect(page.locator('#step-3.onboarding-step.active')).toBeVisible();
        await expect(page.locator('#substep-questions.guided-substep.active')).toBeVisible();

        const apiCtx = await apiContextFromPage(page);
        try {
            const coursesAfterResumeRes = await apiCtx.get('/api/courses');
            expect(coursesAfterResumeRes.ok()).toBeTruthy();
            const { data: coursesAfterResume } = await coursesAfterResumeRes.json();
            expect(coursesAfterResume).toHaveLength(1);
            expect(coursesAfterResume[0].id).toBe(seededCourse.courseId);
        } finally {
            await apiCtx.dispose();
        }
    });

    test('resumes the requested incomplete course from a direct onboarding courseId URL', async ({ page }) => {
        test.setTimeout(45_000);

        const seededCourse = await seedCourseFor(user.username, {
            courseId: `${SEEDED_COURSE_ID_PREFIX}-direct-courseid-${Date.now()}`,
            courseName: `${COURSE_NAME} Direct CourseId`,
            learningObjectives: [LEARNING_OBJECTIVE],
        });

        await loginViaUI(page);
        await page.goto(`/instructor/onboarding?courseId=${seededCourse.courseId}`);

        // Product requirement: direct onboarding links resume the requested accessible incomplete course.
        await expect(page.locator('#step-3.onboarding-step.active')).toBeVisible();
        await expect(page.locator('#substep-materials.guided-substep.active')).toBeVisible();
    });

    test('does not resume or leak another instructor direct onboarding courseId', async ({ page }) => {
        test.setTimeout(45_000);

        const privateCourse = await seedCourseFor(ownerUser.username, {
            courseId: `${SEEDED_COURSE_ID_PREFIX}-private-courseid-${Date.now()}`,
            courseName: `${COURSE_NAME} Private CourseId`,
            learningObjectives: [LEARNING_OBJECTIVE],
        });

        await loginViaUI(page);
        await page.goto(`/instructor/onboarding?courseId=${privateCourse.courseId}`);

        // Product requirement: a direct courseId URL must not resume or expose a course the instructor cannot access.
        await expect(page.locator('#step-1.onboarding-step.active')).toBeVisible();
        await expect(page.locator('#step-3.onboarding-step.active')).toHaveCount(0);

        await page.locator('#step-1 button.btn-primary', { hasText: 'Get Started' }).click();
        await expect(page.locator('#step-2.onboarding-step.active')).toBeVisible();

        // NOTE: previously this test also asserted that `privateCourse` did not
        // appear in the #course-select dropdown nor in any page text. Those
        // assertions were unsound: /api/courses/available/joinable returns
        // every non-deleted course the current instructor doesn't already own
        // (by design — it powers the "join another instructor's course via
        // code" flow), so a seeded course owned by a different instructor is
        // expected to show up in the dropdown. The assertion happened to pass
        // locally because the user's DB has many courses, the API response is
        // slow enough to lose a race against the test's step transitions, and
        // the dropdown was still empty at assertion time. CI (fresh DB, fast
        // response) exposed the latent race. The valuable invariant here is
        // already covered above: visiting ?courseId=X for a course the
        // instructor cannot access must not auto-resume them into step 3.
    });

    test('persists reviewed topic removals and manual additions', async ({ page }) => {
        test.setTimeout(120_000);

        const removedTopic = 'E2E Remove Me';
        const keptTopic = 'E2E Keep Me';
        const manualTopic = 'E2E Manual Topic';

        await page.route('**/api/courses/*/extract-topics', async route => {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    success: true,
                    data: {
                        courseId: 'mocked-course-id',
                        topics: [removedTopic, keptTopic],
                    },
                }),
            });
        });

        await startCustomCourse(page, `${COURSE_NAME} Topics`);
        await addLearningObjective(page);
        await page.locator('#substep-objectives button.btn-primary', { hasText: 'Continue to Course Materials' }).click();
        await expect(page.locator('#substep-materials.guided-substep.active')).toBeVisible();

        await page.locator('.material-item.required button.upload-btn').first().click();
        await expect(page.locator('#upload-modal')).toBeVisible();
        await page.locator('#file-input').setInputFiles(LECTURE_FIXTURE);
        await page.locator('#upload-btn').click();
        await expect(page.locator('#topic-review-section')).toBeVisible({ timeout: 120_000 });
        await expect(page.locator('#upload-topic-review-list .topic-review-item')).toHaveCount(2);

        // Product requirement: removing a detected topic keeps it out of the saved approved-topic list.
        await expect(page.locator('#upload-topic-review-list .topic-review-input').first()).toHaveValue(removedTopic);
        await page.locator('#upload-topic-review-list .topic-review-remove').first().click();
        await expect(page.locator('#upload-topic-review-list .topic-review-input').first()).toHaveValue(keptTopic);

        // Product requirement: manually added topics are persisted when Save Topics is clicked.
        await page.locator('#upload-topic-new-input').fill(manualTopic);
        await page.locator('#upload-topic-add-btn').click();
        await page.locator('#save-topics-btn').click();
        await expect(page.locator('#upload-modal')).toBeHidden({ timeout: 10_000 });

        const apiCtx = await apiContextFromPage(page);
        try {
            const coursesRes = await apiCtx.get('/api/courses');
            const { data: courses } = await coursesRes.json();
            expect(courses).toHaveLength(1);

            const approvedTopicsRes = await apiCtx.get(`/api/courses/${courses[0].id}/approved-topics`);
            expect(approvedTopicsRes.ok()).toBeTruthy();
            const approvedTopics = await approvedTopicsRes.json();
            expect(approvedTopics.success).toBeTruthy();
            expect(approvedTopics.data.topicLabels).toContain(keptTopic);
            expect(approvedTopics.data.topicLabels).toContain(manualTopic);
            expect(approvedTopics.data.topicLabels).not.toContain(removedTopic);
        } finally {
            await apiCtx.dispose();
        }
    });

    test('keeps required upload unset when no upload content is provided', async ({ page }) => {
        test.setTimeout(60_000);

        await startCustomCourse(page, `${COURSE_NAME} Empty Upload`);
        await addLearningObjective(page);
        await page.locator('#substep-objectives button.btn-primary', { hasText: 'Continue to Course Materials' }).click();
        await expect(page.locator('#substep-materials.guided-substep.active')).toBeVisible();

        await page.locator('.material-item.required button.upload-btn').first().click();
        await expect(page.locator('#upload-modal')).toBeVisible();
        await page.locator('#upload-btn').click();

        // Product requirement: an empty upload attempt stays in the modal and does not mark the material uploaded.
        await expect(page.locator('#upload-modal')).toBeVisible();
        await expect(page.locator('#lecture-status')).toHaveText(/Not Uploaded/i);
        await expect(page.getByText('Please provide content via file upload or direct text input')).toBeVisible();
    });

    test('keeps required upload unset when the upload API fails', async ({ page }) => {
        test.setTimeout(60_000);

        await page.route('**/api/documents/upload', async route => {
            await route.fulfill({
                status: 500,
                contentType: 'application/json',
                body: JSON.stringify({
                    success: false,
                    message: 'E2E forced upload failure',
                }),
            });
        });

        await startCustomCourse(page, `${COURSE_NAME} Upload Failure`);
        await addLearningObjective(page);
        await page.locator('#substep-objectives button.btn-primary', { hasText: 'Continue to Course Materials' }).click();
        await expect(page.locator('#substep-materials.guided-substep.active')).toBeVisible();

        await page.locator('.material-item.required button.upload-btn').first().click();
        await expect(page.locator('#upload-modal')).toBeVisible();
        await page.locator('#file-input').setInputFiles(LECTURE_FIXTURE);
        await page.locator('#upload-btn').click();

        // Product requirement: upload failures restore the form and do not mark the material uploaded.
        await expect(page.locator('#upload-modal')).toBeVisible();
        await expect(page.locator('#upload-section')).toBeVisible();
        await expect(page.locator('#upload-loading-indicator')).toBeHidden();
        await expect(page.locator('#lecture-status')).toHaveText(/Not Uploaded/i);
        await expect(page.getByText(/Error uploading content:/)).toBeVisible();
    });

    test('does not complete onboarding without at least one assessment question', async ({ page }) => {
        test.setTimeout(90_000);

        await mockFastSuccessfulUploads(page);
        await startCustomCourse(page, `${COURSE_NAME} No Questions`);
        await addLearningObjective(page);
        await page.locator('#substep-objectives button.btn-primary', { hasText: 'Continue to Course Materials' }).click();
        await expect(page.locator('#substep-materials.guided-substep.active')).toBeVisible();

        await uploadRequiredMaterial(page, 0, page.locator('#lecture-status'), LECTURE_FIXTURE);
        await uploadRequiredMaterial(page, 1, page.locator('#practice-status'), PRACTICE_FIXTURE);
        await page.locator('#substep-materials button.btn-primary', { hasText: 'Continue to Probing Questions' }).click();
        await expect(page.locator('#substep-questions.guided-substep.active')).toBeVisible();

        await page.locator('#substep-questions button.btn-primary', { hasText: 'Complete Unit 1 & Continue' }).click();

        // Product requirement: final completion is blocked until at least one assessment question exists.
        await expect(page.locator('#substep-questions.guided-substep.active')).toBeVisible();
        await expect(page).toHaveURL(/\/instructor\/onboarding/);
        await expect(page.getByText('Please add at least one assessment question before continuing.')).toBeVisible();

        const apiCtx = await apiContextFromPage(page);
        try {
            const coursesRes = await apiCtx.get('/api/courses');
            expect(coursesRes.ok()).toBeTruthy();
            const { data: courses } = await coursesRes.json();
            expect(courses).toHaveLength(1);

            const courseDetailRes = await apiCtx.get(`/api/onboarding/${courses[0].id}`);
            expect(courseDetailRes.ok()).toBeTruthy();
            const detail = await courseDetailRes.json();
            expect(detail.success).toBeTruthy();
            expect(detail.data.isOnboardingComplete).toBe(false);
        } finally {
            await apiCtx.dispose();
        }
    });

    test('preserves in-progress onboarding state across refresh and browser back', async ({ page }) => {
        test.setTimeout(150_000);

        await page.route('**/api/courses/*/extract-topics', async route => {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    success: true,
                    data: {
                        topics: ['E2E Refresh Persistence Topic'],
                    },
                }),
            });
        });

        await startCustomCourse(page, `${COURSE_NAME} Refresh Persistence`);
        await addLearningObjective(page);
        await page.locator('#substep-objectives button.btn-primary', { hasText: 'Continue to Course Materials' }).click();
        await expect(page.locator('#substep-materials.guided-substep.active')).toBeVisible();

        await page.reload();

        // Product requirement: refreshing after objectives are entered keeps the objective and resumes at materials.
        await expect(page.locator('#step-3.onboarding-step.active')).toBeVisible();
        await expect(page.locator('#substep-materials.guided-substep.active')).toBeVisible();
        await expect(page.locator('#objectives-list .objective-text')).toHaveText([LEARNING_OBJECTIVE]);

        await uploadRequiredMaterial(page, 0, page.locator('#lecture-status'), LECTURE_FIXTURE);
        await page.reload();

        // Product requirement: a partial upload survives refresh without pretending both required uploads exist.
        await expect(page.locator('#step-3.onboarding-step.active')).toBeVisible();
        await expect(page.locator('#substep-materials.guided-substep.active')).toBeVisible();
        await expect(page.locator('#lecture-status')).not.toHaveText(/Not Uploaded/i);
        await expect(page.locator('#practice-status')).toHaveText(/Not Uploaded/i);

        await uploadRequiredMaterial(page, 1, page.locator('#practice-status'), PRACTICE_FIXTURE);
        await page.locator('#substep-materials button.btn-primary', { hasText: 'Continue to Probing Questions' }).click();
        await expect(page.locator('#substep-questions.guided-substep.active')).toBeVisible();
        await addQuestion(page, QUESTIONS.trueFalse);
        await expect(page.locator('#assessment-questions-onboarding .question-item')).toHaveCount(1);
        await expect(page.locator('#assessment-questions-onboarding')).toContainText(QUESTIONS.trueFalse.text);

        await page.goto('/instructor/home');
        await page.goBack();

        // Product requirement: leaving and coming back before completion does not lose created questions.
        await expect(page.locator('#step-3.onboarding-step.active')).toBeVisible();
        await expect(page.locator('#substep-questions.guided-substep.active')).toBeVisible();
        await expect(page.locator('#assessment-questions-onboarding .question-item')).toHaveCount(1);
        await expect(page.locator('#assessment-questions-onboarding')).toContainText(QUESTIONS.trueFalse.text);

        const apiCtx = await apiContextFromPage(page);
        try {
            const coursesRes = await apiCtx.get('/api/courses');
            expect(coursesRes.ok()).toBeTruthy();
            const { data: courses } = await coursesRes.json();
            expect(courses).toHaveLength(1);
            expect(courses[0].name).toBe(`${COURSE_NAME} Refresh Persistence`);
        } finally {
            await apiCtx.dispose();
        }
    });

    test('does not persist removed objectives or questions when completing onboarding', async ({ page }) => {
        test.setTimeout(120_000);

        page.on('dialog', dialog => dialog.accept());
        await mockFastSuccessfulUploads(page);

        await startCustomCourse(page, `${COURSE_NAME} Removed Data`);
        await addLearningObjectiveText(page, REMOVED_LEARNING_OBJECTIVE);
        await addLearningObjectiveText(page, SECOND_LEARNING_OBJECTIVE);

        // Product requirement: objectives removed before final completion are absent from the saved course.
        await page.locator('#objectives-list .objective-display-item', { hasText: REMOVED_LEARNING_OBJECTIVE })
            .locator('.remove-objective')
            .click();
        await expect(page.locator('#objectives-list')).not.toContainText(REMOVED_LEARNING_OBJECTIVE);
        await expect(page.locator('#objectives-list')).toContainText(SECOND_LEARNING_OBJECTIVE);

        await page.locator('#substep-objectives button.btn-primary', { hasText: 'Continue to Course Materials' }).click();
        await expect(page.locator('#substep-materials.guided-substep.active')).toBeVisible();
        await uploadRequiredMaterial(page, 0, page.locator('#lecture-status'), LECTURE_FIXTURE);
        await uploadRequiredMaterial(page, 1, page.locator('#practice-status'), PRACTICE_FIXTURE);
        await page.locator('#substep-materials button.btn-primary', { hasText: 'Continue to Probing Questions' }).click();
        await expect(page.locator('#substep-questions.guided-substep.active')).toBeVisible();

        await addQuestion(page, QUESTIONS.trueFalse);
        await addQuestion(page, QUESTIONS.shortAnswer);

        // Product requirement: questions removed before final completion are absent from the saved course.
        await page.locator('#assessment-questions-onboarding .question-item', { hasText: QUESTIONS.trueFalse.text })
            .locator('.delete-question-btn')
            .click();
        await expect(page.locator('#assessment-questions-onboarding')).not.toContainText(QUESTIONS.trueFalse.text);
        await expect(page.locator('#assessment-questions-onboarding')).toContainText(QUESTIONS.shortAnswer.text);

        await page.locator('#substep-questions button.btn-primary', { hasText: 'Complete Unit 1 & Continue' }).click();
        await page.waitForURL(url => !url.pathname.includes('/onboarding'), { timeout: 30_000 });

        const apiCtx = await apiContextFromPage(page);
        try {
            const { course, unit1 } = await getOnlyCourseDetail(apiCtx);
            expect(course.isOnboardingComplete).toBe(true);
            expect(unit1.learningObjectives).toContain(SECOND_LEARNING_OBJECTIVE);
            expect(unit1.learningObjectives).not.toContain(REMOVED_LEARNING_OBJECTIVE);
            expect(unit1.assessmentQuestions.map(question => question.question)).toContain(QUESTIONS.shortAnswer.text);
            expect(unit1.assessmentQuestions.map(question => question.question)).not.toContain(QUESTIONS.trueFalse.text);
        } finally {
            await apiCtx.dispose();
        }
    });

    test('keeps the question modal open for invalid assessment questions', async ({ page }) => {
        test.setTimeout(90_000);

        async function expectInvalidQuestionSubmission(setupForm, expectedMessage) {
            // Dismiss any lingering error notifications from a prior iteration —
            // they share text with later iterations (e.g. "Please select the
            // correct answer." fires for both MCQ-no-correct and TF-no-selection).
            await page.evaluate(() => {
                document.querySelectorAll('.notification.error').forEach((n) => n.remove());
            });

            await page.locator('.add-question-btn').click();
            await expect(page.locator('#question-modal')).toBeVisible();
            await setupForm();
            await page.locator('#question-modal button.btn-primary', { hasText: 'Save Question' }).click();

            // Product requirement: invalid question submissions stay editable and add no question.
            await expect(page.locator('#question-modal')).toBeVisible();
            await expect(page.locator('.notification.error', { hasText: expectedMessage })).toBeVisible();
            await expect(page.locator('#assessment-questions-onboarding .question-item')).toHaveCount(0);
            await page.locator('#question-modal .modal-close').click();
            await expect(page.locator('#question-modal')).toBeHidden();
        }

        await startCustomCourse(page, `${COURSE_NAME} Question Validation`);
        await page.locator('.progress-card[data-substep="questions"]').click();
        await expect(page.locator('#substep-questions.guided-substep.active')).toBeVisible();

        await expectInvalidQuestionSubmission(async () => {
            await page.locator('#question-type').selectOption('true-false');
            await page.locator('input[name="tf-answer"][value="true"]').check();
        }, 'Please enter a question.');

        await expectInvalidQuestionSubmission(async () => {
            await page.locator('#question-type').selectOption('multiple-choice');
            await page.locator('#question-text').fill(QUESTIONS.multipleChoice.text);
            await page.locator('.mcq-input[data-option="A"]').fill('Carbohydrates');
            await page.locator('input[name="mcq-correct"][value="A"]').check();
        }, 'Please provide at least 2 answer options.');

        await expectInvalidQuestionSubmission(async () => {
            await page.locator('#question-type').selectOption('multiple-choice');
            await page.locator('#question-text').fill(QUESTIONS.multipleChoice.text);
            // The option list starts at just A - Enter inserts option B (#524).
            await page.locator('.mcq-input[data-option="A"]').fill('Carbohydrates');
            await page.locator('.mcq-input[data-option="A"]').press('Enter');
            await page.locator('.mcq-input[data-option="B"]').fill('Lipids');
        }, 'Please select the correct answer.');

        await expectInvalidQuestionSubmission(async () => {
            await page.locator('#question-type').selectOption('true-false');
            await page.locator('#question-text').fill(QUESTIONS.trueFalse.text);
        }, 'Please select the correct answer.');

        await expectInvalidQuestionSubmission(async () => {
            await page.locator('#question-type').selectOption('short-answer');
            await page.locator('#question-text').fill(QUESTIONS.shortAnswer.text);
        }, 'Please provide the expected answer or key points.');
    });

    test('blocks impossible pass thresholds before completing onboarding', async ({ page }) => {
        test.setTimeout(120_000);

        await mockFastSuccessfulUploads(page);
        await startCustomCourse(page, `${COURSE_NAME} Threshold Validation`);
        await addLearningObjective(page);
        await page.locator('#substep-objectives button.btn-primary', { hasText: 'Continue to Course Materials' }).click();
        await expect(page.locator('#substep-materials.guided-substep.active')).toBeVisible();
        await uploadRequiredMaterial(page, 0, page.locator('#lecture-status'), LECTURE_FIXTURE);
        await uploadRequiredMaterial(page, 1, page.locator('#practice-status'), PRACTICE_FIXTURE);
        await page.locator('#substep-materials button.btn-primary', { hasText: 'Continue to Probing Questions' }).click();
        await expect(page.locator('#substep-questions.guided-substep.active')).toBeVisible();
        await addQuestion(page, QUESTIONS.trueFalse);

        await page.locator('#pass-threshold-onboarding').fill('11');
        await page.locator('#substep-questions button.btn-primary', { hasText: 'Complete Unit 1 & Continue' }).click();

        // Product requirement: threshold cannot exceed the number of questions and cannot be persisted as complete.
        await expect(page.locator('#substep-questions.guided-substep.active')).toBeVisible();
        await expect(page).toHaveURL(/\/instructor\/onboarding/);
        await expect(page.getByText('Pass threshold cannot exceed the number of assessment questions.')).toBeVisible();

        const apiCtx = await apiContextFromPage(page);
        try {
            const { course, unit1 } = await getOnlyCourseDetail(apiCtx);
            expect(course.isOnboardingComplete).toBe(false);
            expect(unit1.passThreshold).not.toBe(11);
        } finally {
            await apiCtx.dispose();
        }
    });

    test('attaches repeated lecture-notes uploads as independently named documents', async ({ page }) => {
        test.setTimeout(150_000);

        await page.route('**/api/courses/*/extract-topics', async route => {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    success: true,
                    data: {
                        topics: ['E2E Replacement Topic'],
                    },
                }),
            });
        });

        await startCustomCourse(page, `${COURSE_NAME} Repeated Lecture Uploads`);
        await addLearningObjective(page);
        await page.locator('#substep-objectives button.btn-primary', { hasText: 'Continue to Course Materials' }).click();
        await expect(page.locator('#substep-materials.guided-substep.active')).toBeVisible();

        await uploadRequiredMaterial(page, 0, page.locator('#lecture-status'), LECTURE_FIXTURE);
        await uploadRequiredMaterial(page, 0, page.locator('#lecture-status'), PRACTICE_FIXTURE);

        const apiCtx = await apiContextFromPage(page);
        try {
            const { unit1 } = await getOnlyCourseDetail(apiCtx);
            const lectureDocuments = unit1.documents.filter(document => document.documentType === 'lecture-notes');

            expect(lectureDocuments).toHaveLength(2);
            expect(lectureDocuments.map(document => document.title).sort()).toEqual([
                path.basename(LECTURE_FIXTURE),
                path.basename(PRACTICE_FIXTURE),
            ].sort());
            expect(lectureDocuments.every(document => document.documentId)).toBe(true);
        } finally {
            await apiCtx.dispose();
        }
    });

    test('joins an existing course only with a valid instructor code', async ({ page }) => {
        test.setTimeout(90_000);

        const instructorCourseCode = 'JOIN42';
        const joinableCourse = await seedCourseFor(ownerUser.username, {
            courseId: `${JOINABLE_COURSE_ID_PREFIX}-${Date.now()}`,
            courseName: `${COURSE_NAME} Joinable`,
            instructorCourseCode,
            isOnboardingComplete: true,
            learningObjectives: [LEARNING_OBJECTIVE],
        });

        await gotoOnboardingStart(page);
        await page.locator('#step-1 button.btn-primary', { hasText: 'Get Started' }).click();
        await expect(page.locator('#step-2.onboarding-step.active')).toBeVisible();
        await expect(page.locator(`#course-select option[value="${joinableCourse.courseId}"]`)).toHaveCount(1);
        await page.locator('#course-select').selectOption(joinableCourse.courseId);
        await expect(page.locator('#join-course-btn')).toBeVisible();
        await expect(page.locator('#instructor-course-code-group')).toBeVisible();

        // Product requirement: invalid instructor course codes are rejected and keep the instructor on onboarding.
        await page.locator('#instructor-course-code').fill('WRONG1');
        await page.locator('#join-course-btn').click();
        await expect(page.locator('#instructor-course-code-error')).toContainText(/invalid instructor course code/i);
        await expect(page.locator('#step-2.onboarding-step.active')).toBeVisible();

        // Product requirement: a valid instructor course code grants instructor access and redirects to the joined course.
        await page.locator('#instructor-course-code').fill(instructorCourseCode);
        await page.locator('#join-course-btn').click();
        await page.waitForURL(url =>
            url.pathname === '/instructor/documents' &&
            url.searchParams.get('courseId') === joinableCourse.courseId,
        { timeout: 10_000 });

        await withDb(async (db) => {
            const freshInstructor = await getTestUserDoc(db, user.username);
            const joinedCourse = await db.collection('courses').findOne({ courseId: joinableCourse.courseId });
            expect(joinedCourse.instructors).toContain(freshInstructor.userId);
            expect(joinedCourse.isOnboardingComplete).toBe(true);
        });
    });

    test('completes the full onboarding flow end-to-end', async ({ page }) => {
        test.setTimeout(180_000);

        // Auto-accept any "replace existing content" confirms triggered by re-uploads.
        page.on('dialog', dialog => dialog.accept());

        // The onboarding flow calls /api/courses/:courseId/extract-topics
        // after materials are uploaded. With the LLM stub the route otherwise
        // gets `{}` and returns zero approved topics, which fails the final
        // assertion that approved-topics is non-empty. Match the extraction
        // system prompt and script a small topic list.
        const apiForStub = await request.newContext();
        try {
            await resetLlmStub(apiForStub);
            await addLlmStubRule(apiForStub, {
                matchSystemPrompt: 'biochemistry topic labels only',
                content: JSON.stringify({
                    topics: ['DNA structure', 'DNA replication', 'Cell membrane transport'],
                }),
            });
        } finally {
            await apiForStub.dispose();
        }

        await loginViaUI(page);
        await page.goto('/instructor/onboarding');

        // Step 1 — Welcome
        await expect(page.locator('#step-1.onboarding-step.active')).toBeVisible();
        await page.locator('#step-1 button.btn-primary', { hasText: 'Get Started' }).click();

        // Step 2 — Course Setup (custom course, 1 week, 1 lecture/week)
        await expect(page.locator('#step-2.onboarding-step.active')).toBeVisible();
        await page.locator('#course-select').selectOption('custom');
        await page.locator('#custom-course-name').fill(COURSE_NAME);
        await page.locator('#course-api-key').fill(VALID_API_KEY);
        await page.locator('#weeks-count').fill('1');
        await page.locator('#lectures-per-week').fill('1');
        await page.locator('#continue-btn').click();

        // Step 3 — Unit 1 Setup
        await expect(page.locator('#step-3.onboarding-step.active')).toBeVisible();

        // 3a — Learning Objectives
        await expect(page.locator('#substep-objectives.guided-substep.active')).toBeVisible();
        await page.locator('#objective-input').fill(LEARNING_OBJECTIVE);
        await page.locator('.add-objective-btn').click();
        await expect(page.locator('#objectives-list .objective-display-item')).toHaveCount(1);
        await page.locator('#substep-objectives button.btn-primary', { hasText: 'Continue to Course Materials' }).click();

        // 3b — Course Materials: upload BOTH lecture notes and practice questions
        // (the finalize step validates that both required materials have been uploaded)
        await expect(page.locator('#substep-materials.guided-substep.active')).toBeVisible();

        await uploadRequiredMaterial(page, 0, page.locator('#lecture-status'), LECTURE_FIXTURE);
        await uploadRequiredMaterial(page, 1, page.locator('#practice-status'), PRACTICE_FIXTURE);

        await page.locator('#substep-materials button.btn-primary', { hasText: 'Continue to Probing Questions' }).click();

        // 3c — Assessment Questions: one of each supported type
        await expect(page.locator('#substep-questions.guided-substep.active')).toBeVisible();

        await addQuestion(page, QUESTIONS.trueFalse);
        await addQuestion(page, QUESTIONS.multipleChoice);
        await addQuestion(page, QUESTIONS.shortAnswer);

        // Finalize — completeUnit1Setup() saves data then redirects to the course
        // upload page after a short notification delay, so we wait for the URL change.
        await page.locator('#substep-questions button.btn-primary', { hasText: 'Complete Unit 1 & Continue' }).click();
        await page.waitForURL(url => !url.pathname.includes('/onboarding'), { timeout: 30_000 });

        // API truth — the instructor now has exactly one course, and it's marked complete
        const apiCtx = await apiContextFromPage(page);
        const coursesRes = await apiCtx.get('/api/courses');
        expect(coursesRes.ok()).toBeTruthy();
        const { data: courses } = await coursesRes.json();
        expect(courses).toHaveLength(1);
        expect(courses[0].name).toBe(COURSE_NAME);

        const courseDetailRes = await apiCtx.get(`/api/onboarding/${courses[0].id}`);
        expect(courseDetailRes.ok()).toBeTruthy();
        const detail = await courseDetailRes.json();
        expect(detail.success).toBeTruthy();
        const course = detail.data;
        expect(course && course.isOnboardingComplete).toBe(true);
        expect(course.courseName).toBe(COURSE_NAME);
        expect(course.courseStructure).toMatchObject({
            weeks: 1,
            lecturesPerWeek: 1,
            totalUnits: 1,
        });
        expect(course.lectures).toHaveLength(1);

        const unit1 = course.lectures[0];
        expect(unit1.name).toBe('Unit 1');
        expect(unit1.learningObjectives).toContain(LEARNING_OBJECTIVE);

        expect(unit1.documents).toHaveLength(2);
        const documentTypes = unit1.documents.map(document => document.documentType).sort();
        expect(documentTypes).toEqual(['lecture-notes', 'practice-quiz']);

        expect(unit1.assessmentQuestions).toHaveLength(3);
        const savedTrueFalse = findSavedQuestion(unit1.assessmentQuestions, QUESTIONS.trueFalse.text);
        expect(savedTrueFalse.questionType).toBe('true-false');
        // True/false answers are now stored as booleans (see scripts/migrate-question-schema.js).
        expect(savedTrueFalse.correctAnswer).toBe(true);

        const savedMultipleChoice = findSavedQuestion(unit1.assessmentQuestions, QUESTIONS.multipleChoice.text);
        expect(savedMultipleChoice.questionType).toBe('multiple-choice');
        // Multiple-choice options are stored as an ordered array with a numeric answer index.
        expect(savedMultipleChoice.options).toEqual(Object.values(QUESTIONS.multipleChoice.options));
        expect(savedMultipleChoice.correctAnswer).toBe(
            Object.keys(QUESTIONS.multipleChoice.options).indexOf(QUESTIONS.multipleChoice.correct)
        );

        const savedShortAnswer = findSavedQuestion(unit1.assessmentQuestions, QUESTIONS.shortAnswer.text);
        expect(savedShortAnswer.questionType).toBe('short-answer');
        expect(savedShortAnswer.correctAnswer).toBe(QUESTIONS.shortAnswer.expected);

        const approvedTopicsRes = await apiCtx.get(`/api/courses/${courses[0].id}/approved-topics`);
        expect(approvedTopicsRes.ok()).toBeTruthy();
        const approvedTopics = await approvedTopicsRes.json();
        expect(approvedTopics.success).toBeTruthy();
        expect(approvedTopics.data.topics.length).toBeGreaterThan(0);
        expect(approvedTopics.data.topicLabels.length).toBeGreaterThan(0);
        expect(approvedTopics.data.topicLabels.every(topic => topic.trim().length > 0)).toBe(true);

        await apiCtx.dispose();
    });
});

// Lifted out of the serial-mode describe above so its (potentially real)
// failure does not cascade-skip the rest of the suite. See FINDINGS if this
// stays failing — it may indicate the completed-onboarding redirect is not
// happening at /instructor/onboarding.
test.describe('instructor onboarding — isolated redirects', () => {
    test.beforeEach(async () => {
        await cleanupSeededCourses();
        await hardDeleteCoursesFor(user.username);
    });

    test.afterEach(async () => {
        await cleanupSeededCourses();
    });

    test('redirects completed instructors away from onboarding', async ({ page }) => {
        test.setTimeout(30_000);

        const completedCourse = await seedCourseFor(user.username, {
            courseId: `${SEEDED_COURSE_ID_PREFIX}-complete-${Date.now()}`,
            courseName: `${COURSE_NAME} Completed Redirect`,
            isOnboardingComplete: true,
            learningObjectives: [LEARNING_OBJECTIVE],
        });

        await loginViaUI(page);
        await page.goto('/instructor/onboarding');

        // Product requirement: instructors with completed onboarding cannot restart onboarding as a fresh flow.
        await page.waitForURL(url =>
            url.pathname === '/instructor/documents' &&
            url.searchParams.get('courseId') === completedCourse.courseId,
        { timeout: 10_000 });
    });
});
