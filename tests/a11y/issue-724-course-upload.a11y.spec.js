// @ts-check
/**
 * One test per finding in ubc/tlef-biocbot#724 (a manual accessibility pass over
 * the instructor Course Upload page).
 *
 * Each test drives the page into the state the finding was observed in and then
 * checks it mechanically with tests/a11y/toolkit. Before the fixes every test
 * here failed; they are the proof that each fix did what it was meant to.
 *
 * Every test writes its evidence (the names, ratios, sizes, focus targets it
 * measured) to a11y-results/issue-724/<run>/<n>.json, so a before/after table
 * can be built from the two runs. Set A11Y_EVIDENCE_RUN to name the run.
 */
const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');
const { TEST_USERS, storageStatePath } = require('../e2e/helpers/users');
const {
    seedCourse, seedDocumentAndAttach, cleanupCourses, getUserIdByUsername,
} = require('../e2e/helpers/courses-test');
const toolkit = require('./toolkit');

const COURSE_ID = 'BIOC-A11Y-724';
const EVIDENCE_DIR = path.resolve(__dirname, '../../a11y-results/issue-724', process.env.A11Y_EVIDENCE_RUN || 'current');
const SYMBOL = /[×←-⇿■-◿☀-➿]|^\+$/u;

/** @param {number} n */
const card = (n, unit) => ({
    cardId: `fc-${unit}-${n}`,
    front: `Question ${n} for ${unit}`,
    back: `Answer ${n} for ${unit}`,
    source: { documentId: 'doc1', fileName: 'Lecture.pdf', chunkIndex: n },
});

const draftDeck = (unit) => ({
    deckId: `deck-${unit.replace(/\s+/g, '-')}`, courseId: COURSE_ID, lectureName: unit, title: `${unit} Flashcards`,
    hasDraft: true, isPublished: false, isStale: false, publishedVersion: 0,
    draftCards: [card(1, unit), card(2, unit), card(3, unit)], publishedCards: [],
});

const publishedDeck = (unit) => ({
    deckId: `deck-${unit.replace(/\s+/g, '-')}`, courseId: COURSE_ID, lectureName: unit, title: `${unit} Flashcards`,
    hasDraft: false, isPublished: true, isStale: false, publishedVersion: 1,
    draftCards: [], publishedCards: [card(1, unit), card(2, unit)],
});

/**
 * The LMS launchers only appear when a deployment has Canvas/Moodle configured,
 * and flashcard decks need generated content, so both are answered from here.
 * Everything else (units, objectives, documents, publish, reorder) is the real
 * application against a seeded course.
 * @param {import('@playwright/test').Page} page
 */
async function mockIntegrations(page) {
    const json = (body, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });
    await page.route('**/api/lms/configuration', (route) => route.fulfill(json({
        success: true,
        data: { providers: { canvas: { enabled: true, environment: 'present' }, moodle: { enabled: true, environment: 'present' } } },
    })));
    await page.route('**/api/lms/*/status', (route) => route.fulfill(json({ success: false, connected: false }, 401)));
    await page.route('**/api/lms/moodle/info', (route) => route.fulfill(json({
        success: true,
        data: {
            tokenUrl: 'https://moodle.example.test/user/managetoken.php',
            manageTokensUrl: 'https://moodle.example.test/admin/webservice/tokens.php',
        },
    })));

    const decks = [draftDeck('Unit 1'), draftDeck('Unit 2'), publishedDeck('Unit 3')];
    await page.route('**/api/flashcards/instructor?**', (route) => route.fulfill(json({ success: true, data: { units: [], decks } })));
    await page.route('**/api/flashcards/instructor/generate', (route) => route.fulfill(json({
        success: true, message: 'Flashcard draft generated.', data: draftDeck('Unit 1'),
    })));
    await page.route('**/api/flashcards/instructor/deck-*', async (route) => {
        const body = route.request().postDataJSON() || {};
        const unit = decodeURIComponent(route.request().url().split('/deck-')[1].split('/')[0]).replace(/-/g, ' ');
        route.fulfill(json({ success: true, data: { ...draftDeck(unit), draftCards: body.cards || draftDeck(unit).draftCards } }));
    });
}

/** @param {import('@playwright/test').Page} page */
async function openCourseUpload(page) {
    await mockIntegrations(page);
    await page.goto(`/instructor/documents?courseId=${COURSE_ID}`);
    await expect(page.locator('.accordion-item')).toHaveCount(3, { timeout: 20_000 });
    await expect(page.locator('.flashcard-editor-row')).toHaveCount(8, { timeout: 20_000 });
    await expect(page.locator('.lms-import-chip:visible')).toHaveCount(2);
    await expect(page.locator('.add-content-section')).toHaveCount(3);
    // Expand every unit through its own disclosure control, as a user would.
    for (let guard = 0; guard < 6; guard += 1) {
        const collapsed = page.locator('.accordion-item').filter({ has: page.locator('.accordion-content.collapsed') });
        if ((await collapsed.count()) === 0) break;
        await unitToggle(collapsed.first()).click();
    }
    await expect(page.locator('.accordion-content.collapsed')).toHaveCount(0);
    // Let the page's own staggered loaders (documents, thresholds, decks) finish.
    await page.waitForTimeout(700);
}

