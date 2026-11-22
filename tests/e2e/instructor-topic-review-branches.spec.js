// @ts-check

const { test, expect } = require('./fixtures/monocart');
const { storageStatePath } = require('./helpers/users');
const { gotoOnboarding, startCustomCourse } = require('./helpers/onboarding-branches');

test.use({ storageState: storageStatePath('instructor_fresh') });

test.describe('onboarding topic review branches', () => {
    test('returns no topics when uploaded document has no id', async ({ page }) => {
        await gotoOnboarding(page);

        const topics = await page.evaluate(() => {
            const testWindow = /** @type {any} */ (window);
            return testWindow.extractTopicsForUploadedDocument('COURSE-A', '');
        });

        expect(topics).toEqual([]);
    });

    test('rejects when topic extraction request fails', async ({ page }) => {
        await gotoOnboarding(page, { extractTopicsStatus: 500 });

        await expect(page.evaluate(() => {
            const testWindow = /** @type {any} */ (window);
            return testWindow.extractTopicsForUploadedDocument('COURSE-A', 'doc-1');
        })).rejects.toThrow(/Failed to extract topics: 500/);
    });

    test('shows skip notice when extraction is skipped for additional material', async ({ page }) => {
        await gotoOnboarding(page, { extractTopicsSkippedAdditional: true });

        const modalPromise = page.evaluate(async () => {
            const testWindow = /** @type {any} */ (window);
            const topics = await testWindow.extractTopicsForUploadedDocument('COURSE-A', 'doc-1');
            return testWindow.openTopicReviewModal('COURSE-A', 'Extra Notes', [], topics, 'Unit 1');
        });
        await expect(page.locator('#topic-review-modal')).toHaveClass(/show/);
        await expect(page.locator('#topic-review-skip-notice')).toBeVisible();
        await expect(page.locator('#topic-review-skip-notice')).toContainText('Additional material secondary search is turned on');
        await page.locator('#topic-review-cancel-btn').click();

        await expect(modalPromise).resolves.toBeNull();
    });

    test('rejects when approved topics save request fails', async ({ page }) => {
        await gotoOnboarding(page, { approvedTopicsStatus: 500 });

        await expect(page.evaluate(() => {
            const testWindow = /** @type {any} */ (window);
            return testWindow.saveCourseApprovedTopics('COURSE-A', ['Topic A']);
        })).rejects.toThrow(/Failed to save approved topics: 500/);
    });

    test('renders topic review empty-state and resolves null on cancel', async ({ page }) => {
        await gotoOnboarding(page);

        const modalPromise = page.evaluate(() => {
            const testWindow = /** @type {any} */ (window);
            return testWindow.openTopicReviewModal('COURSE-A', '', [], [], 'Unit 1');
        });
        await expect(page.locator('#topic-review-modal')).toHaveClass(/show/);
        await expect(page.locator('#topic-review-list .topic-review-empty')).toHaveText('No topics detected yet. Add topics manually for this course.');
        await page.locator('#topic-review-cancel-btn').click();

        await expect(modalPromise).resolves.toBeNull();
    });

    test('shows empty-state after removing the last modal topic', async ({ page }) => {
        await gotoOnboarding(page);

        const modalPromise = page.evaluate(() => {
            const testWindow = /** @type {any} */ (window);
            return testWindow.openTopicReviewModal('COURSE-A', 'Branch Doc', [], ['Topic A'], 'Unit 1');
        });
        await page.locator('#topic-review-remove-btn').count().catch(() => 0);
        await page.locator('#topic-review-list .topic-review-remove').click();
        await expect(page.locator('#topic-review-list .topic-review-empty')).toHaveText('No topics yet. Add at least one topic to track struggle mapping.');
        await page.locator('#topic-review-add-btn').click();
        await expect(page.locator('#topic-review-list .topic-review-empty')).toBeVisible();
        await page.locator('#topic-review-save-btn').click();

        await expect(modalPromise).resolves.toEqual([]);
    });

    test('shows inline topic review empty-state and no-ops when list is missing', async ({ page }) => {
        await gotoOnboarding(page);

        await page.evaluate(() => {
            const testWindow = /** @type {any} */ (window);
            testWindow.openUploadModal('Unit 1', 'additional');
            testWindow.showInlineTopicReview('COURSE-A', '', [], []);
            document.getElementById('upload-topic-review-list')?.remove();
            testWindow.addInlineTopicRow('Missing List Topic');
        });

        await expect(page.locator('#topic-review-section')).toBeVisible();
        await expect(page.locator('#modal-title')).toHaveText('Review Detected Topics');
    });

    test('shows inline empty-state after removing the last reviewed topic', async ({ page }) => {
        await gotoOnboarding(page);

        await page.evaluate(() => {
            const testWindow = /** @type {any} */ (window);
            testWindow.openUploadModal('Unit 1', 'additional');
            testWindow.showInlineTopicReview('COURSE-A', 'Branch Doc', [], ['Topic A']);
        });

        await page.locator('#upload-topic-review-list .topic-review-remove').click();
        await expect(page.locator('#upload-topic-review-list .topic-review-empty')).toHaveText('No topics yet. Add at least one topic to track struggle mapping.');
        await page.locator('#upload-topic-add-btn').click();
        await expect(page.locator('#upload-topic-review-list .topic-review-empty')).toBeVisible();
    });

    test('closes upload modal when saving without pending topic data', async ({ page }) => {
        await gotoOnboarding(page);

        await page.evaluate(() => {
            const testWindow = /** @type {any} */ (window);
            testWindow.openUploadModal('Unit 1', 'additional');
            return testWindow.handleSaveTopicsFromModal();
        });

        await expect(page.locator('#upload-modal')).toBeHidden();
    });

    test('reports inline approved-topic save failures', async ({ page }) => {
        await gotoOnboarding(page, { approvedTopicsStatus: 500 });
        await startCustomCourse(page, 'Topic Save Failure Biology');

        await page.evaluate(() => {
            const testWindow = /** @type {any} */ (window);
            testWindow.openUploadModal('Unit 1', 'additional');
            testWindow.showInlineTopicReview('COURSE-A', 'Branch Doc', [], ['Topic A']);
        });
        await page.locator('#save-topics-btn').click();

        await expect(page.locator('.notification-message', { hasText: 'Could not save topics. Please try again.' }).last()).toBeVisible();
        await expect(page.locator('#upload-modal')).toBeHidden();
    });
});
