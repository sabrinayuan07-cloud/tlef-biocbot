// @ts-check
/**
 * Accessibility audit of /instructor/home.
 *
 * An audit, not a gate: the test drives the page through its states, runs the
 * toolkit rules and axe-core in each, and writes what it finds to
 * a11y-results/other-pages/raw/. Nothing here fails the build.
 */
const { test } = require('@playwright/test');
const { storageStatePath } = require('../e2e/helpers/users');
const { auditTest, toastStates, pageShell } = require('./helpers/audit-recorder');
const { MAIN, JOINABLE, seedAuditData, cleanupAuditData } = require('./helpers/audit-seed');

test.describe('Audit: instructor home', () => {
    test.use({ storageState: storageStatePath('instructor'), viewport: { width: 1440, height: 1000 } });

    test.beforeAll(async () => { await seedAuditData(); });
    test.afterAll(async () => { await cleanupAuditData(); });

    auditTest(test, '/instructor/home', async ({ page, rec }) => {
        page.on('dialog', (d) => d.accept().catch(() => {}));
        await page.addInitScript((id) => { try { localStorage.setItem('selectedCourseId', id); } catch (_) {} }, MAIN);
        await page.goto(`/instructor/home?courseId=${MAIN}`);
        await page.locator('.approved-topic-chip').first().waitFor({ timeout: 25_000 });
        await page.locator('.persistence-topic-card').first().waitFor({ timeout: 15_000 }).catch(() => {});
        await page.locator('.struggle-topic-item').first().waitFor({ timeout: 15_000 }).catch(() => {});
        await page.locator('#live-struggle-tbody tr').first().waitFor({ timeout: 15_000 }).catch(() => {});
        await page.waitForTimeout(1500);

        const populated = await page.evaluate(() => ({
            approvedTopics: document.querySelectorAll('.approved-topic-chip').length,
            persistenceCards: document.querySelectorAll('.persistence-topic-card').length,
            struggleTopics: document.querySelectorAll('.struggle-topic-item').length,
            liveRows: document.querySelectorAll('#live-struggle-tbody tr:not(.no-data-row)').length,
            missingItems: document.querySelectorAll('#missing-items-list .missing-item').length,
            statistics: !!document.querySelector('#statistics-section') && /** @type {HTMLElement} */ (document.querySelector('#statistics-section')).offsetParent !== null,
            chart: !!document.querySelector('#weekly-struggle-chart-container canvas'),
        }));
        rec.note('what the page rendered from the seeded course', populated);
        await pageShell(page, rec);
        await rec.capture(page, 'loaded-populated');

        // Section headers that show and hide their section.
        await rec.disclosures(page, '.section-header.clickable', { scope: '.home-section', labelPrefix: 'section header: ' });
        await rec.state(page, 'sections-collapsed', async () => {
            for (const header of await page.locator('.section-header.clickable').all()) await header.click();
        });
        await rec.step('expand the sections again', async () => {
            for (const header of await page.locator('.section-header.clickable').all()) await header.click();
        });
        // A struggle topic row that shows and hides its students.
        await rec.disclosures(page, '.struggle-topic-item .topic-header', { scope: '.struggle-topic-item', limit: 2, labelPrefix: 'struggle topic row: ' });
        await rec.state(page, 'struggle-topic-toggled', () => page.locator('.struggle-topic-item .topic-header').first().click());

        // Tooltips ("More information" icons).
        await rec.state(page, 'tooltip-focused', async () => {
            await page.locator('.info-icon').first().focus();
            await page.waitForTimeout(300);
        });
        await rec.graphic('"More information" icon', page.locator('.info-icon').first());
        await rec.graphic('approved topic remove (×) glyph', page.locator('.topic-chip-remove').first());
        await rec.graphic('"Active only" checkbox', page.locator('#filter-active-only'), { pad: 3 });
        await rec.graphic('chart "previous weeks" control', page.locator('#chart-prev-weeks'));

        // Course switcher: the control hides itself and reveals a panel.
        await rec.focus('"Change course" (hides itself, reveals the course selector)', page.locator('#change-course-btn'), { settleMs: 700 });
        await rec.state(page, 'course-selector-open', async () => {
            if (!(await page.locator('#course-selector').isVisible())) await page.locator('#change-course-btn').click();
            await page.locator('#course-selector').waitFor({ state: 'visible', timeout: 5000 });
        });
        // Join another course (inside the course selector): choosing one reveals details, a code field and a button.
        await rec.state(page, 'join-course-selected', async () => {
            const select = page.locator('#join-course-select-dropdown');
            await select.selectOption(JOINABLE);
            await page.locator('#join-course-btn').waitFor({ state: 'visible', timeout: 5000 });
        });
        await rec.status('"Join course" with no instructor code (validation message)', page, async () => {
            await page.locator('#join-course-btn').click();
        }, { watchMs: 4000 });
        await rec.capture(page, 'join-course-validation-error');

        await rec.focus('"Cancel" in the course selector (returns to the course display)', page.locator('#cancel-course-select-btn'), { settleMs: 700 });

        // Topic → unit dialog (built by the page, not the shared modal helper).
        const badge = page.locator('.topic-unit-badge-btn').first();
        await rec.dialog(page, 'dialog-assign-topic-to-unit', {
            root: '#topic-unit-assignment-modal',
            trigger: badge,
            open: () => badge.click(),
            close: () => page.locator('#topic-unit-cancel-btn').click(),
        });
        const persistenceCard = page.locator('.persistence-topic-card.clickable-topic-card').first();
        await rec.dialog(page, 'dialog-assign-topic-from-persistence-card', {
            root: '#topic-unit-assignment-modal',
            trigger: persistenceCard,
            open: async () => { await persistenceCard.focus(); await page.keyboard.press('Enter'); },
            close: () => page.locator('#topic-unit-cancel-btn').click(),
        });

        // Approved topics: add, rename in place, remove.
        await rec.status('add an approved topic (announcement)', page, async () => {
            await page.locator('#new-topic-input').fill('citric acid cycle');
            await page.locator('button.approved-topic-add-btn[onclick="addApprovedTopic()"]').click();
        }, { watchMs: 6500 });
        await rec.capture(page, 'after-adding-topic');
        await page.locator('#new-topic-input').fill('electron transport chain').catch(() => {});
        await rec.focus('"Add" approved topic (list re-renders)', page.locator('button.approved-topic-add-btn[onclick="addApprovedTopic()"]'), { settleMs: 1800 });
        await rec.state(page, 'topic-inline-rename', async () => {
            await page.locator('.topic-chip-label').first().dblclick();
            await page.locator('.topic-chip-edit-input').waitFor({ state: 'visible', timeout: 4000 });
        });
        await rec.step('leave the inline rename', () => page.keyboard.press('Escape'));
        // Renaming a topic is offered on double-click; can a keyboard user start it?
        const rename = await page.locator('.topic-chip-label').first().evaluate(async (label) => {
            const focusable = /** @type {HTMLElement} */ (label).tabIndex >= 0;
            /** @type {HTMLElement} */ (label).focus();
            const tookFocus = document.activeElement === label;
            for (const key of ['Enter', 'F2', ' ']) {
                label.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
                label.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }));
            }
            await new Promise((resolve) => setTimeout(resolve, 300));
            const opened = !!document.querySelector('.topic-chip-edit-input');
            if (opened) document.querySelector('.topic-chip-edit-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            return { labelFocusable: focusable, tookFocus, role: label.getAttribute('role'), title: label.getAttribute('title'), editorOpenedFromKeyboard: opened };
        }).catch((e) => ({ error: String(e), editorOpenedFromKeyboard: null }));
        rec.note('approved topic rename from the keyboard (offered on double-click)', rename, rename.editorOpenedFromKeyboard === false);
        await rec.focus('remove an approved topic (×, the chip is removed)', page.locator('.topic-chip-remove').first(), { settleMs: 1800 });

        // Live activity table filter re-renders the table.
        await rec.state(page, 'live-table-active-only', async () => {
            await page.locator('#filter-active-only').check();
            await page.waitForTimeout(400);
        });
        rec.note('chart paging controls', await page.evaluate(() => ['chart-prev-weeks', 'chart-next-weeks'].map((id) => {
            const b = /** @type {HTMLButtonElement|null} */ (document.getElementById(id));
            return b ? { id, text: b.textContent, disabled: b.disabled, title: b.title } : { id, missing: true };
        })));
        const pager = page.locator('#chart-prev-weeks:not(:disabled), #chart-next-weeks:not(:disabled)').first();
        if (await pager.count()) await rec.focus('chart paging control (chart re-renders)', pager, { settleMs: 1500 });
        else rec.notCovered('focus after paging the weekly chart', 'both paging controls are disabled with the seeded data (one page of weeks)');

        await toastStates(page, rec);
    });
});

test.describe('Audit: instructor home, no course yet', () => {
    test.use({ storageState: storageStatePath('instructor_fresh'), viewport: { width: 1440, height: 1000 } });

    auditTest(test, '/instructor/home', async ({ page, rec }) => {
        await page.addInitScript(() => { try { localStorage.removeItem('selectedCourseId'); } catch (_) {} });
        await page.goto('/instructor/home');
        await page.waitForLoadState('networkidle').catch(() => {});
        await page.waitForTimeout(1200);
        const onboardingPrompt = await page.locator('#onboarding-prompt-section').isVisible().catch(() => false);
        rec.note('which first-run state was showing', { onboardingPrompt, url: page.url() });
        if (!onboardingPrompt) rec.notCovered('the "no course yet" prompt', 'the fresh instructor account already owns a completed course in the local database, so the prompt did not show; the state captured is whatever that account sees');
        await rec.capture(page, 'first-run');
    }, { variant: 'no-course' });
});
