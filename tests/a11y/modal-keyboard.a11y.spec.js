// @ts-check
/// <reference types="node" />
const { test, expect } = require('@playwright/test');
const { storageStatePath } = require('../e2e/helpers/users');
const { expectModalKeyboardContract } = require('./helpers/modal-keyboard-contract');

const MODAL_COURSE_ID = 'A11Y-MODAL-FIXTURE';

/** @param {import('@playwright/test').Page} page */
async function seedQuestionTrigger(page) {
    await page.route(`**/api/onboarding/${MODAL_COURSE_ID}`, (route) => route.fulfill({
        json: {
            success: true,
            data: {
                courseId: MODAL_COURSE_ID,
                courseName: 'Accessibility Modal Fixture',
                courseStructure: { weeks: 1, lecturesPerWeek: 1, totalUnits: 1 },
                lectures: [{
                    name: 'Unit 1',
                    learningObjectives: [],
                    assessmentQuestions: [],
                    documents: [],
                    isPublished: false,
                    passThreshold: 0,
                }],
            },
        },
    }));
}

/** @param {import('@playwright/test').Page} page */
async function seedRemovableTA(page) {
    const taId = 'a11y-modal-ta';
    const course = {
        courseId: MODAL_COURSE_ID,
        courseName: 'Accessibility Modal Fixture',
        tas: [taId],
    };

    await page.route('**/api/onboarding/instructor/*', (route) => route.fulfill({
        json: { success: true, data: { courses: [course] } },
    }));
    await page.route('**/api/auth/tas', (route) => route.fulfill({
        json: {
            success: true,
            data: [{
                userId: taId,
                username: 'a11y_modal_ta',
                email: 'a11y-modal-ta@test.local',
                displayName: 'Accessibility Fixture TA',
                createdAt: '2026-01-01T00:00:00.000Z',
            }],
        },
    }));
    await page.route(`**/api/courses/${MODAL_COURSE_ID}/ta-permissions`, (route) => route.fulfill({
        json: {
            success: true,
            data: {
                taPermissions: {
                    [taId]: {
                        materials: true,
                        questions: true,
                        settings: true,
                        transcripts: true,
                        flags: true,
                        roster: true,
                    },
                },
            },
        },
    }));
}

test.describe('Accessibility: representative modal keyboard contract', () => {
    test.use({ storageState: storageStatePath('student') });

    test('student dashboard confirmation uses the shared native-dialog contract', async ({ page }) => {
        await page.goto('/student/dashboard.html');
        await page.waitForLoadState('load');

        await expectModalKeyboardContract(page, {
            trigger: '#reset-all-btn',
            activationKey: 'Enter',
            dialog: '#confirm-modal',
            name: 'Reset All Topics?',
            initialFocus: '#dashboard-confirm-modal-title',
            firstFocusable: '#modal-cancel-btn',
            lastFocusable: '#modal-confirm-btn',
        });
    });
});

test.describe('Accessibility: instructor modal keyboard fixtures', () => {
    test.use({ storageState: storageStatePath('instructor') });

    test('instructor question modal runs from a deterministic visible trigger', async ({ page }) => {
        await seedQuestionTrigger(page);
        await page.goto(`/instructor/documents?courseId=${MODAL_COURSE_ID}`);
        await page.waitForLoadState('load');

        await expectModalKeyboardContract(page, {
            trigger: '.add-question-btn',
            dialog: 'dialog.a11y-modal-host:has(#question-modal)',
            name: 'Create Assessment Question',
            initialFocus: '#question-modal h2',
            firstFocusable: '#question-modal .modal-close',
            lastFocusable: '#question-modal .modal-actions .btn-primary:last-child',
        });
    });

    test('remove TA modal runs from a deterministic removable TA', async ({ page }) => {
        await seedRemovableTA(page);
        await page.goto(`/instructor/ta-hub?courseId=${MODAL_COURSE_ID}`);
        await page.waitForLoadState('load');

        await expectModalKeyboardContract(page, {
            trigger: '.btn-small.btn-danger',
            dialog: 'dialog.a11y-modal-host:has(#remove-ta-modal)',
            name: 'Remove Teaching Assistant',
            initialFocus: '#remove-ta-modal h2',
            firstFocusable: '#remove-ta-modal .modal-close',
            lastFocusable: '#confirm-remove-ta',
        });
    });
});

test.describe('Accessibility: instructor onboarding modal keyboard contract', () => {
    test.use({ storageState: storageStatePath('instructor_fresh') });

    test('the onboarding question modal opens from its real trigger and returns focus after dismissal', async ({ page }) => {
        await page.goto('/instructor/onboarding');
        await page.waitForLoadState('load');

        // The questions panel is normally selected through the preceding guided
        // flow. Select it here only to expose its real, user-visible trigger.
        await page.evaluate(() => {
            const onboardingWindow = /** @type {any} */ (window);
            onboardingWindow.showStep(3);
            onboardingWindow.showSubstep('questions');
        });
        await expect(page.locator('#step-3')).toHaveClass(/active/);
        await expect(page.locator('#substep-questions')).toHaveClass(/active/);

        await expectModalKeyboardContract(page, {
            trigger: '#substep-questions .add-question-btn',
            dialog: 'dialog.a11y-modal-host:has(#question-modal)',
            name: 'Create Assessment Question',
            initialFocus: '#question-modal h2',
            firstFocusable: '#question-modal .modal-close',
            lastFocusable: '#question-modal .modal-actions .btn-primary:last-child',
        });
    });
});
