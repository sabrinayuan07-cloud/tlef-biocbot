// @ts-check
/**
 * Focused browser coverage for public/instructor/scripts/flagged.js.
 *
 * Drives the flagged-content page through every branch of its loaders,
 * filters, render helpers, moderation flows, and the mental-health-flag
 * section. Uses page.route to mock the API surface so we can deterministically
 * exercise error paths, admin-vs-non-admin behavior, and TA permission gating.
 *
 * The existing tests/e2e/flagging.spec.js covers the API contracts and the
 * end-to-end DB-backed flows. This spec is browser-only and concentrates on
 * client-side branch coverage.
 */

const { test, expect } = require('./fixtures/monocart');
const fs = require('fs');
const path = require('path');
const { storageStatePath, TEST_USERS } = require('./helpers/users');

const COURSE_ID = 'COVERAGE-FLAGGED';
const COURSE_ID_ALT = 'COVERAGE-FLAGGED-ALT';
const INSTRUCTOR_ID = 'cov_inst_id';
const TA_ID = 'cov_ta_id';
const STUDENT_ID = 'cov_student_id';
const FLAGGED_HTML = fs.readFileSync(path.join(__dirname, '../../public/instructor/flagged.html'), 'utf8');

/**
 * @typedef {{
 *   flagId: string,
 *   flagReason?: string,
 *   flagStatus?: string,
 *   priority?: string,
 *   instructorResponse?: string | null,
 *   instructorName?: string | null,
 *   createdAt?: string,
 *   updatedAt?: string,
 *   botMode?: string | null,
 *   studentName?: string,
 *   flagDescription?: string,
 *   questionContent?: Record<string, any>,
 *   unitName?: string,
 * }} FlagShape
 */

/**
 * @param {Partial<FlagShape>} overrides
 * @returns {FlagShape}
 */
function buildFlag(overrides = {}) {
    return {
        flagId: 'flag_default',
        flagReason: 'unclear',
        flagStatus: 'pending',
        priority: 'medium',
        instructorResponse: null,
        instructorName: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        botMode: 'tutor',
        studentName: 'Cov Student',
        flagDescription: 'I do not understand this question.',
        unitName: 'Unit 1',
        questionContent: {
            question: 'What does ATP stand for?',
            questionType: 'short-answer',
        },
        ...overrides,
    };
}

/**
 * @typedef {{
 *   flagId: string,
 *   message?: string,
 *   concernLevel?: string,
 *   status?: string,
 *   createdAt?: string,
 *   llmReason?: string,
 *   studentName?: string,
 *   studentId?: string,
 *   conversationContext?: Array<{ role: string, content: string }>,
 *   unitName?: string,
 *   courseId?: string,
 * }} MHFlag
 */

/**
 * @param {Partial<MHFlag>} overrides
 * @returns {MHFlag}
 */
function buildMHFlag(overrides = {}) {
    return {
        flagId: 'mhf_default',
        message: 'I feel overwhelmed.',
        concernLevel: 'low concern',
        status: 'pending',
        createdAt: new Date().toISOString(),
        llmReason: 'Student expressed feeling overwhelmed.',
        studentName: 'Anonymous Student',
        unitName: 'Unit 1',
        courseId: COURSE_ID,
        conversationContext: [
            { role: 'user', content: 'I feel overwhelmed.' },
            { role: 'assistant', content: 'I am here to listen.' },
        ],
        ...overrides,
    };
}

/**
 * Install a fully-mocked API surface so the flagged page can render whatever
 * scenario the test wants without touching MongoDB. Returns captured request
 * payloads so individual tests can assert on what the page sent.
 *
 * @param {import('@playwright/test').Page} page
 * @param {{
 *   role?: 'instructor' | 'ta',
 *   systemAdmin?: boolean,
 *   userId?: string,
 *   courseId?: string | null,
 *   courses?: Array<Record<string, any>>,
 *   instructorCoursesEndpointStatus?: number,
 *   permissions?: Record<string, { materials?: boolean, questions?: boolean, flags?: boolean, roster?: boolean, transcripts?: boolean, settings?: boolean }>,
 *   flags?: FlagShape[],
 *   flagsByCourse?: Record<string, FlagShape[]>,
 *   flagsStatus?: number,
 *   stats?: Record<string, number>,
 *   statsByCourse?: Record<string, Record<string, number>>,
 *   statsStatus?: number,
 *   mhFlags?: MHFlag[],
 *   mhIsAdmin?: boolean,
 *   mhSuccess?: boolean,
 *   mhActionStatus?: number,
 *   mhActionSuccess?: boolean,
 *   responseStatus?: number,
 *   responseSuccess?: boolean,
 *   statusUpdateStatus?: number,
 *   statusUpdateSuccess?: boolean,
 * }} [options]
 */