/** The control that expands/collapses a unit, whatever element it is. */
function unitToggle(unit) {
    return unit.locator('[aria-expanded]').first();
}

/** @param {import('@playwright/test').Page} page @param {'canvas'|'moodle'} provider */
async function openLmsDialog(page, provider) {
    await page.locator(`.lms-import-chip[data-lms-provider="${provider}"]`).click();
    await expect(page.locator('#lms-import-modal')).toHaveClass(/show/);
    await expect(page.locator('#lms-stepper li')).toHaveCount(4);
    if (provider === 'moodle') await expect(page.locator('#lms-token-url')).toBeVisible();
    await page.waitForTimeout(300);
}

/** @param {import('@playwright/test').Page} page @param {RegExp} button */
async function openUploadDialog(page, button) {
    await page.locator('.accordion-item').first().getByRole('button', { name: button }).click();
    await expect(page.locator('#upload-modal')).toBeVisible();
    await expect(page.locator('#upload-method-selection')).toBeVisible();
}

/** Findings of a rule whose element matches `pattern` (tested against its HTML and selector). */
function findingsFor(findings, rules, pattern) {
    const wanted = Array.isArray(rules) ? rules : [rules];
    return findings.filter((f) => wanted.includes(f.rule) && (!pattern || pattern.test(f.html) || pattern.test(f.selector)));
}

const brief = (findings) => findings.map((f) => ({ rule: f.rule, selector: f.selector, name: f.name, message: f.message }));

/** Whether each matched element is exposed as an item of a list. */
async function listMarkup(locator) {
    return locator.evaluateAll((els) => els.map((el) => {
        const isItem = el.matches('li, [role="listitem"]');
        const list = el.parentElement && el.parentElement.closest('ul, ol, [role="list"]');
        const direct = !!list && (el.parentElement === list || el.parentElement.getAttribute('role') === 'presentation');
        return {
            tag: el.tagName.toLowerCase(), role: el.getAttribute('role'), isItem,
            list: list ? list.tagName.toLowerCase() : null, ok: isItem && direct,
        };
    }));
}

/** Whether each matched piece of text sits inside a heading element. */
async function headingMarkup(locator) {
    return locator.evaluateAll((els) => els.map((el) => {
        const heading = el.closest('h1, h2, h3, h4, h5, h6, [role="heading"]');
        return {
            text: (el.textContent || '').trim().slice(0, 50),
            heading: heading ? (heading.getAttribute('aria-level') ? `h${heading.getAttribute('aria-level')}` : heading.tagName.toLowerCase()) : null,
        };
    }));
}

/**
 * Register one finding as a test and persist what it measured.
 * @param {number|number[]} numbers issue numbers this test covers
 * @param {string} title
 * @param {(ctx: { page: import('@playwright/test').Page, note: (key: string, value: any) => void }) => Promise<void>} body
 */
