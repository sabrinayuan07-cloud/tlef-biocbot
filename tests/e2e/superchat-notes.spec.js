// @ts-check
/**
 * Super Chat Notes (#345) — API + behavior coverage.
 *
 * Exercises the platform-level shared instructor notes feature:
 *   - /api/superchat-notes  CRUD (create / list / get / update / delete)
 *   - Authorization: an instructor can edit/delete ONLY their own notes; a
 *     second instructor is denied (403) and the data is not mutated.
 *   - Role gating: students cannot reach the shared instructor/TA surfaces,
 *     while TAs can use them when Instructor Super Chat is configured.
 *   - Duplicate detection probe (/check-similar).
 *   - Super Chat retrieval behavior with the LLM + embeddings STUBBED (no
 *     OpenAI traffic): notes blend into instructor answers when enabled, are
 *     excluded when the admin toggle is off, and NEVER surface in the student
 *     Super Course chat.
 *
 * The web server runs with BIOCBOT_TEST_LLM_STUB=1 (see playwright.config.js),
 * so the LLM returns scripted content and embeddings are deterministic
 * bag-of-words vectors (src/services/embeddingsStub.js). That lets us assert
 * retrieval deterministically: a query that shares distinctive tokens with a
 * note scores high enough to clear the similarity floor.
 */

require('dotenv').config();
const { test, expect, request } = require('./fixtures/monocart');
const { TEST_USERS, storageStatePath } = require('./helpers/users');
const { withDb, getUserIdByUsername, seedCourse, cleanupCourses } = require('./helpers/courses-test');
const { seedSuperchat, cleanupSuperchats } = require('./helpers/superchats-test');
const { resetLlmStub, enqueueLlmResponses, addLlmStubRule } = require('./helpers/llm-stub');
const { createValidLlmApiKey } = require('./helpers/llm-keys');

const NOTES = '/api/superchat-notes';
const SETTINGS_ID = 'superCourseChat';
const NOTES_LLM_SETTINGS_ID = 'notesLlm';
// Student-visible bucket + enrolled course, used by the "students never see notes" test.
const NOTES_BUCKET_ID = 'BIOC-E2E-NOTES-BUCKET';
const NOTES_COURSE_ID = 'BIOC-E2E-NOTES-COURSE';
const NOTES_INSTRUCTOR_BUCKET_ID = 'BIOC-E2E-NOTES-INSTRUCTOR-BUCKET';
const NOTES_INSTRUCTOR_COURSE_ID = 'BIOC-E2E-NOTES-INSTRUCTOR-COURSE';

let instructorId;
let instructorFreshId;
let studentId;
let taId;
let originalSuperCourseSettings = null;
let originalNotesLlmSettings = null;

async function readSetting(id) {
    return withDb((db) => db.collection('settings').findOne({ _id: id }));
}

async function restoreSettingDoc(id, originalDoc) {
    await withDb(async (db) => {
        if (originalDoc) {
            await db.collection('settings').replaceOne({ _id: id }, originalDoc, { upsert: true });
        } else {
            await db.collection('settings').deleteOne({ _id: id });
        }
    });
}

async function setNotesSettings(overrides = {}) {
    await withDb(async (db) => {
        await db.collection('settings').updateOne(
            { _id: SETTINGS_ID },
            {
                $set: {
                    studentTopK: 8,
                    instructorTopK: 8,
                    includeInactiveCourses: false,
                    showStudentSuperCourse: false,
                    includeNotesInRetrieval: true,
                    noteRetrievalRatio: 0.25,
                    noteMinScore: 0.1,
                    instructorPrompt: 'E2E instructor super prompt',
                    studentPrompt: 'E2E student super prompt',
                    llmApiKey: createValidLlmApiKey('instructor-superchat'),
                    updatedAt: new Date(),
                    ...overrides,
                },
                $setOnInsert: { createdAt: new Date() },
            },
            { upsert: true }
        );
    });
}

async function seedNotesLlmKey() {
    await withDb(async (db) => {
        await db.collection('settings').updateOne(
            { _id: NOTES_LLM_SETTINGS_ID },
            {
                $set: {
                    llmApiKey: createValidLlmApiKey('notes'),
                    updatedAt: new Date(),
                    updatedBy: 'e2e',
                },
                $setOnInsert: { createdAt: new Date() },
            },
            { upsert: true }
        );
    });
}

