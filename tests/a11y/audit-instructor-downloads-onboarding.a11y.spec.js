// @ts-check
/**
 * Accessibility audit of /instructor/downloads (system admins only) and
 * /instructor/onboarding (the course set-up wizard).
 *
 * An audit, not a gate: findings are written to a11y-results/other-pages/raw/
 * and nothing here fails the build.
 */
const { test } = require('@playwright/test');
const { storageStatePath } = require('../e2e/helpers/users');
const {
    DOWNLOAD_COURSE_ID, getInstructorId, resetDownloadData, cleanupDownloadData,
} = require('../e2e/helpers/downloads');
const { gotoOnboarding } = require('../e2e/helpers/onboarding-branches');
const { auditTest, toastStates, pageShell } = require('./helpers/audit-recorder');
const { setSystemAdmin } = require('./helpers/audit-seed');

test.describe('Audit: instructor downloads', () => {
    test.use({ storageState: storageStatePath('instructor'), viewport: { width: 1440, height: 1000 } });

    let instructorId;
    let wasAdmin = false;
    test.beforeAll(async () => {
        instructorId = await getInstructorId();
        await resetDownloadData({ instructorId });
        wasAdmin = await setSystemAdmin(instructorId, true);
    });
    test.afterAll(async () => {
        await cleanupDownloadData(instructorId);
        await setSystemAdmin(instructorId, wasAdmin);
    });

    auditTest(test, '/instructor/downloads', async ({ page, rec }) => {
        // Downloads are looked at, not taken: stop the browser saving files.
        page.on('download', (d) => d.cancel().catch(() => {}));
        await page.addInitScript((id) => { try { localStorage.setItem('selectedCourseId', id); } catch (_) {} }, DOWNLOAD_COURSE_ID);
        await page.goto(`/instructor/downloads?courseId=${DOWNLOAD_COURSE_ID}`);
        await page.locator('#students-list .student-card').first().waitFor({ timeout: 25_000 });
        await page.waitForTimeout(800);
        rec.note('what the page rendered', await page.evaluate(() => ({
            studentCards: document.querySelectorAll('#students-list .student-card').length,
            scopeSelectorVisible: !!document.querySelector('#scope-selector-container') && /** @type {HTMLElement} */ (document.querySelector('#scope-selector-container')).offsetParent !== null,
        })));
        await pageShell(page, rec);
        await rec.capture(page, 'loaded-with-students');

        // Download menus: a button that opens a menu of formats.
        const courseMenu = page.locator('.download-dropdown-toggle:visible').first();
        await rec.disclosure('course "Download" menu button', courseMenu, { scope: '.download-dropdown, .header-actions, header, body' });
        await rec.state(page, 'course-download-menu-open', async () => {
            await courseMenu.click();
            await page.locator('.download-dropdown-menu.open, [id^="download-menu-"].open').first().waitFor({ state: 'visible', timeout: 4000 });
        });
        rec.note('focus and roles when the download menu opens', await page.evaluate(() => {
            const menu = document.querySelector('[id^="download-menu-"].open');
            const a = document.activeElement;
            return {
                menuRole: menu ? menu.getAttribute('role') : null,
                itemRoles: menu ? [...menu.children].slice(0, 4).map((c) => `${c.tagName.toLowerCase()}[role=${c.getAttribute('role')}]`) : [],
                focusInsideMenu: !!a && !!menu && menu.contains(a),
            };
        }));
        await rec.step('close the menu', () => page.keyboard.press('Escape'));

        await rec.status('change the "empty chats" filter (is the new result announced?)', page, async () => {
            await page.locator('#empty-chat-filter').selectOption({ index: 1 });
        }, { watchMs: 3000 });
        await rec.capture(page, 'filter-changed');
        await rec.step('put the filter back', () => page.locator('#empty-chat-filter').selectOption({ index: 0 }));
        await page.locator('#students-list .student-card').first().waitFor({ timeout: 10_000 }).catch(() => {});

        // A student's sessions open in a dialog.
        const view = page.locator('#students-list .student-card button').filter({ hasText: /View Sessions/i }).first();
        await rec.dialog(page, 'dialog-student-sessions', {
            root: '#student-modal', trigger: view,
            open: () => view.click(),
            close: () => page.locator('#student-modal .modal-close').first().click(),
            inside: async () => {
                await page.locator('#sessions-list .session-item-wrapper').first().waitFor({ timeout: 8000 });
                rec.note('sessions listed in the dialog', { count: await page.locator('#sessions-list .session-item-wrapper').count() });
                const preview = page.locator('#sessions-list .session-item-wrapper .btn-outline').first();
                await rec.disclosure('"Preview Chat" (shows the transcript inline)', preview, { scope: '.session-item-wrapper' });
                await rec.state(page, 'dialog-student-sessions-preview-open', async () => {
                    await preview.click();
                    await page.locator('[id^="preview-"]:visible').first().waitFor({ timeout: 8000 });
                    await page.waitForTimeout(500);
                }, { root: '#student-modal' });
                const sessionMenu = page.locator('#sessions-list .download-dropdown-toggle').first();
                await rec.disclosure('per-session "Download" menu button', sessionMenu, { scope: '.session-item-wrapper' });
                await rec.state(page, 'dialog-student-sessions-download-menu-open', () => sessionMenu.click(), { root: '#student-modal' });
                await rec.step('close the session menu', () => sessionMenu.click());
                await rec.graphic('dialog close (×) control', page.locator('#student-modal .modal-close').first());
            },
        });

        const changelog = page.locator('#changelog-btn');
        await rec.dialog(page, 'dialog-export-change-log', {
            root: '#changelog-modal', trigger: changelog,
            open: () => changelog.click(),
            close: () => page.locator('#changelog-modal .modal-close').first().click(),
        });

        await toastStates(page, rec);
        rec.notCovered('the bulk-download progress dialog (#download-modal)',
            'it only shows while a real multi-session export is being built and closes by itself; not driven');
    });

    auditTest(test, '/instructor/downloads', async ({ page, rec }) => {
        await page.route(/\/api\/students\/[^/]+(\?.*)?$/, (route) => route.fulfill({
            status: 500, contentType: 'application/json', body: JSON.stringify({ success: false, message: 'Could not load students.' }),
        }));
        await page.goto(`/instructor/downloads?courseId=${DOWNLOAD_COURSE_ID}`);
        await page.waitForTimeout(2500);
        rec.note('which state showed', await page.evaluate(() => Object.fromEntries(['loading-state', 'error-state', 'empty-state', 'students-container']
            .map((id) => [id, !!document.getElementById(id) && /** @type {HTMLElement} */ (document.getElementById(id)).offsetParent !== null]))));
        await rec.capture(page, 'load-error');
    }, { variant: 'error' });
});

