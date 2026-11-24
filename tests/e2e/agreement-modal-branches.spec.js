// @ts-check
/**
 * Focused branch coverage for public/common/scripts/agreement-modal.js.
 *
 * These tests intentionally leave product gaps exposed: the modal is meant to
 * be reusable across student/instructor/TA contexts, but the current script
 * renders a single student-oriented copy variant for every context.
 */

const { test, expect } = require('./fixtures/monocart');
const { TEST_USERS, storageStatePath } = require('./helpers/users');
const { withDb, getUserIdByUsername } = require('./helpers/courses-test');

/** @type {Record<string, string>} */
const userIds = {};

test.beforeAll(async () => {
    userIds.student = await getUserIdByUsername(TEST_USERS.student.username);
    userIds.instructor = await getUserIdByUsername(TEST_USERS.instructor.username);
    userIds.ta = await getUserIdByUsername(TEST_USERS.ta.username);
});

test.afterEach(async () => {
    await withDb((db) =>
        db.collection('userAgreements').deleteMany({
            userId: { $in: Object.values(userIds) },
        })
    );
});

/**
 * @param {'student'|'instructor'|'ta'} userType
 * @param {boolean} hasAgreed
 */
async function seedAgreement(userType, hasAgreed) {
    const now = new Date();
    await withDb((db) =>
        db.collection('userAgreements').replaceOne(
            { userId: userIds[userType], userType },
            {
                userId: userIds[userType],
                userType,
                hasAgreed,
                agreementVersion: '1.0',
                agreedAt: hasAgreed ? now : null,
                createdAt: now,
                updatedAt: now,
            },
            { upsert: true }
        )
    );
}

/**
 * @param {import('@playwright/test').Page} page
 */
async function waitForStudentModalElement(page) {
    await page.goto('/student/history');
    const modal = page.locator('#agreement-modal-overlay');
    await expect(modal).toBeAttached({ timeout: 10_000 });
    return modal;
}

test.describe('Agreement modal auto-init and submit branches', () => {
    test.use({ storageState: storageStatePath('student') });

    test('already-accepted users keep the modal hidden on auto-init', async ({ page }) => {
        await seedAgreement('student', true);

        const modal = await waitForStudentModalElement(page);
        await page.waitForTimeout(750);

        await expect(modal).toBeHidden();
    });

    test('non-200 POST leaves the modal open and restores the enabled button', async ({ page }) => {
        await seedAgreement('student', false);
        await page.route('**/api/user-agreement/agree', (route) =>
            route.fulfill({
                status: 500,
                contentType: 'application/json',
                body: JSON.stringify({ success: false, message: 'forced e2e failure' }),
            })
        );

        const modal = await waitForStudentModalElement(page);
        await expect(modal).toBeVisible({ timeout: 10_000 });

        let alertText = '';
        page.once('dialog', async (dialog) => {
            alertText = dialog.message();
            await dialog.accept();
        });

        await page.locator('#agreement-checkbox').check();
        await page.locator('#agree-btn').click();

        await expect.poll(() => alertText, { timeout: 5_000 }).toBe('Failed to record your agreement. Please try again.');
        await expect(modal).toBeVisible();
        await expect(page.locator('#agree-btn')).toHaveText('I Agree - Continue');
        await expect(page.locator('#agree-btn')).toBeEnabled();
    });
});

test.describe('Agreement modal close behavior branches', () => {
    test.use({ storageState: storageStatePath('student') });

    test('required modal ignores Escape and backdrop clicks', async ({ page }) => {
        await seedAgreement('student', false);

        const modal = await waitForStudentModalElement(page);
        await expect(modal).toBeVisible({ timeout: 10_000 });

        await page.keyboard.press('Escape');
        await expect(modal).toBeVisible();

        await modal.click({ position: { x: 2, y: 2 } });
        await expect(modal).toBeVisible();
    });

    test('read-only modal closes on Escape and backdrop click', async ({ page }) => {
        await seedAgreement('student', true);

        const modal = await waitForStudentModalElement(page);
        await expect(modal).toBeHidden({ timeout: 10_000 });

        await page.evaluate(() => {
            const testWindow = /** @type {any} */ (window);
            testWindow.agreementModal.show(true);
        });
        await expect(modal).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(modal).toBeHidden();

        await page.evaluate(() => {
            const testWindow = /** @type {any} */ (window);
            testWindow.agreementModal.show(true);
        });
        await expect(modal).toBeVisible();
        await modal.click({ position: { x: 2, y: 2 } });
        await expect(modal).toBeHidden();
    });
});

test.describe('Agreement modal role copy variants', () => {
    test('student, instructor, and TA contexts render distinct copy', async ({ page }) => {
        await page.route('**/api/user-agreement/status', (route) =>
            route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    success: true,
                    data: { hasAgreed: true, agreementVersion: '1.0', agreedAt: null },
                }),
            })
        );

        await page.route('**/agreement-modal-harness.html', (route) =>
            route.fulfill({
                status: 200,
                contentType: 'text/html',
                body: [
                    '<!doctype html>',
                    '<html>',
                    '<head><title>Agreement harness</title></head>',
                    '<body>',
                    '<script src="/common/scripts/biocbot-events.js"></script>',
                    '<script src="/common/scripts/agreement-modal.js"></script>',
                    '</body>',
                    '</html>',
                ].join(''),
            })
        );

        /** @type {Record<string, string>} */
        const modalTextByRole = {};

        for (const rolePath of ['/student/agreement-modal-harness.html', '/instructor/agreement-modal-harness.html', '/ta/agreement-modal-harness.html']) {
            await page.goto(rolePath);
            await page.evaluate(() => {
                const testWindow = /** @type {any} */ (window);
                testWindow.agreementModal.show(true);
            });
            const role = rolePath.split('/')[1];
            modalTextByRole[role] = (await page.locator('#agreement-modal').innerText()).replace(/\s+/g, ' ').trim();
        }

        expect(modalTextByRole.student).toContain('Your AI-Powered Study Assistant');
        expect(new Set(Object.values(modalTextByRole)).size).toBe(3);
    });
});
