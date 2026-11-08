// @ts-check
/**
 * Focused browser coverage for public/styles/chat.css.
 *
 * A single happy-path student chat session exercises the base chat container,
 * user/bot messages, course header, and standard input. It does not reliably
 * visit these CSS states: disabled input/send controls, flag/action hover
 * menus, typing dots and animation delays, practice question answer states,
 * feedback variants, source footer/download links, calibration and mode-result
 * messages, unit selection, info modal, history preview/edit/mobile-expanded
 * states, and assessment summary cards.
 *
 * Existing student-chat.spec.js covers course selection, mode-toggle
 * persistence, the history empty/continue paths, and source-document download
 * endpoints. chat-rag-documents.spec.js covers RAG API attribution payloads and
 * download boundaries. Neither spec is a dedicated renderer for the CSS-only
 * combinations above, so this static harness mirrors the DOM produced by
 * student.js/history.js and visits the states directly.
 */

const { test, expect } = require('./fixtures/monocart');

const HARNESS_PATH = '/chat-css-coverage-harness';

function chatCssHarness() {
    return `<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Chat CSS Coverage Harness</title>
    <link rel="stylesheet" href="/styles/style.css">
    <link rel="stylesheet" href="/styles/chat.css">
</head>
<body>
    <div class="app-container">
        <main class="main-content">
            <header class="chat-header">
                <h1>Chat with BiocBot</h1>
                <div class="current-course">
                    <span class="course-label">Course:</span>
                    <span class="course-name">BIOC CSS Coverage</span>
                </div>
                <div class="unit-selection-container">
                    <label for="unit-select" class="unit-label">Select Unit:</label>
                    <select id="unit-select" class="unit-select">
                        <option value="">Choose a unit...</option>
                        <option value="unit-1" selected>Unit 1</option>
                    </select>
                </div>
            </header>

            <section class="chat-container">
                <div class="messages" id="chat-messages">
                    <article class="message bot-message assessment-start">
                        <div class="message-avatar">B</div>
                        <div class="message-content">
                            <p>Start the assessment for this unit.</p>
                            <div class="message-footer">
                                <div class="message-source">
                                    Sources: <a href="/api/chat/source-documents/doc-css/download?courseId=course-css">lecture-notes.txt</a>
                                </div>
                                <div class="message-footer-right">
                                    <button class="message-action-btn practice-question-btn" type="button">
                                        <span class="icon">?</span>
                                        Practice
                                    </button>
                                    <button class="message-action-btn explain-btn" type="button">
                                        <span class="icon">i</span>
                                        Explain
                                    </button>
                                    <div class="message-flag-container">
                                        <button class="flag-button" type="button">...</button>
                                        <div class="flag-menu show">
                                            <button class="flag-option" type="button">Confusing</button>
                                            <button class="flag-option" type="button">Incorrect</button>
                                            <button class="flag-option" type="button">Unsafe</button>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </article>

                    <article class="message user-message">
                        <div class="message-avatar">S</div>
                        <div class="message-content">
                            <p>I need help with enzymes.</p>
                            <span class="timestamp">10:02 AM</span>
                        </div>
                    </article>

                    <article class="message bot-message typing-indicator" id="typing-indicator">
                        <div class="message-avatar">B</div>
                        <div class="message-content">
                            <div class="dots">
                                <span class="dot"></span>
                                <span class="dot"></span>
                                <span class="dot"></span>
                            </div>
                        </div>
                    </article>

                    <article class="message bot-message mode-result standard-mode-result mode-toggle-result">
                        <div class="message-avatar">B</div>
                        <div class="message-content standard-mode-content" style="background: linear-gradient(red, blue);">
                            <div class="score-info"><strong>Score: 3/4</strong>Ready for tutor mode.</div>
                            <div class="mode-explanation"><strong>Tutor mode</strong><br>BiocBot will guide the next answer.</div>
                            <p><strong>Mode selected:</strong> Tutor</p>
                        </div>
                    </article>

                    <article class="message bot-message calibration-question">
                        <div class="message-avatar">B</div>
                        <div class="message-content">
                            <p>Which statement best describes catalase?</p>
                            <div class="calibration-options">
                                <div class="calibration-option-container">
                                    <button class="calibration-option selected" type="button">It speeds hydrogen peroxide breakdown.</button>
                                    <span class="calibration-score-box"></span>
                                </div>
                                <div class="calibration-option-container">
                                    <button class="calibration-option" type="button">It stores genetic information.</button>
                                    <span class="calibration-score-box"></span>
                                </div>
                            </div>
                            <div class="calibration-short-answer">
                                <textarea class="calibration-answer-input">Catalase is an enzyme.</textarea>
                                <button class="calibration-submit-btn" type="button">Submit</button>
                            </div>
                        </div>
                    </article>

                    <article class="message bot-message">
                        <div class="message-avatar">B</div>
                        <div class="message-content">
                            <div class="practice-question-container">
                                <div class="practice-question-header">Practice Question</div>
                                <div class="practice-question-text">What does catalase break down?</div>
                                <div class="practice-options">
                                    <label class="practice-option-label practice-option-disabled practice-option-was-correct">
                                        <input type="radio" name="practice" disabled>
                                        <span class="practice-option-text">Hydrogen peroxide</span>
                                    </label>
                                    <label class="practice-option-label practice-option-correct">
                                        <input type="radio" name="practice" checked>
                                        <span class="practice-option-text">Hydrogen peroxide into water and oxygen</span>
                                    </label>
                                    <label class="practice-option-label practice-option-incorrect">
                                        <input type="radio" name="practice">
                                        <span class="practice-option-text">Carbon dioxide</span>
                                    </label>
                                </div>
                                <div class="practice-sa-container">
                                    <textarea class="practice-sa-input">short answer draft</textarea>
                                    <textarea class="practice-sa-input" disabled>submitted answer</textarea>
                                </div>
                                <button class="practice-submit-btn" type="button">Check Answer</button>
                                <button class="practice-submit-btn" type="button" disabled>Submitted</button>
                                <div class="practice-feedback practice-feedback-correct">Correct.</div>
                                <div class="practice-feedback practice-feedback-incorrect">Try again.</div>
                                <div class="practice-feedback practice-feedback-error">This question expired.</div>
                            </div>
                        </div>
                    </article>

                    <article class="message bot-message unit-selection-welcome">
                        <div class="message-avatar">B</div>
                        <div class="message-content">
                            <div class="unit-selection-option">
                                <strong>Unit selection</strong>
                                <div>Choose a published unit before asking a question.</div>
                            </div>
                            <p class="ai-use-disclaimer">
                                This AI tool generates responses using a large language model.
                                <a href="#" class="ai-use-disclaimer-link" data-open-full-disclaimer>View Chat Rules</a>.
                            </p>
                        </div>
                    </article>

                    <article class="message bot-message">
                        <div class="message-avatar">B</div>
                        <div class="message-content">
                            <p>Session limit warning <a class="chat-limit-link" href="#chat-limit-modal-overlay">See why?</a></p>
                        </div>
                    </article>
                </div>

                <div class="chat-input-container">
                    <form id="chat-form">
                        <input id="chat-input" class="disabled-input" type="text" value="disabled text">
                        <button id="send-button" class="disabled-button" type="submit" disabled>Send</button>
                    </form>
                    <div class="chat-footer">
                        <div class="chat-disclaimer">BiocBot can make mistakes.</div>
                        <div class="mode-toggle-container" style="display: block;">
                            <div class="mode-toggle">
                                <span class="mode-label protege-label active">Protégé</span>
                                <div class="toggle-switch">
                                    <input id="mode-toggle-checkbox" type="checkbox" checked>
                                    <label for="mode-toggle-checkbox" class="toggle-slider"></label>
                                </div>
                                <span class="mode-label tutor-label">Tutor</span>
                            </div>
                        </div>
                    </div>
                </div>
            </section>

            <section class="history-container">
                <aside class="chat-history-list">
                    <div class="history-header">
                        <h3>Chat History</h3>
                        <div class="search-container">
                            <input id="history-search" type="search" value="enzyme">
                        </div>
                    </div>
                    <div class="history-items">
                        <article class="chat-history-item active mobile-expanded editing" data-chat-id="css-history-1">
                            <div class="title-container">
                                <span class="title title-text">Enzyme review session</span>
                                <button class="edit-btn" type="button"><span class="edit-icon">e</span></button>
                            </div>
                            <div class="title-edit-container">
                                <input class="title-input" value="Enzyme review session">
                                <button class="save-btn" type="button"><span class="save-icon">s</span></button>
                                <button class="cancel-btn" type="button"><span class="cancel-icon">x</span></button>
                            </div>
                            <div class="preview">Catalase and peroxide practice with a long preview that wraps.</div>
                            <div class="date">Today</div>
                            <div class="metadata">
                                <span class="message-count">4 messages</span>
                                <span class="duration">8 min</span>
                            </div>
                            <div class="mobile-actions-container">
                                <button class="mobile-action-btn primary" type="button">Continue</button>
                                <button class="mobile-action-btn secondary" type="button">Delete</button>
                            </div>
                        </article>
                    </div>
                    <div class="no-history">
                        <div class="no-history-content">
                            <div class="no-history-icon">0</div>
                            <h4>No Chat History</h4>
                            <p>Start a conversation to see it here.</p>
                        </div>
                    </div>
                </aside>
                <section class="chat-preview-panel">
                    <div class="preview-header">
                        <button class="mobile-back-btn" type="button">Back</button>
                        <h2>Enzyme review session</h2>
                        <div class="preview-actions">
                            <button class="primary-button" type="button">Continue Chat</button>
                            <button class="secondary-button" type="button">Delete</button>
                        </div>
                    </div>
                    <div class="preview-messages">
                        <article class="message bot-message">
                            <div class="message-avatar">B</div>
                            <div class="message-content"><p>Preview message.</p></div>
                        </article>
                        <div class="more-messages"><p>2 more messages</p></div>
                        <div class="no-selection">
                            <div class="no-selection-content">
                                <div class="no-selection-icon">-</div>
                                <h4>No Chat Selected</h4>
                                <p>Select a chat from the list.</p>
                            </div>
                        </div>
                    </div>
                </section>
            </section>

            <section class="assessment-summary-container">
                <header class="assessment-summary-header">
                    <h2 class="assessment-summary-title"><span>Assessment</span> Summary</h2>
                    <div class="assessment-summary-score">2 / 3</div>
                </header>
                <div class="assessment-questions-list">
                    <article class="summary-question-card">
                        <div class="summary-question-header">
                            <span class="summary-q-number">1</span>
                            <span class="summary-q-text">What does catalase do?</span>
                        </div>
                        <div class="summary-answer-section">
                            <div class="answer-box student">
                                <span class="answer-box-label">Your answer</span>
                                <div class="answer-box-content">Breaks down peroxide.</div>
                            </div>
                            <div class="answer-box expected">
                                <span class="answer-box-label">Expected</span>
                                <div class="answer-box-content">Converts hydrogen peroxide.</div>
                            </div>
                        </div>
                        <div class="summary-feedback-section correct">
                            <span class="feedback-icon">+</span>
                            <span>Good match.</span>
                        </div>
                        <div class="summary-feedback-section incorrect">
                            <span class="feedback-icon">!</span>
                            <span>Needs more detail.</span>
                        </div>
                    </article>
                </div>
            </section>
        </main>
    </div>

    <div id="chat-limit-modal-overlay" class="info-modal-overlay">
        <div class="info-modal" role="dialog" aria-modal="true" aria-labelledby="limit-modal-title">
            <div class="info-modal-header">
                <h2 id="limit-modal-title">Why the message limit?</h2>
            </div>
            <div class="info-modal-body">
                <h3>Quality</h3>
                <ul>
                    <li>Long sessions can reduce answer quality.</li>
                    <li>Starting fresh preserves context.</li>
                </ul>
                <h3>Next steps</h3>
                <p>Save the current session first.</p>
            </div>
            <div class="info-modal-footer">
                <button id="close-info-modal-btn" class="info-modal-btn" type="button">Close</button>
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
            body: chatCssHarness(),
        });
    });
    await page.goto(HARNESS_PATH);
    await page.waitForLoadState('networkidle');
    await expect(page.locator('.chat-container')).toBeVisible();
    await expect(page.locator('.history-container')).toBeVisible();
}

test.describe('chat.css harness coverage', () => {
    test('renders non-happy-path student chat, practice, calibration, history, and modal states', async ({ page }) => {
        await page.setViewportSize({ width: 1120, height: 1200 });
        await gotoHarness(page);

        await expect(page.locator('.typing-indicator .dot')).toHaveCount(3);
        await expect(page.locator('.flag-menu.show')).toBeVisible();
        await expect(page.locator('.practice-feedback-error')).toBeVisible();
        await expect(page.locator('.calibration-option.selected')).toBeVisible();
        await expect(page.locator('.ai-use-disclaimer .ai-use-disclaimer-link')).toBeVisible();
        await expect(page.locator('.assessment-summary-container')).toBeVisible();
        await expect(page.locator('.summary-feedback-section.correct')).toBeVisible();
        await expect(page.locator('.summary-feedback-section.incorrect')).toBeVisible();

        await page.locator('.flag-button').hover();
        await page.locator('.flag-option').first().hover();
        await page.locator('.message-action-btn').first().hover();
        await page.locator('.practice-option-label').nth(1).hover();
        await page.locator('.practice-sa-input').first().focus();
        await page.locator('.practice-submit-btn').first().hover();
        await page.locator('.calibration-option').last().hover();
        await page.locator('.calibration-answer-input').focus();
        await page.locator('.calibration-submit-btn').hover();
        await page.locator('.toggle-slider').hover();
        await page.locator('.unit-select').hover();
        await page.locator('.unit-select').focus();
        // Regression check for #645: .unit-select's own padding shorthand
        // must leave room for the global select chevron added by #643/#644.
        await expect(page.locator('.unit-select')).toHaveCSS('padding-right', '34px');
        await page.locator('#history-search').focus();
        await page.locator('.chat-history-item').first().hover();
        await page.locator('.preview-actions .primary-button').hover();
        await page.locator('.preview-actions .secondary-button').hover();
        await page.locator('.chat-limit-link').hover();
        await page.locator('.summary-question-card').hover();

        await expect(page.locator('#chat-input')).toHaveClass(/disabled-input/);
        await expect(page.locator('#send-button')).toBeDisabled();
        await page.locator('#send-button').hover({ force: true });

        await page.locator('#chat-limit-modal-overlay').evaluate((element) => element.classList.add('show'));
        await expect(page.locator('.info-modal-overlay.show')).toBeVisible();
        await page.locator('.info-modal-btn').hover();
    });

    test('applies mobile chat, calibration, mode-toggle, history, and summary media rules', async ({ page }) => {
        await page.setViewportSize({ width: 500, height: 1000 });
        await gotoHarness(page);

        await expect(page.locator('.chat-container')).toBeVisible();
        await expect(page.locator('.message-source').first()).toBeVisible();
        await expect(page.locator('.chat-history-item.mobile-expanded .mobile-actions-container')).toBeVisible();
        await expect(page.locator('.chat-preview-panel')).toBeHidden();
        await expect(page.locator('.mode-toggle-container')).toBeVisible();
        await expect(page.locator('.summary-answer-section')).toBeVisible();
    });
});
