// @ts-check
/**
 * Accessibility audit of /instructor/settings: the hub, every panel, the search
 * box, and the two dialogs (confirm, course copy). The admin-only panels are
 * audited too, with the test instructor made a system admin for the duration.
 *
 * An audit, not a gate: findings are written to a11y-results/other-pages/raw/
 * and nothing here fails the build. Nothing global is saved: on the admin
 * panels the audit only looks, and every confirm dialog is cancelled.
 */
const { test } = require('@playwright/test');
const { storageStatePath } = require('../e2e/helpers/users');
const { auditTest, toastStates, pageShell } = require('./helpers/audit-recorder');
const { MAIN, seedAuditData, cleanupAuditData, setSystemAdmin } = require('./helpers/audit-seed');

const COURSE_PANELS = ['course-basics', 'student-chat', 'prompts', 'quiz', 'privacy', 'super-course', 'lifecycle'];
const ADMIN_PANELS = ['admin-platform', 'admin-access', 'admin-safety', 'admin-database'];

/** @param {import('@playwright/test').Page} page @param {string} name */
async function openPanel(page, name) {
    const rail = page.locator(`.settings-rail-link[data-panel="${name}"]`);
    if (await rail.isVisible().catch(() => false)) await rail.click();
    else await page.locator(`.settings-tile[data-panel="${name}"]`).click();
    await page.locator(`#settings-panel-${name}`).waitFor({ state: 'visible', timeout: 8000 });
    await page.waitForTimeout(500);
}

