// @ts-check
/**
 * Focused branch coverage for public/student/scripts/flagged.js.
 *
 * These tests drive the real /student/flagged page with mocked endpoints so
 * the student-side empty, error, filtering, enrollment, and render fallback
 * branches can be exercised without changing production code.
 */

const { test, expect } = require('./fixtures/monocart');
const { storageStatePath } = require('./helpers/users');

const COURSE_ID = 'STUDENT-FLAGGED-BRANCHES';
const COURSE_NAME = 'Student Flagged Branches';

/**
 * @typedef {{
 *   flagId: string,
 *   flagReason?: string,
 *   flagStatus?: string,
 *   instructorResponse?: string | null,
 *   instructorName?: string | null,
 *   createdAt?: string,
 *   updatedAt?: string,
 *   botMode?: string | null,
 *   flagDescription?: string | null,
 *   questionContent?: Record<string, any> | null,
 *   unitName?: string | null,
 * }} StudentFlag
 *
 * @typedef {{
 *   selectedCourseId?: string | null,
 *   selectedCourseName?: string | null,
 *   enrollmentStatus?: number,
 *   enrollmentBody?: Record<string, any>,
 *   enrollmentAbort?: boolean,
 *   flagResponses?: Array<{ status?: number, body: Record<string, any> }>,
 *   flags?: StudentFlag[],
 * }} HarnessOptions
 */

/**
 * @param {Partial<StudentFlag>} [overrides]
 * @returns {StudentFlag}
 */
function flag(overrides = {}) {
    return {
        flagId: 'flag_student_branch',
        flagReason: 'unclear',
        flagStatus: 'pending',
        instructorResponse: null,
        instructorName: null,
        createdAt: new Date(Date.now() - 60_000).toISOString(),
        updatedAt: new Date().toISOString(),
        botMode: 'tutor',
        flagDescription: 'I need help with this answer.',
        questionContent: {
            question: 'Which enzyme copies DNA?',
            questionType: 'short-answer',
        },
        unitName: 'Unit 1',
        ...overrides,
    };
}

/**
 * @param {StudentFlag[]} flags
 * @returns {{ status: number, body: Record<string, any> }}
 */
function flagsResponse(flags) {
    return {
        status: 200,
        body: { success: true, data: { flags, count: flags.length } },
    };
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {HarnessOptions} [options]
 */
async function installStudentFlaggedRoutes(page, options = {}) {
    const selectedCourseId = options.selectedCourseId === undefined ? COURSE_ID : options.selectedCourseId;
    const selectedCourseName = options.selectedCourseName === undefined ? COURSE_NAME : options.selectedCourseName;
    const flagRequests = [];
    const queuedFlagResponses = options.flagResponses
        ? [...options.flagResponses]
        : [flagsResponse(options.flags || [])];

    await page.route('**/api/**', async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        const pathname = url.pathname;

        if (pathname === '/api/auth/me') {
            await route.fulfill({
                json: {
                    success: true,
                    user: {
                        userId: 'user_e2e_student',
                        username: 'e2e_student',
                        displayName: 'E2E Student',
                        role: 'student',
                    },
                },
            });
            return;
        }

        if (pathname === '/api/settings/llm-tag') {
            await route.fulfill({ json: { success: true, llmIndex: null, reasoningIndex: null } });
            return;
        }

        if (pathname === '/api/quiz/status') {
            await route.fulfill({ json: { success: true, enabled: false } });
            return;
        }

        if (pathname === `/api/courses/${COURSE_ID}/student-enrollment`) {
            if (options.enrollmentAbort) {
                await route.abort('failed');
                return;
            }
            await route.fulfill({
                status: options.enrollmentStatus || 200,
                json: options.enrollmentBody || {
                    success: true,
                    data: { enrolled: true, status: 'active' },
                },
            });
            return;
        }

        if (pathname === `/api/courses/${COURSE_ID}`) {
            await route.fulfill({
                json: {
                    success: true,
                    data: { courseId: COURSE_ID, studentIdleTimeout: 240 },
                },
            });
            return;
        }

        if (pathname === '/api/flags/my') {
            flagRequests.push({
                url: request.url(),
                method: request.method(),
            });
            const next = queuedFlagResponses.shift() || flagsResponse(options.flags || []);
            await route.fulfill({
                status: next.status || 200,
                contentType: 'application/json',
                body: JSON.stringify(next.body),
            });
            return;
        }

        await route.fulfill({
            status: 404,
            json: { success: false, message: `Unhandled mocked API route: ${pathname}` },
        });
    });

    await page.addInitScript(({ courseId, courseName }) => {
        localStorage.clear();
        if (courseId) {
            localStorage.setItem('selectedCourseId', courseId);
        }
        if (courseName) {
            localStorage.setItem('selectedCourseName', courseName);
        }
    }, { courseId: selectedCourseId, courseName: selectedCourseName });

    return { flagRequests };
}

