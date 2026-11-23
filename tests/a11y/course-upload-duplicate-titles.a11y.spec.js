// @ts-check
/**
 * Repeated controls on the Course Upload page stay distinguishable when the
 * titles they borrow repeat.
 *
 * The fixes for issue 724 told repeated controls apart by ending each name
 * with the title of the unit, file or objective it acts on ("Add Question to
 * 1. Cell Structure"). Those titles do not have to be unique: two units can
 * share a title (and hide their numbers), the same file can be uploaded twice,
 * and an objective can be written twice. Ivan's re-test of 724 asked about
 * exactly this. Here every one of those repeats at once, and no two controls
 * may end up with the same name.
 */
const { test, expect } = require('@playwright/test');
const { storageStatePath } = require('../e2e/helpers/users');
const { cleanupCourses } = require('../e2e/helpers/courses-test');
const toolkit = require('./toolkit');
const fixture = require('./helpers/course-upload-fixture');

const COURSE_ID = 'BIOC-A11Y-DUPLICATES';

test.describe('Course Upload: repeated titles', () => {
    test.use({ storageState: storageStatePath('instructor'), viewport: { width: 1440, height: 1000 } });

    test.beforeAll(async () => {
        await fixture.seedDuplicateTitlesCourse(COURSE_ID);
    });

    test.afterAll(async () => {
        await cleanupCourses([COURSE_ID]);
    });

    test('no two controls share a name when unit titles, file names and objectives repeat', async ({ page }) => {
        await fixture.openCourseUpload(page, COURSE_ID);

        // The page really does repeat itself: two units show the same title,
        // and "lecture.pdf" is listed three times.
        const titles = await page.locator('.accordion-item .folder-name').allTextContents();
        expect(titles.map((t) => t.trim())).toEqual(['Cell Structure', 'Cell Structure', '3. Metabolism']);
        await expect(page.locator('.file-item .file-title', { hasText: 'lecture.pdf' })).toHaveCount(3);

        const duplicates = (await toolkit.audit(page, { rules: ['control-name-duplicate'] }))
            .filter((f) => f.rule === 'control-name-duplicate')
            .map((f) => ({ name: f.name, selector: f.selector, message: f.message }));
        expect(duplicates, 'controls that share a name').toEqual([]);

        // The unit controls themselves (their names are their titles).
        const triggers = await toolkit.describeAll(page.locator('.accordion-trigger'));
        expect(new Set(triggers.map((t) => t.name)).size, `unit control names: ${triggers.map((t) => t.name).join(' | ')}`).toBe(3);
    });
});
