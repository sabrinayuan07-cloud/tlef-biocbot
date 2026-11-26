// @ts-check
/**
 * Repeated controls on the Course Upload page stay distinguishable when the
 * titles they borrow repeat.
 *
 * Repeated controls are told apart by hidden context naming the unit, file or
 * objective they act on ("Add Question (Assessment Questions) (1. Cell
 * Structure)"). Those titles do not have to be unique: two units can share a
 * title (and hide their numbers), the same file can be uploaded twice, and an
 * objective can be written twice. The house rule for that
 * (ubc/ltic-accessibility-skills, handling-items-with-same-name.md) is an
 * automatic position: "Cell Structure (1 of 2)" in visible headings and
 * "(Cell Structure - 1 of 2)" inside control names, never stored, worked out
 * again after every add, rename, delete and reorder.
 */
const { test, expect } = require('@playwright/test');
const { storageStatePath } = require('../e2e/helpers/users');
const { cleanupCourses } = require('../e2e/helpers/courses-test');
const toolkit = require('./toolkit');
const fixture = require('./helpers/course-upload-fixture');

const COURSE_ID = 'BIOC-A11Y-DUPLICATES';

/** @param {import('@playwright/test').Locator} locator */
const names = async (locator) => (await toolkit.describeAll(locator)).map((c) => c.name);

/** @param {import('@playwright/test').Page} page */
const unitHeadings = (page) => page.locator('.accordion-item .unit-heading').allTextContents()
    .then((texts) => texts.map((t) => t.replace(/\s+/g, ' ').trim()));

/** @param {import('@playwright/test').Page} page */
async function expectNoDuplicateNames(page) {
    const duplicates = (await toolkit.audit(page, { rules: ['control-name-duplicate'] }))
        .filter((f) => f.rule === 'control-name-duplicate')
        .map((f) => ({ name: f.name, selector: f.selector, message: f.message }));
    expect(duplicates, 'controls that share a name').toEqual([]);
}

