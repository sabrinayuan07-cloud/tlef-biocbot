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

test.describe('onboarding save and upload modal branches', () => {
    test('blocks save assessment when no questions exist', async ({ page }) => {
        await gotoOnboarding(page);
        await startCustomCourse(page, 'Save Assessment Gate Biology');
        await page.locator('.progress-card[data-substep="questions"]').click();

        await page.locator('.save-btn', { hasText: 'Save Assessment' }).click();

        await expect(page.locator('.notification-message', { hasText: 'Please add at least one assessment question before saving.' }).last()).toBeVisible();
    });

    test('blocks final completion when objectives, materials, or questions are missing', async ({ page }) => {
        await gotoOnboarding(page);
        await startCustomCourse(page, 'Completion Gate Biology');

        await page.locator('.progress-card[data-substep="questions"]').click();
        await page.locator('#substep-questions button.btn-primary', { hasText: 'Complete Unit 1 & Continue' }).click();
        await expect(page.locator('.notification-message', { hasText: 'Please add at least one learning objective before continuing.' }).last()).toBeVisible();

        await page.locator('.progress-card[data-substep="objectives"]').click();
        await addObjective(page);
        await page.locator('.progress-card[data-substep="questions"]').click();
        await page.locator('#substep-questions button.btn-primary', { hasText: 'Complete Unit 1 & Continue' }).click();
        await expect(page.locator('.notification-message', { hasText: 'Please upload required materials (Lecture Notes and Practice Questions) before continuing.' }).last()).toBeVisible();

        await page.locator('#lecture-status').evaluate(element => { /** @type {HTMLElement} */ (element).dataset.status = 'uploaded'; });
        await page.locator('#practice-status').evaluate(element => { /** @type {HTMLElement} */ (element).dataset.status = 'uploaded'; });
        await page.locator('#substep-questions button.btn-primary', { hasText: 'Complete Unit 1 & Continue' }).click();
        await expect(page.locator('.notification-message', { hasText: 'Please add at least one assessment question before continuing.' }).last()).toBeVisible();
    });

    test('prevents closing upload modal while loading indicator is active', async ({ page }) => {
        await gotoOnboarding(page);

        await page.evaluate(() => {
            const testWindow = /** @type {any} */ (window);
            testWindow.openUploadModal('Unit 1', 'additional');
            document.getElementById('upload-loading-indicator').style.display = 'block';
        });
        await page.locator('#upload-modal .modal-close').click();

        await expect(page.locator('.notification-message', { hasText: 'Please wait for the upload to complete before closing.' }).last()).toBeVisible();
        await expect(page.locator('#upload-modal')).toHaveClass(/show/);
    });

    test('opens default upload modal title for unknown content type', async ({ page }) => {
        await gotoOnboarding(page);

        await page.evaluate(() => {
            const testWindow = /** @type {any} */ (window);
            testWindow.openUploadModal('Unit 3', 'unknown-type');
        });

        await expect(page.locator('#modal-title')).toHaveText('Upload Content for Unit 3');
        await expect(page.locator('#upload-btn')).toBeEnabled();
    });

    test('keeps upload modal on missing content and on missing course context', async ({ page }) => {
        await gotoOnboarding(page);

        await page.evaluate(() => {
            const testWindow = /** @type {any} */ (window);
            testWindow.openUploadModal('Unit 1', 'lecture-notes');
        });
        await page.locator('#upload-btn').click();
        await expect(page.locator('.notification-message', { hasText: 'Please provide content via file upload or direct text input' }).last()).toBeVisible();

        await page.locator('#material-name').fill('Lecture Notes Without Course');
        await page.locator('#text-input').fill('Lecture text without a course.');
        await page.locator('#upload-btn').click();
        await expect(page.locator('.notification-message', { hasText: /No course ID available/ }).last()).toBeVisible();
    });

    test('uploads direct text and saves reviewed topics for additional material', async ({ page }) => {
        const captures = await gotoOnboarding(page);
        await startCustomCourse(page, 'Upload Text Biology');

        await page.evaluate(() => {
            const testWindow = /** @type {any} */ (window);
            testWindow.openUploadModal('Unit 1', 'additional');
        });
        await page.locator('#material-name').fill('Additional Material - Unit 1');
        await page.locator('#text-input').fill('Additional branch material.');
        await page.locator('#upload-btn').click();
        await expect(page.locator('#topic-review-section')).toBeVisible();
        await page.locator('#upload-topic-new-input').fill('Added Review Topic');
        await page.locator('#upload-topic-add-btn').click();
        await page.locator('#save-topics-btn').click();

        await expect(page.locator('#upload-modal')).toBeHidden();
        expect(captures.textUploads[0]).toEqual(expect.objectContaining({
            documentType: 'additional',
            title: 'Additional Material - Unit 1',
        }));
        expect(captures.approvedTopicSaves[0].topics).toEqual([
            expect.objectContaining({ topic: 'Branch Topic' }),
            expect.objectContaining({ topic: 'Added Review Topic' }),
        ]);
    });

    test('recovers upload UI when document upload fails', async ({ page }) => {
        await gotoOnboarding(page, { documentUploadStatus: 500 });
        await startCustomCourse(page, 'Upload Failure Biology');

        await page.evaluate(() => {
            const testWindow = /** @type {any} */ (window);
            testWindow.openUploadModal('Unit 1', 'additional');
        });
        await page.locator('#file-input').setInputFiles({
            name: 'branch.txt',
            mimeType: 'text/plain',
            buffer: Buffer.from('branch upload failure'),
        });
        await page.locator('#upload-btn').click();

        await expect(page.locator('.notification-message', { hasText: /Error uploading content: Failed to save document/ }).last()).toBeVisible();
        await expect(page.locator('#upload-section')).toBeVisible();
        await expect(page.locator('#upload-btn')).toBeEnabled();
    });

    test('skips already saved questions when saving all Unit 1 data', async ({ page }) => {
        const captures = await gotoOnboarding(page);
        await startCustomCourse(page, 'Save All Skip Biology');
        await addObjective(page);
        await page.locator('.progress-card[data-substep="questions"]').click();
        await addTrueFalseQuestion(page);
        await page.locator('.save-btn', { hasText: 'Save Assessment' }).click();
        await expect.poll(() => captures.questionSaves.length).toBe(1);

        await page.evaluate(() => {
            const testWindow = /** @type {any} */ (window);
            return testWindow.saveAllUnit1Data();
        });

        expect(captures.questionSaves).toHaveLength(1);
        expect(captures.thresholdSaves.length).toBeGreaterThanOrEqual(1);
    });
});
