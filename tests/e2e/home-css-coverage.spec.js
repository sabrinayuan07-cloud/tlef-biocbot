// @ts-check
/**
 * Focused browser coverage for public/styles/home.css.
 *
 * public/instructor/home.html is the only public HTML page found by grep that links
 * /styles/home.css; public/ta/home.html uses /ta/styles/ta-home.css instead.
 *
 * Existing role specs exercise the real instructor home, student dashboard,
 * student hub, and TA hub flows. This harness fills CSS-only gaps that are
 * awkward to cover in one authenticated page load: hover/focus states,
 * empty/no-data variants, collapsed topic cards, modal visibility, pending
 * flag and content-completion banners, and mobile media queries.
 */

const { test, expect } = require('./fixtures/monocart');
const fs = require('fs/promises');
const path = require('path');
const { storageStatePath } = require('./helpers/users');

const HARNESS_PATH = '/home-css-coverage-harness';
const PUBLIC_DIR = path.resolve(__dirname, '../../public');

function homeCssHarness() {
    return `<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Home CSS Coverage Harness</title>
    <link rel="stylesheet" href="/styles/style.css">
    <link rel="stylesheet" href="/styles/home.css">
</head>
<body class="instructor-app">
    <div class="app-container">
        <header class="sidebar">
            <div class="logo-container"><h2>BiocBot</h2></div>
            <nav class="main-nav">
                <ul>
                    <li class="active"><a href="#">Home</a></li>
                    <li><a href="#">Super Chat Notes</a></li>
                </ul>
            </nav>
            <div class="user-info">Coverage Instructor</div>
        </header>
        <main class="main-content">
            <header class="home-header">
                <div class="header-content">
                    <h1>Home</h1>
                    <div class="course-selection-container" id="course-selection-container">
                        <div class="current-course-display" id="current-course-display">
                            <span class="course-label">Current Course:</span>
                            <span class="course-name-display" id="course-name-display">Coverage Biology</span>
                            <button class="action-btn secondary" id="change-course-btn">Change Course</button>
                        </div>
                        <div class="course-selector" id="course-selector">
                            <label for="course-select-dropdown">Select One of Your Courses:</label>
                            <select id="course-select-dropdown" class="course-select-dropdown">
                                <option>Coverage Biology</option>
                            </select>
                            <div id="selected-course-details" class="selected-course-details">
                                <div class="course-info">
                                    <h4>Coverage Biology</h4>
                                    <p><strong>Course ID:</strong> <span>BIOC-CSS</span></p>
                                    <p>Enter the instructor course code to join this course.</p>
                                </div>
                            </div>
                            <div class="course-selector-actions">
                                <button class="action-btn primary" type="button">Join Course</button>
                                <button class="action-btn secondary" type="button">Cancel</button>
                            </div>
                        </div>
                    </div>
                </div>
            </header>

            <div class="home-container">
                <section class="home-section course-summary">
                    <div class="section-header"><h2>Course Summary</h2></div>
                    <div class="course-info">
                        <div class="course-details">
                            <h2 class="course-name">Coverage Biology</h2>
                            <p class="course-meta">BIOL 101 - Spring</p>
                        </div>
                        <div class="course-actions">
                            <button class="action-btn primary" type="button">Course Upload</button>
                            <button class="action-btn secondary" type="button">Settings</button>
                        </div>
                    </div>
                </section>

                <section class="home-section daily-digest">
                    <div class="section-header"><h2>Daily Digest</h2></div>
                    <div class="digest-content">
                        <div class="digest-stats">
                            <div class="stat-item">
                                <span class="stat-label">New sessions</span>
                                <span class="stat-value">4</span>
                            </div>
                            <div class="stat-item">
                                <span class="stat-label">Average duration</span>
                                <span class="stat-value">6m</span>
                            </div>
                        </div>
                        <div class="digest-flags">
                            <div class="flags-info">
                                <span class="flags-count">2 pending flags</span>
                            </div>
                            <button class="action-btn secondary" type="button">Review</button>
                        </div>
                    </div>
                </section>

                <section class="home-section recent-activity">
                    <div class="section-header"><h2>Recent Activity</h2></div>
                    <div class="activity-list">
                        <div class="activity-item success" tabindex="0">
                            <span class="activity-number">1</span>
                            <span class="activity-text">Student completed Unit 1</span>
                        </div>
                        <div class="activity-item error">
                            <span class="activity-number">2</span>
                            <span class="activity-text">Upload failed validation</span>
                        </div>
                    </div>
                </section>

                <section class="home-section flagged-section has-pending-flags">
                    <div class="section-header"><h2>Flagged Content</h2></div>
                    <div class="flagged-content">
                        <div class="flagged-info">
                            <p class="flagged-description">Review and respond to questions flagged by students</p>
                            <div class="flagged-stats">
                                <span class="flagged-count-label">Pending Flags:</span>
                                <span class="flagged-count">3</span>
                            </div>
                        </div>
                        <a href="/instructor/flagged" class="action-btn primary view-flags-btn">View Flagged Questions</a>
                    </div>
                </section>

                <section class="home-section missing-items-section" id="missing-items-section">
                    <div class="section-header"><h2>Missing Course Content</h2></div>
                    <div class="missing-items-content">
                        <p class="missing-items-description">The following units are missing required content.</p>
                        <div class="missing-items-list">
                            <div class="missing-item">
                                <div class="missing-item-header">
                                    <span class="missing-item-course">Coverage Biology</span>
                                    <span class="missing-item-unit">Unit 2</span>
                                </div>
                                <div class="missing-item-details">Missing: Lecture Notes, Practice Questions</div>
                                <div class="missing-item-actions">
                                    <a class="action-btn secondary" href="/instructor/documents">Fix Missing Items</a>
                                </div>
                            </div>
                        </div>
                    </div>
                </section>

                <section class="home-section complete-section" id="complete-section">
                    <div class="section-header"><h2>All Units Complete</h2></div>
                    <div class="complete-content">
                        <p>All units have the required learning objectives, lecture notes, and practice questions.</p>
                    </div>
                </section>

                <section class="home-section onboarding-prompt-section" id="onboarding-prompt-section">
                    <div class="section-header"><h2>Complete Your Onboarding</h2></div>
                    <div class="onboarding-prompt-content">
                        <p class="onboarding-prompt-description">Welcome to BiocBot. Complete onboarding to set up your course.</p>
                        <a href="/instructor/onboarding" class="action-btn primary">Go to Onboarding Page</a>
                    </div>
                </section>

                <section class="home-section disclaimer-section">
                    <div class="section-header"><h2>Important Disclaimers</h2></div>
                    <div class="disclaimer-content">
                        <div class="disclaimer-item">
                            <strong>Copyright Permission:</strong>
                            <p>Course content must have proper permissions before upload.</p>
                        </div>
                        <div class="disclaimer-item">
                            <strong>AI Processing:</strong>
                            <p>Uploaded content will be processed for embedding generation.</p>
                        </div>
                    </div>
                </section>

                <section class="home-section statistics-section" id="statistics-section">
                    <div class="section-header"><h2><span aria-hidden="true">📊</span> Course Statistics</h2></div>
                    <div class="statistics-content">
                        <div class="statistics-grid">
                            <div class="stat-card">
                                <div class="stat-label">Total Students</div>
                                <div class="stat-value">24</div>
                            </div>
                            <div class="stat-card">
                                <div class="stat-label">Total Sessions</div>
                                <div class="stat-value">42</div>
                                <div class="stat-sublabel">sessions</div>
                            </div>
                        </div>
                        <div class="mode-distribution">
                            <div class="stat-label">Mode Distribution</div>
                            <div class="mode-bars">
                                <div class="mode-bar-item">
                                    <div class="mode-label">Tutor Mode</div>
                                    <div class="mode-bar"><div class="mode-bar-fill tutor" style="width: 65%">65%</div></div>
                                    <div class="mode-count">13</div>
                                </div>
                                <div class="mode-bar-item">
                                    <div class="mode-label">Protege Mode</div>
                                    <div class="mode-bar"><div class="mode-bar-fill protege" style="width: 35%">35%</div></div>
                                    <div class="mode-count">7</div>
                                </div>
                            </div>
                        </div>
                    </div>
                </section>

                <section class="home-section approved-topics-section section-collapsed" id="approved-topics-section">
                    <div class="section-header clickable">
                        <h2><span class="section-toggle-icon">▼</span>Approved Global Topics <span class="info-icon tooltip" data-tooltip="Approved topics for this course.">i</span></h2>
                    </div>
                    <div class="approved-topics-content" id="approved-topics-content">
                        <p class="no-data-message">No approved global topics set yet. Add one below.</p>
                        <div class="approved-topics-chips-container">
                            <span class="approved-topic-chip" data-topic="Respiration">
                                <span class="topic-chip-label">Respiration</span>
                                <span class="topic-unit-badge mapped">Unit 1</span>
                                <button class="topic-chip-remove" type="button">x</button>
                            </span>
                            <span class="approved-topic-chip editing" data-topic="Photosynthesis">
                                <input class="topic-chip-edit-input" value="Photosynthesis">
                                <span class="topic-unit-badge unassigned">Unassigned</span>
                            </span>
                        </div>
                        <div class="approved-topics-add-row">
                            <input class="approved-topic-input" id="new-topic-input" value="osmosis">
                            <select class="approved-topic-unit-select"><option>Unit 2</option></select>
                            <button class="approved-topic-add-btn" type="button">+ Add</button>
                        </div>
                        <div class="approved-topics-footer">
                            <span>2 topics</span>
                            <span class="approved-topics-hint">Double-click a topic to edit it</span>
                        </div>
                    </div>
                </section>

                <section class="home-section persistence-topics-section" id="persistence-topics-section">
                    <div class="section-header"><h2>Cumulative Struggle Topics</h2></div>
                    <div class="persistence-topic-card clickable-topic-card" data-topic="osmosis" role="button" tabindex="0">
                        <strong>Osmosis</strong>
                        <span class="topic-unit-badge mapped">Unit 2</span>
                    </div>
                </section>

                <section class="home-section struggle-topics-section" id="struggle-topics-section">
                    <div class="section-header clickable">
                        <h2><span class="section-toggle-icon">▼</span>Struggle Topics <span class="info-icon tooltip" data-tooltip="Current struggle topics.">i</span></h2>
                    </div>
                    <div class="struggle-topics-content" id="struggle-topics-content">
                        <p class="no-data-message">No struggle topics recorded for this course yet.</p>
                        <div class="struggle-topic-item collapsed">
                            <div class="topic-header">
                                <h3><span class="toggle-icon">▼</span> Cell membranes</h3>
                                <span class="badge">2 students (1 active)</span>
                            </div>
                            <div class="topic-content">Student A Student B</div>
                        </div>
                    </div>
                    <div class="weekly-struggle-chart-container" id="weekly-struggle-chart-container">
                        <div class="chart-header">
                            <h3>Weekly Active Struggle Trends <span class="info-icon tooltip" data-tooltip="Weekly active struggles.">i</span></h3>
                            <div class="chart-nav-controls">
                                <button class="action-btn secondary chart-nav-btn" disabled>Earlier</button>
                                <span class="chart-week-range">May 11 - May 17</span>
                                <button class="action-btn secondary chart-nav-btn">Later</button>
                            </div>
                        </div>
                        <div class="chart-canvas-wrapper"><canvas></canvas></div>
                        <div class="chart-legend-note">Each bar shows unique students.</div>
                    </div>
                    <div class="live-struggle-table-container" id="live-struggle-container">
                        <div class="table-header">
                            <h3>Live Struggle Activity</h3>
                            <div class="table-controls">
                                <label class="filter-checkbox">
                                    <input type="checkbox" checked>
                                    <span>Show only active</span>
                                </label>
                                <button class="action-btn secondary" type="button">Download CSV</button>
                            </div>
                        </div>
                        <div class="table-scroll-container">
                            <table class="live-struggle-table">
                                <thead><tr><th>Time</th><th>Name</th><th>Topic</th><th>State</th></tr></thead>
                                <tbody>
                                    <tr><td>10:00</td><td>Ada</td><td>Cell membranes</td><td><span class="state-badge active">Active</span></td></tr>
                                    <tr><td>10:05</td><td>Grace</td><td>Osmosis</td><td><span class="state-badge inactive">Inactive</span></td></tr>
                                    <tr class="no-data-row"><td colspan="4">No struggle activity yet.</td></tr>
                                </tbody>
                            </table>
                        </div>
                    </div>
                </section>
            </div>
        </main>
    </div>

    <div class="topic-unit-modal" id="topic-unit-assignment-modal">
        <div class="topic-unit-modal-card">
            <div class="topic-unit-modal-header">
                <h3>Assign Topic to Unit</h3>
                <button class="topic-unit-modal-close" type="button">x</button>
            </div>
            <div class="topic-unit-modal-body">
                <p class="topic-unit-modal-topic">Osmosis</p>
                <select class="topic-unit-select"><option>Unit 2</option></select>
                <p class="topic-unit-modal-hint">This uses the stable unit name.</p>
            </div>
            <div class="topic-unit-modal-actions">
                <button class="approved-topic-add-btn secondary" type="button">Cancel</button>
                <button class="approved-topic-add-btn" type="button">Save</button>
            </div>
        </div>
    </div>
</body>
</html>`;
}

