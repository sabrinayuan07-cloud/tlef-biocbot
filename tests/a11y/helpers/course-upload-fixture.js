// @ts-check
/**
 * The instructor Course Upload page in the state the issue 724 checks need:
 * a seeded three-unit course (objectives, two documents in units 1 and 2, one
 * question per unit), the Canvas and Moodle launchers turned on, and flashcard
 * decks for every unit (two drafts, one published).
 *
 * Shared by tests/a11y/issue-724-course-upload.a11y.spec.js (Chromium checks)
 * and tests/screen-reader/course-upload.sr.spec.js (VoiceOver), so both test
 * the same page.
 */
const { expect } = require('@playwright/test');
const { TEST_USERS } = require('../../e2e/helpers/users');
const { seedCourse, seedDocumentAndAttach, getUserIdByUsername } = require('../../e2e/helpers/courses-test');

/** @param {number} n @param {string} unit */
const card = (n, unit) => ({
    cardId: `fc-${unit}-${n}`,
    front: `Question ${n} for ${unit}`,
    back: `Answer ${n} for ${unit}`,
    source: { documentId: 'doc1', fileName: 'Lecture.pdf', chunkIndex: n },
});

/** @param {string} courseId @param {string} unit */
const draftDeck = (courseId, unit) => ({
    deckId: `deck-${unit.replace(/\s+/g, '-')}`, courseId, lectureName: unit, title: `${unit} Flashcards`,
    hasDraft: true, isPublished: false, isStale: false, publishedVersion: 0,
    draftCards: [card(1, unit), card(2, unit), card(3, unit)], publishedCards: [],
});

/** @param {string} courseId @param {string} unit */
const publishedDeck = (courseId, unit) => ({
    deckId: `deck-${unit.replace(/\s+/g, '-')}`, courseId, lectureName: unit, title: `${unit} Flashcards`,
    hasDraft: false, isPublished: true, isStale: false, publishedVersion: 1,
    draftCards: [], publishedCards: [card(1, unit), card(2, unit)],
});

/**
 * The LMS launchers only appear when a deployment has Canvas/Moodle configured,
 * and flashcard decks need generated content, so both are answered from here.
 * Everything else (units, objectives, documents, publish, reorder) is the real
 * application against a seeded course.
 * @param {import('@playwright/test').Page} page
 * @param {string} courseId
 */
async function mockIntegrations(page, courseId) {
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

    const decks = [draftDeck(courseId, 'Unit 1'), draftDeck(courseId, 'Unit 2'), publishedDeck(courseId, 'Unit 3')];
    await page.route('**/api/flashcards/instructor?**', (route) => route.fulfill(json({ success: true, data: { units: [], decks } })));
    await page.route('**/api/flashcards/instructor/generate', (route) => route.fulfill(json({
        success: true, message: 'Flashcard draft generated.', data: draftDeck(courseId, 'Unit 1'),
    })));
    await page.route('**/api/flashcards/instructor/deck-*', async (route) => {
        const body = route.request().postDataJSON() || {};
        const unit = decodeURIComponent(route.request().url().split('/deck-')[1].split('/')[0]).replace(/-/g, ' ');
        route.fulfill(json({ success: true, data: { ...draftDeck(courseId, unit), draftCards: body.cards || draftDeck(courseId, unit).draftCards } }));
    });
}

/**
 * Seed the course: three units with objectives and one true/false question
 * each, and two documents in units 1 and 2. Safe to call before every test.
 * @param {string} courseId
 * @param {{ courseName?: string, docPrefix?: string }} [options]
 */
