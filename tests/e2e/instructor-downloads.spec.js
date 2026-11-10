// @ts-check
/**
 * E2E coverage for public/instructor/scripts/downloads.js and its backing
 * instructor-only student chat download endpoints.
 */

const fs = require('fs/promises');
const { test, expect } = require('./fixtures/monocart');
const { storageStatePath } = require('./helpers/users');
const {
    DOWNLOAD_COURSE_ID,
    DOWNLOAD_COURSE_NAME,
    DOWNLOAD_OTHER_COURSE_ID,
    DOWNLOAD_EMPTY_COURSE_ID,
    DOWNLOAD_EMPTY_COURSE_NAME,
    DOWNLOAD_LARGE_COURSE_ID,
    DOWNLOAD_LARGE_COURSE_NAME,
    DOWNLOAD_STUDENT_ID,
    DOWNLOAD_STUDENT_NAME,
    DOWNLOAD_SECOND_STUDENT_ID,
    DOWNLOAD_SECOND_STUDENT_NAME,
    DOWNLOAD_LARGE_STUDENT_NAME,
    DOWNLOAD_WELCOME_ONLY_STUDENT_NAME,
    SESSION_VISIBLE_ID,
    SESSION_STUDENT_DELETED_ID,
    SESSION_LEGACY_ID,
    SESSION_SOFT_DELETED_ID,
    SESSION_OTHER_COURSE_ID,
    SESSION_UNRELATED_ID,
    SESSION_LARGE_ID,
    SESSION_LARGE_MESSAGE_COUNT,
    getInstructorId,
    setSystemAdmin,
    resetDownloadData,
    cleanupDownloadData,
} = require('./helpers/downloads');

let instructorId;

test.beforeAll(async () => {
    instructorId = await getInstructorId();
});

test.afterAll(async () => {
    await cleanupDownloadData(instructorId);
});

async function seedAsAdmin() {
    await resetDownloadData({ instructorId });
    await setSystemAdmin(instructorId, true);
}

async function seedAsNonAdmin() {
    await resetDownloadData({ instructorId });
    await setSystemAdmin(instructorId, false);
}

async function openDownloadsPage(page) {
    await page.addInitScript((staleCourseId) => {
        try {
            localStorage.setItem('selectedCourseId', staleCourseId);
        } catch (_) {}
    }, DOWNLOAD_OTHER_COURSE_ID);

    await page.goto(`/instructor/downloads?courseId=${DOWNLOAD_COURSE_ID}`);
    await expect(page.locator('#course-title')).toHaveText(
        `${DOWNLOAD_COURSE_NAME} - Download Chats`,
        { timeout: 15_000 }
    );
    await expect(page.locator('#students-container')).toBeVisible({ timeout: 15_000 });
}

async function openStudentModal(page) {
    const card = page.locator('.student-card', { hasText: DOWNLOAD_STUDENT_NAME });
    await expect(card).toBeVisible({ timeout: 15_000 });
    await card.getByRole('button', { name: 'View Sessions' }).click();

    const modal = page.locator('#student-modal');
    await expect(modal).toBeVisible({ timeout: 10_000 });
    await expect(modal.locator('#student-modal-title')).toContainText(DOWNLOAD_STUDENT_NAME);
    return modal;
}

async function readDownloadedJson(download) {
    const downloadPath = await download.path();
    expect(downloadPath).toBeTruthy();
    return JSON.parse(await fs.readFile(downloadPath, 'utf8'));
}

async function readDownloadedText(download) {
    const downloadPath = await download.path();
    expect(downloadPath).toBeTruthy();
    return fs.readFile(downloadPath, 'utf8');
}