async function seedInstructorSuperchatContext(overrides = {}) {
    await seedSuperchat({
        superchatId: NOTES_INSTRUCTOR_BUCKET_ID,
        name: 'Notes Instructor Bucket',
        yearLevel: 2,
        showToStudents: false,
        overrides,
    });
    await seedCourse({
        courseId: NOTES_INSTRUCTOR_COURSE_ID,
        instructorId,
        courseName: 'BIOC 202 Notes Instructor',
        overrides: { yearLevel: 2, superchatIds: [NOTES_INSTRUCTOR_BUCKET_ID] },
    });
}

// Remove every note authored by the test instructors and TA from Mongo so list
// assertions and counts stay deterministic across runs. (Qdrant stub vectors
// use distinctive per-test tokens, so any residue can't cause false matches.)
async function cleanupTestNotes() {
    await withDb((db) =>
        db.collection('superchat_notes').deleteMany({
            authorId: { $in: [instructorId, instructorFreshId, taId].filter(Boolean) },
        })
    );
}

function ctx(baseURL, role) {
    return request.newContext({ baseURL, storageState: storageStatePath(role) });
}

test.beforeAll(async () => {
    instructorId = await getUserIdByUsername(TEST_USERS.instructor.username);
    instructorFreshId = await getUserIdByUsername(TEST_USERS.instructor_fresh.username);
    studentId = await getUserIdByUsername(TEST_USERS.student.username);
    taId = await getUserIdByUsername(TEST_USERS.ta.username);
    originalSuperCourseSettings = await readSetting(SETTINGS_ID);
    originalNotesLlmSettings = await readSetting(NOTES_LLM_SETTINGS_ID);
});

test.beforeEach(async () => {
    await cleanupTestNotes();
    await seedNotesLlmKey();
});

test.afterAll(async () => {
    await cleanupTestNotes();
    await cleanupCourses([NOTES_COURSE_ID, NOTES_INSTRUCTOR_COURSE_ID]);
    await cleanupSuperchats([NOTES_BUCKET_ID, NOTES_INSTRUCTOR_BUCKET_ID]);
    await restoreSettingDoc(SETTINGS_ID, originalSuperCourseSettings);
    await restoreSettingDoc(NOTES_LLM_SETTINGS_ID, originalNotesLlmSettings);
});

// ---------------------------------------------------------------------------
// Section 1 — CRUD happy paths + auto-title + validation
// ---------------------------------------------------------------------------
test.describe('Super Chat Notes CRUD', () => {
    test('instructor can create, fetch, edit, and delete their own note', async ({ baseURL }) => {
        const api = await ctx(baseURL, 'instructor');
        try {
            // Create
            const createRes = await api.post(NOTES, {
                data: {
                    title: 'Km vs Vmax',
                    content: 'Km is the substrate concentration at half of Vmax, not a binding affinity.',
                    tags: ['enzyme kinetics', 'common confusion'],
                },
            });
            expect(createRes.status()).toBe(201);
            const created = (await createRes.json()).note;
            expect(created.noteId).toBeTruthy();
            expect(created.isOwn).toBe(true);
            expect(created.authorId).toBe(instructorId);
            expect(created.tags).toEqual(['enzyme kinetics', 'common confusion']);

            // Fetch by id
            const getRes = await api.get(`${NOTES}/${created.noteId}`);
            expect(getRes.status()).toBe(200);
            expect((await getRes.json()).note.title).toBe('Km vs Vmax');

            // Edit
            const putRes = await api.put(`${NOTES}/${created.noteId}`, {
                data: { content: 'Updated: Km is the [S] at half Vmax.', tags: ['kinetics'] },
            });
            expect(putRes.status()).toBe(200);
            const updated = (await putRes.json()).note;
            expect(updated.content).toContain('Updated: Km');
            expect(updated.tags).toEqual(['kinetics']);

            // Delete
            const delRes = await api.delete(`${NOTES}/${created.noteId}`);
            expect(delRes.status()).toBe(200);

            // Gone (soft-deleted → hidden from GET)
            const goneRes = await api.get(`${NOTES}/${created.noteId}`, { failOnStatusCode: false });
            expect(goneRes.status()).toBe(404);
        } finally {
            await api.dispose();
        }
    });

    test('blank title auto-generates from the first sentence', async ({ baseURL }) => {
        const api = await ctx(baseURL, 'instructor');
        try {
            const res = await api.post(NOTES, {
                data: { content: 'Proton gradients drive ATP synthase. The rest is detail.' },
            });
            expect(res.status()).toBe(201);
            const note = (await res.json()).note;
            expect(note.title).toBe('Proton gradients drive ATP synthase.');
        } finally {
            await api.dispose();
        }
    });

    test('empty content is rejected with 400', async ({ baseURL }) => {
        const api = await ctx(baseURL, 'instructor');
        try {
            const res = await api.post(NOTES, { data: { content: '   ' }, failOnStatusCode: false });
            expect(res.status()).toBe(400);
        } finally {
            await api.dispose();
        }
    });

    test('list shows isOwn correctly for the author vs another instructor', async ({ baseURL }) => {
        const authorApi = await ctx(baseURL, 'instructor');
        const otherApi = await ctx(baseURL, 'instructor_fresh');
        try {
            const created = (await (await authorApi.post(NOTES, {
                data: { content: 'A shared platform-level note about lipids.' },
            })).json()).note;

            // Author sees it as their own
            const mineList = (await (await authorApi.get(NOTES)).json()).data.notes;
            const mineEntry = mineList.find((n) => n.noteId === created.noteId);
            expect(mineEntry).toBeTruthy();
            expect(mineEntry.isOwn).toBe(true);

            // The other instructor sees the SAME note (platform-level) but not as own
            const otherList = (await (await otherApi.get(NOTES)).json()).data.notes;
            const otherEntry = otherList.find((n) => n.noteId === created.noteId);
            expect(otherEntry).toBeTruthy();
            expect(otherEntry.isOwn).toBe(false);
        } finally {
            await authorApi.dispose();
            await otherApi.dispose();
        }
    });
});