test.describe('public/student/scripts/flagged.js branch coverage', () => {
    test.use({ storageState: storageStatePath('student') });

    test('shows the empty state and refreshes with the selected course', async ({ page }) => {
        const { flagRequests } = await installStudentFlaggedRoutes(page, {
            flagResponses: [flagsResponse([]), flagsResponse([])],
        });

        await page.goto('/student/flagged');

        await expect(page.locator('#empty-state')).toBeVisible({ timeout: 15_000 });
        await expect(page.locator('#empty-state')).toContainText('No flags found.');
        await expect(page.locator('#flagged-list .flag-card')).toHaveCount(0);

        await page.locator('#refresh-flags').click();
        await expect.poll(() => flagRequests.length).toBe(2);
        expect(flagRequests[0].url).toContain(`courseId=${encodeURIComponent(COURSE_ID)}`);
        expect(flagRequests[1].url).toContain(`courseId=${encodeURIComponent(COURSE_ID)}`);
    });

    test('filters flags by status and renders pending/response/fallback label branches', async ({ page }) => {
        await installStudentFlaggedRoutes(page, {
            flags: [
                flag({
                    flagId: 'flag_pending_fallbacks',
                    flagReason: 'surprising',
                    flagStatus: undefined,
                    botMode: null,
                    flagDescription: null,
                    questionContent: null,
                    unitName: null,
                }),
                flag({
                    flagId: 'flag_reviewed_response',
                    flagReason: 'typo',
                    flagStatus: 'reviewed',
                    instructorResponse: 'The prompt wording has been updated.',
                    instructorName: null,
                    botMode: 'coach',
                    unitName: 'Review Unit',
                    questionContent: { question: 'Find the typo in this prompt.' },
                }),
                flag({
                    flagId: 'flag_resolved_response',
                    flagReason: 'incorrect',
                    flagStatus: 'resolved',
                    instructorResponse: 'Corrected.',
                    instructorName: 'Dr. Branch',
                    botMode: 'protege',
                    questionContent: { question: 'Hemoglobin transports oxygen.' },
                }),
            ],
        });

        await page.goto('/student/flagged');

        const list = page.locator('#flagged-list');
        await expect(list.locator('.flag-card')).toHaveCount(3, { timeout: 15_000 });
        await expect(list).toContainText('surprising');
        await expect(list).toContainText('Question content not available');
        await expect(list).toContainText('Unknown Unit');
        await expect(list).toContainText('Unknown mode');
        await expect(list).toContainText('No response from instructor yet.');
        await expect(list).toContainText('The prompt wording has been updated.');
        await expect(list).toContainText('Responded by Instructor');
        await expect(list).toContainText('coach mode');
        await expect(list).toContainText('Protégé mode');
        await expect(list).toContainText('Typo/Error');
        await expect(list).toContainText('Incorrect');

        await page.locator('#status-filter').selectOption('reviewed');
        await expect(list.locator('.flag-card')).toHaveCount(1);
        await expect(list).toContainText('Find the typo in this prompt.');
        await expect(list).not.toContainText('Hemoglobin transports oxygen.');

        await page.locator('#status-filter').selectOption('dismissed');
        await expect(page.locator('#empty-state')).toBeVisible();
        await expect(list.locator('.flag-card')).toHaveCount(0);
    });

    test('a stored flag\'s reason, unit, mode and status render as text, never as markup', async ({ page }) => {
        const markup = '"><img src=x onerror="window.__flagMarkupRan=true">';
        await installStudentFlaggedRoutes(page, {
            flags: [flag({
                flagId: 'flag_markup',
                flagReason: markup,
                flagStatus: markup,
                unitName: markup,
                botMode: markup,
            })],
        });

        await page.goto('/student/flagged');
        const list = page.locator('#flagged-list');
        await expect(list.locator('.flag-card')).toHaveCount(1, { timeout: 15_000 });

        await expect(list.locator('img')).toHaveCount(0);
        await expect(list.locator('.flag-type-badge')).toHaveText(markup);
        await expect(list.locator('.flag-status-badge')).toHaveText(markup);
        await expect(list).toContainText(`${markup} mode`);
        await expect(list.locator('.context-tag').first()).toHaveText(markup);
        for (const selector of ['.flag-type-badge', '.flag-status-badge']) {
            expect(await list.locator(selector).evaluate((el) => el.getAttributeNames())).toEqual(['class']);
        }
        expect(await page.evaluate(() => /** @type {any} */ (window).__flagMarkupRan)).toBeUndefined();
    });

    test('shows a missing-course error before calling the flags endpoint', async ({ page }) => {
        const { flagRequests } = await installStudentFlaggedRoutes(page, {
            selectedCourseId: null,
            selectedCourseName: null,
            flags: [flag()],
        });

        await page.goto('/student/flagged');

        await expect(page.locator('#empty-state')).toBeVisible({ timeout: 15_000 });
        await expect(page.locator('#empty-state')).toHaveText('Please select a course to view your flags.');
        expect(flagRequests).toHaveLength(0);
    });

    test('shows a load error when /api/flags/my fails or returns unsuccessful JSON', async ({ page }) => {
        const { flagRequests } = await installStudentFlaggedRoutes(page, {
            flagResponses: [
                { status: 500, body: { success: false, message: 'forced server error' } },
                { status: 200, body: { success: false } },
            ],
        });

        await page.goto('/student/flagged');

        await expect(page.locator('#empty-state')).toBeVisible({ timeout: 15_000 });
        await expect(page.locator('#empty-state')).toHaveText('Unable to load your flags. Please try again.');

        await page.locator('#refresh-flags').click();
        await expect.poll(() => flagRequests.length).toBe(2);
        await expect(page.locator('#empty-state')).toHaveText('Unable to load your flags. Please try again.');
    });

    test('stops on banned enrollment and hides the flagged content controls', async ({ page }) => {
        const { flagRequests } = await installStudentFlaggedRoutes(page, {
            enrollmentBody: {
                success: true,
                data: { enrolled: true, status: 'banned' },
            },
            flags: [flag()],
        });

        await page.goto('/student/flagged');

        await expect(page.getByRole('heading', { name: 'Access disabled' })).toBeVisible({ timeout: 15_000 });
        await expect(page.locator('.filter-controls')).toBeHidden();
        await expect(page.locator('.flagged-content-container')).toBeHidden();
        expect(flagRequests).toHaveLength(0);
    });

    test('continues loading flags when the enrollment preflight fails', async ({ page }) => {
        await installStudentFlaggedRoutes(page, {
            enrollmentAbort: true,
            flags: [
                flag({
                    flagId: 'flag_after_enrollment_error',
                    flagDescription: 'Enrollment preflight failed but flags still loaded.',
                }),
            ],
        });

        await page.goto('/student/flagged');

        await expect(page.locator('#flagged-list')).toContainText(
            'Enrollment preflight failed but flags still loaded.',
            { timeout: 15_000 }
        );
    });
});
