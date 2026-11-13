// @ts-check
/**
 * Focused browser coverage for public/styles/documents.css.
 *
 * This spec uses a static harness instead of production JS so the assertions
 * stay about CSS behavior only. The DOM mirrors states produced by
 * public/instructor/index.html, public/instructor/onboarding.html, and
 * public/instructor/scripts/instructor.js.
 */

const { test, expect } = require('./fixtures/monocart');
const fs = require('fs');
const path = require('path');

const HARNESS_PATH = '/documents-css-coverage-harness';

// /instructor/* static assets (including components.css) sit behind
// authMiddleware.requireInstructorOrTA server-side, which this harness's
// unauthenticated page.goto() can't pass - a <link> to it would silently
// 302 to /login and never apply. Inlining the real file's content as a
// <style> tag exercises the same rules without needing the guarded route.
const componentsCss = fs.readFileSync(
    path.join(__dirname, '../../public/instructor/styles/components.css'),
    'utf8'
);

function documentsCssHarness() {
    return `<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Documents CSS Coverage Harness</title>
    <link rel="stylesheet" href="/styles/style.css">
    <link rel="stylesheet" href="/styles/documents.css">
    <style>${componentsCss}</style>
</head>
<body>
    <div class="app-container">
        <main class="main-content">
            <header class="documents-header">
                <h1>Biology 101 Course Upload</h1>
            </header>
            <div class="course-subtitle">
                <p>Course Material</p>
            </div>

            <div class="action-buttons-container">
                <button class="action-btn with-icon" type="button">
                    <span class="btn-icon">+</span>
                    Add course unit
                </button>
            </div>

            <div class="document-tabs">
                <div class="tab-header">
                    <button class="tab-btn active" type="button">Materials</button>
                    <button class="tab-btn" id="inactive-tab" type="button">Questions</button>
                </div>
                <div class="tab-content">
                    <div class="accordion-container">
                        <section class="accordion-item published" data-unit-name="Unit 1">
                            <div class="accordion-header">
                                <span class="folder-icon">Unit</span>
                                <span class="folder-name">Unit 1</span>
                                <div class="header-actions">
                                    <div class="publish-toggle">
                                        <label class="toggle-switch">
                                            <input id="publish-unit-1" type="checkbox" checked>
                                            <span class="toggle-slider"></span>
                                        </label>
                                        <span class="toggle-label">Published</span>
                                    </div>
                                    <button class="delete-unit-btn" type="button">
                                        <span class="btn-icon">x</span>
                                    </button>
                                </div>
                                <span class="accordion-toggle">v</span>
                            </div>

                            <div class="accordion-content">
                                <section class="unit-section learning-objectives-section">
                                    <div class="section-header">
                                        <h3>Learning Objectives</h3>
                                        <button class="toggle-section" type="button">v</button>
                                    </div>
                                    <div class="section-content">
                                        <h4>Objectives</h4>
                                        <p>Please provide 3 to 8 learning objectives covered by this unit.</p>
                                        <div class="objectives-list">
                                            <div class="objective-display-item">
                                                <span class="objective-text">Explain enzyme regulation.</span>
                                                <button class="remove-objective" type="button">x</button>
                                            </div>
                                        </div>
                                        <div class="objective-input-container">
                                            <input id="objective-input" class="objective-input" type="text" value="Compare catalysts">
                                            <button class="add-objective-btn-inline" type="button">+</button>
                                        </div>
                                        <div class="save-objectives">
                                            <button class="save-btn" type="button">Save Learning Objectives</button>
                                        </div>
                                    </div>
                                </section>

                                <section class="unit-section course-materials-section">
                                    <div class="section-header">
                                        <h3>Course Materials</h3>
                                        <button class="toggle-section" type="button">v</button>
                                    </div>
                                    <div class="section-content">
                                        <div class="content-type-header">
                                            <p><strong>Required Materials:</strong> lecture notes and practice questions are mandatory.</p>
                                        </div>

                                        <div class="file-item placeholder-item" data-document-type="lecture_notes">
                                            <span class="file-icon">File</span>
                                            <div class="file-info">
                                                <h3>*Lecture Notes - Unit 1</h3>
                                                <p>Placeholder for required lecture notes.</p>
                                                <span class="status-text not-uploaded">Not Uploaded</span>
                                            </div>
                                            <div class="file-actions">
                                                <button class="action-button upload" type="button">Upload</button>
                                            </div>
                                        </div>

                                        <div class="file-item" data-document-id="doc-uploaded" data-document-type="lecture_notes">
                                            <span class="file-icon">File</span>
                                            <div class="file-info uploaded">
                                                <h3>lecture-notes.txt</h3>
                                                <p>Uploaded from the document upload modal.</p>
                                                <span class="status-text uploaded">Uploaded</span>
                                            </div>
                                            <div class="file-actions">
                                                <button class="action-button view" type="button">View</button>
                                                <button class="action-button download" type="button">Download</button>
                                                <button class="action-button delete" type="button">Delete</button>
                                            </div>
                                        </div>

                                        <div class="file-item additional-material-item" data-document-id="doc-failed" data-document-type="additional">
                                            <span class="file-icon">File</span>
                                            <div class="file-info">
                                                <h3>supplemental-reading.pdf</h3>
                                                <p>Displayed with a failed status after a processing error.</p>
                                                <span class="status-text failed">Failed</span>
                                            </div>
                                            <div class="file-actions">
                                                <button class="action-button upload" type="button">Retry</button>
                                            </div>
                                        </div>

                                        <div class="add-content-section">
                                            <button class="add-content-btn additional-material" type="button">
                                                <span class="btn-icon">+</span>
                                                Add Additional Material
                                            </button>
                                        </div>
                                    </div>
                                </section>

                                <section class="unit-section assessment-questions-section">
                                    <div class="section-header">
                                        <h3>Assessment Questions</h3>
                                        <button class="toggle-section" type="button">v</button>
                                    </div>
                                    <div class="section-content">
                                        <div class="assessment-info">
                                            <p>Assessment questions determine student readiness.</p>
                                        </div>
                                        <div class="threshold-setting">
                                            <label for="pass-threshold-onboarding">Correct answers required</label>
                                            <input id="pass-threshold-onboarding" class="threshold-input" type="number" value="2">
                                            <span class="threshold-help">out of total questions</span>
                                        </div>
                                        <div class="questions-list">
                                            <div class="no-questions-message">
                                                <p>No assessment questions created yet.</p>
                                            </div>
                                            <article class="question-item">
                                                <header class="question-header">
                                                    <span class="question-type-badge true-false">True/False</span>
                                                    <span class="question-number">Question 1</span>
                                                    <div class="question-action-buttons">
                                                        <button class="edit-question-btn" type="button">e</button>
                                                        <button class="delete-question-btn" type="button">x</button>
                                                    </div>
                                                </header>
                                                <div class="question-content">
                                                    <p class="question-text">Enzymes lower activation energy.</p>
                                                    <div class="question-learning-objective">
                                                        <span class="question-learning-objective-label">Learning Objective</span>
                                                        <span class="question-learning-objective-value">Explain enzyme regulation</span>
                                                        <span class="question-learning-objective-value unassigned">Unassigned</span>
                                                    </div>
                                                    <p class="answer-preview">Answer: True</p>
                                                    <div class="mcq-preview">
                                                        <span class="mcq-option-preview">A. Slower reactions</span>
                                                        <span class="mcq-option-preview correct">B. Lower activation energy</span>
                                                    </div>
                                                </div>
                                            </article>
                                        </div>
                                        <div class="assessment-actions">
                                            <button class="add-question-btn" type="button">
                                                <span class="btn-icon">+</span>
                                                Add Question
                                            </button>
                                            <button class="auto-link-btn is-loading" type="button" disabled>
                                                <span class="btn-icon">*</span>
                                                Auto-link Questions
                                            </button>
                                            <button class="generate-ai-btn" type="button" disabled>Generate with AI</button>
                                        </div>
                                        <p class="learning-objective-note">AI selected this objective.</p>
                                        <p class="edit-learning-objective-question-text">Which concept should this question assess?</p>
                                        <div class="save-assessment">
                                            <button class="save-btn" type="button">Save Assessment</button>
                                        </div>
                                    </div>
                                </section>
                            </div>
                        </section>

                        <section class="accordion-item" data-unit-name="Unit 2">
                            <div class="accordion-header">
                                <span class="folder-name">Unit 2</span>
                                <span class="accordion-toggle">&gt;</span>
                            </div>
                            <div class="accordion-content collapsed">
                                <p>Collapsed unit content.</p>
                            </div>
                        </section>
                    </div>
                </div>
            </div>

            <section class="empty-course-state">
                <div class="empty-message">
                    <h3>No course selected</h3>
                    <p>Choose a course before uploading material.</p>
                    <a class="btn-primary" href="/instructor/home">Choose Course</a>
                </div>
            </section>
        </main>
    </div>

    <div id="upload-modal" class="modal">
        <div class="modal-content">
            <div class="modal-header">
                <h2>Upload Content</h2>
                <button class="modal-close" type="button">x</button>
            </div>
            <div class="modal-body">
                <div class="upload-loading-indicator">
                    <div class="loading-spinner"></div>
                    <div class="loading-message">
                        <p><strong>Uploading and processing document...</strong></p>
                        <p class="loading-note">Please do not close this window.</p>
                    </div>
                </div>
                <div class="upload-section">
                    <div class="file-upload-container">
                        <button class="upload-file-btn" id="upload-file-btn" type="button">
                            <span class="upload-icon">File</span>
                            <span>Upload Document</span>
                        </button>
                        <div class="file-info">
                            <span class="file-name">lecture-notes.txt</span>
                            <span class="file-size">12 KB</span>
                        </div>
                    </div>
                    <div class="input-section">
                        <label for="material-name">Material Name</label>
                        <input id="material-name" type="text" value="Additional Reading">
                    </div>
                    <div class="input-section">
                        <label for="source-url">Source URL</label>
                        <input id="source-url" type="url" value="https://example.test/reading">
                    </div>
                    <div class="input-section">
                        <label for="text-input">Content</label>
                        <textarea id="text-input">Paste content directly here.</textarea>
                    </div>
                </div>
            </div>
            <div class="modal-footer">
                <div class="modal-actions">
                    <button class="btn-secondary" type="button">Cancel</button>
                    <button class="btn-primary" type="button">Upload</button>
                </div>
            </div>
        </div>
    </div>

    <div id="question-modal" class="modal">
        <div class="modal-content">
            <div class="modal-header">
                <h2>Create Assessment Question</h2>
                <button class="modal-close" type="button">x</button>
            </div>
            <div class="modal-body">
                <form class="question-form">
                    <div class="form-section">
                        <label for="question-type">Question Type</label>
                        <select id="question-type">
                            <option>True/False</option>
                        </select>
                    </div>
                    <details class="struggle-topic-panel" open>
                        <summary>
                            <span>Optional: generate from a struggle topic</span>
                            <small>Uses topics assigned to this unit</small>
                        </summary>
                        <div class="struggle-topic-generate-row">
                            <label for="struggle-topic-select">Struggle Topic</label>
                            <select id="struggle-topic-select">
                                <option>Enzyme regulation</option>
                            </select>
                            <div class="struggle-topic-actions">
                                <button class="struggle-topic-scope-btn active" type="button">Show all unit-linked topics</button>
                                <button class="btn-ai compact" type="button">Generate from Topic</button>
                            </div>
                            <p class="struggle-topic-note">Default: showing cumulative topics assigned to this unit.</p>
                        </div>
                    </details>
                    <div class="radio-group">
                        <label class="radio-option"><input type="radio" name="tf" checked> True</label>
                        <label class="radio-option"><input type="radio" name="tf"> False</label>
                    </div>
                    <div class="mcq-options">
                        <div class="mcq-option">
                            <input class="mcq-input" type="text" value="A choice">
                            <label class="radio-option"><input type="radio" name="mcq"> Correct</label>
                        </div>
                    </div>
                    <div class="ai-question-types">
                        <label class="ai-type-option">
                            <input type="radio" name="ai-type" checked>
                            <span>Multiple Choice</span>
                        </label>
                    </div>
                    <div class="ai-question-count">
                        <label for="ai-count">Number of questions</label>
                        <input id="ai-count" type="number" value="3">
                    </div>
                </form>
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
    await page.route(`**${HARNESS_PATH}`, async (route) => {
        await route.fulfill({
            status: 200,
            contentType: 'text/html',
            body: documentsCssHarness(),
        });
    });
    await page.goto(HARNESS_PATH);
    await page.waitForLoadState('networkidle');
    await page.waitForFunction(() => {
        const tabHeader = document.querySelector('.tab-header');
        const fileItem = document.querySelector('.file-item');
        if (!tabHeader || !fileItem) return false;
        return window.getComputedStyle(tabHeader).display === 'flex'
            && window.getComputedStyle(fileItem).display === 'flex';
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

test.describe('documents.css harness coverage', () => {
    test('styles realistic instructor document, question, and modal states', async ({ page }) => {
        await page.setViewportSize({ width: 1100, height: 1000 });
        await gotoHarness(page);

        await expect(page.locator('.document-tabs')).toHaveCSS('overflow', 'hidden');
        await expect(page.locator('.tab-header')).toHaveCSS('display', 'flex');
        await expect(page.locator('.tab-btn.active')).toHaveCSS('border-bottom-color', 'rgb(74, 111, 165)');
        await expect(page.locator('.accordion-item.published')).toHaveCSS('border-color', 'rgb(74, 111, 165)');
        await expect(page.locator('.accordion-item.published .folder-name')).toHaveCSS('color', 'rgb(74, 111, 165)');
        await expect(page.locator('.accordion-content.collapsed')).toHaveCSS('max-height', '0px');

        await page.locator('#inactive-tab').hover();
        await expect(page.locator('#inactive-tab')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0.03)');

        await expect(page.locator('.toggle-switch')).toHaveCSS('width', '44px');
        await expect(page.locator('#publish-unit-1 + .toggle-slider')).toHaveCSS('background-color', 'rgb(74, 111, 165)');
        expect(await pseudoStyle(page.locator('#publish-unit-1 + .toggle-slider'), '::before', 'transform')).not.toBe('none');

        await expect(page.locator('.file-item').first()).toHaveCSS('display', 'flex');
        await expect(page.locator('.file-info.uploaded')).toHaveCSS('color', 'rgb(40, 167, 69)');
        await expect(page.locator('.status-text.uploaded')).toHaveCSS('color', 'rgb(40, 167, 69)');
        await expect(page.locator('.status-text.failed')).toHaveCSS('color', 'rgb(220, 53, 69)');
        await expect(page.locator('.additional-material-item')).toHaveCSS('border-left-color', 'rgb(23, 162, 184)');
        await expect(page.locator('.action-button.download')).toHaveCSS('background-color', 'rgb(40, 167, 69)');
        await expect(page.locator('.action-button.delete')).toHaveCSS('background-color', 'rgb(220, 53, 69)');
        await expect(page.locator('.add-content-btn.additional-material')).toHaveCSS('display', 'flex');

        await expect(page.locator('.objective-display-item')).toHaveCSS('display', 'flex');
        await expect(page.locator('.objective-input')).toHaveCSS('border-top-right-radius', '0px');
        await expect(page.locator('.add-objective-btn-inline')).toHaveCSS('height', '36px');
        await page.locator('.add-objective-btn-inline').hover();
        await expect(page.locator('.add-objective-btn-inline')).toHaveCSS('background-color', 'rgb(69, 160, 73)');

        await expect(page.locator('.question-type-badge.true-false')).toHaveCSS('text-transform', 'uppercase');
        await expect(page.locator('.question-learning-objective-value').first()).toHaveCSS('border-radius', '999px');
        await expect(page.locator('.question-learning-objective-value.unassigned')).toHaveCSS('color', 'rgb(107, 114, 128)');
        await expect(page.locator('.mcq-option-preview.correct')).toHaveCSS('font-weight', '600');
        await expect(page.locator('.auto-link-btn.is-loading')).toHaveCSS('cursor', 'not-allowed');
        await expect(page.locator('.generate-ai-btn:disabled')).toHaveCSS('opacity', '0.6');

        await page.locator('#upload-modal').evaluate((element) => element.classList.add('show'));
        await expect(page.locator('#upload-modal')).toHaveCSS('display', 'flex');
        await expect(page.locator('#upload-modal .modal-content')).toHaveCSS('max-width', '600px');
        await expect(page.locator('#upload-file-btn')).toHaveCSS('min-height', '56px');
        await page.locator('#upload-file-btn').hover();
        await expect(page.locator('#upload-file-btn')).toHaveCSS('background-color', 'rgb(61, 90, 128)');
        await expect(page.locator('.upload-loading-indicator')).toHaveCSS('text-align', 'center');
        await expect(page.locator('.loading-spinner')).toHaveCSS('border-radius', '50%');

        await page.locator('#material-name').focus();
        await expect(page.locator('#material-name')).toHaveCSS('border-color', 'rgb(74, 111, 165)');

        await page.locator('#upload-modal').evaluate((element) => element.classList.remove('show'));
        await page.locator('#question-modal').evaluate((element) => element.classList.add('show'));
        await page.locator('#question-type').focus();
        await expect(page.locator('#question-type')).toHaveCSS('border-color', 'rgb(0, 123, 255)');

        await expect(page.locator('.struggle-topic-panel summary')).toHaveCSS('display', 'flex');
        await expect(page.locator('.struggle-topic-scope-btn.active')).toHaveCSS('border-color', 'rgb(74, 111, 165)');
        await expect(page.locator('.mcq-option')).toHaveCSS('min-width', '0px');
        await expect(page.locator('.ai-type-option')).toHaveCSS('min-height', '56px');
        await page.locator('.ai-type-option').hover();
        await expect(page.locator('.ai-type-option')).toHaveCSS('border-color', 'rgb(74, 111, 165)');
        await page.locator('#ai-count').focus();
        await expect(page.locator('#ai-count')).toHaveCSS('border-color', 'rgb(74, 111, 165)');
    });

    test('applies mobile document layout rules for current instructor controls', async ({ page }) => {
        await page.setViewportSize({ width: 500, height: 900 });
        await gotoHarness(page);

        await expect(page.locator('.action-buttons-container')).toHaveCSS('flex-direction', 'column');
        await expect(page.locator('.file-item').first()).toHaveCSS('flex-direction', 'column');
        await expect(page.locator('.file-actions').first()).toHaveCSS('justify-content', 'flex-end');
        await page.locator('#upload-modal').evaluate((element) => element.classList.add('show'));
        await expect(page.locator('#upload-modal .modal-content')).toHaveCSS('margin-top', '20px');
        await expect(page.locator('#upload-modal .modal-actions')).toHaveCSS('flex-direction', 'column');
        await expect(page.locator('.threshold-setting .threshold-input')).toHaveCSS('flex-direction', 'column');
        await expect(page.locator('.struggle-topic-panel summary')).toHaveCSS('flex-direction', 'column');
    });
});
