// @ts-check
/**
 * Accessibility audit of the student pages: /student (chat), /student/history,
 * /student/quiz, /student/flagged, /student/dashboard.html, /student/super-course.
 *
 * An audit, not a gate: findings are written to a11y-results/other-pages/raw/
 * and nothing here fails the build.
 *
 * Two things every test here does first:
 *  - answers the consent check as "already agreed", so the page is audited and
 *    not the blocking consent dialog (the dialog is audited on purpose, once);
 *  - blocks POST /api/auth/logout, so the student page's idle timer cannot end
 *    the shared test session while a long audit is running.
 */
const { test } = require('@playwright/test');
const { storageStatePath } = require('../e2e/helpers/users');
const { stubAgreementAccepted } = require('../e2e/helpers/agreement');
const { auditTest, toastStates, pageShell, stubEmptyLists, queueLlmReplies } = require('./helpers/audit-recorder');
const {
    MAIN, MAIN_NAME, BUCKET_A, seedAuditData, cleanupAuditData, cleanupUiRowsSince, patchMainCourse,
} = require('./helpers/audit-seed');

/** @param {import('@playwright/test').Page} page */
async function guard(page, { agreed = true } = {}) {
    await page.route('**/api/auth/logout', (route) => route.abort());
    if (agreed) await stubAgreementAccepted(page);
    page.on('dialog', (d) => d.accept().catch(() => {}));
}

/** @param {import('@playwright/test').Page} page @param {Record<string, string>} [extra] */
async function selectCourse(page, extra = {}) {
    await page.addInitScript(({ values }) => {
        if (sessionStorage.getItem('a11yAuditSeeded')) return;
        sessionStorage.setItem('a11yAuditSeeded', '1');
        try {
            localStorage.clear();
            for (const [k, v] of Object.entries(values)) localStorage.setItem(k, v);
        } catch (_) {}
    }, { values: { selectedCourseId: MAIN, selectedCourseName: MAIN_NAME, ...extra } });
}

async function llmRule(page, rule) {
    const payload = { ...rule, content: typeof rule.content === 'string' ? rule.content : JSON.stringify(rule.content) };
    const res = await page.request.post('/api/test/llm-stub/rule', { data: payload, failOnStatusCode: false });
    if (!res.ok()) throw new Error(`LLM stub rule failed: ${res.status()}`);
}