test.describe('Audit: instructor onboarding wizard', () => {
    test.use({ storageState: storageStatePath('instructor'), viewport: { width: 1440, height: 1000 } });

    auditTest(test, '/instructor/onboarding', async ({ page, rec }) => {
        page.on('dialog', (d) => d.accept().catch(() => {}));
        // Every /api call is answered by the e2e helper, so the wizard runs end
        // to end without creating a course, a document or a question.
        await gotoOnboarding(page);
        await page.waitForTimeout(800);
        await pageShell(page, rec);
        rec.note('step indicators', await page.evaluate(() => [...document.querySelectorAll('.step-indicator')].map((el) => ({
            text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40), current: el.getAttribute('aria-current'), cls: el.className,
        }))));
        await rec.capture(page, 'step-1-welcome');
        await rec.focus('"Get Started" (step 1 is replaced by step 2)', page.locator('#step-1 button.btn-primary').filter({ hasText: 'Get Started' }), { settleMs: 900 });

        await rec.state(page, 'step-2-course-setup', async () => {
            if (!(await page.locator('#step-2.onboarding-step.active').isVisible())) await page.locator('#step-1 button.btn-primary').filter({ hasText: 'Get Started' }).click();
            await page.locator('#step-2.onboarding-step.active').waitFor({ state: 'visible', timeout: 6000 });
        });
        await rec.state(page, 'step-2-join-existing-course', async () => {
            const values = await page.locator('#course-select option').evaluateAll((o) => o.map((x) => /** @type {HTMLOptionElement} */ (x).value).filter((v) => v && v !== 'custom'));
            if (!values.length) throw new Error('no existing course offered in #course-select');
            await page.locator('#course-select').selectOption(values[0]);
            await page.waitForTimeout(500);
        });
        await rec.status('choose "custom course" (more fields appear; is anything announced?)', page, async () => {
            await page.locator('#course-select').selectOption('custom');
        }, { watchMs: 2000 });
        await rec.capture(page, 'step-2-custom-course-fields');
        await rec.status('"Continue" with required fields empty (validation)', page, () => page.locator('#continue-btn').click(), { watchMs: 3000 });
        rec.note('how the empty required fields were reported', await page.evaluate(() => {
            const invalid = [...document.querySelectorAll('#course-setup-form :invalid')].filter((el) => el.tagName !== 'FIELDSET');
            const a = document.activeElement;
            return {
                invalidFields: invalid.map((el) => el.id), nativeValidation: invalid.length > 0,
                focusOn: a && a !== document.body ? a.id || a.tagName : 'body',
                ariaInvalid: invalid.map((el) => el.getAttribute('aria-invalid')),
            };
        }));
        await rec.capture(page, 'step-2-validation');
        await rec.step('fill in the course set-up form', async () => {
            await page.locator('#custom-course-name').fill('Audit Onboarding Course');
            await page.locator('#course-api-key').fill('sk-test-a11y-audit-not-a-real-key-000000000000');
            await page.locator('#weeks-count').fill('1');
            await page.locator('#lectures-per-week').fill('1');
        });
        await rec.focus('"Continue to Unit Setup" (step 2 is replaced by step 3)', page.locator('#continue-btn'), { settleMs: 2500 });

        // Step 3, substep 1: learning objectives.
        await rec.state(page, 'step-3-objectives-empty', () => page.locator('#substep-objectives.active, #step-3.onboarding-step.active').first().waitFor({ state: 'visible', timeout: 8000 }));
        rec.note('progress cards as controls', await page.evaluate(() => [...document.querySelectorAll('.progress-card')].map((el) => ({
            tag: el.tagName.toLowerCase(), role: el.getAttribute('role'), tabindex: el.getAttribute('tabindex'), current: el.getAttribute('aria-current'),
            text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40), clickable: !!/** @type {HTMLElement} */ (el).onclick || getComputedStyle(el).cursor === 'pointer',
        }))));
        await rec.status('add a learning objective (is it announced?)', page, async () => {
            await page.locator('#objective-input').fill('Explain how enzymes lower activation energy.');
            await page.locator('.add-objective-btn').click();
        }, { watchMs: 2500 });
        await page.locator('#objective-input').fill('Describe competitive inhibition.').catch(() => {});
        await rec.focus('"+" add objective (the list re-renders)', page.locator('.add-objective-btn'), { settleMs: 900 });
        await rec.capture(page, 'step-3-objectives-two-added');
        await rec.graphic('"+" add objective glyph', page.locator('.add-objective-btn'));
        await rec.focus('remove an objective (the item is removed)', page.locator('#objectives-list .remove-objective').first(), { settleMs: 900 });
        await rec.focus('"Continue to Course Materials" (substep changes)', page.locator('#substep-objectives button.btn-primary').filter({ hasText: 'Continue to Course Materials' }), { settleMs: 2000 });

        // Substep 2: materials and the upload dialog.
        await rec.state(page, 'step-3-materials', () => page.locator('#substep-materials').waitFor({ state: 'visible', timeout: 8000 }));
        const upload = page.locator('#substep-materials .upload-btn').first();
        await rec.dialog(page, 'dialog-upload', {
            root: '#upload-modal', trigger: upload,
            open: () => upload.click(),
            close: () => page.locator('#upload-modal .modal-close').first().click(),
            inside: async () => {
                await rec.step('fill in a pasted-text upload', async () => {
                    await page.locator('#material-name').fill('Lecture Notes - Unit 1');
                    await page.locator('#text-input').fill('Enzymes lower the activation energy of a reaction.');
                });
                await rec.capture(page, 'dialog-upload-filled', { root: '#upload-modal' });
                await rec.focus('"Upload" in the dialog (the form is replaced by topic review)', page.locator('#upload-btn'), { settleMs: 3000 });
                rec.note('topic review after upload', { shown: await page.locator('#topic-review-section').isVisible().catch(() => false) });
                await rec.capture(page, 'dialog-upload-topic-review', { root: '#upload-modal' });
            },
        });
        await rec.step('mark both required materials as uploaded', async () => {
            if (await page.locator('#upload-modal').isVisible().catch(() => false)) await page.locator('#upload-modal .modal-close').first().click();
            for (const id of ['#lecture-status', '#practice-status']) {
                await page.locator(id).evaluate((el) => { /** @type {HTMLElement} */ (el).dataset.status = 'uploaded'; });
            }
        });
        await rec.capture(page, 'step-3-materials-after-upload');
        await rec.focus('"Continue to Probing Questions" (substep changes)', page.locator('#substep-materials button.btn-primary').filter({ hasText: 'Continue to Probing Questions' }), { settleMs: 2000 });

        // Substep 3: questions and the question dialog.
        await rec.state(page, 'step-3-questions-empty', () => page.locator('#substep-questions').waitFor({ state: 'visible', timeout: 8000 }));
        const addQuestion = page.locator('#substep-questions .add-question-btn').first();
        await rec.dialog(page, 'dialog-add-question', {
            root: '#question-modal', trigger: addQuestion,
            open: () => addQuestion.click(),
            close: () => page.locator('#question-modal .modal-close').first().click(),
            inside: async () => {
                for (const [type, label] of [['true-false', 'true-false'], ['multiple-choice', 'multiple-choice'], ['short-answer', 'short-answer']]) {
                    await rec.state(page, `dialog-add-question-${label}`, async () => {
                        await page.locator('#question-type').selectOption(type);
                        await page.waitForTimeout(300);
                    }, { root: '#question-modal' });
                }
                await rec.status('"Save Question" with nothing filled in (validation)', page,
                    () => page.locator('#question-modal button.btn-primary').filter({ hasText: 'Save Question' }).click(), { watchMs: 3000 });
                await rec.capture(page, 'dialog-add-question-validation', { root: '#question-modal' });
            },
        });
        await rec.step('add one true/false question', async () => {
            await page.evaluate(() => document.querySelectorAll('.notification .notification-close').forEach((b) => /** @type {HTMLElement} */ (b).click()));
            if (!(await page.locator('#question-modal').isVisible().catch(() => false))) await addQuestion.click();
            await page.locator('#question-type').selectOption('true-false');
            await page.locator('#question-text').fill('Enzymes lower activation energy.');
            await page.locator('input[name="tf-answer"][value="true"]').check();
            await page.locator('#question-modal button.btn-primary').filter({ hasText: 'Save Question' }).click();
            await page.locator('#assessment-questions-onboarding .question-item').first().waitFor({ timeout: 8000 });
        });
        await rec.capture(page, 'step-3-questions-one-added');
        const autoLink = page.locator('#substep-questions .auto-link-btn').first();
        await rec.dialog(page, 'dialog-auto-link-confirmation', {
            root: '#auto-link-confirmation-modal', trigger: autoLink,
            open: () => autoLink.click(),
            close: () => page.locator('#auto-link-confirmation-modal .modal-close').first().click(),
        });
        const edit = page.locator('#assessment-questions-onboarding .edit-question-btn').first();
        await rec.dialog(page, 'dialog-question-learning-objective', {
            root: '#question-learning-objective-modal', trigger: edit,
            open: () => edit.click(),
            close: () => page.locator('#question-learning-objective-modal .modal-close').first().click(),
        });
        await rec.focus('delete a question (confirm, then the item is removed)', page.locator('#assessment-questions-onboarding .delete-question-btn').first(), { settleMs: 1500 });

        await toastStates(page, rec);
        rec.notCovered('the "onboarding complete" screen, the regenerate-with-AI dialog, the file-picker upload path and the academic-calendar sync section',
            'the complete screen redirects away after 5 seconds; AI generation and the academic API are off in the mocked wizard; a real file upload was not driven');
    });
});