test.describe('Instructor downloads page — system admin UI', () => {
    test.use({ storageState: storageStatePath('instructor'), acceptDownloads: true });

    test.beforeEach(async () => {
        await seedAsAdmin();
    });

    test.afterEach(async () => {
        await setSystemAdmin(instructorId, false);
    });

    test('loads the URL-selected course, updates localStorage, and excludes globally deleted sessions', async ({ page }) => {
        await openDownloadsPage(page);

        await expect(page.locator('#instructor-downloads-nav')).toBeVisible();
        await expect(page.locator('#total-students')).toHaveText('2');
        await expect(page.locator('#download-course-btn')).toBeVisible();

        const caseyCard = page.locator('.student-card', { hasText: DOWNLOAD_STUDENT_NAME });
        await expect(caseyCard).toContainText('2 saved chats');
        await expect(page.locator('.student-card', { hasText: DOWNLOAD_SECOND_STUDENT_NAME })).toContainText('1 saved chat');

        const selectedCourseId = await page.evaluate(() => localStorage.getItem('selectedCourseId'));
        expect(selectedCourseId).toBe(DOWNLOAD_COURSE_ID);

        const modal = await openStudentModal(page);
        await expect(modal.locator('#sessions-list')).toContainText('Visible Download Chat');
        await expect(modal.locator('#sessions-list')).toContainText('Student Deleted But Instructor Visible');
        await expect(modal.locator('#sessions-list')).not.toContainText('Soft Deleted Download Chat');
    });

    test('normalizeChatExportOrder sorts every export shape oldest-first, stably', async ({ page }) => {
        await openDownloadsPage(page);

        const result = await page.evaluate(() => {
            // Single-session shape
            const single = {
                messages: [
                    { type: 'bot', content: 'third', timestamp: '2026-01-15T10:10:00Z' },
                    { type: 'user', content: 'first', timestamp: '2026-01-15T10:00:00Z' },
                    { type: 'bot', content: 'second', timestamp: '2026-01-15T10:05:00Z' },
                ],
            };
            // Combined single-student shape (sessions[].chatData.messages)
            const combined = {
                sessions: [
                    { chatData: { messages: [
                        { content: 'b', timestamp: '2026-01-15T11:00:00Z' },
                        { content: 'a', timestamp: '2026-01-15T09:00:00Z' },
                    ] } },
                ],
            };
            // Course/superchat-wide shape (students[].sessions[].chatData.messages)
            const wide = {
                students: [
                    { sessions: [
                        { chatData: { messages: [
                            { content: 'y', timestamp: '2026-01-15T12:00:00Z' },
                            { content: 'x', timestamp: '2026-01-15T08:00:00Z' },
                        ] } },
                    ] },
                ],
            };
            // When any message lacks a usable timestamp, original order is kept
            const partial = {
                messages: [
                    { content: 'keep-1' },
                    { content: 'keep-2', timestamp: '2020-01-01T00:00:00Z' },
                ],
            };

            return {
                single: normalizeChatExportOrder(single).messages.map((m) => m.content),
                combined: normalizeChatExportOrder(combined).sessions[0].chatData.messages.map((m) => m.content),
                wide: normalizeChatExportOrder(wide).students[0].sessions[0].chatData.messages.map((m) => m.content),
                partial: normalizeChatExportOrder(partial).messages.map((m) => m.content),
            };
        });

        expect(result.single).toEqual(['first', 'second', 'third']);
        expect(result.combined).toEqual(['a', 'b']);
        expect(result.wide).toEqual(['x', 'y']);
        expect(result.partial).toEqual(['keep-1', 'keep-2']);
    });

    test('preview strips HTML from chat messages before rendering inline', async ({ page }) => {
        await openDownloadsPage(page);
        const modal = await openStudentModal(page);

        const session = modal.locator('.session-item-wrapper', { hasText: 'Visible Download Chat' });
        await session.getByRole('button', { name: 'Preview Chat' }).click();

        const preview = page.locator(`#preview-${SESSION_VISIBLE_ID}`);
        await expect(preview).toContainText('Hello Casey', { timeout: 10_000 });
        await expect(preview).toContainText('Here is a safe response with ATP.');

        const previewHTML = await preview.innerHTML();
        expect(previewHTML).not.toContain('<strong>');
        expect(previewHTML).not.toContain('<p>');
    });

    test('downloads one session as JSON from the session dropdown', async ({ page }) => {
        await openDownloadsPage(page);
        const modal = await openStudentModal(page);

        const session = modal.locator('.session-item-wrapper', { hasText: 'Visible Download Chat' });
        await session.getByRole('button', { name: /^Download/ }).click();

        const [download] = await Promise.all([
            page.waitForEvent('download'),
            page.locator(`#download-menu-${SESSION_VISIBLE_ID}`).getByRole('button', { name: 'Download JSON' }).click(),
        ]);

        expect(download.suggestedFilename()).toBe(
            `BiocBot_Chat_${DOWNLOAD_COURSE_ID}_${DOWNLOAD_STUDENT_NAME}_2026-01-15.json`
        );

        const payload = await readDownloadedJson(download);
        expect(payload).toMatchObject({
            messages: [
                {
                    type: 'user',
                    content: expect.stringContaining('Hello <strong>Casey</strong>'),
                },
                {
                    type: 'bot',
                    content: expect.stringContaining('safe response with ATP'),
                },
            ],
        });
    });

    test('download-all for one student delivers a combined JSON payload', async ({ page }) => {
        await openDownloadsPage(page);
        await openStudentModal(page);

        page.on('dialog', (dialog) => dialog.dismiss().catch(() => {}));

        await page.locator('#download-all-btn .download-dropdown-toggle').click();
        const [download] = await Promise.all([
            page.waitForEvent('download'),
            page.locator('#download-menu-student-all').getByRole('button', { name: 'Download JSON' }).click(),
        ]);

        const payload = await readDownloadedJson(download);
        expect(payload).toMatchObject({
            studentName: DOWNLOAD_STUDENT_NAME,
            courseId: DOWNLOAD_COURSE_ID,
            totalSessions: 2,
        });
        expect(payload.sessions.map((session) => session.sessionId).sort()).toEqual([
            SESSION_STUDENT_DELETED_ID,
            SESSION_VISIBLE_ID,
        ].sort());
    });

    test('downloads one session as TXT with HTML stripped from messages', async ({ page }) => {
        await openDownloadsPage(page);
        const modal = await openStudentModal(page);

        const session = modal.locator('.session-item-wrapper', { hasText: 'Visible Download Chat' });
        await session.getByRole('button', { name: /^Download/ }).click();

        const [download] = await Promise.all([
            page.waitForEvent('download'),
            page.locator(`#download-menu-${SESSION_VISIBLE_ID}`).getByRole('button', { name: 'Download TXT' }).click(),
        ]);

        expect(download.suggestedFilename()).toBe(
            `BiocBot_Chat_${DOWNLOAD_COURSE_ID}_${DOWNLOAD_STUDENT_NAME}_2026-01-15.txt`
        );

        const text = await readDownloadedText(download);
        expect(text).toContain('STUDENT');
        expect(text).toContain('BIOCBOT');
        expect(text).toContain('Hello Casey');
        expect(text).toContain('Here is a safe response with ATP.');
        expect(text).not.toContain('<strong>');
        expect(text).not.toContain('<p>');
    });

    test('download-all for one student as TXT combines sessions and strips HTML', async ({ page }) => {
        await openDownloadsPage(page);
        await openStudentModal(page);

        page.on('dialog', (dialog) => dialog.dismiss().catch(() => {}));

        await page.locator('#download-all-btn .download-dropdown-toggle').click();
        const [download] = await Promise.all([
            page.waitForEvent('download'),
            page.locator('#download-menu-student-all').getByRole('button', { name: 'Download TXT' }).click(),
        ]);

        expect(download.suggestedFilename()).toMatch(
            new RegExp(`^BiocBot_AllSessions_${DOWNLOAD_COURSE_ID}_${DOWNLOAD_STUDENT_NAME}_\\d{4}-\\d{2}-\\d{2}\\.txt$`)
        );

        const text = await readDownloadedText(download);
        expect(text).toContain(`Student: ${DOWNLOAD_STUDENT_NAME}`);
        expect(text).toContain(`Course: ${DOWNLOAD_COURSE_ID}`);
        expect(text).toContain('Total Sessions: 2');
        expect(text).toContain('Visible Download Chat');
        expect(text).toContain('Student Deleted But Instructor Visible');
        expect(text).toContain('Hello Casey');
        expect(text).toContain('Instructor downloads should still include it.');
        expect(text).not.toContain('Soft Deleted Download Chat');
        expect(text).not.toContain('<strong>');
        expect(text).not.toContain('<p>');
    });

    test('downloads all course sessions as JSON across every student', async ({ page }) => {
        await openDownloadsPage(page);

        const dialogMessages = [];
        page.on('dialog', async (dialog) => {
            dialogMessages.push(dialog.message());
            await dialog.dismiss();
        });

        await page.locator('#download-course-btn').click();
        const [download] = await Promise.all([
            page.waitForEvent('download'),
            page.locator('#download-menu-course-all').getByRole('button', { name: 'Download JSON' }).click(),
        ]);

        expect(download.suggestedFilename()).toMatch(
            new RegExp(`^BiocBot_Course_${DOWNLOAD_COURSE_ID}_AllSessions_\\d{4}-\\d{2}-\\d{2}\\.json$`)
        );

        const payload = await readDownloadedJson(download);
        expect(payload).toMatchObject({
            courseId: DOWNLOAD_COURSE_ID,
            totalStudents: 2,
        });
        expect(Array.isArray(payload.students)).toBe(true);
        expect(payload.students).toHaveLength(2);

        const casey = payload.students.find((s) => s.studentName === DOWNLOAD_STUDENT_NAME);
        expect(casey).toBeTruthy();
        expect(casey.sessions.map((s) => s.sessionId).sort()).toEqual(
            [SESSION_STUDENT_DELETED_ID, SESSION_VISIBLE_ID].sort()
        );

        const riley = payload.students.find((s) => s.studentName === DOWNLOAD_SECOND_STUDENT_NAME);
        expect(riley).toBeTruthy();
        expect(riley.sessions.map((s) => s.sessionId)).toEqual([SESSION_LEGACY_ID]);

        const allSessionIds = payload.students.flatMap((s) => s.sessions.map((sess) => sess.sessionId));
        expect(allSessionIds).not.toContain(SESSION_SOFT_DELETED_ID);
        expect(allSessionIds).not.toContain(SESSION_OTHER_COURSE_ID);
        expect(allSessionIds).not.toContain(SESSION_UNRELATED_ID);

        await page.waitForTimeout(500);
        expect(dialogMessages).toEqual([]);
    });

    test('downloads all course sessions as TXT with student headers and HTML stripped', async ({ page }) => {
        await openDownloadsPage(page);

        await page.locator('#download-course-btn').click();
        const [download] = await Promise.all([
            page.waitForEvent('download'),
            page.locator('#download-menu-course-all').getByRole('button', { name: 'Download TXT' }).click(),
        ]);

        expect(download.suggestedFilename()).toMatch(
            new RegExp(`^BiocBot_Course_${DOWNLOAD_COURSE_ID}_AllSessions_\\d{4}-\\d{2}-\\d{2}\\.txt$`)
        );

        const text = await readDownloadedText(download);
        expect(text).toContain(`Course Chat Export - ${DOWNLOAD_COURSE_ID}`);
        expect(text).toContain('Total Students: 2');
        expect(text).toContain(`Student: ${DOWNLOAD_STUDENT_NAME}`);
        expect(text).toContain(`Student: ${DOWNLOAD_SECOND_STUDENT_NAME}`);
        expect(text).toContain('Visible Download Chat');
        expect(text).toContain('Legacy Session Without Delete Flag');
        expect(text).toContain('Hello Casey');
        expect(text).not.toContain('<strong>');
        expect(text).not.toContain('<p>');
        expect(text).not.toContain('Soft Deleted Download Chat');
        expect(text).not.toContain('Other Course Chat');
    });

    test('falls back to localStorage course id when no URL parameter is provided', async ({ page }) => {
        await page.addInitScript((courseId) => {
            try {
                localStorage.setItem('selectedCourseId', courseId);
            } catch (_) {}
        }, DOWNLOAD_COURSE_ID);

        await page.goto('/instructor/downloads');
        await expect(page.locator('#course-title')).toHaveText(
            `${DOWNLOAD_COURSE_NAME} - Download Chats`,
            { timeout: 15_000 }
        );

        const url = new URL(page.url());
        expect(url.searchParams.get('courseId')).toBe(DOWNLOAD_COURSE_ID);
        await expect(page.locator('#total-students')).toHaveText('2');
    });

    test('opens the export change log modal and downloads it as Markdown', async ({ page }) => {
        await openDownloadsPage(page);

        await page.getByRole('button', { name: 'What changed in exports' }).click();

        const modal = page.locator('#changelog-modal');
        await expect(modal).toBeVisible({ timeout: 10_000 });
        await expect(modal.locator('#changelog-error')).toBeHidden();
        await expect(modal.locator('.changelog-entry').first()).toBeVisible({ timeout: 10_000 });

        const [download] = await Promise.all([
            page.waitForEvent('download'),
            modal.getByRole('button', { name: 'Download as Markdown (.md)' }).click(),
        ]);

        expect(download.suggestedFilename()).toMatch(/^biocbot-chat-export-change-log-\d{4}-\d{2}-\d{2}\.md$/);

        const markdown = await readDownloadedText(download);
        expect(markdown).toContain('## Changes');
        expect(markdown).toContain('## Appendix: Interpreting the JSON Chat Export');

        await modal.locator('.modal-close').click();
        await expect(modal).toBeHidden();
    });

    test('closes the student modal via the close button', async ({ page }) => {
        await openDownloadsPage(page);
        const modal = await openStudentModal(page);

        await modal.locator('.modal-close').click();
        await expect(modal).toBeHidden();
    });

    test('renders the empty state and hides the course download button when no chats exist', async ({ page }) => {
        await page.goto(`/instructor/downloads?courseId=${DOWNLOAD_EMPTY_COURSE_ID}`);
        await expect(page.locator('#course-title')).toHaveText(
            `${DOWNLOAD_EMPTY_COURSE_NAME} - Download Chats`,
            { timeout: 15_000 }
        );

        await expect(page.locator('#total-students')).toHaveText('0');
        await expect(page.locator('#empty-state')).toBeVisible();
        await expect(page.locator('#students-container')).toBeHidden();
        await expect(page.locator('#download-course-btn')).toBeHidden();
    });

    test('renders an avatar with the first letter of each student name', async ({ page }) => {
        await openDownloadsPage(page);

        const caseyCard = page.locator('.student-card', { hasText: DOWNLOAD_STUDENT_NAME });
        const rileyCard = page.locator('.student-card', { hasText: DOWNLOAD_SECOND_STUDENT_NAME });

        await expect(caseyCard.locator('.student-avatar')).toHaveText('C');
        await expect(rileyCard.locator('.student-avatar')).toHaveText('R');
        await expect(caseyCard.locator('.student-id')).toContainText(DOWNLOAD_STUDENT_ID);
        await expect(rileyCard.locator('.student-id')).toContainText(DOWNLOAD_SECOND_STUDENT_ID);
    });

    test('shows unit name, message count, and computed duration on each session row', async ({ page }) => {
        await openDownloadsPage(page);
        const modal = await openStudentModal(page);

        const session = modal.locator('.session-item-wrapper', { hasText: 'Visible Download Chat' });
        const details = session.locator('.session-details');
        await expect(details).toContainText('Unit: Unit 1');
        await expect(details).toContainText('Messages: 2');
        await expect(details).toContainText('Duration: 9s');
        await expect(session.locator('.session-date')).toContainText('Saved:');
    });

    test('downloads a legacy session (no isDeleted flag) for the second student', async ({ page }) => {
        await openDownloadsPage(page);

        const rileyCard = page.locator('.student-card', { hasText: DOWNLOAD_SECOND_STUDENT_NAME });
        await rileyCard.getByRole('button', { name: 'View Sessions' }).click();

        const modal = page.locator('#student-modal');
        await expect(modal).toBeVisible({ timeout: 10_000 });

        const session = modal.locator('.session-item-wrapper', { hasText: 'Legacy Session Without Delete Flag' });
        await session.getByRole('button', { name: /^Download/ }).click();

        const [download] = await Promise.all([
            page.waitForEvent('download'),
            page.locator(`#download-menu-${SESSION_LEGACY_ID}`).getByRole('button', { name: 'Download JSON' }).click(),
        ]);

        expect(download.suggestedFilename()).toBe(
            `BiocBot_Chat_${DOWNLOAD_COURSE_ID}_${DOWNLOAD_SECOND_STUDENT_NAME}_2026-01-17.json`
        );

        const payload = await readDownloadedJson(download);
        expect(payload.messages).toEqual([
            {
                type: 'user',
                content: 'Legacy session should stay visible.',
                timestamp: '2026-01-17T10:00:00.000Z',
            },
        ]);
    });

    test('closes an open download dropdown when clicking elsewhere on the page', async ({ page }) => {
        await openDownloadsPage(page);
        const modal = await openStudentModal(page);

        const session = modal.locator('.session-item-wrapper', { hasText: 'Visible Download Chat' });
        const menu = page.locator(`#download-menu-${SESSION_VISIBLE_ID}`);

        await session.getByRole('button', { name: /^Download/ }).click();
        await expect(menu).toHaveClass(/open/);

        await modal.locator('#student-modal-title').click();
        await expect(menu).not.toHaveClass(/open/);
    });

    test('preview shows a "Showing 20 of N" indicator and caches after first load', async ({ page }) => {
        await page.goto(`/instructor/downloads?courseId=${DOWNLOAD_LARGE_COURSE_ID}`);
        await expect(page.locator('#course-title')).toHaveText(
            `${DOWNLOAD_LARGE_COURSE_NAME} - Download Chats`,
            { timeout: 15_000 }
        );

        const card = page.locator('.student-card', { hasText: DOWNLOAD_LARGE_STUDENT_NAME });
        await card.getByRole('button', { name: 'View Sessions' }).click();

        const modal = page.locator('#student-modal');
        await expect(modal).toBeVisible({ timeout: 10_000 });

        const session = modal.locator('.session-item-wrapper', { hasText: 'Large Session With Many Messages' });
        const previewToggle = session.getByRole('button', { name: 'Preview Chat' });
        const preview = page.locator(`#preview-${SESSION_LARGE_ID}`);

        const sessionFetches = [];
        page.on('request', (req) => {
            if (req.url().includes(`/sessions/${SESSION_LARGE_ID}`)) {
                sessionFetches.push(req.url());
            }
        });

        await previewToggle.click();
        await expect(preview).toContainText(
            `Showing 20 of ${SESSION_LARGE_MESSAGE_COUNT} messages. Download for full chat.`,
            { timeout: 10_000 }
        );
        await expect(preview).toContainText('Student message 1');
        await expect(preview).toContainText('Bot reply 2');
        // Message 21+ should not be rendered (paginated to first 20).
        await expect(preview).not.toContainText('Student message 21');

        const fetchesAfterFirstOpen = sessionFetches.length;
        expect(fetchesAfterFirstOpen).toBeGreaterThanOrEqual(1);

        // Collapse, then re-open: preview should reuse the cached payload (no new fetch).
        await previewToggle.click();
        await expect(preview).toBeHidden();

        await previewToggle.click();
        await expect(preview).toBeVisible();
        await expect(preview).toContainText('Student message 1');
        await page.waitForTimeout(250);
        expect(sessionFetches.length).toBe(fetchesAfterFirstOpen);
    });

    test('the "Chats to show" dropdown reveals and hides a student whose only session has no student message (#519)', async ({ page }) => {
        await openDownloadsPage(page);

        const welcomeOnlyCard = page.locator('.student-card', { hasText: DOWNLOAD_WELCOME_ONLY_STUDENT_NAME });
        await expect(welcomeOnlyCard).toHaveCount(0);

        await page.locator('#empty-chat-filter').selectOption('include');
        await expect(welcomeOnlyCard).toBeVisible({ timeout: 10_000 });

        await page.locator('#empty-chat-filter').selectOption('exclude');
        await expect(welcomeOnlyCard).toHaveCount(0);
    });
});