test.describe('Audit: student pages', () => {
    test.use({ storageState: storageStatePath('student'), viewport: { width: 1440, height: 1000 } });

    test.beforeEach(async ({ request }) => {
        await seedAuditData();
        await request.post('/api/test/llm-stub/reset', { failOnStatusCode: false });
    });
    const startedAt = new Date();
    test.afterAll(async ({ request }) => {
        await request.post('/api/test/llm-stub/reset', { failOnStatusCode: false });
        await cleanupUiRowsSince(startedAt);
        await cleanupAuditData();
    });

    // ------------------------------------------------------------ /student
    auditTest(test, '/student', async ({ page, rec }) => {
        await guard(page);
        await llmRule(page, { matchSystemPrompt: 'analyzing student struggle', content: { isStruggling: false, mappedTopic: 'unmapped', matchConfidence: 0 } });
        await llmRule(page, { matchMessage: 'Course context:', content: 'Glycolysis happens in the cytosol. It splits one glucose into two pyruvate and yields a net two ATP.' });
        await selectCourse(page, { selectedUnitName: 'Unit 2', studentMode: 'tutor' });
        await page.goto('/student');
        await page.locator('#chat-input:not([disabled])').waitFor({ timeout: 25_000 });
        await page.waitForTimeout(1000);
        await pageShell(page, rec);
        await rec.capture(page, 'chat-ready-no-messages');

        // Send two questions so the conversation has several messages in it.
        await rec.status('send a question and receive a reply (announcements)', page, async () => {
            await page.locator('#chat-input').fill('Where does glycolysis happen?');
            await page.locator('#chat-input').press('Enter');
            await page.locator('#chat-messages .bot-message .flag-button').first().waitFor({ timeout: 25_000 });
        }, { watchMs: 2500 });
        await rec.step('send a second question', async () => {
            const before = await page.locator('#chat-messages .bot-message .flag-button').count();
            await page.locator('#chat-input').fill('How much ATP does it make?');
            await page.locator('#chat-input').press('Enter');
            await page.waitForFunction((n) => document.querySelectorAll('#chat-messages .bot-message .flag-button').length > n, before, { timeout: 25_000 });
        });
        rec.note('conversation after two exchanges', await page.evaluate(() => ({
            messages: document.querySelectorAll('#chat-messages .message').length,
            inList: !!document.querySelector('#chat-messages ul > li .message, #chat-messages li.message'),
            messageHeadings: document.querySelectorAll('#chat-messages .message h2').length,
            liveRegion: { role: document.querySelector('#chat-messages')?.getAttribute('role'), live: document.querySelector('#chat-messages')?.getAttribute('aria-live') },
            flagButtons: document.querySelectorAll('#chat-messages .flag-button').length,
            feedbackButtons: document.querySelectorAll('#chat-messages .message-feedback-btn').length,
            actionButtons: document.querySelectorAll('#chat-messages .message-action-btn, #chat-messages .practice-question-btn').length,
        })));
        await rec.capture(page, 'chat-with-two-exchanges');
        await page.locator('#chat-input').fill('One more thing').catch(() => {});
        await rec.focus('"Send" (the request is in flight)', page.locator('#send-button, .send-button, #chat-form button[type="submit"]').first(), { settleMs: 3500 });

        // Per-message controls.
        const flagButton = page.locator('#chat-messages .bot-message .flag-button').last();
        await rec.disclosure('flag menu button on a reply', flagButton, { scope: '.message' });
        await rec.state(page, 'flag-menu-open', async () => {
            await flagButton.click();
            await page.locator('#chat-messages .flag-menu.show').first().waitFor({ state: 'visible', timeout: 4000 });
        });
        await rec.graphic('flag button icon', flagButton);
        const feedback = page.locator('#chat-messages .message-feedback-btn').first();
        if (await feedback.count()) {
            const before = await feedback.getAttribute('aria-pressed').catch(() => null);
            await rec.focus('thumbs-up feedback on a reply', feedback, { settleMs: 1200 });
            rec.note('feedback button state', { ariaPressedBefore: before, ariaPressedAfter: await page.locator('#chat-messages .message-feedback-btn').first().getAttribute('aria-pressed').catch(() => null) },
                before === null);
            await rec.graphic('feedback (thumbs) icon', page.locator('#chat-messages .message-feedback-btn').first());
        }
        await rec.step('open the flag menu again', async () => {
            if (!(await page.locator('#chat-messages .flag-menu.show').count())) await flagButton.click();
        });
        await rec.status('flag a reply (announcement)', page, () => page.locator('#chat-messages .flag-menu.show .flag-option').first().click(), { watchMs: 4000 });
        await rec.capture(page, 'after-flagging-a-reply');

        // Mode switch and unit picker.
        await rec.graphic('Tutor/Protégé mode switch', page.locator('.mode-toggle-container').first(), { pad: 2 });
        rec.note('mode switch as a control', await page.locator('#mode-toggle-checkbox').evaluate((el) => ({
            type: el.getAttribute('type'), role: el.getAttribute('role'), checked: /** @type {HTMLInputElement} */ (el).checked,
            label: /** @type {HTMLInputElement} */ (el).labels && /** @type {HTMLInputElement} */ (el).labels[0] ? /** @type {HTMLInputElement} */ (el).labels[0].textContent.trim().replace(/\s+/g, ' ') : null,
            ariaLabel: el.getAttribute('aria-label'),
        })).catch((e) => ({ error: String(e) })));
        await rec.status('switch to Protégé mode (is the change announced?)', page, async () => {
            await page.locator('#mode-toggle-checkbox').focus();
            await page.keyboard.press('Space');
        }, { watchMs: 3500 });
        await rec.capture(page, 'protege-mode');

        // Dialogs the chat page can raise.
        await rec.dialog(page, 'dialog-chat-limit-info', {
            root: '#chat-limit-modal-overlay',
            open: () => page.evaluate(() => /** @type {any} */ (window).showChatLimitModal()),
            close: () => page.locator('#close-info-modal-btn').click(),
        });
        const rules = page.locator('#view-rules-link, [data-open-full-disclaimer], .ai-use-disclaimer-link').first();
        await rec.dialog(page, 'dialog-ai-use-rules-read-only', {
            root: '#agreement-modal-overlay', trigger: rules,
            open: async () => {
                if (await rules.isVisible().catch(() => false)) await rules.click();
                else await page.evaluate(() => /** @type {any} */ (window).agreementModal.show(true));
            },
            close: () => page.locator('#close-modal-btn').click(),
        });

        // New session: the conversation is thrown away and rebuilt.
        await rec.focus('"New session" (confirm, then the conversation is rebuilt)', page.locator('#new-session-btn'), { settleMs: 2500 });
        await rec.capture(page, 'after-new-session');

        await toastStates(page, rec);
        rec.notCovered('"Explain"/practice-question follow-ups, the chat summary offer (after 25 messages), the chat-limit warning link at 13 messages, struggle "directive mode", downloadable source links',
            'each needs a long conversation or specific model output; not driven');
    });

    auditTest(test, '/student', async ({ page, rec }) => {
        // A unit with assessment questions starts with calibration questions.
        await guard(page);
        await selectCourse(page, { selectedUnitName: 'Unit 1', studentMode: 'tutor' });
        await page.goto('/student');
        // The page opens on the welcome message and waits for a unit to be picked.
        await page.locator('#unit-select').waitFor({ state: 'visible', timeout: 25_000 });
        await page.waitForTimeout(800);
        await rec.capture(page, 'welcome-pick-a-unit');
        await rec.status('pick a unit that has questions (is the first question announced?)', page, async () => {
            await page.locator('#unit-select').selectOption('Unit 1');
            await page.locator('.calibration-question').first().waitFor({ timeout: 20_000 });
        }, { watchMs: 2000 });
        const started = await rec.step('wait for the first calibration question', () => page.locator('.calibration-question').first().waitFor({ timeout: 10_000 }));
        if (!started) {
            rec.note('what the chat showed instead of calibration', await page.evaluate(() => ({
                text: (document.querySelector('#chat-messages')?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 400),
                unit: /** @type {HTMLSelectElement|null} */ (document.querySelector('#unit-select'))?.value,
                units: [.../** @type {HTMLSelectElement} */ (document.querySelector('#unit-select') || { options: [] }).options].map((o) => o.value),
                stored: { unit: localStorage.getItem('selectedUnitName'), course: localStorage.getItem('selectedCourseId') },
            })).catch((e) => ({ error: String(e) })));
            await rec.capture(page, 'unit-with-questions-as-loaded');
            return;
        }
        await page.waitForTimeout(800);
        rec.note('calibration as rendered', await page.evaluate(() => ({
            questions: document.querySelectorAll('.calibration-question').length,
            options: document.querySelectorAll('.calibration-option').length,
            chatInputHidden: !document.querySelector('.chat-input-container') || /** @type {HTMLElement} */ (document.querySelector('.chat-input-container')).offsetParent === null,
        })));
        await rec.capture(page, 'calibration-first-question');
        for (let i = 0; i < 4; i += 1) {
            const option = page.locator('.calibration-question:last-of-type .calibration-option:not([disabled])').first();
            const text = page.locator('.calibration-answer-input:not([disabled])').last();
            if (await option.isVisible().catch(() => false)) {
                await rec.focus(`answer calibration question ${i + 1} (option button; the options are then disabled)`, option, { settleMs: 2000 });
            } else if (await text.isVisible().catch(() => false)) {
                await queueLlmReplies(page, ['{"correct":true,"feedback":"That is right."}']).catch(() => {});
                await text.fill('A peptide bond.');
                await rec.capture(page, 'calibration-short-answer-question');
                await rec.focus(`submit calibration question ${i + 1} (short answer)`, page.locator('.calibration-submit-btn:not([disabled])').last(), { settleMs: 3000 });
            } else break;
            await rec.capture(page, `calibration-after-answer-${i + 1}`);
        }
        rec.note('after calibration', await page.evaluate(() => ({
            result: !!document.querySelector('.mode-result'),
            chatInputEnabled: !!document.querySelector('#chat-input') && !/** @type {HTMLInputElement} */ (document.querySelector('#chat-input')).disabled,
        })));
    }, { variant: 'calibration' });

    auditTest(test, '/student', async ({ page, rec }) => {
        // No course chosen yet: the course picker.
        await guard(page);
        await page.addInitScript(() => { try { localStorage.clear(); } catch (_) {} });
        await page.goto('/student');
        await rec.state(page, 'course-picker', () => page.locator('#course-selection-wrapper, #course-select').first().waitFor({ state: 'visible', timeout: 20_000 }));
    }, { variant: 'no-course-chosen' });

    auditTest(test, '/student', async ({ page, rec }) => {
        // First visit: the consent dialog blocks the page until the box is ticked.
        await guard(page, { agreed: false });
        await page.route('**/api/user-agreement/status', (route) => route.fulfill({
            status: 200, contentType: 'application/json',
            body: JSON.stringify({ success: true, data: { hasAgreed: false, agreementVersion: '1.0', agreedAt: null } }),
        }));
        await page.route('**/api/user-agreement/agree', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) }));
        await selectCourse(page, { selectedUnitName: 'Unit 2', studentMode: 'tutor' });
        await page.goto('/student');
        await page.locator('#agreement-modal').waitFor({ state: 'visible', timeout: 20_000 });
        await page.waitForTimeout(600);
        rec.note('consent dialog', await page.evaluate(() => {
            const dlg = document.querySelector('#agreement-modal');
            const a = document.activeElement;
            return {
                role: dlg?.getAttribute('role'), ariaModal: dlg?.getAttribute('aria-modal'),
                labelledby: dlg?.getAttribute('aria-labelledby'), insideNativeDialog: !!dlg?.closest('dialog'),
                focusInside: !!a && !!dlg && dlg.contains(a), focusOn: a && a !== document.body ? (a.id || a.tagName) : 'body',
                agreeDisabled: /** @type {HTMLButtonElement|null} */ (document.querySelector('#agree-btn'))?.disabled,
            };
        }));
        await rec.capture(page, 'consent-dialog', { root: '#agreement-modal-overlay' });
        await rec.graphic('consent checkbox', page.locator('#agreement-checkbox'), { pad: 3 });
        await rec.state(page, 'consent-dialog-box-ticked', () => page.locator('#agreement-checkbox').check(), { root: '#agreement-modal-overlay' });
        await rec.focus('"I agree" (the dialog closes)', page.locator('#agree-btn'), { settleMs: 1500 });
    }, { variant: 'first-visit-consent' });

    auditTest(test, '/student', async ({ page, rec }) => {
        // Idle warning: set a 20 s timeout on the course so the warning shows at 10 s.
        await guard(page);
        await patchMainCourse({ 'prompts.studentIdleTimeout': 20 });
        try {
            await selectCourse(page, { selectedUnitName: 'Unit 2', studentMode: 'tutor' });
            await page.goto('/student');
            await page.locator('#chat-input').waitFor({ timeout: 20_000 });
            const shown = await rec.step('wait for the idle warning', () => page.locator('#idle-timeout-modal').waitFor({ state: 'visible', timeout: 30_000 }));
            if (shown) {
                rec.note('idle warning dialog', await page.evaluate(() => {
                    const root = document.querySelector('#idle-timeout-modal');
                    const dlg = root?.querySelector('[role="alertdialog"], [role="dialog"]') || root?.closest('dialog');
                    const a = document.activeElement;
                    return {
                        role: dlg?.getAttribute('role') || null, ariaModal: dlg?.getAttribute('aria-modal') || null,
                        named: !!(dlg?.getAttribute('aria-labelledby') || dlg?.getAttribute('aria-label')),
                        insideNativeDialog: !!root?.closest('dialog'), focusInside: !!a && !!root && root.contains(a),
                        focusOn: a && a !== document.body ? (a.id || a.tagName) : 'body',
                        countdownLive: document.querySelector('#idle-countdown-display')?.closest('[aria-live], [role="timer"], [role="status"], [role="alert"]')?.getAttribute('aria-live') || null,
                    };
                }));
                await rec.capture(page, 'idle-warning-dialog', { root: '#idle-timeout-modal', settleMs: 100 });
                await rec.focus('"Stay signed in" (the dialog closes)', page.locator('#idle-stay-btn'), { settleMs: 800 });
            }
        } finally {
            await patchMainCourse({ 'prompts.studentIdleTimeout': null });
        }
        rec.notCovered('how long the idle warning gives before signing out (WCAG 2.2.1 Timing Adjustable)', 'needs a judgement about the real timeout values, not a check of this 20-second test setting');
    }, { variant: 'idle-warning' });

    auditTest(test, '/student', async ({ page, rec }) => {
        // End-of-chat survey: turned on for the course, then triggered on a restored conversation.
        await guard(page);
        await patchMainCourse({ chatSurveySettings: { enabled: true, triggerMessageCount: 2 } });
        try {
            await llmRule(page, { matchSystemPrompt: 'analyzing student struggle', content: { isStruggling: false, mappedTopic: 'unmapped', matchConfidence: 0 } });
            await llmRule(page, { matchMessage: 'Course context:', content: 'Glycolysis happens in the cytosol.' });
            await selectCourse(page, { selectedUnitName: 'Unit 2', studentMode: 'tutor' });
            await page.goto('/student');
            await page.locator('#chat-input:not([disabled])').waitFor({ timeout: 25_000 });
            await page.waitForTimeout(800);
            for (const q of ['Where does glycolysis happen?', 'How much ATP does it make?']) {
                const before = await page.locator('#chat-messages .bot-message .flag-button').count();
                await page.locator('#chat-input').fill(q);
                await page.locator('#chat-input').press('Enter');
                await page.waitForFunction((n) => document.querySelectorAll('#chat-messages .bot-message .flag-button').length > n, before, { timeout: 25_000 }).catch(() => {});
                if (await page.locator('#chat-survey-overlay').isVisible().catch(() => false)) break;
            }
            await page.evaluate(() => /** @type {any} */ (window).maybeShowChatSurvey && /** @type {any} */ (window).maybeShowChatSurvey()).catch(() => {});
            await rec.dialog(page, 'dialog-chat-survey', {
                root: '#chat-survey-overlay',
                open: async () => {},
                close: () => page.locator('#chat-survey-overlay .chat-survey-close').click(),
                inside: async () => {
                    rec.note('survey rating controls', await page.evaluate(() => {
                        const modal = document.querySelector('#chat-survey-overlay');
                        return {
                            radios: modal?.querySelectorAll('input[type="radio"]').length, buttons: modal?.querySelectorAll('button').length,
                            fieldsets: modal?.querySelectorAll('fieldset').length, legends: modal?.querySelectorAll('legend').length,
                            ariaPressed: modal?.querySelectorAll('[aria-pressed]').length, radiogroups: modal?.querySelectorAll('[role="radiogroup"]').length,
                        };
                    }));
                    await rec.graphic('survey close (×) control', page.locator('#chat-survey-overlay .chat-survey-close'));
                },
            });
        } finally {
            await patchMainCourse({ chatSurveySettings: null });
        }
    }, { variant: 'chat-survey' });

    auditTest(test, '/student', async ({ page, rec }) => {
        // First-run guided tour: answered from a stub so the shared test account is not changed.
        await guard(page);
        await page.route('**/api/auth/me', async (route) => {
            try {
                const response = await route.fetch();
                const body = await response.json();
                const user = body.user || (body.data && body.data.user) || body.data || body;
                if (user && typeof user === 'object') user.studentOnboardingComplete = false;
                await route.fulfill({ response, json: body });
            } catch (_) { await route.continue().catch(() => {}); }
        });
        await page.route('**/api/auth/student-onboarding/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) }));
        // Start with no course chosen: the tour's first step is choosing one.
        await page.addInitScript(() => {
            if (sessionStorage.getItem('a11yAuditSeeded')) return;
            sessionStorage.setItem('a11yAuditSeeded', '1');
            try { localStorage.clear(); } catch (_) {}
        });
        await page.goto('/student');
        const shown = await rec.step('wait for the guided tour', () => page.locator('.student-tour-card').waitFor({ state: 'visible', timeout: 20_000 }));
        if (!shown) return;
        const describeStep = (n) => page.evaluate(() => {
            const card = document.querySelector('.student-tour-card');
            const next = /** @type {HTMLButtonElement|null} */ (document.querySelector('.student-tour-next'));
            const a = document.activeElement;
            return {
                role: card?.getAttribute('role'), ariaModal: card?.getAttribute('aria-modal'), labelledby: card?.getAttribute('aria-labelledby'),
                title: document.querySelector('#student-tour-title')?.textContent, focusInsideCard: !!a && !!card && card.contains(a),
                focusOn: a && a !== document.body ? (a.id || a.className || a.tagName) : 'body',
                nextText: next ? next.textContent.trim() : null, nextDisabled: next ? next.disabled : null,
                shadeBlocksPage: !!document.querySelector('.student-tour-shade'),
                cardAfterTargetInDom: (() => { const t = document.querySelector('.student-tour-target'); return t && card ? !!(t.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING) : null; })(),
            };
        }).then((data) => rec.note(`guided tour step ${n}`, data));
        const title = () => page.locator('#student-tour-title').textContent().catch(() => '');

        await describeStep(1);
        await rec.capture(page, 'guided-tour-step-1-choose-course', { root: '.student-tour-card' });
        await rec.capture(page, 'guided-tour-step-1-whole-page');
        await rec.status('complete tour step 1 by choosing a course (is the next step announced?)', page, async () => {
            await page.locator('#course-select').selectOption(MAIN);
            await page.waitForFunction(() => /unit/i.test(document.querySelector('#student-tour-title')?.textContent || ''), null, { timeout: 15_000 });
        }, { watchMs: 2500 });
        if (/unit/i.test(await title())) {
            await describeStep(2);
            await rec.capture(page, 'guided-tour-step-2-choose-unit', { root: '.student-tour-card' });
            await rec.step('choose a unit', async () => {
                await page.locator('#unit-select').selectOption('Unit 2');
                await page.waitForFunction(() => /tutor/i.test(document.querySelector('#student-tour-title')?.textContent || ''), null, { timeout: 15_000 });
            });
        }
        if (/tutor/i.test(await title())) {
            await describeStep(3);
            await rec.capture(page, 'guided-tour-step-3-mode', { root: '.student-tour-card' });
            await rec.capture(page, 'guided-tour-step-3-whole-page');
            await rec.reach('tour "next" button from the highlighted control', page, page.locator('.student-tour-next'),
                { from: page.locator('.student-tour-target').first(), maxTabs: 25 });
        }
        rec.notCovered('guided tour steps 4 to 8 (Chat History, Flagged Messages, Topic Dashboard, Quiz, Flashcards)',
            'each is the same tour card on another page; moving between pages needs the tour progress saved on the real account, which this audit stubs so the shared test student is not changed');
    }, { variant: 'guided-tour' });

    // ----------------------------------------------------- /student/history
    auditTest(test, '/student/history', async ({ page, rec }) => {
        await guard(page);
        await selectCourse(page);
        await page.goto('/student/history');
        await page.locator('.chat-history-item').first().waitFor({ timeout: 25_000 });
        await page.waitForTimeout(700);
        rec.note('what the page rendered', await page.evaluate(() => ({
            items: document.querySelectorAll('.chat-history-item').length,
            itemTag: document.querySelector('.chat-history-item')?.tagName.toLowerCase(),
            itemRole: document.querySelector('.chat-history-item')?.getAttribute('role'),
            itemTabindex: document.querySelector('.chat-history-item')?.getAttribute('tabindex'),
            listTag: document.querySelector('#chat-history-list')?.tagName.toLowerCase(),
            listRole: document.querySelector('#chat-history-list')?.getAttribute('role'),
        })));
        await pageShell(page, rec);
        await rec.capture(page, 'loaded-with-saved-chats');

        // The list is one Tab stop; arrow keys change which chat is selected (history.js).
        const list = page.locator('#chat-history-list');
        rec.note('the history list as a keyboard widget', await list.evaluate((el) => ({
            role: el.getAttribute('role'), tabindex: el.getAttribute('tabindex'), name: el.getAttribute('aria-label') || el.getAttribute('aria-labelledby'),
            activedescendant: el.getAttribute('aria-activedescendant'),
            itemsFocusable: [...el.querySelectorAll('.chat-history-item, .history-item-select')].filter((n) => /** @type {HTMLElement} */ (n).tabIndex >= 0).length,
        })).catch((e) => ({ error: String(e) })));
        await rec.capture(page, 'first-chat-selected-preview-showing');
        const moved = await rec.status('move the selection with Arrow Down (is the newly selected chat announced?)', page, async () => {
            await list.focus();
            await page.keyboard.press('ArrowDown');
            await page.waitForTimeout(600);
        }, { watchMs: 2500 });
        const selection = await page.evaluate(() => {
            const active = document.querySelector('.chat-history-item.active');
            const list = document.querySelector('#chat-history-list');
            const focus = document.activeElement;
            return {
                selectedTitle: (active?.querySelector('.title-text, .chat-title, h3, h4')?.textContent || active?.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60),
                exposedAs: ['aria-selected', 'aria-current', 'aria-pressed', 'aria-checked'].filter((a) => active?.hasAttribute(a) || active?.querySelector(`[${a}]`)),
                activedescendant: list?.getAttribute('aria-activedescendant') || null,
                focusOn: focus && focus !== document.body ? (focus.id || focus.className) : 'body',
                previewMessages: document.querySelectorAll('#preview-messages .message').length,
                previewInList: !!document.querySelector('#preview-messages ul, #preview-messages ol, #preview-messages [role="list"]'),
            };
        }).catch((e) => ({ error: String(e) }));
        // Whether the silence is a defect is judged in the report (triage.js), with these facts beside it.
        rec.note('which chat is selected, as exposed to assistive technology after Arrow Down', { ...selection, anythingAnnounced: !!moved && moved.announcements.some((a) => a.text) });
        await rec.capture(page, 'second-chat-selected');
        await rec.reach('the selected chat\'s actions (Continue, Download, Delete) by Tab from the list', page, page.locator('#continue-chat-btn'), { from: list, maxTabs: 6 });

        // Rename: the button hides itself and a text field appears.
        await rec.focus('"Rename Chat" (hides itself, reveals a text field)', page.locator('.edit-btn:visible').first(), { settleMs: 800 });
        await rec.state(page, 'rename-field-open', async () => {
            if (!(await page.locator('.title-input:visible').count())) await page.locator('.edit-btn:visible').first().click();
            await page.locator('.title-input:visible').first().waitFor({ timeout: 4000 });
        });
        await rec.focus('"Cancel" rename (returns to the title)', page.locator('.cancel-btn:visible').first(), { settleMs: 800 });
        await rec.status('save a new chat title (announcement)', page, async () => {
            await page.locator('.edit-btn:visible').first().click();
            await page.locator('.title-input:visible').first().fill('Renamed during the audit');
            await page.locator('.save-btn:visible').first().click();
        }, { watchMs: 4000 });
        await rec.capture(page, 'after-rename');

        await rec.graphic('"Delete" chat control', page.locator('#delete-chat-btn'));
        await rec.focus('"Delete" chat (confirm, then the item is removed)', page.locator('#delete-chat-btn'), { settleMs: 2500 });
        await rec.capture(page, 'after-deleting-a-chat');
        await toastStates(page, rec);
        rec.notCovered('the mobile layout of the history list (expand row, action buttons, Back)', 'audited at 1440 px wide only');
    });

    auditTest(test, '/student/history', async ({ page, rec }) => {
        await guard(page);
        await selectCourse(page);
        await stubEmptyLists(page, /\/api\/students\/[^/]+\/[^/]+\/sessions\/own/);
        await page.goto('/student/history');
        await rec.state(page, 'no-saved-chats', () => page.locator('#no-history-message').waitFor({ state: 'visible', timeout: 15_000 }));
    }, { variant: 'empty' });

    // -------------------------------------------------------- /student/quiz
    auditTest(test, '/student/quiz', async ({ page, rec }) => {
        await guard(page);
        await selectCourse(page);
        await page.goto(`/student/quiz?courseId=${MAIN}`);
        await page.locator('#question-card').waitFor({ state: 'visible', timeout: 25_000 });
        await page.waitForTimeout(700);
        await pageShell(page, rec);

        const which = () => page.evaluate(() => ['mc-options', 'tf-options', 'sa-container']
            .find((id) => !!document.getElementById(id) && /** @type {HTMLElement} */ (document.getElementById(id)).offsetParent !== null) || 'none');
        const seen = new Set();
        // Walk the questions; capture each type once, unanswered and after a wrong answer.
        for (let i = 0; i < 6; i += 1) {
            const type = await which();
            if (type === 'none') break;
            if (!seen.has(type)) await rec.capture(page, `question-${type}`);
            if (i === 0) {
                await rec.status('"Submit" with nothing selected (message)', page, () => page.locator('#submit-btn').click(), { watchMs: 3000 });
                await rec.capture(page, 'submit-with-no-answer');
                await page.evaluate(() => document.querySelectorAll('.notification .notification-close').forEach((b) => /** @type {HTMLElement} */ (b).click())).catch(() => {});
            }
            await rec.step(`answer question ${i + 1} (${type})`, async () => {
                if (type === 'sa-container') {
                    await queueLlmReplies(page, ['{"correct":false,"feedback":"Not quite: think about what joins two amino acids."}']);
                    await page.locator('#sa-input').fill('A hydrogen bond.');
                } else {
                    // The last option is the wrong one for both seeded questions.
                    await page.locator(`#${type} input[type="radio"]`).last().check({ force: true });
                }
            });
            if (!seen.has(type)) {
                await rec.graphic(`${type}: selected answer control`, page.locator(type === 'sa-container' ? '#sa-input' : `#${type} label`).last(), { pad: 2 });
                await rec.status(`submit an answer (${type}): is the feedback announced?`, page, () => page.locator('#submit-btn').click(), { watchMs: 4000 });
                await page.locator('#feedback-container').waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {});
                rec.note(`after submitting (${type})`, await page.evaluate(() => {
                    const a = document.activeElement;
                    const fb = document.getElementById('feedback-container');
                    return {
                        feedbackClass: fb?.className, feedbackLive: fb?.closest('[aria-live], [role="status"], [role="alert"]') ? true : false,
                        focusOn: a && a !== document.body ? (a.id || a.className || a.tagName) : 'body',
                        materials: document.querySelectorAll('#materials-list .material-item').length,
                        helpChatOpen: !!document.getElementById('quiz-chat-container') && /** @type {HTMLElement} */ (document.getElementById('quiz-chat-container')).offsetParent !== null,
                    };
                }), await page.evaluate(() => !document.activeElement || document.activeElement === document.body));
                await rec.capture(page, `feedback-after-${type}`);
            } else {
                await page.locator('#submit-btn').click().catch(() => {});
                await page.locator('#feedback-container').waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {});
            }
            seen.add(type);
            if (await page.locator('#quiz-chat-container').isVisible().catch(() => false) && !seen.has('help-chat')) {
                seen.add('help-chat');
                await rec.status('ask the quiz help chat a question (announcement)', page, async () => {
                    await queueLlmReplies(page, ['A peptide bond forms by a condensation reaction between two amino acids.']);
                    await page.locator('#quiz-chat-input').fill('Can you explain?');
                    await page.locator('#quiz-chat-send').click();
                }, { watchMs: 5000 });
                await rec.capture(page, 'help-chat-with-reply');
                await rec.focus('close the quiz help chat', page.locator('#quiz-chat-close'), { settleMs: 700 });
            }
            const next = page.locator('#next-btn');
            if (!(await next.isVisible().catch(() => false))) break;
            if (i === 0) await rec.focus('"Next" (the question card is replaced)', next, { settleMs: 1200 });
            else await next.click();
            await page.waitForTimeout(500);
            if (await page.locator('#quiz-complete').isVisible().catch(() => false)) break;
        }
        if (await page.locator('#quiz-complete').isVisible().catch(() => false)) {
            await rec.capture(page, 'quiz-complete');
            await rec.focus('"Try Again" (the quiz restarts)', page.locator('#restart-btn'), { settleMs: 1500 });
        } else {
            rec.notCovered('the "quiz complete" screen', 'the walk through the questions ended before the last one');
        }
        await rec.status('change the question-type filter (is the new set announced?)', page, async () => {
            await page.locator('#type-filter').selectOption({ index: 1 });
        }, { watchMs: 2500 });
        await rec.capture(page, 'filtered-by-type');
        await rec.focus('"Shuffle" (the question card is replaced)', page.locator('#shuffle-btn'), { settleMs: 1200 });
        await toastStates(page, rec);
    });

    auditTest(test, '/student/quiz', async ({ page, rec }) => {
        await guard(page);
        await page.addInitScript(() => { try { localStorage.clear(); } catch (_) {} });
        await page.goto('/student/quiz');
        await page.waitForTimeout(2500);
        rec.note('which state showed', await page.evaluate(() => Object.fromEntries(['quiz-loading', 'quiz-empty', 'quiz-disabled', 'question-card']
            .map((id) => [id, !!document.getElementById(id) && /** @type {HTMLElement} */ (document.getElementById(id)).offsetParent !== null]))));
        await rec.capture(page, 'no-course-or-quiz-off');
    }, { variant: 'unavailable' });

    // ----------------------------------------------------- /student/flagged
    auditTest(test, '/student/flagged', async ({ page, rec }) => {
        await guard(page);
        await selectCourse(page);
        await page.goto('/student/flagged');
        await page.locator('#flagged-list .flag-card').first().waitFor({ timeout: 25_000 });
        await page.waitForTimeout(700);
        rec.note('what the page rendered', await page.evaluate(() => ({
            cards: document.querySelectorAll('#flagged-list .flag-card').length,
            withResponse: document.querySelectorAll('#flagged-list .response-section').length,
            pending: document.querySelectorAll('#flagged-list .pending-section').length,
            badges: [...document.querySelectorAll('#flagged-list .flag-status-badge')].map((b) => b.textContent.trim()),
        })));
        await pageShell(page, rec);
        await rec.capture(page, 'loaded-all-flags');
        for (const status of ['pending', 'resolved']) {
            await rec.status(`filter to "${status}" (is the new result announced?)`, page, () => page.locator('#status-filter').selectOption(status), { watchMs: 2000 });
            await rec.capture(page, `filtered-${status}`);
        }
        await rec.step('show all again', () => page.locator('#status-filter').selectOption({ index: 0 }));
        await rec.focus('"Refresh" (the list re-renders)', page.locator('#refresh-flags'), { settleMs: 2000 });
        const hasToast = await toastStates(page, rec);
        if (!hasToast) rec.note('status messages on this page', { detail: 'the page has no toast component; filter and refresh results are not announced unless a live region exists' });
    });

    auditTest(test, '/student/flagged', async ({ page, rec }) => {
        await guard(page);
        await selectCourse(page);
        await stubEmptyLists(page, /\/api\/flags\/my/);
        await page.goto('/student/flagged');
        await rec.state(page, 'no-flags', () => page.locator('#empty-state').waitFor({ state: 'visible', timeout: 15_000 }));
    }, { variant: 'empty' });

    // ----------------------------------------------- /student/dashboard.html
    auditTest(test, '/student/dashboard.html', async ({ page, rec }) => {
        await guard(page);
        await selectCourse(page);
        await page.goto('/student/dashboard.html');
        await page.locator('#topics-list-container .topic-card').first().waitFor({ timeout: 25_000 });
        await page.waitForTimeout(700);
        rec.note('what the page rendered', await page.evaluate(() => ({
            struggleCards: document.querySelectorAll('#topics-list-container .topic-card').length,
            activeCards: document.querySelectorAll('#topics-list-container .topic-card.active-struggle').length,
            unitCards: document.querySelectorAll('#course-topics-container .topic-item-card').length,
        })));
        await pageShell(page, rec);
        await rec.capture(page, 'loaded-with-topics');

        const reset = page.locator('#topics-list-container .topic-card .reset-btn').first();
        await rec.dialog(page, 'dialog-confirm-reset-topic', {
            root: '#confirm-modal', trigger: reset,
            open: () => reset.click(),
            close: () => page.locator('#modal-cancel-btn').click(),
        });
        await rec.step('confirm resetting one topic', async () => {
            await reset.click();
            await page.locator('#confirm-modal').waitFor({ state: 'visible', timeout: 5000 });
            await page.locator('#modal-confirm-btn').focus();
            await page.keyboard.press('Enter');
            await page.waitForTimeout(2500);
        });
        rec.note('focus after confirming "Reset" on a topic (its card is re-rendered)', await page.evaluate(() => {
            const a = document.activeElement;
            const onBody = !a || a === document.body;
            return { lost: onBody, active: onBody ? 'body' : (a.id || a.className || a.tagName) };
        }), await page.evaluate(() => !document.activeElement || document.activeElement === document.body));
        await rec.capture(page, 'after-resetting-one-topic');
        const resetAll = page.locator('#reset-all-btn');
        await rec.dialog(page, 'dialog-confirm-reset-all', {
            root: '#confirm-modal', trigger: resetAll,
            open: () => resetAll.click(),
            close: () => page.locator('#modal-cancel-btn').click(),
        });
        const hasToast = await toastStates(page, rec);
        if (!hasToast) rec.note('status messages on this page', { detail: 'the page has no toast component; a successful reset is shown only by the cards changing' });
    });

    auditTest(test, '/student/dashboard.html', async ({ page, rec }) => {
        await guard(page);
        await selectCourse(page);
        await stubEmptyLists(page, /\/api\/student\/struggle|\/sessions\/own/);
        await page.goto('/student/dashboard.html');
        await page.waitForTimeout(2500);
        await rec.capture(page, 'no-struggle-topics');
    }, { variant: 'empty' });

    // ------------------------------------------------- /student/super-course
    auditTest(test, '/student/super-course', async ({ page, rec }) => {
        await guard(page);
        await selectCourse(page);
        await page.goto('/student/super-course');
        await page.locator('#superchat-picker').waitFor({ state: 'visible', timeout: 25_000 });
        await rec.step('choose the audit bucket', async () => {
            await page.locator('#superchat-picker').selectOption(BUCKET_A);
            await page.locator('#super-course-pool-list .super-course-pool-chip').first().waitFor({ timeout: 10_000 });
        });
        await page.waitForTimeout(800);
        rec.note('what the page rendered', await page.evaluate(() => ({
            buckets: document.querySelectorAll('#superchat-picker option').length,
            poolChips: document.querySelectorAll('.super-course-pool-chip').length,
            historyItems: document.querySelectorAll('.super-course-history-item').length,
            levelNotice: !!document.querySelector('#super-course-level-notice') && /** @type {HTMLElement} */ (document.querySelector('#super-course-level-notice')).offsetParent !== null,
        })));
        await pageShell(page, rec);
        await rec.capture(page, 'loaded');

        await rec.disclosure('"Super Chat History" toggle', page.locator('#toggle-super-course-history'), { scope: '#super-course-history-panel' });
        await rec.state(page, 'history-open', async () => {
            const toggle = page.locator('#toggle-super-course-history');
            if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
            await page.locator('.super-course-history-item').first().waitFor({ state: 'visible', timeout: 8000 });
        });
        await rec.status('change bucket (is the new pool announced?)', page, async () => {
            const values = await page.locator('#superchat-picker option').evaluateAll((o) => o.map((x) => /** @type {HTMLOptionElement} */ (x).value));
            const other = values.find((v) => v && v !== 'A11Y-AUD-BUCKET-A');
            if (other) await page.locator('#superchat-picker').selectOption(other);
        }, { watchMs: 3000 });
        await rec.capture(page, 'other-bucket-selected');
        await rec.step('back to the audit bucket', async () => {
            await page.locator('#superchat-picker').selectOption(BUCKET_A);
            await page.waitForTimeout(800);
        });

        await rec.status('send a question and receive a reply (announcements)', page, async () => {
            await queueLlmReplies(page, ['Glycolysis in Audit Cell Biology 110 feeds the citric acid cycle taught in Audit Biochemistry 201.']);
            await page.locator('#chat-input').fill('How do my two courses connect?');
            await page.locator('#send-button').click();
            await page.locator('#chat-messages .bot-message .flag-button, #chat-messages .bot-message .message-source').first().waitFor({ timeout: 25_000 });
        }, { watchMs: 2500 });
        rec.note('conversation after one exchange', await page.evaluate(() => ({
            messages: document.querySelectorAll('#chat-messages .message').length,
            errors: document.querySelectorAll('#chat-messages .error-message').length,
            citations: document.querySelectorAll('#chat-messages .super-course-citation-list li, #chat-messages .super-course-citation-list > *').length,
            flagButtons: document.querySelectorAll('#chat-messages .flag-button').length,
        })));
        await rec.capture(page, 'after-one-exchange');
        const flagButton = page.locator('#chat-messages .flag-button').last();
        await rec.disclosure('flag menu button on a reply', flagButton, { scope: '.message' });
        await rec.state(page, 'flag-menu-open', async () => {
            await flagButton.click();
            await page.locator('#chat-messages .flag-menu.show').first().waitFor({ state: 'visible', timeout: 4000 });
        });
        await rec.step('close the flag menu', () => page.keyboard.press('Escape'));

        await rec.status('"Continue" a saved session (announcement)', page, async () => {
            await page.locator('.super-course-history-item .super-course-history-action.primary').first().click();
        }, { watchMs: 5000 });
        await rec.capture(page, 'after-continuing-a-session');
        await rec.focus('"Delete" a saved session (confirm, then the item is removed)',
            page.locator('.super-course-history-item .super-course-history-action:not(.primary)').first(), { settleMs: 2500 });
        await rec.focus('"New Chat" (confirm, then the conversation is cleared)', page.locator('#new-super-course-chat'), { settleMs: 1500 });
        const rules = page.locator('#view-rules-link');
        await rec.dialog(page, 'dialog-ai-use-rules-read-only', {
            root: '#agreement-modal-overlay', trigger: rules,
            open: () => rules.click(),
            close: () => page.locator('#close-modal-btn').click(),
        });
        const hasToast = await toastStates(page, rec);
        if (!hasToast) rec.note('status messages on this page', { detail: 'window.showNotification is not loaded on this page' });
    });
});