// ---------------------------------------------------------------------------
// Section 2 — Authorization: instructors cannot mutate each other's notes
// ---------------------------------------------------------------------------
test.describe('Super Chat Notes authorization', () => {
    test('a second instructor cannot EDIT another instructor\'s note (403, no mutation)', async ({ baseURL }) => {
        const authorApi = await ctx(baseURL, 'instructor');
        const attackerApi = await ctx(baseURL, 'instructor_fresh');
        try {
            const created = (await (await authorApi.post(NOTES, {
                data: { title: 'Owned note', content: 'Original protected content.' },
            })).json()).note;

            const res = await attackerApi.put(`${NOTES}/${created.noteId}`, {
                data: { content: 'Vandalized by another instructor' },
                failOnStatusCode: false,
            });
            expect(res.status()).toBe(403);

            // Content must be unchanged
            const after = (await (await authorApi.get(`${NOTES}/${created.noteId}`)).json()).note;
            expect(after.content).toBe('Original protected content.');
        } finally {
            await authorApi.dispose();
            await attackerApi.dispose();
        }
    });

    test('a second instructor cannot DELETE another instructor\'s note (403, still present)', async ({ baseURL }) => {
        const authorApi = await ctx(baseURL, 'instructor');
        const attackerApi = await ctx(baseURL, 'instructor_fresh');
        try {
            const created = (await (await authorApi.post(NOTES, {
                data: { content: 'Do not delete me.' },
            })).json()).note;

            const res = await attackerApi.delete(`${NOTES}/${created.noteId}`, { failOnStatusCode: false });
            expect(res.status()).toBe(403);

            // Note must still be retrievable by its author
            const stillThere = await authorApi.get(`${NOTES}/${created.noteId}`);
            expect(stillThere.status()).toBe(200);
        } finally {
            await authorApi.dispose();
            await attackerApi.dispose();
        }
    });
});

// ---------------------------------------------------------------------------
// Section 3 — Role gating (shared instructor/TA surface)
// ---------------------------------------------------------------------------
test.describe('Super Chat Notes role gating', () => {
    for (const role of ['student']) {
        test(`${role} cannot list or create notes`, async ({ baseURL }) => {
            const api = await ctx(baseURL, role);
            try {
                const listRes = await api.get(NOTES, { failOnStatusCode: false });
                expect([401, 403]).toContain(listRes.status());

                const createRes = await api.post(NOTES, {
                    data: { content: 'Should never be created by a non-instructor.' },
                    failOnStatusCode: false,
                });
                expect([401, 403]).toContain(createRes.status());
            } finally {
                await api.dispose();
            }
        });
    }

    test('a TA can use configured Super Chat and shared notes', async ({ baseURL }) => {
        await setNotesSettings();
        await seedInstructorSuperchatContext();
        const api = await ctx(baseURL, 'ta');
        try {
            const poolRes = await api.get('/api/instructor/chat/pool');
            expect(poolRes.status()).toBe(200);
            expect((await poolRes.json()).courses).toEqual(expect.arrayContaining([
                expect.objectContaining({ courseId: NOTES_INSTRUCTOR_COURSE_ID }),
            ]));

            const createRes = await api.post(NOTES, {
                data: { content: 'TA-authored note for shared Super Chat access.' },
            });
            expect(createRes.status()).toBe(201);
            expect((await createRes.json()).note).toMatchObject({ authorId: taId, isOwn: true });
        } finally {
            await api.dispose();
        }
    });
});

