// @ts-check
require('dotenv').config();
const { MongoClient } = require('mongodb');
const { test, expect } = require('./fixtures/monocart');
const { TEST_USERS, loadCredentials } = require('./helpers/users');

const user = TEST_USERS.instructor;
const COURSE_ID = 'BIOC-E2E-INSTRUCTOR';
const COURSE_NAME = 'BIOC E2E Instructor Test';

let password;

test.beforeAll(() => {
    password = loadCredentials().instructor;
    if (!password) {
        throw new Error('No credentials.instructor found. Global-setup should have generated it.');
    }
});

async function withDb(fn) {
    if (!process.env.MONGO_URI) {
        throw new Error('MONGO_URI not set; cannot run instructor.js tests.');
    }
    const client = new MongoClient(process.env.MONGO_URI);
    await client.connect();
    try {
        return await fn(client.db());
    } finally {
        await client.close();
    }
}

async function getInstructorUserId() {
    return withDb(async (db) => {
        const u = await db.collection('users').findOne({ username: user.username });
        if (!u) throw new Error(`User ${user.username} not found in DB.`);
        return u.userId;
    });
}

async function seedCourse() {
    const userId = await getInstructorUserId();
    await withDb(async (db) => {
        await db.collection('courses').deleteMany({ instructorId: userId });
        const now = new Date();
        await db.collection('courses').insertOne({
            courseId: COURSE_ID,
            courseName: COURSE_NAME,
            courseCode: 'E2ESTU',
            instructorCourseCode: 'E2EINS',
            instructorId: userId,
            instructors: [userId],
            tas: [],
            courseDescription: '',
            assessmentCriteria: '',
            courseMaterials: [],
            approvedStruggleTopics: [],
            courseStructure: { weeks: 2, lecturesPerWeek: 1, totalUnits: 2 },
            isOnboardingComplete: true,
            status: 'active',
            lectures: [
                {
                    name: 'Unit 1',
                    isPublished: false,
                    learningObjectives: ['Sample objective'],
                    passThreshold: 0,
                    createdAt: now,
                    updatedAt: now,
                    documents: [],
                    assessmentQuestions: [],
                },
                {
                    name: 'Unit 2',
                    isPublished: false,
                    learningObjectives: [],
                    passThreshold: 0,
                    createdAt: now,
                    updatedAt: now,
                    documents: [],
                    assessmentQuestions: [],
                },
            ],
            createdAt: now,
            updatedAt: now,
        });
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

async function gotoCoursePage(page) {
    await page.goto(`/instructor/documents?courseId=${COURSE_ID}`);
    await expect(page.locator('#course-title')).toHaveText(COURSE_NAME, { timeout: 15_000 });
}

test.describe('instructor course management', () => {
    // Each test reseeds the course in beforeEach, so tests are independent.
    // Default mode (not serial) lets one failure not halt the others —
    // important when multiple tests assert independent behaviors that
    // each surface their own bug.

    test.beforeEach(async () => {
        await seedCourse();
        await withDb((db) => db.collection('flashcardDecks').deleteMany({ courseId: COURSE_ID }));
    });

    test('course page renders with title and seeded units', async ({ page }) => {
        await loginViaUI(page);
        await gotoCoursePage(page);

        // Two seeded units should be present in the dynamic container
        const unitContainer = page.locator('#dynamic-units-container');
        await expect(unitContainer).toContainText('Unit 1');
        await expect(unitContainer).toContainText('Unit 2');
    });

    test('instructor can add a new unit', async ({ page }) => {
        await loginViaUI(page);
        await gotoCoursePage(page);

        // Sanity: starting with 2 units
        const unitContainer = page.locator('#dynamic-units-container');
        await expect(unitContainer).toContainText('Unit 1');
        await expect(unitContainer).toContainText('Unit 2');

        await page.locator('#add-unit-btn').click();

        // Wait for the new unit to appear by name
        await expect(unitContainer).toContainText('Unit 3', { timeout: 15_000 });

        // DB truth — the course now has three lectures
        const courseAfter = await withDb((db) =>
            db.collection('courses').findOne({ courseId: COURSE_ID })
        );
        expect(courseAfter.lectures).toHaveLength(3);
        expect(courseAfter.lectures.map((l) => l.name)).toEqual(['Unit 1', 'Unit 2', 'Unit 3']);
    });

    test('instructor can add an assessment question to a unit', async ({ page }) => {
        await loginViaUI(page);
        await gotoCoursePage(page);

        // Open the first unit's question modal via its add-question button.
        // The button is inside the accordion; we may need to expand the unit first.
        const firstAddQuestionBtn = page.locator('.add-question-btn').first();
        if (!(await firstAddQuestionBtn.isVisible())) {
            // Expand Unit 1 by clicking its accordion header
            await page.locator('#dynamic-units-container').getByText('Unit 1', { exact: false }).first().click();
        }
        await firstAddQuestionBtn.click();

        await expect(page.locator('#question-modal')).toBeVisible();
        await page.locator('#question-type').selectOption('true-false');
        await page.locator('#question-text').fill('Sample E2E true/false question.');
        await page.locator('input[name="tf-answer"][value="true"]').check();
        await page.locator('#question-modal button.btn-primary', { hasText: 'Save Question' }).click();
        await expect(page.locator('#question-modal')).toBeHidden({ timeout: 10_000 });

        // DB truth — Unit 1 now has one TF assessment question
        const courseAfter = await withDb((db) =>
            db.collection('courses').findOne({ courseId: COURSE_ID })
        );
        const unit1 = courseAfter.lectures.find((l) => l.name === 'Unit 1');
        expect(unit1.assessmentQuestions).toHaveLength(1);
        expect(unit1.assessmentQuestions[0].questionType).toBe('true-false');
        // Asserts the SHAPE we want stored — boolean. instructor.js currently stores
        // the string "true" (see tests/e2e/FINDINGS.md). Test will fail until fixed.
        expect(unit1.assessmentQuestions[0].correctAnswer).toBe(true);
    });

    test('instructor can add a multiple-choice question to a unit', async ({ page }) => {
        await loginViaUI(page);
        await gotoCoursePage(page);

        await page.locator('.add-question-btn').first().click();
        await expect(page.locator('#question-modal')).toBeVisible();

        await page.locator('#question-type').selectOption('multiple-choice');
        await page.locator('#question-text').fill('Which is NOT a biomolecule class?');
        // The option list starts at just A - Enter inserts the next lettered
        // row (#524) before each can be filled.
        await page.locator('.mcq-input[data-option="A"]').fill('Carbohydrates');
        await page.locator('.mcq-input[data-option="A"]').press('Enter');
        await page.locator('.mcq-input[data-option="B"]').fill('Lipids');
        await page.locator('.mcq-input[data-option="B"]').press('Enter');
        await page.locator('.mcq-input[data-option="C"]').fill('Minerals');
        await page.locator('.mcq-input[data-option="C"]').press('Enter');
        await page.locator('.mcq-input[data-option="D"]').fill('Nucleic acids');
        await page.locator('input[name="mcq-correct"][value="C"]').check();
        await page.locator('#question-modal button.btn-primary', { hasText: 'Save Question' }).click();
        await expect(page.locator('#question-modal')).toBeHidden({ timeout: 10_000 });

        const courseAfter = await withDb((db) =>
            db.collection('courses').findOne({ courseId: COURSE_ID })
        );
        const unit1 = courseAfter.lectures.find((l) => l.name === 'Unit 1');
        expect(unit1.assessmentQuestions).toHaveLength(1);
        const q = unit1.assessmentQuestions[0];
        expect(q.questionType).toBe('multiple-choice');
        // Asserts the SHAPE we want stored — array of option text + numeric index.
        // instructor.js currently stores options as {A,B,C,D} object and correctAnswer
        // as the letter string (see tests/e2e/FINDINGS.md). Test will fail until fixed.
        expect(q.options).toEqual(['Carbohydrates', 'Lipids', 'Minerals', 'Nucleic acids']);
        expect(q.correctAnswer).toBe(2);
    });

    test('instructor can add a short-answer question to a unit', async ({ page }) => {
        await loginViaUI(page);
        await gotoCoursePage(page);

        await page.locator('.add-question-btn').first().click();
        await expect(page.locator('#question-modal')).toBeVisible();

        await page.locator('#question-type').selectOption('short-answer');
        await page.locator('#question-text').fill('Name the bond between amino acids.');
        const expected = 'Peptide bond, formed via condensation.';
        await page.locator('#sa-answer').fill(expected);
        await page.locator('#question-modal button.btn-primary', { hasText: 'Save Question' }).click();
        await expect(page.locator('#question-modal')).toBeHidden({ timeout: 10_000 });

        const courseAfter = await withDb((db) =>
            db.collection('courses').findOne({ courseId: COURSE_ID })
        );
        const unit1 = courseAfter.lectures.find((l) => l.name === 'Unit 1');
        expect(unit1.assessmentQuestions).toHaveLength(1);
        const q = unit1.assessmentQuestions[0];
        expect(q.questionType).toBe('short-answer');
        expect(q.correctAnswer).toBe(expected);
    });

    test('instructor can convert a question into a flashcard, creating the deck on demand', async ({ page }) => {
        await loginViaUI(page);
        await gotoCoursePage(page);

        await page.locator('.add-question-btn').first().click();
        await expect(page.locator('#question-modal')).toBeVisible();
        await page.locator('#question-type').selectOption('short-answer');
        await page.locator('#question-text').fill('What is the powerhouse of the cell?');
        await page.locator('#sa-answer').fill('Mitochondria');
        await page.locator('#question-modal button.btn-primary', { hasText: 'Save Question' }).click();
        await expect(page.locator('#question-modal')).toBeHidden({ timeout: 10_000 });

        // No flashcard deck exists for Unit 1 yet.
        await expect(page.locator('#flashcard-status-unit-1')).toHaveText('Not generated');

        await page.locator('.convert-to-flashcard-btn').first().click();

        // The deck is created on demand and the new card appears.
        await expect(page.locator('#flashcard-status-unit-1')).toHaveText('Draft', { timeout: 10_000 });
        await expect(page.locator('.flashcard-front-input')).toHaveValue('What is the powerhouse of the cell?');
        await expect(page.locator('.flashcard-back-input')).toHaveValue('Mitochondria');

        const courseAfter = await withDb((db) =>
            db.collection('courses').findOne({ courseId: COURSE_ID })
        );
        const unit1 = courseAfter.lectures.find((l) => l.name === 'Unit 1');
        expect(unit1.assessmentQuestions).toHaveLength(1);

        const deck = await withDb((db) =>
            db.collection('flashcardDecks').findOne({ courseId: COURSE_ID, lectureName: 'Unit 1' })
        );
        expect(deck.draftCards).toHaveLength(1);
        expect(deck.draftCards[0]).toMatchObject({
            front: 'What is the powerhouse of the cell?',
            back: 'Mitochondria'
        });
    });

    test('instructor can convert a flashcard into a prefilled question', async ({ page }) => {
        await loginViaUI(page);

        // Seed a draft deck directly so this test exercises the flashcard
        // side without depending on the question->flashcard flow above.
        await withDb((db) => db.collection('flashcardDecks').insertOne({
            deckId: 'deck-e2e-1',
            courseId: COURSE_ID,
            lectureName: 'Unit 1',
            title: 'Unit 1 Flashcards',
            hasDraft: true,
            isPublished: false,
            isStale: false,
            publishedVersion: 0,
            draftCards: [{
                cardId: 'fc-e2e-1',
                front: 'What pigment makes plants green?',
                back: 'Chlorophyll',
                source: null
            }],
            draftSourceDocumentIds: [],
            publishedCards: [],
            publishedSourceDocumentIds: [],
            createdAt: new Date(),
            updatedAt: new Date()
        }));

        await gotoCoursePage(page);
        await expect(page.locator('.flashcard-front-input')).toHaveValue('What pigment makes plants green?');

        await page.locator('.flashcard-convert-btn').first().click();

        await expect(page.locator('#question-modal')).toBeVisible();
        await expect(page.locator('#question-type')).toHaveValue('short-answer');
        await expect(page.locator('#question-text')).toHaveValue('What pigment makes plants green?');
        await expect(page.locator('#sa-answer')).toHaveValue('Chlorophyll');
    });

    test('instructor can delete a unit', async ({ page }) => {
        await loginViaUI(page);
        await gotoCoursePage(page);

        const unitContainer = page.locator('#dynamic-units-container');
        await expect(unitContainer).toContainText('Unit 1');
        await expect(unitContainer).toContainText('Unit 2');

        // Click the trash icon for Unit 2 (second unit). The button has its
        // inline onclick="openDeleteUnitModal('Unit 2')" so we can target it.
        await page.locator('.delete-unit-btn[onclick*="\'Unit 2\'"]').click();

        const modal = page.locator('#delete-unit-modal');
        await expect(modal).toBeVisible();
        await page.locator('#confirm-delete-unit-btn').click();
        await expect(modal).toBeHidden({ timeout: 10_000 });

        // DOM truth — Unit 2 is gone, Unit 1 remains
        await expect(unitContainer).toContainText('Unit 1');
        await expect(unitContainer).not.toContainText('Unit 2');

        // DB truth
        const courseAfter = await withDb((db) =>
            db.collection('courses').findOne({ courseId: COURSE_ID })
        );
        expect(courseAfter.lectures.map((l) => l.name)).toEqual(['Unit 1']);
    });
});