async function installFlaggedRoutes(page, options = {}) {
    const role = options.role ?? 'instructor';
    const userId = options.userId ?? (role === 'ta' ? TA_ID : INSTRUCTOR_ID);
    const courseId = options.courseId !== undefined ? options.courseId : COURSE_ID;
    const courses = options.courses ?? (courseId ? [{ courseId, courseName: 'Cov Course' }] : []);

    if (role === 'ta') {
        await page.route(/\/instructor\/flagged(?:\?.*)?$/, async (route) => {
            await route.fulfill({ contentType: 'text/html', body: FLAGGED_HTML });
        });
    }

    /**
     * @type {{
     *   responsePayloads: Array<{ flagId: string, body: Record<string, any> }>,
     *   statusPayloads: Array<{ flagId: string, body: Record<string, any> }>,
     *   deletes: string[],
     *   mhActions: Array<{ flagId: string, action: string }>,
     * }}
     */
    const captured = {
        responsePayloads: [],
        statusPayloads: [],
        deletes: [],
        mhActions: [],
    };

    await page.route('**/api/**', async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        const pathname = url.pathname;
        const method = request.method();

        if (pathname === '/api/auth/me') {
            await route.fulfill({
                json: {
                    success: true,
                    user: {
                        userId,
                        username: role === 'ta' ? TEST_USERS.ta.username : TEST_USERS.instructor.username,
                        displayName: role === 'ta' ? TEST_USERS.ta.displayName : 'Cov Instructor',
                        role,
                        permissions: { systemAdmin: !!options.systemAdmin },
                    },
                },
            });
            return;
        }

        if (pathname === '/api/settings/llm-tag') {
            await route.fulfill({ json: { success: true, llmIndex: 0, reasoningIndex: 0 } });
            return;
        }

        if (pathname === `/api/courses/ta/${userId}`) {
            await route.fulfill({ json: { success: true, data: courses } });
            return;
        }

        if (pathname === `/api/onboarding/instructor/${userId}`) {
            if (options.instructorCoursesEndpointStatus && options.instructorCoursesEndpointStatus !== 200) {
                await route.fulfill({
                    status: options.instructorCoursesEndpointStatus,
                    json: { success: false, message: 'forced error' },
                });
                return;
            }
            await route.fulfill({ json: { success: true, data: { courses } } });
            return;
        }

        const permMatch = pathname.match(/^\/api\/courses\/([^/]+)\/ta-permissions\//);
        if (permMatch) {
            const id = permMatch[1];
            const perms = options.permissions?.[id];
            if (!perms) {
                await route.fulfill({ status: 404, json: { success: false, message: 'no perms' } });
                return;
            }
            await route.fulfill({ json: { success: true, data: { permissions: perms } } });
            return;
        }

        const flagsCourseMatch = pathname.match(/^\/api\/flags\/course\/([^/]+)$/);
        if (flagsCourseMatch) {
            if (options.flagsStatus && options.flagsStatus !== 200) {
                await route.fulfill({ status: options.flagsStatus, json: { success: false, message: 'forced flags error' } });
                return;
            }
            const id = decodeURIComponent(flagsCourseMatch[1]);
            const flags = options.flagsByCourse?.[id] ?? options.flags ?? [];
            await route.fulfill({ json: { success: true, data: { courseId: id, flags } } });
            return;
        }

        const flagStatsMatch = pathname.match(/^\/api\/flags\/stats\/([^/]+)$/);
        if (flagStatsMatch) {
            if (options.statsStatus && options.statsStatus !== 200) {
                await route.fulfill({ status: options.statsStatus, json: { success: false, message: 'forced stats error' } });
                return;
            }
            const id = decodeURIComponent(flagStatsMatch[1]);
            const stats = options.statsByCourse?.[id] ?? options.stats ?? { total: 0, pending: 0, resolved: 0, dismissed: 0 };
            await route.fulfill({ json: { success: true, data: { statistics: stats } } });
            return;
        }

        const flagResponseMatch = pathname.match(/^\/api\/flags\/([^/]+)\/response$/);
        if (flagResponseMatch && method === 'PUT') {
            captured.responsePayloads.push({ flagId: flagResponseMatch[1], body: request.postDataJSON() });
            if (options.responseStatus && options.responseStatus !== 200) {
                await route.fulfill({ status: options.responseStatus, json: { success: false, message: 'forced response err' } });
                return;
            }
            await route.fulfill({ json: { success: options.responseSuccess !== false, message: 'ok' } });
            return;
        }

        const flagStatusMatch = pathname.match(/^\/api\/flags\/([^/]+)\/status$/);
        if (flagStatusMatch && method === 'PUT') {
            captured.statusPayloads.push({ flagId: flagStatusMatch[1], body: request.postDataJSON() });
            if (options.statusUpdateStatus && options.statusUpdateStatus !== 200) {
                await route.fulfill({ status: options.statusUpdateStatus, json: { success: false, message: 'forced status err' } });
                return;
            }
            await route.fulfill({ json: { success: options.statusUpdateSuccess !== false, message: 'ok' } });
            return;
        }

        const mhCourseMatch = pathname.match(/^\/api\/mental-health-flags\/course\/([^/]+)$/);
        if (mhCourseMatch) {
            await route.fulfill({
                json: {
                    success: options.mhSuccess !== false,
                    isAdmin: !!options.mhIsAdmin,
                    flags: options.mhFlags ?? [],
                    stats: { pending: 0 },
                },
            });
            return;
        }

        const mhActionMatch = pathname.match(/^\/api\/mental-health-flags\/([^/]+)\/(escalate|dismiss|resolve|disregard)$/);
        if (mhActionMatch && method === 'PUT') {
            captured.mhActions.push({ flagId: mhActionMatch[1], action: mhActionMatch[2] });
            if (options.mhActionStatus && options.mhActionStatus !== 200) {
                await route.fulfill({ status: options.mhActionStatus, json: { success: false, message: 'forced mh err' } });
                return;
            }
            await route.fulfill({ json: { success: options.mhActionSuccess !== false, message: 'ok' } });
            return;
        }

        if (pathname === '/api/quiz/status') {
            await route.fulfill({ json: { success: true, enabled: false } });
            return;
        }

        await route.fallback();
    });

    return captured;
}