test.describe('TA Super Chat navigation', () => {
    test.use({ storageState: storageStatePath('ta') });

    test('keeps Super Course and Super Course Notes available from the TA dashboard', async ({ page }) => {
        await setNotesSettings();
        await seedInstructorSuperchatContext();

        await page.goto('/ta');
        await expect(page.getByRole('link', { name: 'Super Course', exact: true })).toBeVisible();
        await expect(page.getByRole('link', { name: 'Super Course Notes', exact: true })).toBeVisible();

        await page.getByRole('link', { name: 'Super Course', exact: true }).click();
        await expect(page).toHaveURL(/\/instructor\/chat$/);
        await expect(page.locator('#instructor-chat-input')).toBeVisible();
        await expect(page.locator('#super-course-pool-list')).toContainText('BIOC 202 Notes Instructor');

        await page.goto('/instructor/notes');
        await expect(page.locator('#new-note-btn')).toBeVisible();
    });
});

// ---------------------------------------------------------------------------
// Section 4 — Duplicate detection probe
// ---------------------------------------------------------------------------
test.describe('Super Chat Notes duplicate detection', () => {
    test('check-similar flags a near-duplicate and ignores unrelated content', async ({ baseURL }) => {
        const api = await ctx(baseURL, 'instructor');
        try {
            const content = 'Glycolysis converts glucose into pyruvate and yields ATP and NADH.';
            await api.post(NOTES, { data: { title: 'Glycolysis basics', content } });

            // Near-identical content should match (stub embeddings: high token overlap)
            const dupe = await api.post(`${NOTES}/check-similar`, { data: { content } });
            expect(dupe.status()).toBe(200);
            const dupeBody = await dupe.json();
            expect(dupeBody.success).toBe(true);
            expect(dupeBody.similar).not.toBeNull();
            expect(dupeBody.similar.title).toBe('Glycolysis basics');

            // Totally unrelated content should not match
            const unrelated = await api.post(`${NOTES}/check-similar`, {
                data: { content: 'Quarterly budget spreadsheet reconciliation procedures.' },
            });
            expect((await unrelated.json()).similar).toBeNull();
        } finally {
            await api.dispose();
        }
    });
});

