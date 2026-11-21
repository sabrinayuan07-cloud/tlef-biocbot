// @ts-check
/**
 * Student Super Course picker — switching between multiple accessible buckets.
 * Seeds two student-visible buckets the student is enrolled into and verifies the
 * picker offers both and that switching swaps the source pool.
 */

require('dotenv').config();
const { test, expect } = require('./fixtures/monocart');
const { TEST_USERS, storageStatePath } = require('./helpers/users');
const {
    getUserIdByUsername,
    seedCourse,
    cleanupCourses,
} = require('./helpers/courses-test');
const { seedSuperchat, cleanupSuperchats } = require('./helpers/superchats-test');
const { stubAgreementAccepted } = require('./helpers/agreement');

const PREFIX = 'BIOC-E2E-SCSWITCH';
const BUCKET_A = `${PREFIX}-A`;
const BUCKET_B = `${PREFIX}-B`;
const COURSE_A = `${PREFIX}-COURSE-A`;
const COURSE_B = `${PREFIX}-COURSE-B`;
// A year-5 course in bucket B the student is NOT enrolled in. Pool membership is
// not enrollment-gated, so it lifts bucket B's pool above the student's level
// (max enrolled year = 3) without raising the student's own level. This makes
// bucket B "above your year" and bucket A not — needed to test the banner toggle.
const COURSE_C = `${PREFIX}-COURSE-C`;

let studentId;
let instructorId;

test.use({ storageState: storageStatePath('student') });

test.beforeAll(async () => {
    studentId = await getUserIdByUsername(TEST_USERS.student.username);
    instructorId = await getUserIdByUsername(TEST_USERS.instructor.username);
});

test.beforeEach(async () => {
    await Promise.all([
        seedSuperchat({ superchatId: BUCKET_A, name: 'Picker Bucket A', yearLevel: 2, showToStudents: true }),
        seedSuperchat({ superchatId: BUCKET_B, name: 'Picker Bucket B', yearLevel: 3, showToStudents: true }),
    ]);
    await Promise.all([
        seedCourse({
            courseId: COURSE_A, instructorId, courseName: 'BIOC 202 Picker A',
            overrides: { yearLevel: 2, superchatIds: [BUCKET_A] },
            studentEnrollment: { [studentId]: { enrolled: true, enrolledAt: new Date() } },
        }),
        seedCourse({
            courseId: COURSE_B, instructorId, courseName: 'BIOC 301 Picker B',
            overrides: { yearLevel: 3, superchatIds: [BUCKET_B] },
            studentEnrollment: { [studentId]: { enrolled: true, enrolledAt: new Date() } },
        }),
        seedCourse({
            courseId: COURSE_C, instructorId, courseName: 'BIOC 501 Picker C',
            overrides: { yearLevel: 5, superchatIds: [BUCKET_B] },
            // Intentionally not enrolled — pool membership only.
        }),
    ]);
});

test.afterEach(async () => {
    await cleanupCourses([COURSE_A, COURSE_B, COURSE_C]);
    await cleanupSuperchats([BUCKET_A, BUCKET_B]);
});

test('the picker offers both accessible buckets and switching swaps the source pool', async ({ page }) => {
    // The agreement modal blocks pointer events on /student/super-course.
    await stubAgreementAccepted(page);
    await page.goto('/student/super-course');

    const picker = page.locator('#superchat-picker');
    await expect(picker).toBeVisible({ timeout: 10_000 });
    // Regression check for #645: .superchat-picker's own padding shorthand
    // must leave room for the global select chevron.
    await expect(picker).toHaveCSS('padding-right', '34px');
    // Both seeded buckets are offered (other residual buckets may also appear).
    await expect(picker.locator(`option[value="${BUCKET_A}"]`)).toHaveCount(1);
    await expect(picker.locator(`option[value="${BUCKET_B}"]`)).toHaveCount(1);

    const poolList = page.locator('#super-course-pool-list');

    // Select bucket A -> its course only.
    await picker.selectOption(BUCKET_A);
    await expect(poolList).toContainText('BIOC 202 Picker A', { timeout: 10_000 });
    await expect(poolList).not.toContainText('BIOC 301 Picker B');

    // Switch to bucket B -> the pool swaps.
    await picker.selectOption(BUCKET_B);
    await expect(poolList).toContainText('BIOC 301 Picker B', { timeout: 10_000 });
    await expect(poolList).not.toContainText('BIOC 202 Picker A');
});

test('the "above your level" notice toggles when switching buckets (not just on reload)', async ({ page }) => {
    // The agreement modal blocks pointer events on /student/super-course.
    await stubAgreementAccepted(page);
    await page.goto('/student/super-course');

    const picker = page.locator('#superchat-picker');
    await expect(picker).toBeVisible({ timeout: 10_000 });
    const notice = page.locator('#super-course-level-notice');

    // Bucket B's pool reaches year 5 (above the student's year 3) -> notice shows.
    await picker.selectOption(BUCKET_B);
    await expect(notice).toBeVisible({ timeout: 10_000 });

    // Switching to bucket A (year 2 only, at/below the student) must REMOVE the
    // notice in place — previously it lingered until a full page reload.
    await picker.selectOption(BUCKET_A);
    await expect(notice).toHaveCount(0);

    // And switching back re-shows it.
    await picker.selectOption(BUCKET_B);
    await expect(notice).toBeVisible();
});

test('/list returns both accessible visible buckets', async ({ request: api }) => {
    const resp = await api.get('/api/student/super-course/list');
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    expect(body.success).toBe(true);
    const ids = body.superchats.map((s) => s.superchatId);
    // Both seeded buckets are visible + enrolled, so both must be offered.
    // (Ordering depends on the student's global enrolled-year state, so we only
    // assert membership here.)
    expect(ids).toContain(BUCKET_A);
    expect(ids).toContain(BUCKET_B);
});