// ---------------------------------------------------------------------------
// Instructor branches
// ---------------------------------------------------------------------------

test.describe('flagged.js — instructor render & moderation', () => {
    test.use({ storageState: storageStatePath('instructor') });

    test('renders multiple flag cards (reasons, priorities, resolved response, status text) and updates stats', async ({ page }) => {
        const now = new Date();
        const justNow = new Date(now.getTime() - 30_000).toISOString(); // "Just now"
        const minutesAgo = new Date(now.getTime() - 5 * 60_000).toISOString(); // "5 minutes ago"
        const hoursAgo = new Date(now.getTime() - 3 * 3_600_000).toISOString(); // "3 hours ago"
        const daysAgo = new Date(now.getTime() - 2 * 86_400_000).toISOString(); // "2 days ago"
        const weeksAgo = new Date(now.getTime() - 14 * 86_400_000).toISOString(); // ISO locale date

        await installFlaggedRoutes(page, {
            flags: [
                buildFlag({
                    flagId: 'flag_incorrect',
                    flagReason: 'incorrect',
                    priority: 'high',
                    botMode: 'protege',
                    createdAt: justNow,
                }),
                buildFlag({
                    flagId: 'flag_unclear',
                    flagReason: 'unclear',
                    createdAt: minutesAgo,
                }),
                buildFlag({
                    flagId: 'flag_resolved',
                    flagReason: 'typo',
                    flagStatus: 'resolved',
                    instructorResponse: 'Fixed the answer key.',
                    instructorName: 'Cov Instructor',
                    createdAt: hoursAgo,
                    updatedAt: hoursAgo,
                }),
                buildFlag({
                    flagId: 'flag_dismissed',
                    flagReason: 'offensive',
                    flagStatus: 'dismissed',
                    createdAt: daysAgo,
                }),
                buildFlag({
                    flagId: 'flag_reviewed',
                    flagReason: 'irrelevant',
                    flagStatus: 'reviewed',
                    botMode: null,
                    createdAt: weeksAgo,
                    questionContent: { question: 'Older question', questionType: 'multiple-choice' },
                }),
                // status: 'all' option to be selected later — seed one extra
                buildFlag({
                    flagId: 'flag_confusing',
                    flagReason: 'confusing',
                    createdAt: justNow,
                }),
                buildFlag({
                    flagId: 'flag_inappropriate',
                    flagReason: 'inappropriate',
                    priority: 'high',
                    createdAt: justNow,
                }),
            ],
            stats: { total: 7, pending: 4, resolved: 1, dismissed: 1, reviewed: 1 },
        });

        await page.goto(`/instructor/flagged?courseId=${COURSE_ID}`);

        // Filter default is "pending", so only the 4 pending cards render.
        const list = page.locator('#flagged-list');
        await expect(list.locator('.flag-card')).toHaveCount(4, { timeout: 15_000 });
        await expect(list).toContainText('Incorrect');
        await expect(list).toContainText('priority: high');
        await expect(list).toContainText('Protégé mode'); // protege display
        await expect(list).toContainText('Tutor mode'); // default tutor

        // Stats counters wired through updateStatsDisplay.
        await expect(page.locator('#total-flags')).toHaveText('7');
        await expect(page.locator('#pending-flags')).toHaveText('4');

        // Switch to "all" status to see resolved/dismissed/reviewed branches.
        await page.locator('#status-filter').selectOption('all');
        await expect(list.locator('.flag-card')).toHaveCount(7);
        await expect(list).toContainText('Resolved');
        await expect(list).toContainText('Fixed the answer key.');
        await expect(list).toContainText('Instructor Response');
        await expect(list).toContainText('Dismissed');
        await expect(list).toContainText('Reviewed');
        await expect(list).toContainText('Unknown mode'); // botMode === null branch

        // Reason filter narrows to one card.
        await page.locator('#flag-type-filter').selectOption('typo');
        await expect(list.locator('.flag-card')).toHaveCount(1);
        await expect(list.locator('.flag-card')).toContainText('Typo/Error');

        // Empty filter combo to show the empty state.
        await page.locator('#status-filter').selectOption('pending');
        await page.locator('#flag-type-filter').selectOption('typo');
        await expect(page.locator('#empty-state')).toBeVisible();
        await expect(list.locator('.flag-card')).toHaveCount(0);
    });

    test('approve flow: open form, send approve, payload contains response + resolved status', async ({ page }) => {
        const captured = await installFlaggedRoutes(page, {
            flags: [buildFlag({ flagId: 'flag_approve', flagDescription: 'Need a reply.' })],
            stats: { total: 1, pending: 1 },
        });

        await page.goto(`/instructor/flagged?courseId=${COURSE_ID}`);

        const card = page.locator('[data-flag-id="flag_approve"]');
        await expect(card).toBeVisible({ timeout: 15_000 });

        // showApprovalForm — form becomes visible, buttons hidden.
        await card.locator('.approve-btn').click();
        await expect(page.locator('#approval-form-flag_approve')).toBeVisible();
        await expect(card.locator('.approve-btn')).toBeHidden();
        await expect(card.locator('.dismiss-btn')).toBeHidden();

        // Cancel — hideApprovalForm restores buttons.
        await card.locator('.cancel-btn').click();
        await expect(page.locator('#approval-form-flag_approve')).toBeHidden();
        await expect(card.locator('.approve-btn')).toBeVisible();

        // Re-open and send a message.
        await card.locator('.approve-btn').click();
        await page.locator('#message-content-flag_approve').fill('Thanks — fixed.');
        await card.locator('.send-approve-btn').click();

        await expect(card).toHaveCount(0, { timeout: 10_000 });
        expect(captured.responsePayloads).toHaveLength(1);
        expect(captured.responsePayloads[0].flagId).toBe('flag_approve');
        expect(captured.responsePayloads[0].body).toMatchObject({
            response: 'Thanks — fixed.',
            flagStatus: 'resolved',
        });
    });

    test('regular course flags show course name and student follow-up copy', async ({ page }) => {
        await installFlaggedRoutes(page, {
            flags: [
                buildFlag({
                    flagId: 'flag_course_name_student',
                    courseName: 'BIOC 404 Advanced Biochemistry',
                    reporterRole: 'student',
                    reporterName: 'Cov Student',
                }),
            ],
            stats: { total: 1, pending: 1 },
        });

        await page.goto(`/instructor/flagged?courseId=${COURSE_ID}`);

        const card = page.locator('[data-flag-id="flag_course_name_student"]');
        await expect(card).toBeVisible({ timeout: 15_000 });
        await expect(card).toContainText('Course: BIOC 404 Advanced Biochemistry');
        await expect(card).toContainText('Reporter: Student');
        await expect(card).toContainText("Student's Concern");

        await card.locator('.approve-btn').click();
        const form = page.locator('#approval-form-flag_course_name_student');
        await expect(form).toBeVisible();
        await expect(form).toContainText('Send Follow-up to Student');
        await expect(form).toContainText('This message will be sent to the student who flagged this content.');
        await expect(page.locator('#message-content-flag_course_name_student')).toContainText('office hours');
    });

    test('super course instructor flags show source breadcrumbs and instructor follow-up copy', async ({ page }) => {
        await installFlaggedRoutes(page, {
            systemAdmin: true,
            flagsByCourse: {
                [COURSE_ID]: [],
                SUPER_COURSE: [
                    buildFlag({
                        flagId: 'flag_super_instructor',
                        courseId: 'SUPER_COURSE',
                        courseName: 'Super Course',
                        unitName: 'Super Course',
                        botMode: 'supercourse-instructor',
                        reporterRole: 'instructor',
                        reporterName: 'Cov Instructor',
                        studentName: 'Cov Instructor',
                        flagDescription: 'Instructor flagged Super Course response as typo',
                        isSuperCourseFlag: true,
                        sourceCourseIds: ['BIOC404-1759893662591', 'BIOC202-1759632732297'],
                        sourceCourseNames: ['BIOC404', 'BIOC202'],
                        questionContent: {
                            question: 'Super Course answer text',
                            questionType: 'super-course-bot-response',
                        },
                    }),
                ],
            },
            statsByCourse: {
                [COURSE_ID]: { total: 0, pending: 0, resolved: 0, dismissed: 0 },
                SUPER_COURSE: { total: 1, pending: 1, resolved: 0, dismissed: 0 },
            },
        });

        await page.goto(`/instructor/flagged?courseId=${COURSE_ID}`);

        const card = page.locator('[data-flag-id="flag_super_instructor"]');
        await expect(card).toBeVisible({ timeout: 15_000 });
        // Super-course flags are labelled by their bucket. This flag has no
        // superchatId, so it falls back to the "all buckets" label.
        await expect(card).toContainText('Bucket: Super Course (all)');
        await expect(card).toContainText('Super Course Instructor mode');
        await expect(card).toContainText('Reporter: Instructor');
        await expect(card).toContainText("Instructor's Concern");
        await expect(card.locator('.source-breadcrumb-row')).toContainText('BIOC404');
        await expect(card.locator('.source-breadcrumb-row')).toContainText('BIOC404-1759893662591');
        await expect(card.locator('.source-breadcrumb-row')).toContainText('BIOC202');

        await card.locator('.approve-btn').click();
        const form = page.locator('#approval-form-flag_super_instructor');
        await expect(form).toBeVisible();
        await expect(form).toContainText('Send Follow-up to Instructor');
        await expect(form).toContainText('This message will be sent to the instructor who flagged this content.');
        await expect(page.locator('#message-content-flag_super_instructor')).toHaveValue(
            'Thanks for flagging this. This Super Course response has been reviewed and marked as resolved.'
        );
        await expect(form).not.toContainText('student who flagged');
    });

    test('approve flow guard: empty message triggers alert and does not send a response', async ({ page }) => {
        const captured = await installFlaggedRoutes(page, {
            flags: [buildFlag({ flagId: 'flag_empty' })],
        });

        page.on('dialog', (dialog) => { dialog.dismiss(); });

        await page.goto(`/instructor/flagged?courseId=${COURSE_ID}`);
        const card = page.locator('[data-flag-id="flag_empty"]');
        await expect(card).toBeVisible({ timeout: 15_000 });

        await card.locator('.approve-btn').click();
        await page.locator('#message-content-flag_empty').fill('   ');
        await card.locator('.send-approve-btn').click();

        // No request fired; card still pending.
        await page.waitForTimeout(300);
        expect(captured.responsePayloads).toHaveLength(0);
        await expect(card).toBeVisible();
    });

    test('approve flow error path: failing response re-enables the buttons and shows an alert', async ({ page }) => {
        let alertSeen = false;
        page.on('dialog', (dialog) => {
            alertSeen = true;
            dialog.dismiss();
        });

        await installFlaggedRoutes(page, {
            flags: [buildFlag({ flagId: 'flag_err' })],
            responseStatus: 500,
        });

        await page.goto(`/instructor/flagged?courseId=${COURSE_ID}`);
        const card = page.locator('[data-flag-id="flag_err"]');
        await expect(card).toBeVisible({ timeout: 15_000 });

        await card.locator('.approve-btn').click();
        await page.locator('#message-content-flag_err').fill('Will fail.');
        await card.locator('.send-approve-btn').click();

        // Send button should return to its normal state after the failure.
        await expect(card.locator('.send-approve-btn')).toHaveText('Send & Approve', { timeout: 10_000 });
        await expect(card.locator('.send-approve-btn')).toBeEnabled();
        expect(alertSeen).toBe(true);
    });

    test('dismiss flow: status payload uses dismissed, card disappears from pending filter', async ({ page }) => {
        const captured = await installFlaggedRoutes(page, {
            flags: [buildFlag({ flagId: 'flag_dismiss' })],
        });

        await page.goto(`/instructor/flagged?courseId=${COURSE_ID}`);
        const card = page.locator('[data-flag-id="flag_dismiss"]');
        await expect(card).toBeVisible({ timeout: 15_000 });

        await card.locator('.dismiss-btn').click();
        await expect(card).toHaveCount(0, { timeout: 10_000 });

        expect(captured.statusPayloads).toHaveLength(1);
        expect(captured.statusPayloads[0].body).toMatchObject({ status: 'dismissed' });
    });

    test('dismiss flow error path: re-enables buttons on API failure', async ({ page }) => {
        let alertSeen = false;
        page.on('dialog', (dialog) => { alertSeen = true; dialog.dismiss(); });

        await installFlaggedRoutes(page, {
            flags: [buildFlag({ flagId: 'flag_dismiss_err' })],
            statusUpdateStatus: 500,
        });

        await page.goto(`/instructor/flagged?courseId=${COURSE_ID}`);
        const card = page.locator('[data-flag-id="flag_dismiss_err"]');
        await expect(card).toBeVisible({ timeout: 15_000 });
        await card.locator('.dismiss-btn').click();

        await expect(card.locator('.dismiss-btn')).toBeEnabled({ timeout: 10_000 });
        expect(alertSeen).toBe(true);
    });

    test('refresh button rebuilds the list and updates label states', async ({ page }) => {
        await installFlaggedRoutes(page, {
            flags: [buildFlag({ flagId: 'flag_refresh' })],
        });

        await page.goto(`/instructor/flagged?courseId=${COURSE_ID}`);
        await expect(page.locator('[data-flag-id="flag_refresh"]')).toBeVisible({ timeout: 15_000 });

        const refresh = page.locator('#refresh-flags');
        await refresh.click();
        // The button briefly says "Refreshing..." but races; allow either.
        await expect(refresh).toHaveText('Refresh', { timeout: 10_000 });
        await expect(refresh).toBeEnabled();
        await expect(page.locator('[data-flag-id="flag_refresh"]')).toBeVisible();
    });

    test('error state path: failing /api/flags/course renders the in-list error message', async ({ page }) => {
        await installFlaggedRoutes(page, { flagsStatus: 500 });

        await page.goto(`/instructor/flagged?courseId=${COURSE_ID}`);

        // showErrorState writes the message into #empty-state.
        await expect(page.locator('#empty-state')).toContainText('Failed to load flagged content', {
            timeout: 15_000,
        });
    });

    test('redirect-on-missing-course path: API returns no courses, page shows notification and navigates to onboarding', async ({ page }) => {
        await installFlaggedRoutes(page, { courses: [], courseId: null });
        // Catch the redirect navigation so we don't fall into the dev server.
        await page.route('**/instructor/onboarding*', async (route) => {
            await route.fulfill({ contentType: 'text/html', body: '<html><body>stub-onboarding</body></html>' });
        });

        await page.goto('/instructor/flagged');

        // Should display the redirect notification.
        await expect(page.locator('.notification.notification-error').filter({ hasText: 'No course found' })).toBeVisible({
            timeout: 15_000,
        });

        // setTimeout 2s before navigating — wait for the redirect.
        await page.waitForURL('**/instructor/onboarding', { timeout: 8_000 });
    });
});