test.describe('Course Upload: repeated titles', () => {
    test.use({ storageState: storageStatePath('instructor'), viewport: { width: 1440, height: 1000 } });

    test.beforeEach(async () => {
        await fixture.seedDuplicateTitlesCourse(COURSE_ID);
    });

    test.afterAll(async () => {
        await cleanupCourses([COURSE_ID]);
    });

    test('no two controls share a name when unit titles, file names and objectives repeat', async ({ page }) => {
        await fixture.openCourseUpload(page, COURSE_ID);

        // The page really does repeat itself: two units have the same title,
        // and "lecture.pdf" is listed three times. The title itself is stored
        // and shown unchanged; the position is added after it.
        const titles = await page.locator('.accordion-item .folder-name').allTextContents();
        expect(titles.map((t) => t.trim())).toEqual(['Cell Structure', 'Cell Structure', '3. Metabolism']);
        expect(await unitHeadings(page)).toEqual(['Cell Structure (1 of 2)', 'Cell Structure (2 of 2)', '3. Metabolism']);
        await expect(page.locator('.file-item .file-title', { hasText: 'lecture.pdf' })).toHaveCount(3);

        await expectNoDuplicateNames(page);

        // Unit controls: the disclosure is named by its heading, and the
        // others carry "(Title - 1 of 2)".
        expect(await names(page.locator('.accordion-trigger'))).toEqual(
            ['Cell Structure (1 of 2)', 'Cell Structure (2 of 2)', '3. Metabolism']);
        expect(await names(page.locator('.unit-rename-btn'))).toEqual([
            'Rename Unit (Cell Structure - 1 of 2)', 'Rename Unit (Cell Structure - 2 of 2)', 'Rename Unit (3. Metabolism)',
        ]);
        expect(await names(page.locator('.header-actions .publish-toggle input'))).toEqual([
            'Publish (Cell Structure - 1 of 2)', 'Publish (Cell Structure - 2 of 2)', 'Publish (3. Metabolism)',
        ]);

        // Files: a position after the title where it repeats within its unit,
        // both on screen and in the control names.
        const unit1 = page.locator('.accordion-item[data-unit-name="Unit 1"]');
        const unit2 = page.locator('.accordion-item[data-unit-name="Unit 2"]');
        expect((await unit1.locator('.file-item[data-document-id] .file-title').allTextContents()).map((t) => t.trim()))
            .toEqual(['lecture.pdf (1 of 2)', 'lecture.pdf (2 of 2)']);
        expect((await unit2.locator('.file-item[data-document-id] .file-title').allTextContents()).map((t) => t.trim()))
            .toEqual(['lecture.pdf']);
        expect(await names(page.locator('.file-item .action-button.view'))).toEqual([
            'View lecture.pdf (1 of 2) (Cell Structure - 1 of 2)',
            'View lecture.pdf (2 of 2) (Cell Structure - 1 of 2)',
            'View lecture.pdf (Cell Structure - 2 of 2)',
        ]);

        // Objectives: the instructor's words, quoted, with a position when they
        // repeat in the unit. Their visible text is left as written.
        expect(await names(unit1.locator('.remove-objective'))).toEqual([
            'Remove Objective ("Explain osmosis" - 1 of 2) (Cell Structure - 1 of 2)',
            'Remove Objective ("Explain osmosis" - 2 of 2) (Cell Structure - 1 of 2)',
            'Remove Objective ("Name the organelles") (Cell Structure - 1 of 2)',
        ]);
        expect(await names(unit2.locator('.remove-objective'))).toEqual([
            'Remove Objective ("Explain osmosis") (Cell Structure - 2 of 2)',
        ]);
        await expect(unit1.locator('.objective-text').first()).toHaveText('Explain osmosis');
    });

    test('positions are worked out again after rename, reorder and add', async ({ page }) => {
        await fixture.openCourseUpload(page, COURSE_ID);
        const unit1 = page.locator('.accordion-item[data-unit-name="Unit 1"]');
        const unit2 = page.locator('.accordion-item[data-unit-name="Unit 2"]');

        // Rename unit 2: neither unit shares a title any more, so both lose
        // their position, including in the names of their children.
        await unit2.locator('.unit-rename-btn').click();
        await expect(unit2.locator('.unit-rename-input')).toBeFocused();
        expect(await names(unit2.locator('.unit-save-btn'))).toEqual(['Save (Rename Unit - "Cell Structure" - 2 of 2)']);
        expect(await names(unit2.locator('.unit-rename-input'))).toEqual(['Unit title ("Cell Structure" - 2 of 2)']);
        await expect(unit2.locator('.unit-rename-input')).toHaveValue('Cell Structure');
        await unit2.locator('.unit-rename-input').fill('Enzymes');
        await unit2.locator('.unit-save-btn').click();
        await expect(unit2.locator('.folder-name')).toHaveText('Enzymes');
        expect(await unitHeadings(page)).toEqual(['Cell Structure', 'Enzymes', '3. Metabolism']);
        expect(await names(page.locator('.unit-rename-btn'))).toEqual([
            'Rename Unit (Cell Structure)', 'Rename Unit (Enzymes)', 'Rename Unit (3. Metabolism)',
        ]);
        expect(await names(unit1.locator('.file-item .action-button.view'))).toEqual([
            'View lecture.pdf (1 of 2) (Cell Structure)', 'View lecture.pdf (2 of 2) (Cell Structure)',
        ]);

        // Rename it back: both get their position again.
        await unit2.locator('.unit-rename-btn').click();
        await unit2.locator('.unit-rename-input').fill('Cell Structure');
        await unit2.locator('.unit-save-btn').click();
        await expect.poll(() => unitHeadings(page)).toEqual(['Cell Structure (1 of 2)', 'Cell Structure (2 of 2)', '3. Metabolism']);
        expect(await names(unit1.locator('.add-question-btn'))).toEqual(['Add Question (Assessment Questions) (Cell Structure - 1 of 2)']);
        await expectNoDuplicateNames(page);

        // Reorder: unit 2 moves first, so it becomes "1 of 2".
        await unit2.locator('.unit-move-btn').first().click();
        await expect(page.locator('.accordion-item').first()).toHaveAttribute('data-unit-name', 'Unit 2');
        await expect(page.locator('.accordion-item[data-unit-name="Unit 2"] .accordion-trigger')).toHaveText('Cell Structure (1 of 2)');
        expect(await names(page.locator('.accordion-item[data-unit-name="Unit 1"] .delete-unit-btn'))).toEqual(['Delete Unit (Cell Structure - 2 of 2)']);

        // Add an objective that unit 1 already has: both copies get a position.
        const unit1Now = page.locator('.accordion-item[data-unit-name="Unit 1"]');
        await fixture.unitToggle(unit1Now).getAttribute('aria-expanded').then(async (expanded) => {
            if (expanded !== 'true') await fixture.unitToggle(unit1Now).click();
        });
        await unit1Now.locator('.objective-input').fill('Name the organelles');
        await unit1Now.locator('.add-objective-btn-inline').click();
        await expect(unit1Now.locator('.remove-objective')).toHaveCount(4);
        expect(await names(unit1Now.locator('.remove-objective'))).toEqual([
            'Remove Objective ("Explain osmosis" - 1 of 2) (Cell Structure - 2 of 2)',
            'Remove Objective ("Explain osmosis" - 2 of 2) (Cell Structure - 2 of 2)',
            'Remove Objective ("Name the organelles" - 1 of 2) (Cell Structure - 2 of 2)',
            'Remove Objective ("Name the organelles" - 2 of 2) (Cell Structure - 2 of 2)',
        ]);
        await expectNoDuplicateNames(page);
    });
});