test.describe('Instructor downloads API — system admin direct access', () => {
    test.use({ storageState: storageStatePath('instructor') });

    test.beforeEach(async () => {
        await seedAsAdmin();
    });

    test.afterEach(async () => {
        await setSystemAdmin(instructorId, false);
    });

    test('lists non-deleted sessions, includes student-deleted and legacy sessions, and rejects soft-deleted fetches', async ({ request: api }) => {
        const res = await api.get(`/api/students/${DOWNLOAD_COURSE_ID}`);
        expect(res.ok()).toBeTruthy();

        const body = await res.json();
        expect(body).toMatchObject({
            success: true,
            data: {
                courseId: DOWNLOAD_COURSE_ID,
                totalStudents: 2,
                totalSessions: 3,
            },
        });

        const casey = body.data.students.find((student) => student.studentId === DOWNLOAD_STUDENT_ID);
        expect(casey).toBeTruthy();
        expect(casey.totalSessions).toBe(2);
        expect(casey.sessions.map((session) => session.sessionId).sort()).toEqual([
            SESSION_STUDENT_DELETED_ID,
            SESSION_VISIBLE_ID,
        ].sort());

        const riley = body.data.students.find((student) => student.studentName === DOWNLOAD_SECOND_STUDENT_NAME);
        expect(riley).toBeTruthy();
        expect(riley.sessions.map((session) => session.sessionId)).toEqual([SESSION_LEGACY_ID]);

        const single = await api.get(
            `/api/students/${DOWNLOAD_COURSE_ID}/${DOWNLOAD_STUDENT_ID}/sessions/${SESSION_VISIBLE_ID}`
        );
        expect(single.ok()).toBeTruthy();
        await expect(single.json()).resolves.toMatchObject({
            success: true,
            data: {
                sessionId: SESSION_VISIBLE_ID,
                courseId: DOWNLOAD_COURSE_ID,
                duration: '9s',
            },
        });

        const softDeleted = await api.get(
            `/api/students/${DOWNLOAD_COURSE_ID}/${DOWNLOAD_STUDENT_ID}/sessions/${SESSION_SOFT_DELETED_ID}`
        );
        expect(softDeleted.status()).toBe(404);
    });

    test('allows system-admin course access without leaking sessions across course IDs', async ({ request: api }) => {
        const otherCourse = await api.get(`/api/students/${DOWNLOAD_OTHER_COURSE_ID}`);
        expect(otherCourse.ok()).toBeTruthy();
        const otherBody = await otherCourse.json();
        expect(otherBody.data.totalStudents).toBe(1);
        expect(otherBody.data.students[0].sessions.map((session) => session.sessionId)).toEqual([
            SESSION_OTHER_COURSE_ID,
        ]);

        const wrongCourseForSession = await api.get(
            `/api/students/${DOWNLOAD_OTHER_COURSE_ID}/${DOWNLOAD_STUDENT_ID}/sessions/${SESSION_VISIBLE_ID}`
        );
        expect(wrongCourseForSession.status()).toBe(404);

        const unrelatedCourse = await api.get(`/api/students/BIOC-E2E-DOWNLOADS-UNRELATED`);
        expect(unrelatedCourse.ok()).toBeTruthy();
        const unrelatedBody = await unrelatedCourse.json();
        expect(unrelatedBody.data.students[0].sessions.map((session) => session.sessionId)).toEqual([
            SESSION_UNRELATED_ID,
        ]);

        const unrelatedSession = await api.get(
            `/api/students/${DOWNLOAD_COURSE_ID}/${DOWNLOAD_STUDENT_ID}/sessions/${SESSION_UNRELATED_ID}`
        );
        expect(unrelatedSession.status()).toBe(404);
    });
});