// ---------------------------------------------------------------------------
// Mental health flag branches
// ---------------------------------------------------------------------------

test.describe('flagged.js — mental health flags', () => {
    test.use({ storageState: storageStatePath('instructor') });

    test('non-admin instructor sees anonymized cards, escalates one, and the conversation context toggles', async ({ page }) => {
        const captured = await installFlaggedRoutes(page, {
            mhFlags: [
                buildMHFlag({
                    flagId: 'mhf_low',
                    concernLevel: 'low concern',
                    message: 'Stressed about midterm.',
                }),
                buildMHFlag({
                    flagId: 'mhf_high',
                    concernLevel: 'high concern',
                    message: 'I feel hopeless.',
                }),
                buildMHFlag({
                    flagId: 'mhf_minimal',
                    message: '',
                    llmReason: '',
                    conversationContext: [],
                }),
            ],
            mhIsAdmin: false,
        });

        await page.goto(`/instructor/flagged?courseId=${COURSE_ID}`);

        const list = page.locator('#mh-flags-list');
        await expect(list.locator('.mh-flag-card')).toHaveCount(3, { timeout: 15_000 });
        await expect(list).toContainText('High Concern');
        await expect(list).toContainText('Low Concern');
        await expect(list).toContainText('I feel hopeless.');

        // Anonymized — no student-info row.
        await expect(list.locator('.mh-flag-student-info')).toHaveCount(0);

        // Total badge sums pending+escalated.
        await expect(page.locator('#mh-total-count')).toHaveText('3');

        // Conversation context toggle hides/shows.
        const ctxBtn = list.locator('[data-mh-flag-id="mhf_high"] .mh-flag-context-toggle');
        await expect(ctxBtn).toHaveText('Show conversation context');
        await ctxBtn.click();
        await expect(list.locator('#mh-ctx-mhf_high')).toBeVisible();
        await expect(ctxBtn).toHaveText('Hide conversation context');
        await ctxBtn.click();
        await expect(list.locator('#mh-ctx-mhf_high')).toBeHidden();

        // Escalate the low-concern flag.
        await list.locator('[data-mh-flag-id="mhf_low"] .mh-escalate-btn').click();
        await expect.poll(() => captured.mhActions.length).toBeGreaterThanOrEqual(1);
        expect(captured.mhActions[0]).toMatchObject({ flagId: 'mhf_low', action: 'escalate' });

        // Switch to "all" filter to see every flag, including the minimal one.
        await page.locator('#mh-status-filter').selectOption('all');
        await expect(list.locator('.mh-flag-card')).toHaveCount(3);
    });

    test('non-admin instructor dismiss path fires action and a refresh of the list', async ({ page }) => {
        const captured = await installFlaggedRoutes(page, {
            mhFlags: [buildMHFlag({ flagId: 'mhf_dismiss' })],
        });

        await page.goto(`/instructor/flagged?courseId=${COURSE_ID}`);
        const card = page.locator('[data-mh-flag-id="mhf_dismiss"]');
        await expect(card).toBeVisible({ timeout: 15_000 });
        await card.locator('.mh-dismiss-btn').click();

        await expect.poll(() => captured.mhActions.length).toBeGreaterThanOrEqual(1);
        expect(captured.mhActions[0]).toMatchObject({ action: 'dismiss' });
    });

    test('mh action error path surfaces the alert via showErrorMessage', async ({ page }) => {
        let alertSeen = false;
        page.on('dialog', (dialog) => { alertSeen = true; dialog.dismiss(); });

        await installFlaggedRoutes(page, {
            mhFlags: [buildMHFlag({ flagId: 'mhf_action_err' })],
            mhActionStatus: 500,
        });

        await page.goto(`/instructor/flagged?courseId=${COURSE_ID}`);
        const card = page.locator('[data-mh-flag-id="mhf_action_err"]');
        await expect(card).toBeVisible({ timeout: 15_000 });
        await card.locator('.mh-escalate-btn').click();

        await expect.poll(() => alertSeen).toBe(true);
    });

    test('admin defaults to the escalated filter on first load and exposes resolve/disregard controls', async ({ page }) => {
        const captured = await installFlaggedRoutes(page, {
            systemAdmin: true,
            mhIsAdmin: true,
            mhFlags: [
                buildMHFlag({
                    flagId: 'mhf_admin_pending',
                    status: 'pending',
                    studentName: 'Real Student Name',
                    studentId: STUDENT_ID,
                }),
                buildMHFlag({
                    flagId: 'mhf_admin_escalated',
                    status: 'escalated',
                    studentName: 'Real Student Name',
                    studentId: STUDENT_ID,
                    concernLevel: 'high concern',
                }),
                buildMHFlag({
                    flagId: 'mhf_admin_resolved',
                    status: 'resolved',
                }),
            ],
        });

        await page.goto(`/instructor/flagged?courseId=${COURSE_ID}`);

        // Status filter initialised to "escalated" for admin.
        await expect(page.locator('#mh-status-filter')).toHaveValue('escalated', { timeout: 15_000 });

        const list = page.locator('#mh-flags-list');
        await expect(list.locator('.mh-flag-card')).toHaveCount(1);
        await expect(list.locator('.mh-flag-student-info')).toContainText('Real Student Name');

        const card = list.locator('[data-mh-flag-id="mhf_admin_escalated"]');
        await expect(card.locator('.mh-resolve-btn')).toBeVisible();
        await expect(card.locator('.mh-disregard-btn')).toBeVisible();
        await card.locator('.mh-resolve-btn').click();
        await expect.poll(() => captured.mhActions.length).toBeGreaterThanOrEqual(1);
        expect(captured.mhActions[0]).toMatchObject({ flagId: 'mhf_admin_escalated', action: 'resolve' });

        // Resolved-status flag should show only a status note in its footer.
        await page.locator('#mh-status-filter').selectOption('resolved');
        await expect(list.locator('[data-mh-flag-id="mhf_admin_resolved"]')).toContainText('Status: resolved');
    });

    test('mh refresh button reloads the section', async ({ page }) => {
        await installFlaggedRoutes(page, {
            mhFlags: [buildMHFlag({ flagId: 'mhf_refresh' })],
        });

        await page.goto(`/instructor/flagged?courseId=${COURSE_ID}`);
        await expect(page.locator('[data-mh-flag-id="mhf_refresh"]')).toBeVisible({ timeout: 15_000 });
        await page.locator('#refresh-mh-flags').click();
        await expect(page.locator('[data-mh-flag-id="mhf_refresh"]')).toBeVisible();
    });

    test('mh section renders empty state when there are no flags', async ({ page }) => {
        await installFlaggedRoutes(page, { mhFlags: [] });

        await page.goto(`/instructor/flagged?courseId=${COURSE_ID}`);
        await expect(page.locator('#mh-empty')).toBeVisible({ timeout: 15_000 });
        await expect(page.locator('#mh-flags-list .mh-flag-card')).toHaveCount(0);
    });
});