/**
 * @param {import('@playwright/test').Page} page
 */
async function gotoHarness(page) {
    await page.route('**/styles/style.css', async (route) => {
        await route.fulfill({
            status: 200,
            contentType: 'text/css',
            body: await fs.readFile(path.join(PUBLIC_DIR, 'styles/style.css'), 'utf8'),
        });
    });
    await page.route('**/styles/home.css', async (route) => {
        await route.fulfill({
            status: 200,
            contentType: 'text/css',
            body: await fs.readFile(path.join(PUBLIC_DIR, 'styles/home.css'), 'utf8'),
        });
    });
    await page.route(`**${HARNESS_PATH}`, async (route) => {
        await route.fulfill({
            status: 200,
            contentType: 'text/html',
            body: homeCssHarness(),
        });
    });
    await page.goto(HARNESS_PATH);
    await page.waitForLoadState('networkidle');
    await page.waitForFunction(() => {
        const testWindow = /** @type {any} */ (window);
        const homeContainer = testWindow.document.querySelector('.home-container');
        return homeContainer && testWindow.getComputedStyle(homeContainer).display === 'grid';
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

test.describe('home.css harness coverage', () => {
    test.use({ storageState: storageStatePath('instructor') });

    test('styles instructor home dashboard states and interactive variants', async ({ page }) => {
        await page.setViewportSize({ width: 1180, height: 1200 });
        await gotoHarness(page);

        await expect(page.locator('.home-header')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
        const sidebarLayout = await page.locator('.sidebar').evaluate((sidebar) => {
            const nav = sidebar.querySelector('.main-nav');
            if (!nav) return null;
            const sidebarRect = sidebar.getBoundingClientRect();
            const navRect = nav.getBoundingClientRect();
            return {
                leftInset: navRect.left - sidebarRect.left,
                rightInset: sidebarRect.right - navRect.right,
            };
        });
        expect(sidebarLayout).toEqual({ leftInset: 20, rightInset: 20 });
        await expect(page.locator('.course-selection-container')).toHaveCSS('border-radius', '8px');
        await expect(page.locator('.current-course-display')).toHaveCSS('display', 'flex');
        await expect(page.locator('.course-selector')).toHaveCSS('flex-direction', 'column');
        await expect(page.locator('.course-select-dropdown').first()).toHaveCSS('max-width', '470px');
        await expect(page.locator('.selected-course-details')).toHaveCSS('background-color', 'rgb(255, 255, 255)');

        await page.locator('#course-select-dropdown').hover();
        await expect(page.locator('#course-select-dropdown')).toHaveCSS('border-color', 'rgb(44, 69, 93)');
        await page.locator('#course-select-dropdown').focus();
        await expect(page.locator('#course-select-dropdown')).toHaveCSS('box-shadow', 'rgba(74, 144, 226, 0.1) 0px 0px 0px 3px');

        await expect(page.locator('.course-summary .course-info')).toHaveCSS('display', 'flex');
        await expect(page.locator('.course-name')).toHaveCSS('font-size', '32px');
        await expect(page.locator('.daily-digest .digest-content')).toHaveCSS('display', 'flex');
        await expect(page.locator('.digest-flags')).toHaveCSS('align-items', 'flex-end');
        await expect(page.locator('.activity-item.success .activity-text')).toHaveCSS('color', 'rgb(40, 167, 69)');
        await expect(page.locator('.activity-item.error .activity-text')).toHaveCSS('color', 'rgb(220, 53, 69)');

        await page.locator('.activity-item').first().hover();
        await expect(page.locator('.activity-item').first()).toHaveCSS('background-color', 'rgb(234, 235, 236)');
        await page.locator('.activity-item').first().focus();
        await expect(page.locator('.activity-item').first()).toHaveCSS('outline-style', 'solid');

        await expect(page.locator('.action-btn.primary').first()).toHaveCSS('color', 'rgb(255, 255, 255)');
        await page.locator('.course-actions .action-btn.primary').hover();
        expect(await page.locator('.course-actions .action-btn.primary').evaluate((el) => getComputedStyle(el).transform)).not.toBe('none');
        await expect(page.locator('.action-btn.secondary').first()).toHaveCSS('background-color', 'rgb(108, 117, 125)');

        await expect(page.locator('.flagged-section.has-pending-flags')).toHaveCSS('border-left-color', 'rgb(44, 69, 93)');
        await expect(page.locator('.flagged-content')).toHaveCSS('display', 'flex');
        await expect(page.locator('.missing-item')).toHaveCSS('background-color', 'rgb(255, 243, 205)');
        await expect(page.locator('.missing-items-section')).toHaveCSS('border-left-color', 'rgb(255, 193, 7)');
        await expect(page.locator('.complete-section')).toHaveCSS('border-left-color', 'rgb(40, 167, 69)');
        await expect(page.locator('.onboarding-prompt-section')).toHaveCSS('border-left-color', 'rgb(44, 69, 93)');
        await expect(page.locator('.disclaimer-item').first()).toHaveCSS('border-left-color', 'rgb(108, 117, 125)');

        await expect(page.locator('.statistics-grid')).toHaveCSS('display', 'grid');
        const statisticsEmojiSpacing = await page
            .locator('#statistics-section .section-header h2 > span[aria-hidden="true"]')
            .evaluate((emoji) => Number.parseFloat(getComputedStyle(emoji).marginRight));
        expect(statisticsEmojiSpacing).toBeGreaterThan(0);
        await expect(page.locator('.stat-card').first()).toHaveCSS('text-align', 'center');
        await page.locator('.stat-card').first().hover();
        expect(await page.locator('.stat-card').first().evaluate((el) => getComputedStyle(el).transform)).not.toBe('none');
        await expect(page.locator('.mode-bar-fill.tutor')).toHaveCSS('background-image', /linear-gradient/);
        await expect(page.locator('.mode-bar-fill.protege')).toHaveCSS('background-image', /linear-gradient/);
    });

    test('styles generated topic, table, tooltip, modal, and empty variants', async ({ page }) => {
        await page.setViewportSize({ width: 1100, height: 1200 });
        await gotoHarness(page);

        await expect(page.locator('.live-struggle-table-container')).toHaveCSS('border-radius', '8px');
        await expect(page.locator('.live-struggle-table-container .table-header')).toHaveCSS('display', 'flex');
        await expect(page.locator('.table-controls')).toHaveCSS('display', 'flex');
        await expect(page.locator('.filter-checkbox')).toHaveCSS('user-select', 'none');
        await expect(page.locator('.table-scroll-container')).toHaveCSS('overflow-x', 'auto');
        await expect(page.locator('.live-struggle-table')).toHaveCSS('border-collapse', 'collapse');
        await expect(page.locator('.live-struggle-table thead')).toHaveCSS('background-color', 'rgb(242, 242, 243)');
        await expect(page.locator('.state-badge.active')).toHaveCSS('background-color', 'rgb(220, 53, 69)');
        await expect(page.locator('.state-badge.inactive')).toHaveCSS('background-color', 'rgb(108, 117, 125)');
        await expect(page.locator('.live-struggle-table .no-data-row')).toHaveCSS('background-color', 'rgb(242, 242, 243)');
        await page.locator('.live-struggle-table tbody tr').first().hover();
        await expect(page.locator('.live-struggle-table tbody tr').first()).toHaveCSS('background-color', 'rgb(242, 242, 243)');

        await expect(page.locator('.weekly-struggle-chart-container')).toHaveCSS('border-radius', '8px');
        await expect(page.locator('.weekly-struggle-chart-container .chart-header')).toHaveCSS('display', 'flex');
        await expect(page.locator('.chart-nav-controls')).toHaveCSS('display', 'flex');
        await expect(page.locator('.chart-nav-btn').first()).toHaveCSS('opacity', '0.4');
        await expect(page.locator('.chart-canvas-wrapper')).toHaveCSS('height', '300px');
        await expect(page.locator('.chart-legend-note')).toHaveCSS('font-style', 'italic');

        await expect(page.locator('.info-icon').first()).toHaveCSS('border-radius', '50%');
        await page.locator('.info-icon').first().hover();
        await expect(page.locator('.info-icon').first()).toHaveCSS('background-color', 'rgb(222, 226, 230)');
        // Poll: visibility transitions over 0.2s, so a one-shot read can catch
        // the pseudo-element while it still computes as hidden.
        await expect.poll(() => pseudoStyle(page.locator('.tooltip').first(), '::after', 'visibility')).toBe('visible');

        await expect(page.locator('.struggle-topic-item')).toHaveCSS('overflow', 'hidden');
        await expect(page.locator('.topic-header')).toHaveCSS('cursor', 'pointer');
        await expect(page.locator('.struggle-topic-item.collapsed .topic-content')).toHaveCSS('display', 'none');
        expect(await page.locator('.struggle-topic-item.collapsed .toggle-icon').evaluate((el) => getComputedStyle(el).transform)).not.toBe('none');
        await page.locator('.topic-header').hover();
        await expect(page.locator('.topic-header')).toHaveCSS('opacity', '0.8');
        await expect(page.locator('.home-section.section-collapsed .section-toggle-icon')).toHaveCSS('transform', /matrix/);
        await expect(page.locator('.home-section.section-collapsed > .approved-topics-content')).toHaveCSS('display', 'none');
        await page.locator('#approved-topics-section').evaluate((element) => element.classList.remove('section-collapsed'));

        await expect(page.locator('.approved-topics-chips-container')).toHaveCSS('display', 'flex');
        await expect(page.locator('.approved-topic-chip').first()).toHaveCSS('border-radius', '999px');
        await page.locator('.approved-topic-chip').first().hover();
        await expect(page.locator('.approved-topic-chip').first()).toHaveCSS('background-color', 'rgb(220, 238, 255)');
        await expect(page.locator('.approved-topic-chip.editing')).toHaveCSS('border-color', 'rgb(74, 144, 217)');
        await expect(page.locator('.topic-unit-badge.mapped').first()).toHaveCSS('color', 'rgb(20, 108, 67)');
        await expect(page.locator('.topic-unit-badge.unassigned')).toHaveCSS('color', 'rgb(154, 91, 0)');
        await page.locator('.topic-chip-remove').hover();
        await expect(page.locator('.topic-chip-remove')).toHaveCSS('background-color', 'rgb(220, 53, 69)');
        await page.locator('.approved-topic-input').focus();
        await expect(page.locator('.approved-topic-input')).toHaveCSS('border-color', 'rgb(74, 144, 217)');
        await expect(page.locator('.approved-topic-unit-select')).toHaveCSS('border-radius', '8px');
        await page.locator('.approved-topic-add-btn').first().hover();
        await expect(page.locator('.approved-topic-add-btn').first()).toHaveCSS('background-color', 'rgb(58, 123, 200)');

        await expect(page.locator('.clickable-topic-card')).toHaveCSS('cursor', 'pointer');
        await page.locator('.clickable-topic-card').hover();
        expect(await page.locator('.clickable-topic-card').evaluate((el) => getComputedStyle(el).transform)).not.toBe('none');

        await page.locator('#topic-unit-assignment-modal').evaluate((element) => element.classList.add('show'));
        await expect(page.locator('.topic-unit-modal.show')).toHaveCSS('display', 'flex');
        await page.locator('.approved-topic-add-btn.secondary').hover();
        await expect(page.locator('.approved-topic-add-btn.secondary')).toHaveCSS('background-color', 'rgb(238, 246, 255)');
        await expect(page.locator('.topic-unit-modal-card')).toHaveCSS('width', '440px');
        await expect(page.locator('.topic-unit-modal-header')).toHaveCSS('display', 'flex');
        await expect(page.locator('.topic-unit-modal-body')).toHaveCSS('display', 'grid');
        await expect(page.locator('.topic-unit-modal-topic')).toHaveCSS('font-weight', '700');
        await expect(page.locator('.topic-unit-modal-hint')).toHaveCSS('font-size', '13.6px');
        await expect(page.locator('.topic-unit-modal-actions')).toHaveCSS('justify-content', 'flex-end');
    });

    test('applies mobile home layout rules for instructor dashboard variants', async ({ page }) => {
        await page.setViewportSize({ width: 460, height: 1000 });
        await gotoHarness(page);

        await expect(page.locator('.home-container')).toHaveCSS('padding', '15px');
        await expect(page.locator('.home-section').first()).toHaveCSS('padding', '15px');
        await expect(page.locator('.home-header')).toHaveCSS('padding', '0px 0px 20px');
        await expect(page.locator('.home-header h1')).toHaveCSS('font-size', '20px');
        await expect(page.locator('.section-header h2').first()).toHaveCSS('font-size', '20.8px');
        await expect(page.locator('.course-summary .course-info')).toHaveCSS('flex-direction', 'column');
        await expect(page.locator('.course-name')).toHaveCSS('font-size', '24px');
        await expect(page.locator('.course-actions')).toHaveCSS('flex-direction', 'column');
        await expect(page.locator('.action-btn').first()).toHaveCSS('text-align', 'center');
        await expect(page.locator('.digest-flags')).toHaveCSS('align-items', 'flex-start');
        await expect(page.locator('.stat-item').first()).toHaveCSS('flex-direction', 'column');
        await expect(page.locator('.flagged-content')).toHaveCSS('flex-direction', 'column');
        await expect(page.locator('.view-flags-btn')).toHaveCSS('text-align', 'center');
        await expect(page.locator('.missing-item-header')).toHaveCSS('flex-direction', 'column');
        await expect(page.locator('.onboarding-prompt-section .action-btn.primary')).toHaveCSS('text-align', 'center');
        await expect(page.locator('.stat-card').first()).toHaveCSS('padding', '15px');
        await expect(page.locator('.stat-card .stat-value').first()).toHaveCSS('font-size', '24px');
        await expect(page.locator('.mode-bar-item').first()).toHaveCSS('flex-direction', 'column');
        await expect(page.locator('.mode-bar').first()).toHaveCSS('border-radius', '6px');
        await expect(page.locator('.mode-count').first()).toHaveCSS('text-align', 'left');
        await expect(page.locator('.live-struggle-table-container .table-header')).toHaveCSS('flex-direction', 'column');
        await expect(page.locator('.table-controls')).toHaveCSS('justify-content', 'space-between');
        await expect(page.locator('.live-struggle-table td').first()).toHaveCSS('font-size', '14.4px');
        await expect(page.locator('.weekly-struggle-chart-container .chart-header')).toHaveCSS('flex-direction', 'column');
        // getComputedStyle returns the resolved pixel value for `width`, not the
        // declared "100%". Validate the mobile @media rule by checking that the
        // nav controls actually fill their flex-column parent.
        const navMatchesParent = await page.evaluate(() => {
            const nav = document.querySelector('.chart-nav-controls');
            const parent = nav?.parentElement;
            if (!nav || !parent) return false;
            return Math.abs(nav.getBoundingClientRect().width - parent.getBoundingClientRect().width) < 1;
        });
        expect(navMatchesParent).toBe(true);
        await expect(page.locator('.chart-canvas-wrapper')).toHaveCSS('height', '250px');
        await expect(page.locator('.approved-topics-add-row')).toHaveCSS('grid-template-columns', /430px|1fr/);
    });
});