test.describe('Instructor downloads permissions', () => {
    test.use({ storageState: storageStatePath('instructor') });

    test.beforeEach(async () => {
        await seedAsNonAdmin();
    });

    test.afterEach(async () => {
        await setSystemAdmin(instructorId, false);
    });

    test('non-admin instructor is redirected from the page and blocked from direct APIs', async ({ page, request: api }) => {
        await page.goto(`/instructor/downloads?courseId=${DOWNLOAD_COURSE_ID}`);
        await page.waitForURL((url) => url.pathname === '/instructor/home', { timeout: 10_000 });

        const res = await api.get(`/api/students/${DOWNLOAD_COURSE_ID}`);
        expect(res.status()).toBe(403);
        await expect(res.json()).resolves.toMatchObject({
            success: false,
            message: 'Only system admins can access student chat download data',
        });
    });

    test('student and TA sessions cannot call instructor download APIs directly', async ({ browser }) => {
        const studentCtx = await browser.newContext({ storageState: storageStatePath('student') });
        const taCtx = await browser.newContext({ storageState: storageStatePath('ta') });

        try {
            const studentList = await studentCtx.request.get(`/api/students/${DOWNLOAD_COURSE_ID}`);
            expect(studentList.status()).toBe(403);

            const taList = await taCtx.request.get(`/api/students/${DOWNLOAD_COURSE_ID}`);
            expect(taList.status()).toBe(403);

            const taSession = await taCtx.request.get(
                `/api/students/${DOWNLOAD_COURSE_ID}/${DOWNLOAD_STUDENT_ID}/sessions/${SESSION_VISIBLE_ID}`
            );
            expect(taSession.status()).toBe(403);
        } finally {
            await studentCtx.close();
            await taCtx.close();
        }
    });
});
