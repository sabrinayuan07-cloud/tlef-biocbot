// @ts-check

const { test, expect } = require('./fixtures/monocart');
const { storageStatePath } = require('./helpers/users');
const {
    gotoOnboarding,
    startCustomCourse,
    addObjective,
} = require('./helpers/onboarding-branches');

test.use({ storageState: storageStatePath('instructor_fresh') });

test.describe('onboarding AI question generation branches', () => {
    test('requires a question type before AI generation', async ({ page }) => {
        await gotoOnboarding(page);

        await page.evaluate(() => {
            const testWindow = /** @type {any} */ (window);
            testWindow.generateAIQuestionContent();
        });

        await expect(page.locator('.notification-message', { hasText: 'Please select a question type first.' }).last()).toBeVisible();
    });

    test('requires objectives or materials before AI generation', async ({ page }) => {
        await gotoOnboarding(page);

        await page.evaluate(() => {
            /** @type {HTMLSelectElement} */ (document.getElementById('question-type')).value = 'true-false';
            const testWindow = /** @type {any} */ (window);
            testWindow.generateAIQuestionContent();
        });

        await expect(page.locator('.notification-message', { hasText: 'Please upload course materials or add learning objectives before generating AI questions.' }).last()).toBeVisible();
    });

    test('uses fallback content when course context is missing', async ({ page }) => {
        await gotoOnboarding(page);

        await page.evaluate(() => {
            document.getElementById('objectives-list').innerHTML = '<div class="objective-display-item"><span class="objective-text">Explain missing course context.</span></div>';
            /** @type {HTMLSelectElement} */ (document.getElementById('question-type')).value = 'short-answer';
            const testWindow = /** @type {any} */ (window);
            testWindow.updateQuestionForm();
            return testWindow.generateAIQuestionContent();
        });

        await expect(page.locator('.notification-message', { hasText: /Error generating AI question: Course ID not found/ }).last()).toBeVisible();
        await expect(page.locator('.notification-message', { hasText: 'Using fallback content due to generation error. Please edit before saving.' }).last()).toBeVisible();
        await expect(page.locator('#sa-answer')).toHaveValue(/Students should demonstrate understanding/);
    });

    test('uses fallback content when AI request fails', async ({ page }) => {
        await gotoOnboarding(page, { aiStatus: 500 });
        await startCustomCourse(page, 'AI Failure Biology');
        await addObjective(page);
        await page.locator('.progress-card[data-substep="questions"]').click();
        await page.locator('.add-question-btn').click();
        await page.locator('#question-type').selectOption('multiple-choice');

        await page.locator('#ai-generate-btn').click();

        await expect(page.locator('.notification-message', { hasText: /Error generating AI question: forced AI failure/ }).last()).toBeVisible();
        await expect(page.locator('#question-text')).toHaveValue(/According to the Unit 1 lecture notes/);
        await expect(page.locator('.mcq-input[data-option="A"]')).toHaveValue('Option A based on lecture content');
    });

    test('uses fallback content when AI reports unsuccessful result', async ({ page }) => {
        await gotoOnboarding(page, { aiSuccess: false });
        await startCustomCourse(page, 'AI Unsuccessful Biology');
        await addObjective(page);
        await page.locator('.progress-card[data-substep="questions"]').click();
        await page.locator('.add-question-btn').click();
        await page.locator('#question-type').selectOption('true-false');

        await page.locator('#ai-generate-btn').click();

        await expect(page.locator('.notification-message', { hasText: /Error generating AI question: AI reported unsuccessful/ }).last()).toBeVisible();
        await expect(page.locator('input[name="tf-answer"]:checked')).toHaveCount(1);
    });

    test('opens regenerate modal and requires feedback for regeneration', async ({ page }) => {
        await gotoOnboarding(page);
        await startCustomCourse(page, 'AI Regenerate Biology');
        await addObjective(page);
        await page.locator('.progress-card[data-substep="questions"]').click();
        await page.locator('.add-question-btn').click();
        await page.locator('#question-type').selectOption('multiple-choice');

        await page.locator('#ai-generate-btn').click();
        await expect(page.locator('.notification-message', { hasText: 'AI question generated successfully! You can now edit and save it.' }).last()).toBeVisible();
        await page.locator('#ai-generate-btn').click();

        await expect(page.locator('#regenerate-modal')).toHaveClass(/show/);
        await expect(page.locator('#current-question-display')).toContainText('Generated branch question?');
        await page.locator('#regenerate-submit-btn').click();
        await expect(page.locator('.notification-message', { hasText: "Please provide feedback about what you'd like to improve." }).last()).toBeVisible();

        await page.locator('#regenerate-feedback').fill('Make it more applied.');
        await page.locator('#regenerate-submit-btn').click();
        await expect(page.locator('.notification-message', { hasText: 'Question regenerated successfully based on your feedback!' }).last()).toBeVisible();
        await expect(page.locator('#question-text')).toHaveValue('Regenerated branch question?');
    });

    test('populates AI content across true-false, multiple-choice, and short-answer forms', async ({ page }) => {
        await gotoOnboarding(page);

        const values = await page.evaluate(() => {
            const testWindow = /** @type {any} */ (window);
            testWindow.populateFormWithAIContent(null);

            /** @type {HTMLSelectElement} */ (document.getElementById('question-type')).value = 'true-false';
            testWindow.updateQuestionForm();
            testWindow.populateFormWithAIContent({ question: 'TF branch?', answer: true });
            const tfChecked = /** @type {HTMLInputElement | null} */ (document.querySelector('input[name="tf-answer"]:checked'))?.value;

            /** @type {HTMLSelectElement} */ (document.getElementById('question-type')).value = 'multiple-choice';
            testWindow.updateQuestionForm();
            testWindow.populateFormWithAIContent({
                question: 'Array branch?',
                options: { choices: ['One', 'Two', 'Three', 'Four'], correctAnswer: 'b' },
            });
            const arrayChoice = /** @type {HTMLInputElement} */ (document.querySelector('.mcq-input[data-option="B"]')).value;
            const arrayCorrect = /** @type {HTMLInputElement | null} */ (document.querySelector('input[name="mcq-correct"]:checked'))?.value;

            testWindow.populateFormWithAIContent({
                question: 'Object branch?',
                options: { A: 'Alpha', B: 'Beta', C: 'Gamma', D: 'Delta' },
                answer: 'C',
            });
            const objectChoice = /** @type {HTMLInputElement} */ (document.querySelector('.mcq-input[data-option="C"]')).value;
            const objectCorrect = /** @type {HTMLInputElement | null} */ (document.querySelector('input[name="mcq-correct"]:checked'))?.value;

            /** @type {HTMLSelectElement} */ (document.getElementById('question-type')).value = 'short-answer';
            testWindow.updateQuestionForm();
            testWindow.populateFormWithAIContent({ prompt: 'SA branch?', EXPECTED_ANSWER: 'Explain clearly.' });
            const shortAnswer = /** @type {HTMLTextAreaElement} */ (document.getElementById('sa-answer')).value;

            return { tfChecked, arrayChoice, arrayCorrect, objectChoice, objectCorrect, shortAnswer };
        });

        expect(values).toEqual({
            tfChecked: 'true',
            arrayChoice: 'Two',
            arrayCorrect: 'B',
            objectChoice: 'Gamma',
            objectCorrect: 'C',
            shortAnswer: 'Explain clearly.',
        });
    });

    test('creates fallback AI content for each supported question type', async ({ page }) => {
        await gotoOnboarding(page);

        const fallback = await page.evaluate(() => {
            const testWindow = /** @type {any} */ (window);
            return {
                tf: testWindow.createFallbackAIContent('true-false', 'Unit 1'),
                mcq: testWindow.createFallbackAIContent('multiple-choice', 'Unit 1'),
                shortAnswer: testWindow.createFallbackAIContent('short-answer', 'Unit 1'),
                unsupported: testWindow.createFallbackAIContent('essay', 'Unit 1'),
            };
        });

        expect(fallback.tf.question).toContain('Unit 1 lecture notes');
        expect(['true', 'false']).toContain(fallback.tf.answer);
        expect(Object.keys(fallback.mcq.options)).toEqual(['A', 'B', 'C', 'D']);
        expect(fallback.shortAnswer.answer).toContain('Students should demonstrate understanding');
        expect(fallback.unsupported).toBeUndefined();
    });
});
