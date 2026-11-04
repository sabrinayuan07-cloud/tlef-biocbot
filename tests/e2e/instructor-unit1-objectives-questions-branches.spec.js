// @ts-check

const { test, expect } = require('./fixtures/monocart');
const { storageStatePath } = require('./helpers/users');
const {
    gotoOnboarding,
    startCustomCourse,
    addObjective,
    addTrueFalseQuestion,
} = require('./helpers/onboarding-branches');

test.use({ storageState: storageStatePath('instructor_fresh') });

test.describe('onboarding Unit 1 objectives and questions branches', () => {
    test('shows validation for missing course, custom name, weeks, and lectures', async ({ page }) => {
        await gotoOnboarding(page);

        await page.locator('#step-1 button.btn-primary', { hasText: 'Get Started' }).click();
        await page.evaluate(() => {
            /** @type {HTMLInputElement} */ (document.getElementById('weeks-count')).value = '1';
            /** @type {HTMLInputElement} */ (document.getElementById('lectures-per-week')).value = '1';
            const testWindow = /** @type {any} */ (window);
            testWindow.validateCourseSetup();
        });
        // A blank selection now means "create a new course" (same as 'custom'),
        // so validation asks for a course name rather than a dropdown pick.
        await expect(page.getByText('Please enter a course name or pick a section above')).toBeVisible();

        await page.locator('#course-select').selectOption('custom');
        await page.evaluate(() => {
            const testWindow = /** @type {any} */ (window);
            testWindow.validateCourseSetup();
        });
        await expect(page.getByText('Please enter a course name or pick a section above')).toBeVisible();

        await page.locator('#custom-course-name').fill('Invalid Structure Biology');
        await page.locator('#weeks-count').fill('0');
        await page.locator('#lectures-per-week').fill('6');
        await page.evaluate(() => {
            const testWindow = /** @type {any} */ (window);
            testWindow.validateCourseSetup();
        });
        await expect(page.getByText('Please enter a valid number of weeks (1-20)')).toBeVisible();
        await expect(page.getByText('Please enter a valid number of lectures per week (1-5)')).toBeVisible();
    });

    test('reports empty objective input and missing objective elements', async ({ page }) => {
        await gotoOnboarding(page);
        await startCustomCourse(page, 'Objective Branch Biology');

        await page.locator('.add-objective-btn').click();
        await expect(page.getByText('Please enter a learning objective.')).toBeVisible();

        await page.locator('#objectives-list').evaluate(element => element.remove());
        await page.locator('#objective-input').fill('This cannot be inserted.');
        await page.locator('.add-objective-btn').click();
        await expect(page.getByText('Error: Could not find objective elements')).toBeVisible();
    });

    test('blocks objective and material substep progression until prerequisites exist', async ({ page }) => {
        await gotoOnboarding(page);
        await startCustomCourse(page, 'Substep Gate Biology');

        await page.locator('#substep-objectives button.btn-primary', { hasText: 'Continue to Course Materials' }).click();
        await expect(page.getByText('Please add at least one learning objective before continuing.')).toBeVisible();

        await addObjective(page);
        await page.locator('#substep-objectives button.btn-primary', { hasText: 'Continue to Course Materials' }).click();
        await expect(page.locator('#substep-materials.guided-substep.active')).toBeVisible();

        await page.locator('#substep-materials button.btn-primary', { hasText: 'Continue to Probing Questions' }).click();
        await expect(page.getByText('Please upload required materials (Lecture Notes and Practice Questions) before continuing.')).toBeVisible();
    });

    test('keeps question modal open for missing type, text, answer, and short-answer key points', async ({ page }) => {
        await gotoOnboarding(page);
        await startCustomCourse(page, 'Question Validation Biology');
        await page.locator('.progress-card[data-substep="questions"]').click();

        await page.locator('.add-question-btn').click();
        await page.locator('#question-modal button.btn-primary', { hasText: 'Save Question' }).click();
        await expect(page.getByText('Please select a question type.')).toBeVisible();

        await page.locator('#question-type').selectOption('true-false');
        await page.locator('#question-modal button.btn-primary', { hasText: 'Save Question' }).click();
        await expect(page.getByText('Please enter a question.')).toBeVisible();

        await page.locator('#question-text').fill('Branch true false?');
        await page.locator('#question-modal button.btn-primary', { hasText: 'Save Question' }).click();
        await expect(page.getByText('Please select the correct answer.')).toBeVisible();

        await page.locator('#question-type').selectOption('short-answer');
        await page.locator('#question-modal button.btn-primary', { hasText: 'Save Question' }).click();
        await expect(page.getByText('Please provide the expected answer or key points.')).toBeVisible();
    });

    test('requires a correct multiple-choice answer before saving', async ({ page }) => {
        await gotoOnboarding(page);
        await startCustomCourse(page, 'MCQ Validation Biology');
        await page.locator('.progress-card[data-substep="questions"]').click();

        await page.locator('.add-question-btn').click();
        await page.locator('#question-type').selectOption('multiple-choice');
        await page.locator('#question-text').fill('Which option is correct?');
        // The option list starts at just A - Enter inserts option B (#524).
        await page.locator('.mcq-input[data-option="A"]').fill('Alpha');
        await page.locator('.mcq-input[data-option="A"]').press('Enter');
        await page.locator('.mcq-input[data-option="B"]').fill('Beta');
        await page.locator('#question-modal button.btn-primary', { hasText: 'Save Question' }).click();

        await expect(page.getByText('Please select the correct answer.')).toBeVisible();
    });

    test('shows auto-link warnings when questions or learning objectives are missing', async ({ page }) => {
        await gotoOnboarding(page);
        await startCustomCourse(page, 'Auto Link Warning Biology');
        await page.locator('.progress-card[data-substep="questions"]').click();

        await page.locator('.auto-link-btn').click();
        await expect(page.getByText('There are no questions to auto-link yet.')).toBeVisible();

        await addTrueFalseQuestion(page);
        await page.locator('#objectives-list').evaluate(element => { element.innerHTML = ''; });
        await page.locator('.auto-link-btn').click();
        await expect(page.getByText('Add learning objectives before auto-linking questions.')).toBeVisible();
    });

    test('shows learning-objective editor errors when context or question is missing', async ({ page }) => {
        await gotoOnboarding(page);
        await startCustomCourse(page, 'Objective Editor Error Biology');

        await page.evaluate(() => {
            const testWindow = /** @type {any} */ (window);
            testWindow.saveQuestionLearningObjective();
        });
        await expect(page.getByText('No question selected for editing.')).toBeVisible();

        await page.evaluate(() => {
            const testWindow = /** @type {any} */ (window);
            testWindow.openQuestionLearningObjectiveModal('Onboarding', 'missing-question-id');
        });
        await expect(page.getByText('Could not open the learning objective editor.')).toBeVisible();
    });

    test('reports auto-link API failures for existing questions', async ({ page }) => {
        await gotoOnboarding(page, { autoLinkStatus: 500 });
        await startCustomCourse(page, 'Auto Link Failure Biology');
        await addObjective(page);
        await page.locator('.progress-card[data-substep="questions"]').click();
        await addTrueFalseQuestion(page);

        await page.locator('.auto-link-btn').click();
        await page.locator('#auto-link-confirmation-modal button.btn-primary', { hasText: 'Yes' }).click();

        await expect(page.getByText(/Error auto-linking questions: forced auto-link failure/)).toBeVisible();
    });
});
