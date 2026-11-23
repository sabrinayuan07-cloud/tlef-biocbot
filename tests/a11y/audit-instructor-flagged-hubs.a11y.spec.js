// @ts-check
/**
 * Accessibility audit of /instructor/flagged, /instructor/student-hub and
 * /instructor/ta-hub.
 *
 * An audit, not a gate: findings are written to a11y-results/other-pages/raw/
 * and nothing here fails the build.
 */
const { test } = require('@playwright/test');
const { storageStatePath } = require('../e2e/helpers/users');
const { auditTest, toastStates, pageShell, stubEmptyLists } = require('./helpers/audit-recorder');
const {
    MAIN, STUDENT_2, TA_2, seedAuditData, cleanupAuditData, setSystemAdmin,
} = require('./helpers/audit-seed');

test.describe('Audit: instructor flagged content, student hub, TA hub', () => {
    test.use({ storageState: storageStatePath('instructor'), viewport: { width: 1440, height: 1000 } });

    let ids;
    let wasAdmin = false;
    test.beforeAll(async () => {
        ids = await seedAuditData();
        wasAdmin = await setSystemAdmin(ids.instructorId, false);
    });
    // Each page is audited against the same starting data.
    test.beforeEach(async () => { await seedAuditData(); });
    test.afterAll(async () => {
        await setSystemAdmin(ids.instructorId, wasAdmin);
        await cleanupAuditData();
    });

    const selectCourse = (page) => page.addInitScript((id) => { try { localStorage.setItem('selectedCourseId', id); } catch (_) {} }, MAIN);

    // ------------------------------------------------------------- flagged
    auditTest(test, '/instructor/flagged', async ({ page, rec }) => {
        page.on('dialog', (d) => d.accept().catch(() => {}));
        await selectCourse(page);
        await page.goto(`/instructor/flagged?courseId=${MAIN}`);
        await page.locator('#flagged-list .flag-card').first().waitFor({ timeout: 25_000 });
        await page.locator('#mh-flags-list .mh-flag-card').first().waitFor({ timeout: 10_000 }).catch(() => {});
        await page.locator('#ra-list .ra-card').first().waitFor({ timeout: 10_000 }).catch(() => {});
        await page.waitForTimeout(800);
        rec.note('what the page rendered', await page.evaluate(() => ({
            flagCards: document.querySelectorAll('#flagged-list .flag-card').length,
            mentalHealthCards: document.querySelectorAll('#mh-flags-list .mh-flag-card').length,
            reviewAgainCards: document.querySelectorAll('#ra-list .ra-card').length,
        })));
        await pageShell(page, rec);
        await rec.capture(page, 'loaded-pending-flags');

        await rec.state(page, 'all-statuses', async () => {
            await page.locator('#status-filter').selectOption({ index: 0 });
            const values = await page.locator('#status-filter option').evaluateAll((o) => o.map((x) => /** @type {HTMLOptionElement} */ (x).value));
            if (values.includes('all')) await page.locator('#status-filter').selectOption('all');
            await page.waitForTimeout(600);
        });
        rec.note('cards with every status showing', await page.evaluate(() => ({
            flagCards: document.querySelectorAll('#flagged-list .flag-card').length,
            withResponse: document.querySelectorAll('#flagged-list .flag-card .instructor-response, #flagged-list .flag-card .response-section').length,
        })));
        await rec.status('change the status filter (is the new result announced?)', page, async () => {
            await page.locator('#status-filter').selectOption('pending');
        }, { watchMs: 2500 });

        // Approve & Reply: the buttons hide themselves and a form appears.
        const firstCard = page.locator('#flagged-list .flag-card').first();
        await rec.focus('"Approve & Reply" (hides itself, reveals the reply form)', firstCard.locator('.approve-btn'), { settleMs: 800 });
        await rec.state(page, 'reply-form-open', async () => {
            if (!(await firstCard.locator('textarea').first().isVisible().catch(() => false))) await firstCard.locator('.approve-btn').click();
            await firstCard.locator('textarea').first().waitFor({ state: 'visible', timeout: 5000 });
        });
        await rec.focus('"Cancel" in the reply form (returns to the buttons)', firstCard.locator('.cancel-btn'), { settleMs: 800 });
        await rec.status('send a reply to a flag (announcement)', page, async () => {
            await firstCard.locator('.approve-btn').click();
            await firstCard.locator('textarea').first().fill('Thanks for flagging this. The explanation has been corrected.');
            await firstCard.locator('.send-approve-btn').click();
        }, { watchMs: 6500 });
        await rec.capture(page, 'after-sending-a-reply');
        await rec.focus('"Dismiss" a flag (the card is removed or re-rendered)', page.locator('#flagged-list .flag-card .dismiss-btn').first(), { settleMs: 2000 });
        await rec.focus('"Refresh" flags (the list re-renders)', page.locator('#refresh-flags'), { settleMs: 2000 });

        // Mental-health flags.
        await rec.disclosures(page, '.mh-flag-context-toggle', { scope: '.mh-flag-card', limit: 2, labelPrefix: 'conversation context: ' });
        await rec.state(page, 'mental-health-context-open', () => page.locator('.mh-flag-context-toggle').first().click());
        await rec.focus('mental-health flag "Dismiss" (the card changes)', page.locator('.mh-flag-card .mh-dismiss-btn').first(), { settleMs: 2000 });
        await rec.focus('mental-health flag "Escalate" (the card changes)', page.locator('.mh-flag-card .mh-escalate-btn').first(), { settleMs: 2000 });
        await rec.capture(page, 'after-mental-health-actions');

        // Review-again flashcards: a card that opens a dialog built by the page.
        const raCard = page.locator('#ra-list .ra-card').first();
        rec.note('review-again card as a control', await raCard.evaluate((el) => ({
            tag: el.tagName.toLowerCase(), role: el.getAttribute('role'), tabindex: el.getAttribute('tabindex'),
            hasButtonInside: !!el.querySelector('button, a[href]'),
        })).catch((e) => ({ error: String(e) })));
        await rec.dialog(page, 'dialog-review-again-card', {
            root: '#ra-card-modal', trigger: raCard,
            open: async () => { await raCard.focus(); await page.keyboard.press('Enter'); },
            close: () => page.locator('#ra-card-modal-close').click(),
            inside: async () => {
                await rec.graphic('dialog close (×) control', page.locator('#ra-card-modal-close'));
                await rec.focus('"Edit" in the card dialog (hides itself, reveals Save and Cancel)', page.locator('#ra-card-modal-edit-btn'), { settleMs: 700 });
                await rec.capture(page, 'dialog-review-again-card-editing', { root: '#ra-card-modal' });
                await rec.focus('"Cancel" in the card dialog edit mode', page.locator('#ra-card-modal-cancel-btn'), { settleMs: 700 });
            },
        });

        await toastStates(page, rec);
    });

    auditTest(test, '/instructor/flagged', async ({ page, rec }) => {
        await selectCourse(page);
        await stubEmptyLists(page, /\/api\/flags\/course\/|\/api\/mental-health-flags\/course\/|\/api\/flashcards\/instructor\/review-again-stats/);
        await page.goto(`/instructor/flagged?courseId=${MAIN}`);
        await page.waitForTimeout(2500);
        await rec.capture(page, 'nothing-flagged');
    }, { variant: 'empty' });

    // --------------------------------------------------------- student hub
    auditTest(test, '/instructor/student-hub', async ({ page, rec }) => {
        page.on('dialog', (d) => d.accept().catch(() => {}));
        await selectCourse(page);
        await page.goto(`/instructor/student-hub?courseId=${MAIN}`);
        await page.locator('#students-container .student-card').first().waitFor({ timeout: 25_000 });
        await page.locator('#survey-responses-container .survey-response-card').first().waitFor({ timeout: 10_000 }).catch(() => {});
        await page.waitForTimeout(800);
        rec.note('what the page rendered', await page.evaluate(() => ({
            studentCards: document.querySelectorAll('#students-container .student-card').length,
            taCards: document.querySelectorAll('#students-container .ta-card').length,
            surveyCards: document.querySelectorAll('#survey-responses-container .survey-response-card').length,
            lmsBarVisible: !!document.querySelector('#lms-grades-bar') && /** @type {HTMLElement} */ (document.querySelector('#lms-grades-bar')).offsetParent !== null,
        })));
        await pageShell(page, rec);
        await rec.capture(page, 'loaded-with-students');

        // Enrolment toggle enables the card's Save button.
        const card = page.locator(`#students-container .student-card:has(#save-${STUDENT_2.userId})`).first();
        const toggle = card.locator('.enroll-toggle input');
        await rec.graphic('enrolment toggle (on)', card.locator('.enroll-toggle'), { pad: 3 });
        await rec.state(page, 'enrolment-changed-unsaved', async () => {
            await card.locator('.enroll-toggle').click();
            await page.waitForTimeout(300);
        });
        await rec.graphic('enrolment toggle (off)', card.locator('.enroll-toggle'), { pad: 3 });
        rec.note('enrolment toggle as a control', await toggle.evaluate((el) => ({
            type: el.getAttribute('type'), role: el.getAttribute('role'), checked: /** @type {HTMLInputElement} */ (el).checked,
            labelText: /** @type {HTMLInputElement} */ (el).labels && /** @type {HTMLInputElement} */ (el).labels[0] ? /** @type {HTMLInputElement} */ (el).labels[0].textContent.trim() : null,
        })).catch((e) => ({ error: String(e) })));
        const saved = await rec.status('save a student\'s enrolment (announcement)', page, () => page.locator(`#save-${STUDENT_2.userId}`).click(), { watchMs: 6500 });
        if (saved) {
            const text = saved.announcements.map((a) => a.text).join(' | ');
            // House rule: a message names the thing by the name the user sees on screen.
            rec.note('what the enrolment message calls the student', { announced: text, usesInternalId: text.includes(STUDENT_2.userId), nameOnScreen: STUDENT_2.displayName }, text.includes(STUDENT_2.userId));
        }
        await rec.capture(page, 'after-saving-enrolment');
        await rec.step('change the toggle back', () => card.locator('.enroll-toggle').click());
        await rec.focus('"Save" on a student card (the button is disabled again afterwards)', page.locator(`#save-${STUDENT_2.userId}`), { settleMs: 2000 });

        // Survey responses: a download menu button and a filter.
        await rec.disclosure('"Download" survey responses menu button', page.locator('#download-survey-responses'), { scope: '.download-dropdown, .survey-responses-header, section, body' });
        await rec.state(page, 'survey-download-menu-open', async () => {
            await page.locator('#download-survey-responses').click();
            await page.locator('#download-menu-survey-responses.open').waitFor({ state: 'visible', timeout: 4000 });
        });
        rec.note('focus when the survey download menu opens', await page.evaluate(() => {
            const a = document.activeElement;
            return { insideMenu: !!a && !!a.closest('#download-menu-survey-responses'), on: a && a !== document.body ? (a.id || a.className) : 'body' };
        }));
        await rec.step('close the menu', () => page.keyboard.press('Escape'));
        await rec.status('change the survey status filter (is the result announced?)', page, async () => {
            await page.locator('#survey-status-filter').selectOption({ index: 1 });
        }, { watchMs: 3000 });
        await rec.capture(page, 'survey-filtered');
        await rec.focus('"Refresh" survey responses (the list re-renders)', page.locator('#refresh-survey-responses'), { settleMs: 2000 });

        // Promote a student: the whole list is rebuilt.
        const promote = page.locator(`#students-container .student-card:has(#save-${STUDENT_2.userId}) .btn-primary`).filter({ hasText: /TA/i }).first();
        await rec.focus('"Promote to TA" (confirm, then the list is rebuilt)', promote, { settleMs: 2500 });
        await rec.capture(page, 'after-promoting-a-student');

        await toastStates(page, rec);
        const lmsBar = await page.locator('#lms-grades-bar').isVisible().catch(() => false);
        if (lmsBar) {
            await rec.capture(page, 'lms-grades-bar', { root: '#lms-grades-bar' });
            rec.notCovered('the LMS grades bar actions (link course, match students, import grades, drop unmatched) and the unmatched-students panel',
                'the bar itself is rendered and audited as it loads; its buttons call the configured LMS and write grades and roster matches, so they were not pressed');
        } else {
            rec.notCovered('the LMS grades bar (link course, match students, import grades, unmatched-students panel)',
                'it only renders when a Canvas or Moodle grade source is configured for the deployment; none was configured for this run');
        }
    });

    auditTest(test, '/instructor/student-hub', async ({ page, rec }) => {
        // System admins get one more control and a dialog: the anonymization ID manager.
        await setSystemAdmin(ids.instructorId, true);
        try {
            await selectCourse(page);
            await page.goto(`/instructor/student-hub?courseId=${MAIN}`);
            await page.locator('#students-container .student-card').first().waitFor({ timeout: 25_000 });
            await page.waitForTimeout(800);
            const opener = page.locator('#open-pseudonym-manager');
            await rec.dialog(page, 'dialog-anonymization-ids', {
                root: '#pseudonym-manager', trigger: opener,
                open: () => opener.click(),
                close: () => page.locator('#close-pseudonym-manager').click(),
            });
            await rec.state(page, 'survey-download-menu-open-as-admin', async () => {
                await page.locator('#download-survey-responses').click();
                await page.locator('#download-menu-survey-responses.open').waitFor({ state: 'visible', timeout: 4000 });
            });
        } finally {
            await setSystemAdmin(ids.instructorId, wasAdmin);
        }
    }, { variant: 'system-admin' });

    auditTest(test, '/instructor/student-hub', async ({ page, rec }) => {
        await selectCourse(page);
        await stubEmptyLists(page, /\/api\/courses\/[^/]+\/students$|\/api\/chat\/survey\/course\//);
        await page.goto(`/instructor/student-hub?courseId=${MAIN}`);
        await page.waitForTimeout(2500);
        await rec.capture(page, 'no-students');
    }, { variant: 'empty' });

    // -------------------------------------------------------------- TA hub
    auditTest(test, '/instructor/ta-hub', async ({ page, rec }) => {
        page.on('dialog', (d) => d.accept().catch(() => {}));
        await selectCourse(page);
        await page.goto(`/instructor/ta-hub?courseId=${MAIN}`);
        await page.locator('#tas-container .ta-card').first().waitFor({ timeout: 25_000 });
        await page.locator('#tas-container .permission-toggle').first().waitFor({ timeout: 10_000 }).catch(() => {});
        await page.waitForTimeout(800);
        rec.note('what the page rendered', await page.evaluate(() => ({
            taCards: document.querySelectorAll('#tas-container .ta-card').length,
            permissionToggles: document.querySelectorAll('#tas-container .permission-toggle').length,
            courseRows: document.querySelectorAll('#course-tas-container .course-ta-item').length,
        })));
        await pageShell(page, rec);
        await rec.capture(page, 'loaded-with-tas');

        const card = page.locator(`#tas-container .ta-card[data-ta-id="${TA_2.userId}"]`);
        // Permission switches save as soon as they change.
        const firstToggle = card.locator('.permission-toggle').first();
        await rec.graphic('permission toggle (as loaded)', firstToggle, { pad: 3 });
        await rec.status('change one TA permission (announcement)', page, () => firstToggle.locator('input').first().click({ force: true }), { watchMs: 6500 });
        await rec.graphic('permission toggle (after changing it)', card.locator('.permission-toggle').first(), { pad: 3 });
        await rec.capture(page, 'after-changing-a-permission');
        await rec.focus('permission toggle from the keyboard (Space; do the cards re-render?)', card.locator('.permission-toggle input').nth(1), { key: 'Space', settleMs: 2000 });
        await rec.status('change the role preset (announcement)', page, async () => {
            await card.locator('.role-preset-picker select').selectOption({ index: 1 });
        }, { watchMs: 6500 });
        await rec.capture(page, 'after-changing-role-preset');

        // Search filters the cards as you type.
        await rec.status('type in the TA search (is the number of matches announced?)', page, async () => {
            await page.locator('#ta-search-input').fill('Two');
        }, { watchMs: 2500 });
        await rec.capture(page, 'search-one-match');
        await rec.state(page, 'search-no-match', async () => {
            await page.locator('#ta-search-input').fill('zzzz-no-such-ta');
            await page.waitForTimeout(400);
        });
        await rec.graphic('search "clear" control', page.locator('#ta-search-clear'));
        await rec.focus('search "clear" (the control hides itself)', page.locator('#ta-search-clear'), { settleMs: 700 });

        // Remove a TA: a confirm dialog, then the card goes.
        const remove = card.locator('.btn-danger').first();
        await rec.dialog(page, 'dialog-remove-ta', {
            root: '#remove-ta-modal', trigger: remove,
            open: () => remove.click(),
            close: () => page.locator('#remove-ta-modal .btn-secondary').first().click(),
        });
        await rec.step('remove the synthetic TA for real', async () => {
            await remove.click();
            await page.locator('#remove-ta-modal').waitFor({ state: 'visible', timeout: 5000 });
            await page.locator('#confirm-remove-ta').focus();
            await page.keyboard.press('Enter');
            await page.waitForTimeout(2500);
        });
        rec.note('focus after confirming "Remove" (the TA\'s card is removed)', await page.evaluate(() => {
            const a = document.activeElement;
            const onBody = !a || a === document.body;
            return { lost: onBody, active: onBody ? 'body' : (a.id || a.className || a.tagName), cardsLeft: document.querySelectorAll('#tas-container .ta-card').length };
        }), await page.evaluate(() => !document.activeElement || document.activeElement === document.body));
        await rec.capture(page, 'after-removing-a-ta');

        await toastStates(page, rec);
    });

    auditTest(test, '/instructor/ta-hub', async ({ page, rec }) => {
        await selectCourse(page);
        await stubEmptyLists(page, '**/api/auth/tas');
        await page.goto(`/instructor/ta-hub?courseId=${MAIN}`);
        await page.waitForTimeout(2500);
        await rec.capture(page, 'no-tas');
    }, { variant: 'empty' });
});
