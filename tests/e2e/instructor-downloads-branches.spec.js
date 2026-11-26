// @ts-check
/**
 * Branch-focused UI coverage for public/instructor/scripts/downloads.js.
 *
 * These tests load the real /instructor/downloads page and mock only the API
 * surface needed to keep branch forcing deterministic and independent from the
 * requireDownloadAdmin server gate.
 */

const fs = require('fs/promises');
const path = require('path');
const { test, expect } = require('./fixtures/monocart');
const { storageStatePath } = require('./helpers/users');

const COURSE_ID = 'BIOC-BRANCH-DOWNLOADS';
const COURSE_NAME = 'Branch Coverage Downloads';
const OBJECT_STUDENT_ID = 'branch_student_object';
const EMPTY_STUDENT_ID = 'branch_student_empty';
const FAILING_STUDENT_ID = 'branch_student_failing';
const PREVIEW_STUDENT_ID = 'branch_student_preview';
const DOWNLOAD_STUDENT_ID = 'branch_student_download';
const DOWNLOADS_HTML_PATH = path.join(__dirname, '../../public/instructor/downloads.html');

const adminUser = {
    userId: 'branch_instructor',
    username: 'branch_instructor',
    displayName: 'Branch Instructor',
    role: 'instructor',
    permissions: { systemAdmin: true },
    preferences: {},
};

function json(route, body, status = 200) {
    return route.fulfill({ status, json: body });
}