async function seedCourseUploadCourse(courseId, { courseName = 'A11y 724 Course', docPrefix = 'a11y724' } = {}) {
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
        courseId, instructorId, courseName,
        lectures: [
            unit(1, 'Cell Structure', ['Describe the cell membrane', 'Name the organelles', 'Explain osmosis']),
            unit(2, 'Enzymes', ['Define activation energy', 'Describe enzyme inhibition']),
            unit(3, 'Metabolism', ['Outline glycolysis', 'Outline the citric acid cycle']),
        ],
    });
    for (const n of [1, 2]) {
        await seedDocumentAndAttach({
            documentId: `${docPrefix}-doc-${n}-a`, courseId, lectureName: `Unit ${n}`, instructorId,
            filename: `unit-${n}-lecture.txt`,
        });
        await seedDocumentAndAttach({
            documentId: `${docPrefix}-doc-${n}-b`, courseId, lectureName: `Unit ${n}`, instructorId,
            filename: `unit-${n}-tutorial.txt`,
        });
    }
}

/**
 * Seed a course whose titles repeat, which the app allows: units 1 and 2 are
 * both titled "Cell Structure" with the unit number hidden, an objective
 * repeats inside unit 1 and again in unit 2, and "lecture.pdf" is uploaded
 * twice to unit 1 and once to unit 2. Unit 3 is an ordinary numbered unit.
 * @param {string} courseId
 * @param {{ docPrefix?: string }} [options]
 */
async function seedDuplicateTitlesCourse(courseId, { docPrefix = 'a11ydup' } = {}) {
    const instructorId = await getUserIdByUsername(TEST_USERS.instructor.username);
    const now = new Date();
    const unit = (n, displayName, showUnitNumber, objectives) => ({
        name: `Unit ${n}`, displayName, showUnitNumber, isPublished: false, learningObjectives: objectives, passThreshold: 1,
        createdAt: now, updatedAt: now, documents: [],
        assessmentQuestions: [{
            questionId: `q-${n}-1`, questionType: 'true-false', question: `Statement ${n} is true.`,
            correctAnswer: 'true', options: {},
        }],
    });
    await seedCourse({
        courseId, instructorId, courseName: 'Duplicate Titles Course',
        lectures: [
            unit(1, 'Cell Structure', false, ['Explain osmosis', 'Explain osmosis', 'Name the organelles']),
            unit(2, 'Cell Structure', false, ['Explain osmosis']),
            unit(3, 'Metabolism', true, ['Outline glycolysis']),
        ],
    });
    for (const [id, n] of [['1-a', 1], ['1-b', 1], ['2-a', 2]]) {
        await seedDocumentAndAttach({
            documentId: `${docPrefix}-doc-${id}`, courseId, lectureName: `Unit ${n}`, instructorId, filename: 'lecture.pdf',
        });
    }
}

/** The control that expands/collapses a unit, whatever element it is. */
function unitToggle(unit) {
    return unit.locator('[aria-expanded]').first();
}

/**
 * Open the page and wait until every part the checks look at has loaded.
 * @param {import('@playwright/test').Page} page
 * @param {string} courseId
 * @param {{ expandAll?: boolean }} [options] expandAll: open every unit through its own control (default), as the checks need
 */
async function openCourseUpload(page, courseId, { expandAll = true } = {}) {
    await mockIntegrations(page, courseId);
    await page.goto(`/instructor/documents?courseId=${courseId}`);
    await expect(page.locator('.accordion-item')).toHaveCount(3, { timeout: 20_000 });
    await expect(page.locator('.flashcard-editor-row')).toHaveCount(8, { timeout: 20_000 });
    await expect(page.locator('.lms-import-chip:visible')).toHaveCount(2);
    await expect(page.locator('.add-content-section')).toHaveCount(3);
    if (expandAll) {
        // Expand every unit through its own disclosure control, as a user would.
        for (let guard = 0; guard < 6; guard += 1) {
            const collapsed = page.locator('.accordion-item').filter({ has: page.locator('.accordion-content.collapsed') });
            if ((await collapsed.count()) === 0) break;
            await unitToggle(collapsed.first()).click();
        }
        await expect(page.locator('.accordion-content.collapsed')).toHaveCount(0);
    }
    // Let the page's own staggered loaders (documents, thresholds, decks) finish.
    await page.waitForTimeout(700);
}

module.exports = {
    card, draftDeck, publishedDeck, mockIntegrations, seedCourseUploadCourse, seedDuplicateTitlesCourse, unitToggle, openCourseUpload,
};