function finding(numbers, title, body) {
    const ids = Array.isArray(numbers) ? numbers : [numbers];
    test(`#${ids.join(', #')} ${title}`, async ({ page }) => {
        /** @type {Record<string, any>} */
        const evidence = {};
        let failure = null;
        try {
            await openCourseUpload(page);
            await body({ page, note: (key, value) => { evidence[key] = value; } });
        } catch (error) {
            failure = error;
        }
        fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
        for (const id of ids) {
            fs.writeFileSync(path.join(EVIDENCE_DIR, `${String(id).padStart(2, '0')}.json`), JSON.stringify({
                issue: id, title, status: failure ? 'fail' : 'pass', evidence,
                error: failure ? String(failure.message || failure).split('\n').slice(0, 4).join(' ').replace(/\u001b\[[0-9;]*m/g, '') : null,
            }, null, 2));
        }
        if (failure) throw failure;
    });
}

test.describe('Issue 724: Course Upload page', () => {
    test.use({ storageState: storageStatePath('instructor'), viewport: { width: 1440, height: 1000 } });

    // Re-seeded before every test: several tests reorder, publish, or edit, and
    // each finding should be checked against the same starting course.
    test.beforeEach(async () => {
        const instructorId = await getUserIdByUsername(TEST_USERS.instructor.username);
        const now = new Date();
        const unit = (n, displayName, objectives) => ({
            name: `Unit ${n}`, displayName, isPublished: false, learningObjectives: objectives, passThreshold: 1,
            createdAt: now, updatedAt: now, documents: [],
            assessmentQuestions: [{
                questionId: `q-${n}-1`, questionType: 'true-false', question: `Statement ${n} is true.`,
                correctAnswer: 'true', options: {},
            }],
        });
        await seedCourse({
            courseId: COURSE_ID, instructorId, courseName: 'A11y 724 Course',
            lectures: [
                unit(1, 'Cell Structure', ['Describe the cell membrane', 'Name the organelles', 'Explain osmosis']),
                unit(2, 'Enzymes', ['Define activation energy', 'Describe enzyme inhibition']),
                unit(3, 'Metabolism', ['Outline glycolysis', 'Outline the citric acid cycle']),
            ],
        });
        for (const n of [1, 2]) {
            await seedDocumentAndAttach({
                documentId: `a11y724-doc-${n}-a`, courseId: COURSE_ID, lectureName: `Unit ${n}`, instructorId,
                filename: `unit-${n}-lecture.txt`,
            });
            await seedDocumentAndAttach({
                documentId: `a11y724-doc-${n}-b`, courseId: COURSE_ID, lectureName: `Unit ${n}`, instructorId,
                filename: `unit-${n}-tutorial.txt`,
            });
        }
    });

    test.afterAll(async () => {
        await cleanupCourses([COURSE_ID]);
    });

    // ---------------------------------------------------------- LMS launchers

    for (const [n, provider, label] of /** @type {const} */ ([[1, 'canvas', 'Canvas'], [2, 'moodle', 'Moodle']])) {
        finding(n, `the ${label} launcher says what it does`, async ({ page, note }) => {
            const control = await toolkit.describe(page.locator(`.lms-import-chip[data-lms-provider="${provider}"]`));
            note('accessibleName', control.name);
            // Judgement call recorded as a regression check: the name has to carry
            // the action ("import"), the provider, and the connection state.
            expect(control.name).toMatch(/import/i);
            expect(control.name).toMatch(new RegExp(label, 'i'));
            expect(control.name).toMatch(/not connected/i);
        });
    }

    // --------------------------------------------------------- unit accordion

    finding(3, 'unit expand/collapse controls are named after their unit', async ({ page, note }) => {
        const names = [];
        for (const unit of await page.locator('.accordion-item').all()) names.push(await toolkit.describe(unitToggle(unit)));
        note('controls', names);
        expect(names.map((c) => c.name)).toEqual(['1. Cell Structure', '2. Enzymes', '3. Metabolism']);
    });

    finding(4, 'no control contains another control', async ({ page, note }) => {
        const found = findingsFor(await toolkit.audit(page, { rules: ['nested-interactive'] }), 'nested-interactive');
        note('nested', brief(found));
        expect(found).toEqual([]);
    });

    finding(5, 'the units are a list', async ({ page, note }) => {
        const markup = await listMarkup(page.locator('.accordion-item'));
        note('items', markup);
        expect(markup.every((m) => m.ok)).toBe(true);
    });

    finding(12, 'each "Rename unit" control names its unit', async ({ page, note }) => {
        const controls = await toolkit.describeAll(page.locator('.unit-rename-btn'));
        note('names', controls.map((c) => c.name));
        expect(new Set(controls.map((c) => c.name)).size).toBe(controls.length);
        for (const control of controls) expect(control.name).toMatch(/rename .*(Cell Structure|Enzymes|Metabolism)/i);
    });

    finding(13, 'unit names are headings', async ({ page, note }) => {
        const markup = await headingMarkup(page.locator('.folder-name'));
        note('unitNames', markup);
        expect(markup.map((m) => m.heading)).toEqual(['h2', 'h2', 'h2']);
    });

    finding(18, 'the caret in the unit expand/collapse control is hidden from assistive technology', async ({ page, note }) => {
        const exposed = await page.locator('.accordion-toggle').evaluateAll((els) => els.map((el) => ({
            glyph: el.textContent, ariaHidden: !!el.closest('[aria-hidden="true"]'),
        })));
        const names = [];
        for (const unit of await page.locator('.accordion-item').all()) names.push((await toolkit.describe(unitToggle(unit))).name);
        note('carets', exposed);
        note('names', names);
        expect(exposed.every((c) => c.ariaHidden)).toBe(true);
        for (const name of names) expect(name).not.toMatch(SYMBOL);
    });

    finding(10, 'the icon in a disabled move button has 3:1 contrast', async ({ page, note }) => {
        const disabled = page.locator('.unit-move-btn:disabled').first();
        await expect(disabled).toBeVisible();
        const measured = await toolkit.graphicContrast(disabled);
        note('pixels', measured);
        expect(measured.ratio).toBeGreaterThanOrEqual(3);
    });

    finding(11, 'the unchecked publish toggle has 3:1 contrast against its surroundings', async ({ page, note }) => {
        const toggle = page.locator('.publish-toggle .toggle-switch').first();
        await expect(page.locator('.publish-toggle input').first()).not.toBeChecked();
        const measured = await toolkit.graphicContrast(toggle, { pad: 4 });
        note('pixels', measured);
        expect(measured.ratio).toBeGreaterThanOrEqual(3);
    });

    finding(14, 'focus stays on a move button after it reorders a unit', async ({ page, note }) => {
        const down = page.locator('.accordion-item').first().locator('.unit-move-btn').nth(1);
        const result = await toolkit.focusAfterActivation(down, { settleMs: 2500 });
        note('focusAfter', result);
        expect(result.lost).toBe(false);
        expect(result.active).toMatch(/unit-move-btn|move/i);
    });

    // ---------------------------------------------------------- status toasts

    /**
     * Shared assertions for findings 15-17 and 48-50: what is announced, whether a
     * control inside a message can be reached, and whether it is taken away.
     */
    async function statusMessageChecks(page, note, action, expectedText) {
        const observed = await toolkit.observeStatusMessages(page, action, { watchMs: 7000 });
        note('announcements', observed.announcements);
        note('messages', observed.messages);
        const announced = observed.announcements.filter((a) => expectedText.test(a.text));
        expect(announced.length, 'the action must announce a status message').toBeGreaterThan(0);
        return { observed, announced };
    }

    finding(15, 'the publish status message announces only its own text', async ({ page, note }) => {
        const { announced } = await statusMessageChecks(page, note,
            () => page.locator('.publish-toggle .toggle-switch').nth(1).click(), /published/i);
        for (const a of announced) {
            expect(a.controlsInside).toEqual([]);
            expect(a.text).not.toMatch(/dismiss/i);
            // The message names the unit by the title the instructor sees.
            expect(a.text).toMatch(/Enzymes/);
        }
    });

    finding(16, 'controls inside status messages can be reached from the keyboard', async ({ page, note }) => {
        await statusMessageChecks(page, note, () => page.locator('.publish-toggle .toggle-switch').nth(1).click(), /published/i);
        // A message that does carry a control (errors must be dismissable) has to
        // put that control where Tab can find it.
        await page.evaluate(() => /** @type {any} */ (window).showNotification('Could not save the unit.', 'error'));
        const dismiss = page.locator('.notification .notification-close').last();
        await expect(dismiss).toBeVisible();
        const reach = await toolkit.reachableByTab(page, dismiss, { from: page.locator('.skip-link a'), maxTabs: 12 });
        note('dismissReachable', reach);
        expect(reach.reached).toBe(true);
    });

    finding(17, 'status messages with controls are not taken away on a timer', async ({ page, note }) => {
        const { observed } = await statusMessageChecks(page, note, async () => {
            await page.locator('.publish-toggle .toggle-switch').nth(1).click();
            await page.evaluate(() => /** @type {any} */ (window).showNotification('Could not save the unit.', 'error'));
        }, /published/i);
        const timedOutWithControls = observed.messages.filter((m) => m.controls.length && m.removedAfterMs !== null);
        note('timedOutWithControls', timedOutWithControls);
        expect(timedOutWithControls).toEqual([]);
        // And the error really is still there after the old 5 second limit.
        await expect(page.locator('.notification.error')).toBeVisible();
    });

    // -------------------------------------------------------- section toggles

    finding(19, 'section show/hide controls are named after their section', async ({ page, note }) => {
        const controls = await toolkit.describeAll(page.locator('.accordion-item').first().locator('.unit-section .toggle-section'));
        note('names', controls.map((c) => c.name));
        // Section name first, then the unit, so the four sections of every unit
        // are distinct from the same four in the next unit.
        expect(controls.map((c) => c.name)).toEqual([
            'Learning Objectives: 1. Cell Structure', 'Course Materials: 1. Cell Structure',
            'Student Flashcards: 1. Cell Structure', 'Assessment Questions: 1. Cell Structure',
        ]);
        expect(controls.every((c) => c.role === 'button')).toBe(true);
    });

    finding(20, 'section show/hide carets are hidden from assistive technology', async ({ page, note }) => {
        const found = findingsFor(await toolkit.audit(page, { rules: ['icon-not-hidden', 'control-names'] }),
            ['icon-not-hidden', 'control-name-symbol-only', 'control-name-has-symbol'], /toggle-section|section-toggle/);
        note('findings', brief(found));
        expect(found).toEqual([]);
    });

    finding(21, 'section show/hide controls expose their state', async ({ page, note }) => {
        const toggle = page.locator('.accordion-item').first().locator('.unit-section .toggle-section').first();
        const result = await toolkit.disclosureState(toggle, { scope: '.unit-section' });
        note('disclosure', result);
        expect(result.togglesContent).toBe(true);
        expect(result.exposesState).toBe(true);
        expect(result.stateChanged).toBe(true);
    });

    // ------------------------------------------------------ learning objectives

    finding(22, 'learning objectives are an ordered list', async ({ page, note }) => {
        const markup = await listMarkup(page.locator('.objective-display-item'));
        note('items', markup);
        expect(markup.every((m) => m.ok && m.list === 'ol')).toBe(true);
    });

    finding(23, 'each "remove objective" control names its objective', async ({ page, note }) => {
        const controls = await toolkit.describeAll(page.locator('.remove-objective'));
        note('names', controls.map((c) => c.name));
        expect(new Set(controls.map((c) => c.name)).size).toBe(controls.length);
        expect(controls[0].name).toMatch(/remove .*Describe the cell membrane/i);
    });

    finding(24, 'the "remove objective" icon is hidden from assistive technology', async ({ page, note }) => {
        const found = findingsFor(await toolkit.audit(page, { rules: ['icon-not-hidden', 'control-names'] }),
            ['icon-not-hidden', 'control-name-symbol-only', 'control-name-has-symbol'], /remove-objective/);
        note('findings', brief(found));
        expect(found).toEqual([]);
    });

    finding(25, '"remove objective" controls are at least 24 by 24', async ({ page, note }) => {
        const sizes = await page.locator('.remove-objective').evaluateAll((els) => els.map((el) => {
            const r = el.getBoundingClientRect();
            return { width: Math.round(r.width * 10) / 10, height: Math.round(r.height * 10) / 10 };
        }));
        note('sizes', sizes);
        for (const size of sizes) {
            expect(size.width).toBeGreaterThanOrEqual(24);
            expect(size.height).toBeGreaterThanOrEqual(24);
        }
    });

    finding(26, 'the learning objective field has an accessible name', async ({ page, note }) => {
        const found = findingsFor(await toolkit.audit(page, { rules: ['field-labels'] }), 'field-name-missing', /objective-input/);
        const fields = await toolkit.describeAll(page.locator('.objective-input'));
        note('findings', brief(found));
        note('names', fields.map((f) => f.name));
        expect(found).toEqual([]);
        expect(new Set(fields.map((f) => f.name)).size).toBe(fields.length);
    });

    finding(27, 'the learning objective field has a visible label', async ({ page, note }) => {
        const found = findingsFor(await toolkit.audit(page, { rules: ['field-labels'] }), 'field-label-not-visible', /objective-input/);
        note('findings', brief(found));
        expect(found).toEqual([]);
    });

    finding(28, 'the "add objective" control says what it does', async ({ page, note }) => {
        const controls = await toolkit.describeAll(page.locator('.add-objective-btn-inline'));
        note('names', controls.map((c) => c.name));
        expect(new Set(controls.map((c) => c.name)).size).toBe(controls.length);
        for (const control of controls) expect(control.name).toMatch(/add (learning )?objective/i);
    });

    finding(29, 'the "add objective" icon has 3:1 contrast', async ({ page, note }) => {
        const measured = await toolkit.graphicContrast(page.locator('.add-objective-btn-inline').first());
        note('pixels', measured);
        expect(measured.ratio).toBeGreaterThanOrEqual(3);
    });

    // --------------------------------------------------------- course materials

    finding(30, 'headings inside Course Materials sit below the section heading', async ({ page, note }) => {
        const found = findingsFor(await toolkit.audit(page, { root: '#dynamic-units-container', rules: ['heading-structure'] }),
            ['heading-not-nested', 'heading-level-skip']);
        const levels = await headingMarkup(page.locator('.accordion-item').first().locator('.course-materials-section .file-info').locator('h1,h2,h3,h4,h5,h6'));
        note('findings', brief(found));
        note('materialHeadings', levels);
        expect(found).toEqual([]);
        expect(levels.every((l) => l.heading === 'h4')).toBe(true);
    });

    finding(31, 'course materials are a list', async ({ page, note }) => {
        const markup = await listMarkup(page.locator('.file-item'));
        note('items', markup);
        expect(markup.length).toBeGreaterThan(3);
        expect(markup.every((m) => m.ok)).toBe(true);
    });

    const duplicateNameFindings = /** @type {const} */ ([
        [32, 'View', /action-button view/],
        [33, 'Delete', /action-button delete/],
        [34, 'Add Lecture Notes', /add-content-btn lecture-notes/],
        [35, 'Add Practice Questions/Tutorial', /add-content-btn practice-quiz/],
        [36, 'Add Additional Material', /add-content-btn additional-material/],
        [45, 'Cards (select)', /flashcard-count-/],
        [46, 'Chemistry notation (checkbox)', /flashcard-chemistry-unit/],
        [47, 'Generate Draft', /flashcard-generate-btn/],
        [53, 'Remove (flashcard)', /flashcard-remove-btn/],
        [54, 'Front (textbox)', /flashcard-front-input/],
        [55, 'Back (textbox)', /flashcard-back-input/],
        [60, 'Add Card', /addManualFlashcard/],
        [61, 'Save Draft', /saveFlashcardDraft/],
        [62, 'Publish to Students', /flashcard-publish-btn/],
        [63, 'protégé threshold (number field)', /pass-threshold-/],
        [64, 'Add Question', /add-question-btn/],
    ]);
    for (const [n, label, pattern] of duplicateNameFindings) {
        finding(n, `"${label}" controls can be told apart by name`, async ({ page, note }) => {
            const all = await toolkit.audit(page, { rules: ['control-name-duplicate'] });
            const found = findingsFor(all, 'control-name-duplicate', pattern);
            const matching = await page.locator('button, input, select, textarea').evaluateAll(
                (els, source) => els.filter((el) => new RegExp(source).test(el.outerHTML.slice(0, 400))).length, pattern.source);
            note('controlsChecked', matching);
            note('duplicates', brief(found));
            expect(matching, 'the controls this finding is about must be on the page').toBeGreaterThan(1);
            expect(found).toEqual([]);
        });
    }

    // ----------------------------------------------------------- LMS dialogs

    finding(6, 'the Close control in "Import from Canvas" is at least 24 by 24', async ({ page, note }) => {
        await openLmsDialog(page, 'canvas');
        const box = await page.locator('#lms-import-close').boundingBox();
        const found = findingsFor(await toolkit.audit(page, { root: '#lms-import-modal', rules: ['target-size'] }), 'target-size', /lms-import-close/);
        note('size', box && { width: box.width, height: box.height });
        note('findings', brief(found));
        expect(box && box.width).toBeGreaterThanOrEqual(24);
        expect(box && box.height).toBeGreaterThanOrEqual(24);
        expect(found).toEqual([]);
    });

    finding(7, 'the links in "Import from Moodle" can be told apart by name', async ({ page, note }) => {
        await openLmsDialog(page, 'moodle');
        const links = await toolkit.describeAll(page.locator('#lms-import-modal a.lms-token-link'));
        const found = findingsFor(await toolkit.audit(page, { root: '#lms-import-modal', rules: ['control-name-duplicate'] }), 'control-name-duplicate');
        note('names', links.map((l) => l.name));
        note('duplicates', brief(found));
        expect(links).toHaveLength(2);
        expect(found).toEqual([]);
    });

    finding([8, 9], 'text in "Import from Canvas" has 4.5:1 contrast, including the disabled Next control', async ({ page, note }) => {
        await openLmsDialog(page, 'canvas');
        await expect(page.locator('#lms-import-next')).toBeDisabled();
        const found = findingsFor(await toolkit.audit(page, { root: '#lms-import-modal', rules: ['text-contrast'] }),
            ['text-contrast', 'text-contrast-inactive']);
        note('lowContrast', found.map((f) => ({ rule: f.rule, text: f.data.text, ratio: f.data.ratio, fg: f.data.foreground, bg: f.data.background })));
        expect(found).toEqual([]);
    });

    // ---------------------------------------------------------- upload dialog

    const uploadFocusFindings = /** @type {const} */ ([
        [37, /Add Lecture Notes/, 'Upload Lecture Notes', /Upload a file/],
        [38, /Add Lecture Notes/, 'Upload Lecture Notes', /Paste content directly/],
        [39, /Add Practice Questions/, 'Upload Practice Questions/Tutorial', /Upload a file/],
        [40, /Add Practice Questions/, 'Upload Practice Questions/Tutorial', /Paste content directly/],
    ]);
    for (const [n, opener, dialogTitle, choice] of uploadFocusFindings) {
        finding(n, `focus is kept when "${choice.source}" is chosen in "${dialogTitle}"`, async ({ page, note }) => {
            await openUploadDialog(page, opener);
            await expect(page.locator('#modal-title')).toHaveText(dialogTitle);
            const result = await toolkit.focusAfterActivation(page.locator('#upload-modal').getByRole('button', { name: choice }));
            note('focusAfter', result);
            expect(result.lost).toBe(false);
        });
    }

    for (const [numbers, opener, dialogTitle] of /** @type {const} */ ([
        [[41, 42], /Add Lecture Notes/, 'Upload Lecture Notes'],
        [[43, 44], /Add Practice Questions/, 'Upload Practice Questions/Tutorial'],
    ])) {
        finding([...numbers], `the Back controls in "${dialogTitle}" are named "Back" with the arrow hidden`, async ({ page, note }) => {
            await openUploadDialog(page, opener);
            const names = [];
            for (const choice of [/Upload a file/, /Paste content directly/]) {
                await page.locator('#upload-modal').getByRole('button', { name: choice }).click();
                const back = page.locator('#upload-modal .btn-text-only:visible');
                await expect(back).toHaveCount(1);
                names.push((await toolkit.describe(back)).name);
                const found = findingsFor(await toolkit.audit(page, { root: '#upload-modal', rules: ['icon-not-hidden', 'control-names'] }),
                    ['icon-not-hidden', 'control-name-has-symbol', 'control-name-symbol-only'], /btn-text-only/);
                note(`findings:${choice.source}`, brief(found));
                expect(found).toEqual([]);
                await back.click();
            }
            note('names', names);
            expect(names).toEqual(['Back', 'Back']);
        });
    }

    // --------------------------------------------------------------- flashcards

    finding(48, 'the "Generate Draft" status message announces only its own text', async ({ page, note }) => {
        const { announced } = await statusMessageChecks(page, note,
            () => page.locator('.flashcard-generate-btn').first().click(), /draft generated/i);
        for (const a of announced) {
            expect(a.controlsInside).toEqual([]);
            expect(a.text).not.toMatch(/dismiss/i);
            expect(a.text).toMatch(/Cell Structure/);
        }
    });

    finding(49, 'controls inside the "Generate Draft" status message can be reached from the keyboard', async ({ page, note }) => {
        const { observed } = await statusMessageChecks(page, note,
            () => page.locator('.flashcard-generate-btn').first().click(), /draft generated/i);
        // Nothing a keyboard user cannot get to: either the message has no control,
        // or the control is still there and in the tab order.
        const withControls = observed.messages.filter((m) => m.controls.length);
        note('messagesWithControls', withControls);
        for (const message of withControls) expect(message.removedAfterMs).toBeNull();
        if (withControls.length) {
            const reach = await toolkit.reachableByTab(page, page.locator('.notification .notification-close').last(),
                { from: page.locator('.skip-link a'), maxTabs: 12 });
            note('dismissReachable', reach);
            expect(reach.reached).toBe(true);
        }
    });

    finding(50, 'the "Generate Draft" status message does not take controls away on a timer', async ({ page, note }) => {
        const { observed } = await statusMessageChecks(page, note,
            () => page.locator('.flashcard-generate-btn').first().click(), /draft generated/i);
        const timedOutWithControls = observed.messages.filter((m) => m.controls.length && m.removedAfterMs !== null);
        note('timedOutWithControls', timedOutWithControls);
        expect(timedOutWithControls).toEqual([]);
    });

    finding(51, '"Instructor-curated study deck" is a heading', async ({ page, note }) => {
        const markup = await headingMarkup(page.locator('.flashcard-intro').getByText('Instructor-curated study deck'));
        note('markup', markup);
        expect(markup.every((m) => m.heading === 'h4')).toBe(true);
    });

    finding(52, 'draft card names are headings', async ({ page, note }) => {
        const markup = await headingMarkup(page.locator('.accordion-item').first().locator('.flashcard-editor-row-heading').getByText(/^Card \d+$/));
        note('markup', markup);
        expect(markup).toHaveLength(3);
        expect(markup.every((m) => m.heading === 'h6')).toBe(true);
    });

    finding(59, 'published card names are headings', async ({ page, note }) => {
        const markup = await headingMarkup(page.locator('.accordion-item').nth(2).locator('.flashcard-editor-row-heading').getByText(/^Card \d+$/));
        note('markup', markup);
        expect(markup).toHaveLength(2);
        expect(markup.every((m) => m.heading === 'h6')).toBe(true);
    });

    finding(56, 'focus is kept after a flashcard is removed', async ({ page, note }) => {
        const remove = page.locator('.accordion-item').first().locator('.flashcard-remove-btn').first();
        const result = await toolkit.focusAfterActivation(remove, { settleMs: 1500 });
        note('focusAfter', result);
        expect(result.lost).toBe(false);
    });

    finding(57, 'draft cards are a list', async ({ page, note }) => {
        const markup = await listMarkup(page.locator('.accordion-item').first().locator('.flashcard-editor-row'));
        note('items', markup);
        expect(markup).toHaveLength(3);
        expect(markup.every((m) => m.ok)).toBe(true);
    });

    finding(58, 'published cards are a list', async ({ page, note }) => {
        const markup = await listMarkup(page.locator('.accordion-item').nth(2).locator('.flashcard-editor-row'));
        note('items', markup);
        expect(markup).toHaveLength(2);
        expect(markup.every((m) => m.ok)).toBe(true);
    });
});

/**
 * The tests above each check one reported finding. This one asks the wider
 * question: with every generic rule switched on, in every state of the page,
 * is anything else wrong that the manual pass did not list?
 *
 * "fail"-tier findings and blocking axe violations fail the test. "review"-tier
 * findings are heuristics; they are written to the evidence file for a person
 * to look at and do not fail the build.
 */
test.describe('Course Upload: generic sweep of every state', () => {
    test.use({ storageState: storageStatePath('instructor'), viewport: { width: 1440, height: 1000 } });

    test.beforeAll(async () => {
        const instructorId = await getUserIdByUsername(TEST_USERS.instructor.username);
        const now = new Date();
        const unit = (n, displayName, objectives) => ({
            name: `Unit ${n}`, displayName, isPublished: false, learningObjectives: objectives, passThreshold: 1,
            createdAt: now, updatedAt: now, documents: [],
            assessmentQuestions: [
                { questionId: `q-${n}-1`, questionType: 'true-false', question: `Statement ${n} is true.`, correctAnswer: 'true', options: {} },
                {
                    questionId: `q-${n}-2`, questionType: 'multiple-choice', question: `Pick the right option for unit ${n}.`,
                    correctAnswer: 'B', options: { A: 'First', B: 'Second', C: 'Third', D: 'Fourth' },
                },
            ],
        });
        await seedCourse({
            courseId: COURSE_ID, instructorId, courseName: 'A11y 724 Course',
            lectures: [
                unit(1, 'Cell Structure', ['Describe the cell membrane', 'Name the organelles', 'Explain osmosis']),
                unit(2, 'Enzymes', ['Define activation energy', 'Describe enzyme inhibition']),
                unit(3, 'Metabolism', ['Outline glycolysis', 'Outline the citric acid cycle']),
            ],
        });
        for (const n of [1, 2]) {
            for (const suffix of ['lecture', 'tutorial']) {
                await seedDocumentAndAttach({
                    documentId: `a11y724-doc-${n}-${suffix}`, courseId: COURSE_ID, lectureName: `Unit ${n}`, instructorId,
                    filename: `unit-${n}-${suffix}.txt`,
                });
            }
        }
    });

    test.afterAll(async () => {
        await cleanupCourses([COURSE_ID]);
    });

    test('no fail-tier toolkit findings and no blocking axe violations in any state', async ({ page }) => {
        test.setTimeout(180_000);
        const AxeBuilder = require('@axe-core/playwright').default;
        /** @type {Record<string, any>} */
        const states = {};

        const capture = async (name, root) => {
            const findings = await toolkit.audit(page, root ? { root } : {});
            let builder = new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']);
            if (root) builder = builder.include(root);
            const axe = (await builder.analyze()).violations;
            fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
            await page.screenshot({ path: path.join(EVIDENCE_DIR, `state-${name}.png`), fullPage: !root });
            states[name] = {
                fail: findings.filter((f) => f.tier === 'fail'),
                review: findings.filter((f) => f.tier === 'review'),
                house: findings.filter((f) => f.tier === 'house'),
                axe: axe.flatMap((v) => v.nodes.map((node) => ({
                    rule: v.id, impact: v.impact, selector: node.target.join(' '), summary: (node.failureSummary || '').split('\n').slice(0, 2).join(' '),
                }))),
            };
        };

        await openCourseUpload(page);
        await capture('page');
        // Close-ups for the write-up: each part of the first unit as rendered.
        const firstUnit = page.locator('.accordion-item').first();
        for (const [name, selector] of [
            ['unit-header', '.accordion-header'], ['objectives', '.learning-objectives-section'],
            ['materials', '.course-materials-section'], ['flashcards', '.flashcards-section'],
            ['questions', '.assessment-questions-section'],
        ]) {
            await firstUnit.locator(selector).first().screenshot({ path: path.join(EVIDENCE_DIR, `part-${name}.png`) });
        }

        await page.locator('.accordion-item').first().locator('.unit-rename-btn').click();
        await capture('rename-unit', '.accordion-item:first-child .accordion-header');
        await page.keyboard.press('Escape');

        await openLmsDialog(page, 'canvas');
        await capture('canvas-dialog', '#lms-import-modal');
        await page.locator('#lms-import-close').click();

        await openLmsDialog(page, 'moodle');
        await capture('moodle-dialog', '#lms-import-modal');
        await page.locator('#lms-import-close').click();

        await openUploadDialog(page, /Add Lecture Notes/);
        await capture('upload-dialog-choose', '#upload-modal');
        await page.locator('#upload-modal').getByRole('button', { name: /Upload a file/ }).click();
        await capture('upload-dialog-file', '#upload-modal');
        await page.locator('#upload-modal .btn-text-only:visible').click();
        await page.locator('#upload-modal').getByRole('button', { name: /Paste content directly/ }).click();
        await capture('upload-dialog-paste', '#upload-modal');
        await page.locator('#upload-modal').getByRole('button', { name: 'Cancel' }).click();

        await page.locator('.accordion-item').first().getByRole('button', { name: /Add Question/ }).click();
        await expect(page.locator('#question-modal')).toBeVisible();
        await capture('question-dialog', '#question-modal');
        await page.locator('#question-modal').getByRole('button', { name: 'Cancel' }).click();

        await page.evaluate(() => {
            const w = /** @type {any} */ (window);
            w.showNotification('Saved.', 'success');
            w.showNotification('Heads up.', 'info');
            w.showNotification('Check this.', 'warning');
            w.showNotification('That did not work.', 'error');
        });
        // Let the slide-in finish: mid-animation the toast is part transparent
        // and any contrast measurement would be of a frame nobody reads.
        await page.waitForTimeout(600);
        await capture('toasts', '.notification-container');

        const summary = Object.fromEntries(Object.entries(states).map(([name, s]) => [name, {
            fail: s.fail.length, review: s.review.length, house: s.house.length,
            axeBlocking: s.axe.filter((a) => a.impact === 'critical' || a.impact === 'serious').length,
            axeOther: s.axe.filter((a) => a.impact !== 'critical' && a.impact !== 'serious').length,
        }]));
        fs.writeFileSync(path.join(EVIDENCE_DIR, 'sweep.json'), JSON.stringify({ summary, states }, null, 2));

        const failing = Object.entries(states).flatMap(([name, s]) => [
            ...s.fail.map((f) => `${name}: ${f.rule} ${f.selector} ${f.name ? `"${f.name}" ` : ''}- ${f.message}`),
            ...s.axe.filter((a) => a.impact === 'critical' || a.impact === 'serious')
                .map((a) => `${name}: axe ${a.rule} [${a.impact}] ${a.selector}`),
        ]);
        expect(failing, `Accessibility findings:\n${failing.join('\n')}`).toEqual([]);
    });
});
