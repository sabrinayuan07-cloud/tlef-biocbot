// @ts-check
/**
 * Accessibility audit of /instructor/chat (Super Chat) and /instructor/notes.
 *
 * An audit, not a gate: findings are written to a11y-results/other-pages/raw/
 * and nothing here fails the build.
 */
const { test } = require('@playwright/test');
const { storageStatePath } = require('../e2e/helpers/users');
const { auditTest, toastStates, pageShell, stubEmptyLists, queueLlmReplies } = require('./helpers/audit-recorder');
const {
    seedAuditData, cleanupAuditData, cleanupUiRowsSince, readSetting, restoreSetting, enableInstructorSuperChat, SUPER_SETTINGS_ID,
} = require('./helpers/audit-seed');

test.describe('Audit: instructor Super Chat and notes', () => {
    test.use({ storageState: storageStatePath('instructor'), viewport: { width: 1440, height: 1000 } });

    let originalSuperSettings;
    const startedAt = new Date();
    test.beforeAll(async () => {
        await seedAuditData();
        // The course pool answers 403 without a Super Chat key; put one in for
        // the audit and restore whatever was there afterwards.
        originalSuperSettings = await readSetting(SUPER_SETTINGS_ID);
        await enableInstructorSuperChat();
    });
    test.afterAll(async () => {
        await restoreSetting(SUPER_SETTINGS_ID, originalSuperSettings);
        await cleanupUiRowsSince(startedAt);
        await cleanupAuditData();
    });

    auditTest(test, '/instructor/chat', async ({ page, rec }) => {
        page.on('dialog', (d) => d.accept().catch(() => {}));
        await page.addInitScript(() => {
            try {
                for (const key of Object.keys(localStorage)) if (key.startsWith('biocbot_instructor_super')) localStorage.removeItem(key);
            } catch (_) {}
        });
        await page.goto('/instructor/chat');
        await page.locator('#super-course-pool-list .super-course-pool-chip').first().waitFor({ timeout: 25_000 }).catch(() => {});
        await page.waitForTimeout(1200);
        rec.note('what the page rendered', await page.evaluate(() => ({
            poolChips: document.querySelectorAll('.super-course-pool-chip').length,
            poolError: !!document.querySelector('#super-course-pool-panel.error'),
            historyItems: document.querySelectorAll('.super-course-history-item').length,
            historyExpanded: document.querySelector('#toggle-super-course-history')?.getAttribute('aria-expanded'),
        })));
        await pageShell(page, rec);
        await rec.capture(page, 'loaded');

        // History panel: a show/hide control.
        await rec.disclosure('"Super Chat History" toggle', page.locator('#toggle-super-course-history'), { scope: '#super-course-history-panel' });
        await rec.state(page, 'history-open', async () => {
            const toggle = page.locator('#toggle-super-course-history');
            if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
            await page.locator('.super-course-history-item').first().waitFor({ state: 'visible', timeout: 8000 });
        });
        await rec.graphic('history caret glyph', page.locator('.super-course-history-caret'));
        await rec.graphic('"Refresh history" icon', page.locator('#refresh-super-course-history'));
        await rec.focus('"Refresh history" (list re-renders)', page.locator('#refresh-super-course-history'), { settleMs: 1500 });

        // Answer-depth picker: a button that opens a listbox.
        await rec.disclosure('answer depth trigger', page.locator('#answer-level-trigger'), { scope: '#answer-level-selector' });
        await rec.state(page, 'answer-depth-menu-open', async () => {
            await page.locator('#answer-level-trigger').click();
            await page.locator('#answer-level-menu').waitFor({ state: 'visible', timeout: 4000 });
        });
        await rec.note('answer depth listbox when open', await page.evaluate(() => {
            const active = document.activeElement;
            return {
                focusOn: active ? `${active.tagName.toLowerCase()}${active.id ? `#${active.id}` : ''}.${active.className}` : null,
                focusInsideMenu: !!active && !!active.closest('#answer-level-menu'),
                selected: document.querySelectorAll('#answer-level-menu [aria-selected="true"]').length,
            };
        }));
        await rec.step('choose an answer depth with the keyboard', async () => {
            await page.keyboard.press('ArrowDown');
            await page.keyboard.press('Enter');
            await page.waitForTimeout(300);
        });
        rec.note('focus after choosing an answer depth', await page.evaluate(() => {
            const active = document.activeElement;
            return { active: active && active !== document.body ? (active.id || active.className) : 'body', menuStillOpen: !document.querySelector('#answer-level-menu')?.hasAttribute('hidden') };
        }), await page.evaluate(() => !document.activeElement || document.activeElement === document.body));
        await rec.step('close the answer depth menu', () => page.keyboard.press('Escape'));

        // Send a message; the reply arrives in a role="log" region.
        await rec.status('send a message and receive a reply (announcements)', page, async () => {
            await queueLlmReplies(page, ['Enzyme kinetics is covered in Audit Biochemistry 201, Unit 2.']);
            await page.locator('#instructor-chat-input').fill('Which course covers enzyme kinetics?');
            await page.locator('#send-button').click();
            await page.locator('#chat-messages .bot-message:not(.pending-message)').last().waitFor({ timeout: 20_000 });
        }, { watchMs: 3000 });
        rec.note('messages after one exchange', await page.evaluate(() => ({
            user: document.querySelectorAll('#chat-messages .user-message').length,
            bot: document.querySelectorAll('#chat-messages .bot-message').length,
            error: document.querySelectorAll('#chat-messages .error-message').length,
            flagButtons: document.querySelectorAll('#chat-messages .flag-button').length,
        })));
        await rec.capture(page, 'after-one-exchange');
        await queueLlmReplies(page, ['It is also introduced in Audit Cell Biology 110.']).catch(() => {});
        await page.locator('#instructor-chat-input').fill('Anywhere else?').catch(() => {});
        await rec.focus('"Send message" (the request is in flight)', page.locator('#send-button'), { settleMs: 2500 });
        await rec.graphic('"Send message" icon', page.locator('#send-button'));

        // Flag a reply: a menu button on each bot message.
        const flagButton = page.locator('#chat-messages .flag-button').last();
        await rec.disclosure('flag menu button on a reply', flagButton, { scope: '.message' });
        await rec.state(page, 'flag-menu-open', async () => {
            await flagButton.click();
            await page.locator('#chat-messages .flag-menu.show').first().waitFor({ state: 'visible', timeout: 4000 });
        });
        await rec.focus('choose a flag reason (the reply is replaced by a thank-you)', page.locator('#chat-messages .flag-menu.show .flag-option').first(), { settleMs: 1500 });
        await rec.capture(page, 'after-flagging-a-reply');

        // Saved sessions: Continue loads one, Delete removes one.
        await rec.status('"Continue" a saved session (announcement)', page, async () => {
            const toggle = page.locator('#toggle-super-course-history');
            if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
            await page.locator('.super-course-history-item .super-course-history-action.primary').first().click();
        }, { watchMs: 6500 });
        await rec.capture(page, 'after-continuing-a-session');
        await rec.focus('"Delete" a saved session (the item is removed)',
            page.locator('.super-course-history-item .super-course-history-action:not(.primary)').first(), { settleMs: 2000 });
        await rec.focus('"+ New" (the conversation is cleared)', page.locator('#new-super-course-chat'), { settleMs: 1500 });
        await rec.capture(page, 'after-new-chat');

        await toastStates(page, rec);
    });

    auditTest(test, '/instructor/chat', async ({ page, rec }) => {
        await page.addInitScript(() => {
            try {
                for (const key of Object.keys(localStorage)) if (key.startsWith('biocbot_instructor_super')) localStorage.removeItem(key);
            } catch (_) {}
        });
        await page.route('**/api/instructor/chat/pool', (route) => route.fulfill({
            status: 403, contentType: 'application/json', body: JSON.stringify({ success: false, message: 'Super Chat is not configured yet.' }),
        }));
        await stubEmptyLists(page, '**/api/instructor/chat/sessions');
        await page.goto('/instructor/chat');
        await page.waitForTimeout(2000);
        await rec.step('open the history panel', async () => {
            const toggle = page.locator('#toggle-super-course-history');
            if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
        });
        await rec.capture(page, 'pool-error-and-empty-history');
    }, { variant: 'not-configured' });

    auditTest(test, '/instructor/notes', async ({ page, rec }) => {
        page.on('dialog', (d) => d.accept().catch(() => {}));
        await page.goto('/instructor/notes');
        await page.locator('.note-card').first().waitFor({ timeout: 25_000 });
        await page.waitForTimeout(800);
        rec.note('what the page rendered', await page.evaluate(() => ({
            cards: document.querySelectorAll('.note-card').length,
            mine: document.querySelectorAll('.note-card.mine').length,
            sectionHeadings: [...document.querySelectorAll('.notes-section-heading')].map((h) => `${h.tagName.toLowerCase()}: ${h.textContent}`),
        })));
        await pageShell(page, rec);
        await rec.capture(page, 'browse-with-notes');

        // The two hub cards switch panels like tabs.
        await rec.disclosure('hub card "Write a new note" (switches panel)', page.locator('#card-new'), { scope: 'main, .main-content, body' });
        await rec.focus('hub card "Write a new note"', page.locator('#card-new'), { settleMs: 700 });
        await rec.state(page, 'editor-empty', async () => {
            if (!(await page.locator('#panel-new').isVisible())) await page.locator('#card-new').click();
            await page.locator('#note-body').waitFor({ state: 'visible', timeout: 5000 });
        });
        await rec.status('"Save note" with nothing written (validation message)', page, () => page.locator('#save-note').click(), { watchMs: 3500 });
        await rec.capture(page, 'editor-validation-error');
        await page.evaluate(() => document.querySelectorAll('.notification .notification-close').forEach((b) => /** @type {HTMLElement} */ (b).click())).catch(() => {});

        await rec.state(page, 'editor-filled-with-tags', async () => {
            await page.locator('#note-title').fill('Km versus Vmax');
            await page.locator('#note-body').fill('Students often read Km as a binding affinity. Remind them it is the substrate concentration at half of Vmax, then work an example.');
            for (const tag of ['enzyme kinetics', 'common confusion']) {
                await page.locator('#tag-input').fill(tag);
                await page.locator('#tag-input').press('Enter');
            }
            await page.locator('#editor-tags .tag-chip').nth(1).waitFor({ timeout: 4000 });
            // Give the similar-note check (700 ms debounce) time to answer.
            await page.waitForTimeout(2200);
        });
        rec.note('duplicate warning', { shown: await page.locator('#dupe-warning.show').isVisible().catch(() => false) });
        await rec.status('add a tag (is it announced?)', page, async () => {
            await page.locator('#tag-input').fill('michaelis-menten');
            await page.locator('#tag-input').press('Enter');
        }, { watchMs: 2500 });
        await rec.graphic('tag remove (×) control', page.locator('#editor-tags .tag-chip > button').first());
        await rec.focus('remove a tag (the chip is removed)', page.locator('#editor-tags .tag-chip > button').first(), { settleMs: 700 });
        await rec.focus('"Cancel" in the editor (returns to the list)', page.locator('#cancel-note'), { settleMs: 900 });

        await rec.focus('"+ New note" in the page header (reveals the editor)', page.locator('#new-note-btn'), { settleMs: 900 });
        await rec.step('back to the list', () => page.locator('#card-browse').click());

        // Own notes: Edit opens the editor, Delete removes the card.
        await rec.focus('"Edit" on one of my notes (reveals the editor)', page.locator('.note-card.mine .note-actions .btn-secondary').first(), { settleMs: 900 });
        await rec.capture(page, 'editor-editing-existing-note');
        await rec.step('back to the list', async () => {
            await page.locator('#cancel-note').click();
            await page.locator('.note-card').first().waitFor({ state: 'visible', timeout: 5000 });
        });
        await rec.status('"Delete" one of my notes (announcement)', page, async () => {
            await page.locator('.note-card.mine .note-actions .btn-danger').first().click();
        }, { watchMs: 6500 });
        await rec.capture(page, 'after-deleting-a-note');
        await rec.focus('"Delete" on my remaining note (the card is removed)', page.locator('.note-card.mine .note-actions .btn-danger').first(), { settleMs: 2000 });

        await toastStates(page, rec);
        rec.notCovered('saving a new note and the "similar note already exists" warning',
            'saving needs the notes LLM key and a vector store; the warning only appears when the similarity service returns a match');
    });

    auditTest(test, '/instructor/notes', async ({ page, rec }) => {
        await stubEmptyLists(page, /\/api\/superchat-notes(\?.*)?$/);
        await page.goto('/instructor/notes');
        await rec.state(page, 'no-notes-yet', () => page.locator('.notes-empty').waitFor({ timeout: 15_000 }));
    }, { variant: 'empty' });
});