// ---------------------------------------------------------------------------
// TA branches on the same page
// ---------------------------------------------------------------------------

test.describe('flagged.js — TA sidebar wiring and navigation', () => {
    test.use({ storageState: storageStatePath('ta') });

    test('TA sees TA nav rows, instructor rows are hidden, and "My Courses" link navigates when permitted', async ({ page, context }) => {
        await context.addInitScript((id) => {
            try { localStorage.setItem('selectedCourseId', id); } catch (e) { /* noop */ }
        }, COURSE_ID);

        await installFlaggedRoutes(page, {
            role: 'ta',
            userId: TA_ID,
            permissions: {
                [COURSE_ID]: { materials: true, questions: true, settings: true, transcripts: true, flags: true, roster: true },
            },
            flags: [],
        });

        await page.route('**/instructor/documents*', async (route) => {
            await route.fulfill({ contentType: 'text/html', body: '<html><body>stub-docs</body></html>' });
        });

        await page.goto(`/instructor/flagged?courseId=${COURSE_ID}`);

        await expect(page.locator('#ta-courses-nav')).toBeVisible({ timeout: 15_000 });
        await expect(page.locator('#ta-support-nav')).toBeVisible();
        await expect(page.locator('#instructor-home-nav')).toBeHidden();
        await expect(page.locator('#user-role')).toHaveText('Teaching Assistant');

        await Promise.all([
            page.waitForURL(/\/instructor\/documents\?courseId=/, { timeout: 10_000 }),
            page.locator('#ta-my-courses-link').click(),
        ]);
        expect(page.url()).toContain(`courseId=${COURSE_ID}`);
    });

    test('TA cannot navigate when the selected course denies that feature — shows a notification and stays put', async ({ page, context }) => {
        await context.addInitScript((id) => {
            try { localStorage.setItem('selectedCourseId', id); } catch (e) { /* noop */ }
        }, COURSE_ID);

        await installFlaggedRoutes(page, {
            role: 'ta',
            userId: TA_ID,
            permissions: {
                [COURSE_ID]: { materials: false, questions: false, settings: false, transcripts: false, flags: true, roster: true },
            },
            flags: [],
        });

        await page.goto(`/instructor/flagged?courseId=${COURSE_ID}`);
        await expect(page.locator('#ta-my-courses-link')).toBeHidden({ timeout: 15_000 });
        // Force visibility for click (updateTANavigationBasedOnPermissions hides
        // the link otherwise — but the handler is still wired up).
        await page.evaluate(() => {
            const navItem = document.getElementById('ta-courses-nav');
            const link = document.getElementById('ta-my-courses-link');
            if (navItem) navItem.style.display = 'block';
            if (link) link.style.display = 'block';
        });

        const startUrl = page.url();
        await page.locator('#ta-my-courses-link').click();

        await expect(page.locator('.notification.notification-error').filter({ hasText: 'do not have permission' })).toBeVisible({
            timeout: 10_000,
        });
        expect(page.url()).toBe(startUrl);
    });

    test('TA with zero assigned courses gets a warning notification on navigation attempts', async ({ page }) => {
        await installFlaggedRoutes(page, {
            role: 'ta',
            userId: TA_ID,
            courses: [],
            courseId: null,
            permissions: {},
            flags: [],
        });

        // Block the onboarding redirect that fires when no course resolves.
        await page.route('**/instructor/onboarding*', async (route) => {
            await route.fulfill({ contentType: 'text/html', body: '<html><body>stub-onboarding</body></html>' });
        });

        await page.goto('/instructor/flagged');
        // Wait until auth + sidebar setup has run.
        await expect(page.locator('#user-role')).toHaveText('Teaching Assistant', { timeout: 15_000 });

        // Trigger checkTAPermissionsAndNavigate via the click handler. The link
        // is hidden — toggle display so the click reaches the JS handler.
        await page.evaluate(() => {
            const link = document.getElementById('ta-my-courses-link');
            if (link) link.style.display = 'block';
        });
        await page.locator('#ta-my-courses-link').click();

        await expect(page.locator('.notification.notification-warning').filter({ hasText: 'No courses assigned' })).toBeVisible({
            timeout: 10_000,
        });
    });
});

