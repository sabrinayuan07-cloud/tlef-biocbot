// @ts-check
/**
 * Focused browser coverage for public/styles/settings.css.
 *
 * This uses lightweight settings-page harnesses so the assertions stay about
 * CSS states instead of database state. The DOM mirrors selectors from
 * public/instructor/settings.html plus TA-facing permission/notification states
 * that appear when a TA reaches settings-adjacent instructor controls.
 */

const { test, expect } = require('./fixtures/monocart');

const INSTRUCTOR_HARNESS_PATH = '/instructor/settings-css-coverage';
const TA_HARNESS_PATH = '/ta/settings-css-coverage';

function settingsHarness(role = 'instructor') {
    const roleLabel = role === 'ta' ? 'TA' : 'Instructor';
    return `<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${roleLabel} Settings CSS Coverage</title>
    <link rel="stylesheet" href="/styles/style.css">
    <link rel="stylesheet" href="/styles/settings.css">
</head>
<body class="instructor-app">
    <div class="app-container">
        <main class="main-content">
            <header class="settings-header">
                <h1>${roleLabel} Settings</h1>
            </header>

            <div class="settings-container">
                <section class="settings-section" id="database-management-section">
                    <h2>Database Management</h2>
                    <div class="development-disclaimer">
                        <div class="disclaimer-icon">!</div>
                        <div class="disclaimer-content">
                            <h3>Development Mode</h3>
                            <p><strong>Note:</strong> destructive controls are restricted to development.</p>
                        </div>
                    </div>
                    <div class="settings-content">
                        <div class="setting-item checkbox">
                            <input id="checkbox-setting" type="checkbox" checked>
                            <label for="checkbox-setting">Legacy checkbox setting</label>
                        </div>
                        <div class="setting-item">
                            <div class="setting-info">
                                <h3>Reset All Data</h3>
                                <p>Delete all data for the course.</p>
                            </div>
                            <div class="setting-controls">
                                <button id="danger-enabled" class="danger-button" type="button">Delete All Data</button>
                                <button id="danger-disabled" class="danger-button" type="button" disabled>Disabled Delete</button>
                            </div>
                        </div>
                    </div>
                </section>

                <section class="settings-section" id="quiz-settings-section">
                    <h2>Quiz Practice Settings</h2>
                    <div class="settings-content">
                        <div class="setting-item">
                            <div class="setting-info">
                                <h3>Enable Quiz Practice Page</h3>
                                <p>Students can access quiz practice.</p>
                            </div>
                            <div class="setting-controls">
                                <label class="toggle-switch">
                                    <input type="checkbox" id="quiz-enabled-toggle" checked>
                                    <span class="toggle-slider"></span>
                                </label>
                            </div>
                        </div>
                        <div class="setting-item vertical">
                            <div class="setting-info">
                                <h3>Testable Units</h3>
                                <p>Select published units students can practice.</p>
                            </div>
                            <div class="setting-controls full-width-control">
                                <div id="testable-units-container">
                                    <p class="loading-text">Loading units...</p>
                                    <label><input type="checkbox" class="testable-unit-checkbox" checked> Unit 1</label>
                                    <label><input type="checkbox" class="testable-unit-checkbox"> Unit 2</label>
                                </div>
                            </div>
                        </div>
                        <div class="setting-item">
                            <div class="setting-info">
                                <h3>Allow Lecture Material Access</h3>
                                <p>Students can download materials after missed answers.</p>
                            </div>
                            <div class="setting-controls">
                                <label class="toggle-switch">
                                    <input type="checkbox" id="quiz-material-access-toggle">
                                    <span class="toggle-slider"></span>
                                </label>
                            </div>
                        </div>
                    </div>
                </section>

                <section class="settings-section" id="validation-section">
                    <h2>Validation States</h2>
                    <div class="settings-content">
                        <div class="setting-item vertical">
                            <div class="setting-info">
                                <h3>Prompt Template</h3>
                                <p>Invalid controls show feedback.</p>
                            </div>
                            <div class="setting-controls full-width-control">
                                <input id="invalid-course-name" class="number-input is-invalid" value="">
                                <div class="invalid-feedback">Course name is required.</div>
                                <textarea id="base-prompt">Use evidence from course material.</textarea>
                            </div>
                        </div>
                    </div>
                </section>

                <section class="settings-section" id="system-admin-section">
                    <h2>System Admin Access</h2>
                    <div class="settings-content">
                        <div class="setting-item vertical">
                            <div class="setting-info">
                                <h3>Grant Admin Access</h3>
                                <p>Grant access to an existing user.</p>
                            </div>
                            <div class="setting-controls full-width-control">
                                <div class="system-admin-grant-row">
                                    <input id="system-admin-email-input" class="number-input system-admin-email-input" value="admin@example.test">
                                    <button id="grant-system-admin-btn" class="primary-button" type="button">Grant Admin Access</button>
                                </div>
                            </div>
                        </div>
                        <div class="setting-item vertical">
                            <div class="setting-info">
                                <h3>Current System Admins</h3>
                                <p>Rows show self, revoke, and empty states.</p>
                            </div>
                            <div class="setting-controls full-width-control">
                                <div id="system-admin-list" class="system-admin-list">
                                    <div class="system-admin-empty">No system admins found.</div>
                                    <div class="system-admin-row is-self">
                                        <div class="system-admin-details">
                                            <div class="system-admin-name-row">
                                                <strong>Current ${roleLabel}</strong>
                                                <span class="system-admin-badge">You</span>
                                            </div>
                                            <div class="system-admin-email">current@example.test</div>
                                            <div class="system-admin-meta">Last login: today</div>
                                        </div>
                                        <button class="secondary-button system-admin-revoke-btn" type="button">Revoke</button>
                                    </div>
                                    <div class="system-admin-row">
                                        <div class="system-admin-details">
                                            <div class="system-admin-name-row"><strong>Other Admin</strong></div>
                                            <div class="system-admin-email">other@example.test</div>
                                            <div class="system-admin-meta">Last login: yesterday</div>
                                        </div>
                                        <button class="secondary-button system-admin-revoke-btn" type="button">Revoke</button>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </section>

                <section class="settings-section" id="course-lifecycle-section">
                    <h2>Course Lifecycle</h2>
                    <div class="settings-content">
                        <div class="setting-item vertical">
                            <div class="setting-info">
                                <h3>Deactivate Course</h3>
                                <p>Course badges reflect active and inactive states.</p>
                            </div>
                            <div class="setting-controls full-width-control">
                                <div class="course-status-panel">
                                    <div class="course-status-header">
                                        <span class="course-state-badge active">Active</span>
                                        <span class="course-state-badge inactive">Inactive</span>
                                        <span class="course-state-note">Students and TAs can currently use this course.</span>
                                    </div>
                                    <button id="toggle-course-active-btn" class="danger-button" type="button">Deactivate Course</button>
                                </div>
                            </div>
                        </div>

                        <div class="setting-item vertical">
                            <div class="setting-info">
                                <h3>Transfer Course</h3>
                                <p>Transfer settings, TAs, and per-unit permissions.</p>
                            </div>
                            <div class="setting-controls full-width-control">
                                <div class="transfer-course-builder">
                                    <div class="transfer-field-group">
                                        <label for="transfer-course-name">New course name</label>
                                        <input id="transfer-course-name" class="number-input transfer-course-name-input" value="Copied Course">
                                    </div>
                                    <div class="transfer-global-options">
                                        <label class="transfer-option">
                                            <input type="checkbox" id="transfer-settings-toggle" checked>
                                            <span>Transfer course settings</span>
                                        </label>
                                        <label class="transfer-option">
                                            <input type="checkbox" id="transfer-tas-toggle" checked>
                                            <span>Transfer TAs and permissions</span>
                                        </label>
                                        <label class="transfer-option">
                                            <input type="checkbox" id="deactivate-source-after-transfer-toggle">
                                            <span>Deactivate source course after transfer</span>
                                        </label>
                                    </div>
                                    <div class="transfer-unit-section">
                                        <div class="transfer-unit-header">
                                            <div>
                                                <h4>Per-Unit Transfer</h4>
                                                <p>Copy documents, learning objectives, and questions independently.</p>
                                            </div>
                                            <div class="transfer-unit-masters">
                                                <label class="transfer-master-option">
                                                    <input type="checkbox" id="transfer-all-docs" checked>
                                                    <span>All docs</span>
                                                </label>
                                                <label class="transfer-master-option">
                                                    <input type="checkbox" id="transfer-all-objectives" checked>
                                                    <span>All learning objectives</span>
                                                </label>
                                                <label class="transfer-master-option">
                                                    <input type="checkbox" id="transfer-all-questions">
                                                    <span>All questions</span>
                                                </label>
                                            </div>
                                        </div>
                                        <div class="transfer-unit-grid" id="transfer-unit-grid">
                                            <div class="transfer-unit-grid-head">Unit</div>
                                            <div class="transfer-unit-grid-head">Docs + Chunks</div>
                                            <div class="transfer-unit-grid-head">Learning objectives</div>
                                            <div class="transfer-unit-grid-head">Questions</div>
                                            <div class="transfer-unit-row" data-unit-name="Unit 1">
                                                <div class="transfer-unit-name">Unit 1</div>
                                                <label class="transfer-unit-checkbox"><input type="checkbox" class="transfer-docs-checkbox" checked></label>
                                                <label class="transfer-unit-checkbox"><input type="checkbox" class="transfer-objectives-checkbox" checked></label>
                                                <label class="transfer-unit-checkbox"><input type="checkbox" class="transfer-questions-checkbox"></label>
                                            </div>
                                            <div class="transfer-unit-grid-empty">No more units.</div>
                                        </div>
                                    </div>
                                    <div class="transfer-actions">
                                        <button id="transfer-course-btn" class="primary-button" type="button">Create Course Copy</button>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </section>

                <div class="settings-actions settings-section-actions">
                    <button id="save-settings" class="primary-button" type="button">Save Settings</button>
                    <button id="reset-settings" class="secondary-button" type="button">Reset to Default</button>
                </div>
            </div>
        </main>
    </div>

    <div id="transfer-course-modal" class="transfer-modal-overlay" aria-hidden="true">
        <div class="transfer-modal" role="dialog" aria-modal="true" aria-labelledby="transfer-modal-title">
            <div class="transfer-modal-header">
                <h2 id="transfer-modal-title">Review Course Copy</h2>
            </div>
            <div class="transfer-modal-body">
                <div id="transfer-modal-confirmation">
                    <p id="transfer-modal-description">This will create a new course copy.</p>
                    <ul id="transfer-modal-summary" class="transfer-modal-summary">
                        <li>Copy settings and TA permissions.</li>
                        <li>Copy selected unit materials.</li>
                    </ul>
                    <div class="transfer-modal-note">Keep this tab open while the transfer runs.</div>
                </div>
                <div id="transfer-modal-loading" class="transfer-modal-loading" hidden>
                    <div class="transfer-modal-spinner" aria-hidden="true"></div>
                    <h3>Creating course copy...</h3>
                    <p id="transfer-modal-loading-text">Copying materials and rebuilding topics.</p>
                </div>
            </div>
            <div class="transfer-modal-footer">
                <button id="transfer-modal-cancel" class="secondary-button" type="button">Cancel</button>
                <button id="transfer-modal-confirm" class="primary-button" type="button">Start Course Copy</button>
            </div>
        </div>
    </div>

    <script>
        const testWindow = /** @type {any} */ (window);
        testWindow.showNotification = (message, type = 'info') => {
            let container = document.querySelector('.notification-container');
            if (!container) {
                container = document.createElement('div');
                container.className = 'notification-container';
                document.body.appendChild(container);
            }
            const notification = document.createElement('div');
            notification.className = 'notification ' + type;
            notification.textContent = message;
            const close = document.createElement('button');
            close.className = 'notification-close';
            close.type = 'button';
            close.textContent = 'x';
            close.addEventListener('click', () => notification.remove());
            notification.appendChild(close);
            container.appendChild(notification);
        };
        document.getElementById('save-settings').addEventListener('click', () => {
            testWindow.showNotification('Error saving settings', 'error');
        });
        document.getElementById('transfer-course-btn').addEventListener('click', () => {
            const modal = document.getElementById('transfer-course-modal');
            modal.classList.add('show');
            modal.setAttribute('aria-hidden', 'false');
        });
        document.getElementById('transfer-modal-confirm').addEventListener('click', () => {
            document.getElementById('transfer-modal-confirmation').hidden = true;
            document.getElementById('transfer-modal-loading').hidden = false;
            document.getElementById('transfer-modal-confirm').disabled = true;
        });
    </script>
</body>
</html>`;
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {'instructor' | 'ta'} role
 */
async function gotoSettingsHarness(page, role) {
    const path = role === 'ta' ? TA_HARNESS_PATH : INSTRUCTOR_HARNESS_PATH;
    await page.route(`**${path}`, async (route) => {
        await route.fulfill({
            status: 200,
            contentType: 'text/html',
            body: settingsHarness(role),
        });
    });
    await page.goto(path);
    await page.waitForLoadState('networkidle');
    await page.waitForFunction(() => {
        const section = document.querySelector('#quiz-settings-section');
        const transfer = document.querySelector('.transfer-unit-grid');
        return !!section && window.getComputedStyle(section).display !== 'none'
            && !!transfer && window.getComputedStyle(transfer).display === 'grid';
    });
}

/**
 * @param {import('@playwright/test').Locator} locator
 * @param {string} pseudo
 * @param {string} property
 */
async function pseudoStyle(locator, pseudo, property) {
    return locator.evaluate(
        (element, args) => window.getComputedStyle(element, args.pseudo).getPropertyValue(args.property),
        { pseudo, property }
    );
}

test.describe('settings.css harness coverage', () => {
    test('covers instructor settings control, validation, notification, and modal states', async ({ page }) => {
        await page.setViewportSize({ width: 1100, height: 1200 });
        await gotoSettingsHarness(page, 'instructor');

        await expect(page.locator('.settings-container')).toHaveCSS('max-width', '1040px');
        await expect(page.locator('.development-disclaimer')).toHaveCSS('display', 'flex');
        await expect(page.locator('.development-disclaimer .disclaimer-content strong')).toHaveCSS('color', 'rgb(108, 87, 0)');
        await expect(page.locator('.setting-item.checkbox')).toHaveCSS('align-items', 'center');
        await expect(page.locator('.setting-item.checkbox input')).toHaveCSS('width', '13px');
        await expect(page.locator('.setting-item.checkbox label')).toHaveCSS('font-weight', '400');

        await expect(page.locator('#danger-disabled')).toHaveCSS('cursor', 'not-allowed');
        await expect(page.locator('#danger-disabled')).toHaveCSS('opacity', '0.7');
        await page.locator('#danger-enabled').hover();
        await expect(page.locator('#danger-enabled')).toHaveCSS('background-color', 'rgb(211, 47, 47)');

        await expect(page.locator('#quiz-enabled-toggle + .toggle-slider')).toHaveCSS('background-color', 'rgb(44, 69, 93)');
        expect(await pseudoStyle(page.locator('#quiz-enabled-toggle + .toggle-slider'), '::before', 'transform')).not.toBe('none');
        await page.locator('#quiz-enabled-toggle').evaluate((element) => {
            const input = /** @type {HTMLInputElement} */ (element);
            input.checked = false;
            input.dispatchEvent(new Event('change', { bubbles: true }));
        });
        await expect(page.locator('#quiz-enabled-toggle + .toggle-slider')).toHaveCSS('background-color', 'rgb(118, 118, 118)');

        await expect(page.locator('#testable-units-container')).toHaveCSS('display', 'flex');
        await expect(page.locator('#testable-units-container .loading-text')).toHaveCSS('color', 'rgba(29, 31, 32, 0.7)');
        await page.locator('#testable-units-container label').first().hover();
        await expect(page.locator('#testable-units-container label').first()).toHaveCSS('border-color', 'rgb(44, 69, 93)');

        await expect(page.locator('.invalid-feedback')).toHaveCSS('color', 'rgb(220, 53, 69)');
        await expect(page.locator('#invalid-course-name')).toHaveCSS('border-color', 'rgb(220, 53, 69)');
        await page.locator('#base-prompt').focus();
        await expect(page.locator('#base-prompt')).toHaveCSS('border-color', 'rgb(44, 69, 93)');

        await expect(page.locator('.course-status-panel')).toHaveCSS('display', 'flex');
        await expect(page.locator('.course-state-badge.active')).toHaveCSS('color', 'rgb(31, 122, 70)');
        await expect(page.locator('.course-state-badge.inactive')).toHaveCSS('color', 'rgb(180, 35, 24)');

        await expect(page.locator('.transfer-global-options')).toHaveCSS('display', 'grid');
        await page.locator('.transfer-option').first().hover();
        await expect(page.locator('.transfer-option').first()).toHaveCSS('border-color', 'rgb(44, 69, 93)');
        await page.locator('.transfer-master-option').first().hover();
        await expect(page.locator('.transfer-master-option').first()).toHaveCSS('border-color', 'rgb(44, 69, 93)');
        await expect(page.locator('.transfer-unit-grid-head').first()).toHaveCSS('text-transform', 'uppercase');
        await expect(page.locator('.transfer-unit-row')).toHaveCSS('display', 'contents');
        await expect(page.locator('.transfer-unit-checkbox').first()).toHaveCSS('min-height', '52px');
        await expect(page.locator('.transfer-unit-grid-empty')).toHaveCSS('grid-column-start', '1');

        await page.locator('#save-settings').click();
        await expect(page.locator('.notification.error')).toContainText('Error saving settings');
        await expect(page.locator('.notification.error')).toHaveCSS('background-color', 'rgb(220, 53, 69)');

        await expect(page.locator('#transfer-course-modal')).toHaveCSS('display', 'none');
        await page.locator('#transfer-course-btn').click();
        await expect(page.locator('#transfer-course-modal')).toHaveCSS('display', 'flex');
        await expect(page.locator('.transfer-modal')).toHaveCSS('overflow', 'hidden');
        await expect(page.locator('.transfer-modal-header')).toHaveCSS('border-bottom-color', 'rgba(29, 31, 32, 0.16)');
        await expect(page.locator('.transfer-modal-header h2')).toHaveCSS('font-size', '19.2px');
        await expect(page.locator('.transfer-modal-body')).toHaveCSS('flex-direction', 'column');
        await expect(page.locator('.transfer-modal-body p').first()).toHaveCSS('line-height', '24.8px');
        await expect(page.locator('.transfer-modal-summary')).toHaveCSS('line-height', '24px');
        await expect(page.locator('.transfer-modal-summary li').nth(1)).toHaveCSS('margin-top', '5.6px');
        await expect(page.locator('.transfer-modal-note')).toHaveCSS('background-color', 'rgb(244, 247, 251)');
        await expect(page.locator('.transfer-modal-loading')).toHaveCSS('display', 'none');

        await page.locator('#transfer-modal-confirm').click();
        await expect(page.locator('#transfer-modal-confirmation')).toHaveCSS('display', 'none');
        await expect(page.locator('.transfer-modal-loading')).toHaveCSS('display', 'flex');
        await expect(page.locator('.transfer-modal-loading h3')).toHaveCSS('font-size', '16.8px');
        await expect(page.locator('.transfer-modal-spinner')).toHaveCSS('border-radius', '50%');
        await expect(page.locator('#transfer-modal-confirm')).toHaveCSS('cursor', 'not-allowed');
    });

    test('covers TA-flavored settings rows and mobile breakpoints', async ({ page }) => {
        await page.setViewportSize({ width: 500, height: 1000 });
        await gotoSettingsHarness(page, 'ta');

        await expect(page.locator('.settings-container')).toHaveCSS('padding-left', '10px');
        await expect(page.locator('.settings-section-actions')).toHaveCSS('flex-direction', 'column');
        await expect(page.locator('.settings-section-actions button').first()).toHaveCSS('width', '440px');

        await expect(page.locator('.system-admin-list')).toHaveCSS('display', 'grid');
        await expect(page.locator('.system-admin-row.is-self')).toHaveCSS('background-color', 'rgb(244, 251, 255)');
        await expect(page.locator('.system-admin-badge')).toHaveCSS('border-radius', '999px');
        await expect(page.locator('.system-admin-email').first()).toHaveCSS('color', 'rgba(29, 31, 32, 0.7)');
        await expect(page.locator('.system-admin-row').first()).toHaveCSS('flex-direction', 'column');
        await expect(page.locator('.system-admin-row').first()).toHaveCSS('align-items', 'stretch');
        await expect(page.locator('.system-admin-revoke-btn').first()).toBeVisible();
        await expect(page.locator('#grant-system-admin-btn')).toBeVisible();

        await expect(page.locator('.transfer-global-options')).toHaveCSS('grid-template-columns', /^[0-9.]+px$/);
        await expect(page.locator('.transfer-unit-header')).toHaveCSS('flex-direction', 'column');
        await expect(page.locator('.transfer-unit-masters')).toHaveCSS('grid-template-columns', /^[0-9.]+px$/);
        await expect(page.locator('.transfer-master-option').first()).toHaveCSS('justify-content', 'space-between');
        await expect(page.locator('.transfer-unit-grid')).toHaveCSS('font-size', '14.4px');
        await expect(page.locator('.transfer-unit-name')).toHaveCSS('min-height', '48px');
        await expect(page.locator('.transfer-unit-checkbox').first()).toHaveCSS('min-height', '48px');
        await expect(page.locator('.transfer-actions')).toHaveCSS('justify-content', 'stretch');
        await expect(page.locator('#transfer-course-btn')).toHaveCSS('width', /^[0-9.]+px$/);

        await page.locator('#transfer-course-btn').click();
        await expect(page.locator('#transfer-course-modal')).toHaveCSS('padding-left', '16px');
        await expect(page.locator('.transfer-modal-footer')).toHaveCSS('flex-direction', 'column-reverse');
        await expect(page.locator('.transfer-modal-footer button').first()).toHaveCSS('width', /^[0-9.]+px$/);
    });
});