// ---------------------------------------------------------------------------
// Section 5 — Super Chat retrieval behavior (LLM + embeddings stubbed)
// ---------------------------------------------------------------------------
test.describe('Super Chat retrieval with notes (stubbed LLM)', () => {
    test('instructor chat returns the stubbed answer and cites a matching note', async ({ baseURL }) => {
        await setNotesSettings({ includeNotesInRetrieval: true });
        await seedInstructorSuperchatContext({ includeNotesInRetrieval: true });
        const api = await ctx(baseURL, 'instructor');
        try {
            // Distinctive nonsense tokens guarantee this note is the only match.
            await api.post(NOTES, {
                data: {
                    title: 'Zorblaxine protocol',
                    content: 'Zorblaxine zinabolic catalysis requires careful membrane flux handling.',
                },
            });

            await resetLlmStub(api);
            await enqueueLlmResponses(api, ['Stubbed instructor answer about zorblaxine.']);

            const res = await api.post('/api/instructor/chat', {
                data: {
                    superchatId: NOTES_INSTRUCTOR_BUCKET_ID,
                    message: 'Tell me about zorblaxine zinabolic catalysis',
                    conversationMessages: [],
                },
            });
            expect(res.status()).toBe(200);
            const body = await res.json();
            expect(body.success).toBe(true);
            expect(body.message).toBe('Stubbed instructor answer about zorblaxine.');

            // A note citation should be present and labelled as a note.
            const noteCitations = (body.citations || []).filter((c) => c.sourceType === 'note');
            expect(noteCitations.length).toBeGreaterThan(0);
            expect(noteCitations[0].label).toContain('Note by');
        } finally {
            await api.dispose();
        }
    });

    test('notes are excluded when the admin toggle is off', async ({ baseURL }) => {
        await setNotesSettings({ includeNotesInRetrieval: false });
        await seedInstructorSuperchatContext({ includeNotesInRetrieval: false });
        const api = await ctx(baseURL, 'instructor');
        try {
            await api.post(NOTES, {
                data: {
                    title: 'Quibblefax note',
                    content: 'Quibblefax transduction modulates the snarfblat receptor cascade.',
                },
            });

            await resetLlmStub(api);
            await enqueueLlmResponses(api, ['Answer with notes disabled.']);

            const res = await api.post('/api/instructor/chat', {
                data: {
                    superchatId: NOTES_INSTRUCTOR_BUCKET_ID,
                    message: 'Explain quibblefax snarfblat transduction',
                    conversationMessages: [],
                },
            });
            expect(res.status()).toBe(200);
            const body = await res.json();
            const noteCitations = (body.citations || []).filter((c) => c.sourceType === 'note');
            expect(noteCitations.length).toBe(0);
        } finally {
            await api.dispose();
        }
    });

    test('instructor chat appends the selected answer-depth modifier to the system prompt', async ({ baseURL }) => {
        await setNotesSettings({
            instructorLevelModifiers: {
                overview: 'INSTRUCTOR-DEPTH-MARKER-OVERVIEW',
                standard: 'INSTRUCTOR-DEPTH-MARKER-STANDARD',
                deepDive: 'INSTRUCTOR-DEPTH-MARKER-DEEPDIVE',
            },
        });
        await seedInstructorSuperchatContext({
            instructorLevelModifiers: {
                overview: 'INSTRUCTOR-DEPTH-MARKER-OVERVIEW',
                standard: 'INSTRUCTOR-DEPTH-MARKER-STANDARD',
                deepDive: 'INSTRUCTOR-DEPTH-MARKER-DEEPDIVE',
            },
        });
        const api = await ctx(baseURL, 'instructor');
        try {
            await resetLlmStub(api);
            // Rule only fires when the deep-dive marker reaches the system prompt.
            await addLlmStubRule(api, {
                matchSystemPrompt: 'INSTRUCTOR-DEPTH-MARKER-DEEPDIVE',
                content: 'DEEP-DIVE-REPLY',
            });
            await enqueueLlmResponses(api, ['FALLBACK-REPLY', 'FALLBACK-REPLY']);

            const deepResp = await api.post('/api/instructor/chat', {
                data: {
                    superchatId: NOTES_INSTRUCTOR_BUCKET_ID,
                    message: 'Explain enzyme kinetics.',
                    level: 'deepDive',
                    conversationMessages: [],
                },
            });
            expect(deepResp.status()).toBe(200);
            expect((await deepResp.json()).message).toBe('DEEP-DIVE-REPLY');

            const overviewResp = await api.post('/api/instructor/chat', {
                data: {
                    superchatId: NOTES_INSTRUCTOR_BUCKET_ID,
                    message: 'Explain enzyme kinetics.',
                    level: 'overview',
                    conversationMessages: [],
                },
            });
            expect(overviewResp.status()).toBe(200);
            expect((await overviewResp.json()).message).toBe('FALLBACK-REPLY');
        } finally {
            await api.dispose();
        }
    });

    test('student Super Chat never surfaces instructor notes', async ({ baseURL }) => {
        // Notes are enabled for instructors. A student-visible bucket the student
        // is enrolled in lets them open Super Chat — but notes are gated at the
        // retrieval call site and must never reach the student answer.
        await setNotesSettings({ includeNotesInRetrieval: true });
        await seedSuperchat({ superchatId: NOTES_BUCKET_ID, name: 'Notes Bucket', yearLevel: 2, showToStudents: true });
        await seedCourse({
            courseId: NOTES_COURSE_ID, instructorId, courseName: 'BIOC 202 Notes',
            overrides: { yearLevel: 2, superchatIds: [NOTES_BUCKET_ID] },
            studentEnrollment: { [studentId]: { enrolled: true, enrolledAt: new Date() } },
        });

        const instructorApi = await ctx(baseURL, 'instructor');
        const studentApi = await ctx(baseURL, 'student');
        try {
            await instructorApi.post(NOTES, {
                data: {
                    title: 'Wuzzleforp note',
                    content: 'Wuzzleforp grindlewax binds the florbnak active site irreversibly.',
                },
            });

            await resetLlmStub(studentApi);
            await enqueueLlmResponses(studentApi, ['Student answer about wuzzleforp.']);

            const res = await studentApi.post('/api/student/super-course/chat', {
                data: { superchatId: NOTES_BUCKET_ID, message: 'What does wuzzleforp grindlewax do to florbnak?' },
                failOnStatusCode: false,
            });
            expect(res.status()).toBe(200);
            const body = await res.json();

            const citationHasNote = (body.citations || []).some((c) => c.sourceType === 'note');
            const attributionHasNote = (body.sourceAttribution?.documents || []).some((d) => d.sourceType === 'note');
            expect(citationHasNote).toBe(false);
            expect(attributionHasNote).toBe(false);
        } finally {
            await instructorApi.dispose();
            await studentApi.dispose();
        }
    });
});