// ---------------------------------------------------------------------------
// Direct helper / utility-function coverage
// ---------------------------------------------------------------------------

test.describe('flagged.js — utility functions exposed on window', () => {
    test.use({ storageState: storageStatePath('instructor') });

    test('display helpers cover every reason / bot mode / status mapping', async ({ page }) => {
        await installFlaggedRoutes(page, { flags: [], stats: { total: 0, pending: 0 } });
        await page.goto(`/instructor/flagged?courseId=${COURSE_ID}`);
        await expect(page.locator('#refresh-flags')).toBeVisible({ timeout: 15_000 });

        const result = await page.evaluate(() => {
            const w = /** @type {any} */ (window);
            return {
                reasons: [
                    'incorrect', 'inappropriate', 'unclear', 'confusing',
                    'typo', 'offensive', 'irrelevant', 'mystery-reason',
                ].map((r) => [r, w.getFlagReasonDisplay(r)]),
                modes: [
                    w.getBotModeDisplay('protege'),
                    w.getBotModeDisplay('tutor'),
                    w.getBotModeDisplay('TUTOR'),
                    w.getBotModeDisplay(''),
                    w.getBotModeDisplay(null),
                    w.getBotModeDisplay('weird'),
                ],
                statuses: [
                    'pending', 'reviewed', 'resolved', 'dismissed', 'unknown-status',
                ].map((s) => [s, w.getStatusDisplayText(s)]),
                timestamps: [
                    w.formatTimestamp(null),
                    w.formatTimestamp(new Date().toISOString()),
                    w.formatTimestamp(new Date(Date.now() - 5 * 60_000).toISOString()),
                    w.formatTimestamp(new Date(Date.now() - 3 * 3_600_000).toISOString()),
                    w.formatTimestamp(new Date(Date.now() - 2 * 86_400_000).toISOString()),
                    w.formatTimestamp(new Date(Date.now() - 14 * 86_400_000).toISOString()),
                    w.formatTimestamp('not-a-real-date'),
                ],
                pdt: [
                    w.formatTimestampPDT(null),
                    w.formatTimestampPDT(new Date().toISOString()),
                    w.formatTimestampPDT('not-a-real-date'),
                ],
                escaped: w.escapeHtml('<script>alert(1)</script>'),
            };
        });

        expect(result.reasons).toEqual([
            ['incorrect', 'Incorrect'],
            ['inappropriate', 'Inappropriate'],
            ['unclear', 'Unclear'],
            ['confusing', 'Confusing'],
            ['typo', 'Typo/Error'],
            ['offensive', 'Offensive'],
            ['irrelevant', 'Irrelevant'],
            ['mystery-reason', 'mystery-reason'],
        ]);

        expect(result.modes).toEqual(['Protégé', 'Tutor', 'Tutor', 'Unknown', 'Unknown', 'weird']);
        expect(result.statuses).toEqual([
            ['pending', 'Pending Review'],
            ['reviewed', 'Reviewed'],
            ['resolved', 'Resolved'],
            ['dismissed', 'Dismissed'],
            ['unknown-status', 'unknown-status'],
        ]);

        expect(result.timestamps[0]).toBe('Unknown');
        expect(result.timestamps[1]).toBe('Just now');
        expect(result.timestamps[2]).toMatch(/minute/);
        expect(result.timestamps[3]).toMatch(/hour/);
        expect(result.timestamps[4]).toMatch(/day/);
        expect(result.timestamps[5]).toMatch(/\//); // toLocaleDateString
        expect(result.timestamps[6]).toBe('Invalid date');

        expect(result.pdt[0]).toBe('Unknown');
        expect(result.pdt[1]).toContain('PDT');
        // The PDT formatter throws on a bad date inside the try/catch fallback;
        // depending on platform it might either parse as Invalid Date or throw.
        expect(['Invalid date', 'Invalid Date PDT']).toContain(result.pdt[2]);

        expect(result.escaped).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
    });

    test('showSuccessMessage stacks toasts and showNotification supports each color variant', async ({ page }) => {
        await installFlaggedRoutes(page, { flags: [] });
        await page.goto(`/instructor/flagged?courseId=${COURSE_ID}`);
        await expect(page.locator('#refresh-flags')).toBeVisible({ timeout: 15_000 });

        await page.evaluate(() => {
            const w = /** @type {any} */ (window);
            w.showSuccessMessage('first');
            w.showSuccessMessage('second');
        });
        await expect(page.locator('.success-toast')).toHaveCount(2);

        await page.evaluate(() => {
            const w = /** @type {any} */ (window);
            w.showNotification('hello-info', 'info');
            w.showNotification('hello-success', 'success');
            w.showNotification('hello-warning', 'warning');
            w.showNotification('hello-error', 'error');
            w.showNotification('hello-default');
        });
        await expect(page.locator('.notification.notification-info').filter({ hasText: 'hello-info' })).toBeVisible();
        await expect(page.locator('.notification.notification-success').filter({ hasText: 'hello-success' })).toBeVisible();
        await expect(page.locator('.notification.notification-warning').filter({ hasText: 'hello-warning' })).toBeVisible();
        await expect(page.locator('.notification.notification-error').filter({ hasText: 'hello-error' })).toBeVisible();
        await expect(page.locator('.notification.notification-info').filter({ hasText: 'hello-default' })).toBeVisible();
    });
});