function notFound(route) {
    return json(route, { success: false, message: 'Unhandled mocked route' }, 404);
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {{
 *   authUser?: Record<string, unknown>,
 *   courses?: Record<string, { name: string }>,
 *   onboardingCourses?: Array<Record<string, unknown>>,
 *   studentsResult?: Record<string, unknown>,
 *   sessionsByStudent?: Record<string, Record<string, unknown>>,
 *   sessionDetailsById?: Record<string, Record<string, unknown>>,
 *   sessionListFailures?: Set<string>,
 *   sessionDetailFailures?: Set<string>,
 *   abortSessionLists?: Set<string>,
 *   abortSessionDetails?: Set<string>,
 * }} [options]
 */
async function mockDownloadsApi(page, options = {}) {
    const courses = options.courses || { [COURSE_ID]: { name: COURSE_NAME } };
    const authUser = options.authUser || adminUser;

    await page.route('**/instructor/downloads*', async (route) => {
        await route.fulfill({
            contentType: 'text/html',
            body: await fs.readFile(DOWNLOADS_HTML_PATH, 'utf8'),
        });
    });

    await page.route('**/api/**', async (route) => {
        const url = new URL(route.request().url());
        const path = url.pathname;

        if (path === '/api/settings/llm-tag') {
            return json(route, { success: true, llmIndex: 0, reasoningIndex: 0 });
        }

        if (path === '/api/auth/me') {
            return json(route, { success: true, user: authUser });
        }

        if (path.startsWith('/api/onboarding/instructor/')) {
            return json(route, {
                success: true,
                data: {
                    courses: options.onboardingCourses || [{ courseId: COURSE_ID }],
                },
            });
        }

        const courseMatch = path.match(/^\/api\/courses\/([^/]+)$/);
        if (courseMatch) {
            const courseId = decodeURIComponent(courseMatch[1]);
            const course = courses[courseId];
            if (!course) {
                return json(route, { success: false, message: 'course not found' }, 404);
            }
            return json(route, { success: true, data: { courseId, ...course } });
        }

        const sessionDetailMatch = path.match(/^\/api\/students\/([^/]+)\/([^/]+)\/sessions\/([^/]+)$/);
        if (sessionDetailMatch) {
            const sessionId = decodeURIComponent(sessionDetailMatch[3]);
            if (options.abortSessionDetails?.has(sessionId)) {
                return route.abort('failed');
            }
            if (options.sessionDetailFailures?.has(sessionId)) {
                return json(route, { success: false, message: 'forced session detail failure' }, 500);
            }
            const detail = options.sessionDetailsById?.[sessionId];
            if (!detail) {
                return json(route, { success: false, message: 'session not found' }, 404);
            }
            return json(route, detail);
        }

        const sessionListMatch = path.match(/^\/api\/students\/([^/]+)\/([^/]+)\/sessions$/);
        if (sessionListMatch) {
            const studentId = decodeURIComponent(sessionListMatch[2]);
            if (options.abortSessionLists?.has(studentId)) {
                return route.abort('failed');
            }
            if (options.sessionListFailures?.has(studentId)) {
                return json(route, { success: false, message: 'forced session list failure' }, 500);
            }
            return json(route, options.sessionsByStudent?.[studentId] || {
                success: true,
                data: { studentName: studentId, sessions: [] },
            });
        }

        const studentsMatch = path.match(/^\/api\/students\/([^/]+)$/);
        if (studentsMatch) {
            return json(route, options.studentsResult || {
                success: true,
                data: {
                    totalStudents: 1,
                    totalSessions: 0,
                    students: [],
                },
            });
        }

        return notFound(route);
    });
}

async function openDownloadsPage(page, courseId = COURSE_ID) {
    await page.goto(`/instructor/downloads?courseId=${courseId}`);
    await expect(page.locator('#course-title')).toHaveText(`${COURSE_NAME} - Download Chats`, {
        timeout: 15_000,
    });
}

async function readDownloadedText(download) {
    const downloadPath = await download.path();
    expect(downloadPath).toBeTruthy();
    return fs.readFile(downloadPath, 'utf8');
}

async function readDownloadedJson(download) {
    const downloadPath = await download.path();
    expect(downloadPath).toBeTruthy();
    return JSON.parse(await fs.readFile(downloadPath, 'utf8'));
}

test.describe('Instructor downloads page branch coverage', () => {
    test.use({ storageState: storageStatePath('instructor'), acceptDownloads: true });

    test('blocks non-admin instructors before loading download data', async ({ page }) => {
        await page.addInitScript(() => {
            const nativeSetTimeout = window.setTimeout;
            const testWindow = /** @type {any} */ (window);
            testWindow.setTimeout = (handler, timeout, ...args) => {
                if (timeout === 1500) {
                    return nativeSetTimeout(handler, 60_000, ...args);
                }
                return nativeSetTimeout(handler, timeout, ...args);
            };
        });
        await mockDownloadsApi(page, {
            authUser: {
                ...adminUser,
                permissions: {},
            },
        });
        await page.route('**/instructor/home*', (route) => route.fulfill({
            contentType: 'text/html',
            body: '<html><body>stub instructor home</body></html>',
        }));

        await page.goto(`/instructor/downloads?courseId=${COURSE_ID}`);

        await expect(page.locator('#error-state')).toBeVisible({ timeout: 5_000 });
        await expect(page.locator('#error-message')).toHaveText('Only admins can access student chat downloads.');
        await expect(page.locator('#students-container')).toBeHidden();
    });

    test('falls back to instructor courses when no course context exists and renders non-string names', async ({ page }) => {
        await page.addInitScript(() => {
            localStorage.removeItem('selectedCourseId');
        });
        await mockDownloadsApi(page, {
            studentsResult: {
                success: true,
                data: {
                    totalStudents: 2,
                    totalSessions: 1,
                    students: [
                        {
                            studentId: OBJECT_STUDENT_ID,
                            studentName: { displayName: 'Object Named Student' },
                            totalSessions: 0,
                        },
                        {
                            studentId: 'branch_student_named_fallback',
                            studentName: { name: 'Fallback Name Student' },
                            totalSessions: 1,
                        },
                    ],
                },
            },
        });

        await page.goto('/instructor/downloads');
        await expect(page.locator('#course-title')).toHaveText(`${COURSE_NAME} - Download Chats`, {
            timeout: 15_000,
        });
        await expect(page.locator('.student-card', { hasText: 'Object Named Student' })).toBeVisible();
        await expect(page.locator('.student-card', { hasText: 'Fallback Name Student' })).toContainText('1 saved chat');

        const cachedCourseIds = await page.evaluate(async () => {
            const testWindow = /** @type {any} */ (window);
            return [
                await testWindow.getCurrentCourseId(),
                await testWindow.getCurrentCourseId(),
            ];
        });
        expect(cachedCourseIds).toEqual([COURSE_ID, COURSE_ID]);
    });

    test('renders the no-students empty state when the students payload omits the students array', async ({ page }) => {
        await mockDownloadsApi(page, {
            studentsResult: {
                success: true,
                data: {
                    totalStudents: 0,
                    totalSessions: 0,
                },
            },
        });

        await openDownloadsPage(page);

        await expect(page.locator('#total-students')).toHaveText('0');
        await expect(page.locator('#empty-state')).toBeVisible();
        await expect(page.locator('#students-container')).toBeHidden();
        await expect(page.locator('#download-course-btn')).toBeHidden();
    });

    test('renders empty modal state and alerts when a session list request fails', async ({ page }) => {
        await mockDownloadsApi(page, {
            studentsResult: {
                success: true,
                data: {
                    totalStudents: 2,
                    totalSessions: 1,
                    students: [
                        {
                            studentId: EMPTY_STUDENT_ID,
                            studentName: 'Empty Modal Student',
                            totalSessions: 0,
                        },
                        {
                            studentId: FAILING_STUDENT_ID,
                            studentName: 'Failing Modal Student',
                            totalSessions: 1,
                        },
                    ],
                },
            },
            sessionsByStudent: {
                [EMPTY_STUDENT_ID]: {
                    success: true,
                    data: { studentName: 'empty_student', sessions: [] },
                },
            },
            sessionListFailures: new Set([FAILING_STUDENT_ID]),
        });

        await openDownloadsPage(page);

        await page.locator('.student-card', { hasText: 'Empty Modal Student' })
            .getByRole('button', { name: 'View Sessions' })
            .click();
        await expect(page.locator('#student-modal')).toBeVisible();
        await expect(page.locator('#sessions-list')).toContainText('No saved chat sessions found.');
        await expect(page.locator('#download-all-btn')).toBeHidden();
        await page.locator('#student-modal .modal-close').click();

        const dialogPromise = page.waitForEvent('dialog');
        await page.locator('.student-card', { hasText: 'Failing Modal Student' })
            .getByRole('button', { name: 'View Sessions' })
            .click();
        const dialog = await dialogPromise;
        expect(dialog.message()).toBe('Failed to load student sessions. Please try again.');
        await dialog.dismiss();
    });

    test('shows empty, error, and alternate-shape preview messages', async ({ page }) => {
        await mockDownloadsApi(page, {
            studentsResult: {
                success: true,
                data: {
                    totalStudents: 1,
                    totalSessions: 3,
                    students: [{
                        studentId: PREVIEW_STUDENT_ID,
                        studentName: 'Preview Branch Student',
                        totalSessions: 3,
                    }],
                },
            },
            sessionsByStudent: {
                [PREVIEW_STUDENT_ID]: {
                    success: true,
                    data: {
                        studentName: 'preview_student',
                        sessions: [
                            {
                                sessionId: 'empty-preview-session',
                                studentId: PREVIEW_STUDENT_ID,
                                title: 'No Message Preview',
                                unitName: '',
                                messageCount: 0,
                                duration: '',
                            },
                            {
                                sessionId: 'broken-preview-session',
                                studentId: PREVIEW_STUDENT_ID,
                                title: 'Broken Preview',
                                unitName: 'Unit 2',
                                messageCount: 1,
                                duration: '1s',
                                savedAt: '2026-02-02T10:00:00.000Z',
                            },
                            {
                                sessionId: 'alternate-preview-session',
                                studentId: PREVIEW_STUDENT_ID,
                                title: 'Alternate Message Shapes',
                                unitName: 'Unit 3',
                                messageCount: 2,
                                duration: '2s',
                                savedAt: '2026-02-03T10:00:00.000Z',
                            },
                        ],
                    },
                },
            },
            sessionDetailsById: {
                'empty-preview-session': {
                    success: true,
                    data: { messages: [] },
                },
                'alternate-preview-session': {
                    success: true,
                    data: {
                        messages: [
                            { sender: 'assistant', text: '<b>Assistant via sender</b>' },
                            { role: 'critic', message: 'Unknown role falls back to student styling' },
                        ],
                    },
                },
            },
            sessionDetailFailures: new Set(['broken-preview-session']),
        });

        await openDownloadsPage(page);
        await page.locator('.student-card', { hasText: 'Preview Branch Student' })
            .getByRole('button', { name: 'View Sessions' })
            .click();

        const modal = page.locator('#student-modal');
        await expect(modal).toBeVisible();

        const emptySession = modal.locator('.session-item-wrapper', { hasText: 'No Message Preview' });
        await expect(emptySession.locator('.session-date')).toContainText('Saved: Unknown date at Unknown time');
        await emptySession.getByRole('button', { name: 'Preview Chat' }).click();
        await expect(page.locator('#preview-empty-preview-session')).toContainText('No messages in this session.');

        const brokenSession = modal.locator('.session-item-wrapper', { hasText: 'Broken Preview' });
        await brokenSession.getByRole('button', { name: 'Preview Chat' }).click();
        await expect(page.locator('#preview-broken-preview-session')).toContainText('Failed to load chat preview.');

        const alternateSession = modal.locator('.session-item-wrapper', { hasText: 'Alternate Message Shapes' });
        await alternateSession.getByRole('button', { name: 'Preview Chat' }).click();
        await expect(page.locator('#preview-alternate-preview-session')).toContainText('Assistant via sender');
        await expect(page.locator('#preview-alternate-preview-session')).toContainText('Unknown role falls back to student styling');
    });

    test('alerts on single-session download failure and uses text fallback for raw object exports', async ({ page }) => {
        await mockDownloadsApi(page, {
            studentsResult: {
                success: true,
                data: {
                    totalStudents: 1,
                    totalSessions: 2,
                    students: [{
                        studentId: DOWNLOAD_STUDENT_ID,
                        studentName: 'Download Branch Student',
                        totalSessions: 2,
                    }],
                },
            },
            sessionsByStudent: {
                [DOWNLOAD_STUDENT_ID]: {
                    success: true,
                    data: {
                        studentName: 'download_student',
                        sessions: [
                            {
                                sessionId: 'failed-download-session',
                                studentId: DOWNLOAD_STUDENT_ID,
                                title: 'Failed Download Session',
                                unitName: 'Unit 1',
                                messageCount: 1,
                                duration: '1s',
                                savedAt: '2026-03-01T10:00:00.000Z',
                            },
                            {
                                sessionId: 'raw-text-download-session',
                                studentId: DOWNLOAD_STUDENT_ID,
                                title: 'Raw Text Download Session',
                                unitName: 'Unit 1',
                                messageCount: 1,
                                duration: '1s',
                                savedAt: '2026-03-02T10:00:00.000Z',
                            },
                        ],
                    },
                },
            },
            sessionDetailsById: {
                'raw-text-download-session': {
                    success: true,
                    data: {
                        courseId: COURSE_ID,
                        studentName: 'Download Branch Student',
                        savedAt: '2026-03-02T10:00:00.000Z',
                        chatData: { note: 'raw object fallback' },
                    },
                },
            },
            sessionDetailFailures: new Set(['failed-download-session']),
        });

        await openDownloadsPage(page);
        await page.locator('.student-card', { hasText: 'Download Branch Student' })
            .getByRole('button', { name: 'View Sessions' })
            .click();
        await expect(page.locator('#student-modal')).toBeVisible();

        const failedSession = page.locator('.session-item-wrapper', { hasText: 'Failed Download Session' });
        await failedSession.getByRole('button', { name: 'Download ▾' }).click();
        const dialogPromise = page.waitForEvent('dialog');
        await page.locator('#download-menu-failed-download-session')
            .getByRole('button', { name: 'Download JSON' })
            .click();
        const dialog = await dialogPromise;
        expect(dialog.message()).toBe('Failed to download session. Please try again.');
        await dialog.dismiss();

        const rawSession = page.locator('.session-item-wrapper', { hasText: 'Raw Text Download Session' });
        await rawSession.getByRole('button', { name: 'Download ▾' }).click();
        const [download] = await Promise.all([
            page.waitForEvent('download'),
            page.locator('#download-menu-raw-text-download-session')
                .getByRole('button', { name: 'Download TXT' })
                .click(),
        ]);

        const text = await readDownloadedText(download);
        expect(text).toContain('"note": "raw object fallback"');
    });

    test('course-wide export continues past per-student and per-session fetch failures', async ({ page }) => {
        const dialogs = [];
        page.on('dialog', async (dialog) => {
            dialogs.push(dialog.message());
            await dialog.dismiss();
        });

        await mockDownloadsApi(page, {
            studentsResult: {
                success: true,
                data: {
                    totalStudents: 2,
                    totalSessions: 2,
                    students: [
                        {
                            studentId: OBJECT_STUDENT_ID,
                            studentName: { name: 'Object Course Export Student' },
                            totalSessions: 2,
                        },
                        {
                            studentId: 'branch_student_missing_name',
                            studentName: null,
                            totalSessions: 1,
                        },
                    ],
                },
            },
            sessionsByStudent: {
                [OBJECT_STUDENT_ID]: {
                    success: true,
                    data: {
                        studentName: 'object_student',
                        sessions: [
                            {
                                sessionId: 'course-export-ok-session',
                                studentId: OBJECT_STUDENT_ID,
                                title: 'Course Export OK',
                                unitName: 'Unit 1',
                                messageCount: 1,
                                duration: '1s',
                                savedAt: '2026-04-01T10:00:00.000Z',
                            },
                            {
                                sessionId: 'course-export-aborted-session',
                                studentId: OBJECT_STUDENT_ID,
                                title: 'Course Export Aborted',
                                unitName: 'Unit 1',
                                messageCount: 1,
                                duration: '1s',
                                savedAt: '2026-04-02T10:00:00.000Z',
                            },
                        ],
                    },
                },
            },
            sessionDetailsById: {
                'course-export-ok-session': {
                    success: true,
                    data: {
                        sessionId: 'course-export-ok-session',
                        courseId: COURSE_ID,
                        studentId: OBJECT_STUDENT_ID,
                        studentName: 'Object Course Export Student',
                        title: 'Course Export OK',
                        unitName: 'Unit 1',
                        savedAt: '2026-04-01T10:00:00.000Z',
                        chatData: {
                            messages: [{ type: 'user', content: 'included course export message' }],
                        },
                    },
                },
            },
            abortSessionLists: new Set(['branch_student_missing_name']),
            abortSessionDetails: new Set(['course-export-aborted-session']),
        });

        await openDownloadsPage(page);
        await page.locator('#download-course-btn').click();

        const [download] = await Promise.all([
            page.waitForEvent('download'),
            page.locator('#download-menu-course-all')
                .getByRole('button', { name: 'Download JSON' })
                .click(),
        ]);

        const payload = await readDownloadedJson(download);
        expect(payload).toMatchObject({
            courseId: COURSE_ID,
            totalStudents: 2,
        });
        expect(payload.students).toHaveLength(1);
        expect(payload.students[0]).toMatchObject({
            studentId: OBJECT_STUDENT_ID,
            studentName: 'Object Course Export Student',
        });
        expect(payload.students[0].sessions.map((session) => session.sessionId)).toEqual(['course-export-ok-session']);
        expect(dialogs).toEqual([]);
    });

    test('saved-chat fields render as text, and their IDs stay IDs, never markup or script', async ({ page }) => {
        const markup = '"><img src=x onerror="window.__savedChatMarkupRan=true">';
        const studentId = `quoted_student'"`;
        const sessionId = `quoted_session');window.__savedChatMarkupRan=true;//" x="`;
        await mockDownloadsApi(page, {
            studentsResult: {
                success: true,
                data: {
                    totalStudents: 1,
                    totalSessions: 1,
                    students: [{ studentId, studentName: markup, totalSessions: 1 }],
                },
            },
            sessionsByStudent: {
                [studentId]: {
                    success: true,
                    data: {
                        studentName: 'quoted_student',
                        sessions: [{
                            sessionId,
                            studentId,
                            title: markup,
                            unitName: markup,
                            messageCount: markup,
                            duration: markup,
                            savedAt: '2026-02-03T10:00:00.000Z',
                        }],
                    },
                },
            },
            sessionDetailsById: {
                [sessionId]: {
                    success: true,
                    data: {
                        sessionId,
                        studentId,
                        courseId: COURSE_ID,
                        studentName: 'quoted_student',
                        savedAt: '2026-02-03T10:00:00.000Z',
                        chatData: {
                            messages: [
                                { type: 'user', content: '<img src=x onerror="window.__savedChatMarkupRan=true">Hello there' },
                                { type: 'bot', content: '<b>Bold reply</b>' },
                            ],
                        },
                    },
                },
            },
        });

        await openDownloadsPage(page);
        const card = page.locator('.student-card');
        await expect(card).toHaveCount(1);
        await expect(card.locator('.student-name')).toHaveText(markup);
        await expect(card.locator('.student-id')).toHaveText(`ID: ${studentId}`);

        await card.getByRole('button', { name: 'View Sessions' }).click();
        const modal = page.locator('#student-modal');
        await expect(modal).toBeVisible();
        const session = modal.locator('.session-item-wrapper');
        await expect(session.locator('.session-title')).toHaveText(markup);
        await expect(session.locator('.session-details')).toContainText(`Unit: ${markup}`);

        await session.getByRole('button', { name: 'Preview Chat' }).click();
        const preview = session.locator('.chat-preview');
        await expect(preview).toContainText('Hello there');
        await expect(preview).toContainText('Bold reply');
        expect(await preview.getAttribute('id')).toBe(`preview-${sessionId}`);

        await session.getByRole('button', { name: 'Download ▾' }).click();
        await expect(session.locator('.download-dropdown-toggle')).toHaveAttribute('aria-expanded', 'true');
        const [download] = await Promise.all([
            page.waitForEvent('download'),
            session.getByRole('button', { name: 'Download TXT' }).click(),
        ]);
        const text = await readDownloadedText(download);
        expect(text).toContain('Hello there');
        expect(text).not.toContain('<img');

        // Only the page's own logo is an image, and only its own static
        // buttons have inline handlers; nothing built from a saved chat has
        // either.
        await expect(page.locator('#students-list img, #sessions-list img')).toHaveCount(0);
        await expect(page.locator('#students-list [onclick], #sessions-list [onclick]')).toHaveCount(0);
        // An image parsed outside the page (the old preview and TXT helpers)
        // never shows up above, but its handler still runs: give one a
        // moment to fail and fire.
        await page.waitForTimeout(500);
        expect(await page.evaluate(() => /** @type {any} */ (window).__savedChatMarkupRan)).toBeUndefined();
    });
});