test.describe('Audit: instructor settings', () => {
    test.use({ storageState: storageStatePath('instructor'), viewport: { width: 1440, height: 1000 } });

    let ids;
    let wasAdmin = false;
    test.beforeAll(async () => {
        ids = await seedAuditData();
        wasAdmin = await setSystemAdmin(ids.instructorId, false);
    });
    test.afterAll(async () => {
        await setSystemAdmin(ids.instructorId, wasAdmin);
        await cleanupAuditData();
    });

    auditTest(test, '/instructor/settings', async ({ page, rec }) => {
        // Belt and braces: the audit never clicks the destructive admin actions, and
        // these calls could not get through if it did.
        await page.route(/\/api\/qdrant\/delete-all-collections|\/api\/settings\/system-admins/, (route) => (
            route.request().method() === 'GET' ? route.continue() : route.abort()
        ));
        await page.addInitScript((id) => { try { localStorage.setItem('selectedCourseId', id); } catch (_) {} }, MAIN);
        await page.goto(`/instructor/settings?courseId=${MAIN}`);
        await page.locator('#settings-hub .settings-tile').first().waitFor({ timeout: 25_000 });
        await page.waitForTimeout(1500);
        await pageShell(page, rec);
        await rec.capture(page, 'hub');

        // Search: a combobox that shows a listbox of matching settings.
        await rec.state(page, 'search-results-open', async () => {
            await page.locator('#settings-search-input').fill('quiz');
            await page.locator('#settings-search-results').waitFor({ state: 'visible', timeout: 5000 });
        });
        await rec.note('search combobox state with results showing', await page.locator('#settings-search-input').evaluate((el) => ({
            role: el.getAttribute('role'), expanded: el.getAttribute('aria-expanded'), controls: el.getAttribute('aria-controls'),
            activedescendant: el.getAttribute('aria-activedescendant'), autocomplete: el.getAttribute('aria-autocomplete'),
        })).catch((e) => ({ error: String(e) })));
        await rec.state(page, 'search-option-active', async () => {
            await page.locator('#settings-search-input').press('ArrowDown');
        });
        await rec.note('search combobox state after Arrow Down', await page.locator('#settings-search-input').evaluate((el) => ({
            expanded: el.getAttribute('aria-expanded'), activedescendant: el.getAttribute('aria-activedescendant'),
            activeOptionSelected: !!document.querySelector('#settings-search-results [aria-selected="true"]'),
        })).catch((e) => ({ error: String(e) })));
        await rec.graphic('search "clear" (×) control', page.locator('#settings-search-clear'));
        await rec.focus('search "clear" (the control hides itself)', page.locator('#settings-search-clear'), { settleMs: 600 });

        // Hub tile → panel: the hub is hidden and the panel revealed.
        await rec.focus('hub tile "Course basics" (hides the hub, reveals the panel)',
            page.locator('.settings-tile[data-panel="course-basics"]'), { settleMs: 900 });

        for (const name of COURSE_PANELS) {
            await rec.state(page, `panel-${name}`, () => openPanel(page, name));

            if (name === 'student-chat') {
                const reset = page.locator('#reset-student-chat');
                await rec.dialog(page, 'dialog-confirm-reset', {
                    root: '#confirm-dialog-modal', trigger: reset,
                    open: () => reset.click(),
                    close: () => page.locator('#confirm-dialog-cancel').click(),
                });
            }
            if (name === 'quiz') {
                // A field that saves itself: is the save announced?
                // The checkbox itself is visually replaced by a styled switch, so it is operated from the keyboard.
                const box = page.locator('#settings-panel-quiz input[type="checkbox"]').first();
                await rec.status('change a quiz setting (autosave announcement)', page, async () => {
                    await box.focus();
                    await page.keyboard.press('Space');
                }, { watchMs: 5000 });
                rec.note('autosave indicator after the change', await page.evaluate(() => {
                    const ind = document.querySelector('#settings-panel-quiz .field-autosave-indicator, .field-autosave-indicator');
                    return ind ? { text: (ind.textContent || '').trim(), live: !!ind.closest('[aria-live], [role="status"], [role="alert"]'), visible: /** @type {HTMLElement} */ (ind).offsetParent !== null } : { present: false };
                }));
                await rec.capture(page, 'panel-quiz-after-autosave');
                await rec.graphic('first checkbox/toggle in the quiz panel', box, { pad: 4 });
            }
            if (name === 'privacy') {
                const box = page.locator('#settings-panel-privacy input[type="checkbox"]').first();
                await rec.graphic('first checkbox/toggle in the privacy panel', box, { pad: 4 });
            }
            if (name === 'super-course') {
                await rec.state(page, 'panel-super-course-advanced-open', async () => {
                    await page.locator('#superchat-advanced > summary').click();
                    await page.waitForTimeout(300);
                });
                await rec.note('bucket checklist', await page.evaluate(() => ({
                    buckets: document.querySelectorAll('#course-superchat-checklist .superchat-checklist-item').length,
                    selectOptions: document.querySelectorAll('#superchat-select option').length,
                })));
            }
            if (name === 'lifecycle') {
                const copy = page.locator('#transfer-course-btn');
                await rec.status('"Create Course Copy" with nothing filled in (validation message)', page, () => copy.click(), { watchMs: 3500 });
                await rec.capture(page, 'panel-lifecycle-validation-error');
                await page.evaluate(() => document.querySelectorAll('.notification .notification-close').forEach((b) => /** @type {HTMLElement} */ (b).click())).catch(() => {});
                await rec.dialog(page, 'dialog-course-copy', {
                    root: '#transfer-course-modal', trigger: copy,
                    open: async () => {
                        await page.locator('#transfer-course-name').fill('Audit Biochemistry 201 (copy)');
                        await page.locator('#transfer-course-api-key').fill('sk-test-a11y-audit-not-a-real-key');
                        await copy.click();
                    },
                    close: () => page.locator('#transfer-modal-cancel').click(),
                });
                const deactivate = page.locator('#toggle-course-active-btn');
                await rec.dialog(page, 'dialog-confirm-deactivate-course', {
                    root: '#confirm-dialog-modal', trigger: deactivate,
                    open: () => deactivate.click(),
                    close: () => page.locator('#confirm-dialog-cancel').click(),
                });
            }
        }

        await rec.focus('"back to all settings" in the rail (hides the panel, reveals the hub)', page.locator('.settings-rail-back').first(), { settleMs: 900 });
        await toastStates(page, rec);

        // ---- Admin-only panels: look, do not save. ----
        const admin = await rec.step('make the test instructor a system admin and reload', async () => {
            await setSystemAdmin(ids.instructorId, true);
            await page.goto(`/instructor/settings?courseId=${MAIN}`);
            await page.locator('#admin-tile-group .settings-tile:visible').first().waitFor({ timeout: 20_000 });
            await page.waitForTimeout(1200);
        });
        if (admin) {
            await rec.capture(page, 'hub-as-system-admin');
            for (const name of ADMIN_PANELS) {
                await rec.state(page, `panel-${name}`, () => openPanel(page, name));
                if (name === 'admin-platform') {
                    await rec.disclosures(page, '#settings-panel-admin-platform button[aria-expanded]:visible', { limit: 4, labelPrefix: 'admin: ' });
                    await rec.state(page, 'panel-admin-platform-models-open', async () => {
                        await page.locator('#settings-panel-admin-platform button[aria-expanded]:visible').first().click();
                        await page.waitForTimeout(500);
                    });
                }
                if (name === 'admin-access') {
                    await rec.note('system admin list', await page.evaluate(() => ({ rows: document.querySelectorAll('#system-admin-list .system-admin-row').length })));
                }
                if (name === 'admin-database') {
                    // "Delete everything" is looked at, never activated: its confirm
                    // dialog is the same component audited from the reset buttons.
                    await rec.graphic('"Delete everything" danger button', page.locator('#delete-collection'));
                    rec.notCovered('the confirm dialog behind "Delete everything" on the Database panel',
                        'deliberately not opened: one wrong key press would wipe the shared local database; the same confirm component was audited from the reset and deactivate buttons');
                }
            }
        }
        await setSystemAdmin(ids.instructorId, wasAdmin).catch(() => {});
        rec.notCovered('saving global platform settings, creating or deleting a Super Chat bucket, granting or revoking a system admin, deactivating or copying the course',
            'not driven: these change data that other suites and the local dev server share; their confirm dialogs were opened and cancelled instead');
    });
});
