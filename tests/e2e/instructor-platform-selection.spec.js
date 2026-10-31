// @ts-check
/**
 * Browser coverage for the AI platform selector.
 *
 * Instructors choose a platform label (OpenAI Chat GPT / UBC On-Premise LLM / UBC LLM Proxy)
 * and enter that platform's
 * key — they never see or choose a chat or embedding model. Admins configure
 * models per platform on the same page, grouped by platform.
 *
 * These specs drive the real pages and mock only the platform-state APIs, so
 * they stay independent of whichever platform the local .env happens to name.
 */

require('dotenv').config();
const { MongoClient } = require('mongodb');
const { test, expect } = require('./fixtures/monocart');
const { TEST_USERS, storageStatePath } = require('./helpers/users');

const COURSE_ID = 'BIOC-E2E-PLATFORM';
const COURSE_NAME = 'BIOC E2E Platform Selection';

const GPT_HELP = 'Feel free to use your own OpenAI API key, or contact the support team for assistance.';
const SANDBOX_HELP = 'Contact the LTIC team to request a UBC LLM Sandbox API key.';
const PROXY_HELP = 'Enter the UBC LLM Proxy key issued for this AI surface.';

// Model names must never appear anywhere an instructor can see.
const MODEL_NAMES = [
    'gpt-4.1-mini', 'gpt-5-nano', 'gpt-5.4-nano', 'gpt-5.6-luna',
    'qwen3.6-35b-a3b', 'gpt-oss-120b',
    'text-embedding-3-small', 'text-embedding-3-large', 'qwen3-embedding-0.6b',
];

let instructorId;
let originalAcademicApiEnabled = false;

async function withDb(fn) {
    if (!process.env.MONGO_URI) {
        throw new Error('MONGO_URI not set; cannot run platform selection e2e tests.');
    }
    const client = new MongoClient(process.env.MONGO_URI);
    await client.connect();
    try {
        return await fn(client.db());
    } finally {
        await client.close();
    }
}

async function setSystemAdmin(userId, isAdmin) {
    await withDb(async (db) => {
        await db.collection('users').updateOne(
            { userId },
            { $set: { 'permissions.systemAdmin': isAdmin === true, updatedAt: new Date() } }
        );
    });
}

/**
 * The "Set up another section" path (`?addCourse=true`) is only honoured when the
 * academic API gate is on; otherwise the server redirects a completed instructor
 * straight to Course Upload. These specs seed a completed course, so they need
 * the gate to reach the onboarding form at all.
 */
async function setAcademicApiEnabled(enabled) {
    await withDb(async (db) => {
        await db.collection('settings').updateOne(
            { _id: 'global' },
            { $set: { academicApiEnabled: enabled === true, updatedAt: new Date() } },
            { upsert: true }
        );
    });
}

/**
 * Open onboarding at Step 2 (Course Setup), which is where the platform choice
 * and API-key field live. Step 1 is the welcome screen.
 */
async function openOnboardingCourseSetup(page) {
    await setAcademicApiEnabled(true);
    await page.goto('/instructor/onboarding?addCourse=true');
    await expect(page.locator('#step-1.onboarding-step.active')).toBeVisible({ timeout: 15_000 });
    // Wait for the async onboarding boot (auth/status check + course loading),
    // not just for nextStep() to exist. The status check intentionally restores
    // step 1 and can otherwise race a fast click back from step 2 to step 1.
    await page.waitForFunction(() => typeof window.nextStep === 'function');
    const courseSelect = page.locator('#course-select');
    await expect(courseSelect.locator('option[value="custom"]')).toHaveCount(1);
    await page.locator('#step-1 button.btn-primary', { hasText: 'Get Started' }).click();
    await expect(page.locator('#step-2.onboarding-step.active')).toBeVisible({ timeout: 15_000 });

    // The platform choice and key field belong to the "create a new course"
    // branch; joining an existing course replaces them. Select the create
    // option explicitly so this does not depend on how the course dropdown
    // happens to be populated for this instructor.
    await courseSelect.selectOption('custom');
    await expect(page.locator('#course-api-key-section')).toBeVisible({ timeout: 15_000 });
}

async function seedCourse() {
    await withDb(async (db) => {
        await db.collection('courses').deleteMany({ courseId: COURSE_ID });
        await db.collection('courses').insertOne({
            courseId: COURSE_ID,
            courseName: COURSE_NAME,
            instructorId,
            instructors: [instructorId],
            status: 'active',
            isOnboardingComplete: true,
            activeLlmProvider: 'openai',
            llmCredentials: {
                openai: {
                    ciphertext: 'v1:seed:seed:seed',
                    last4: '1111',
                    status: 'valid',
                    provider: 'openai',
                    validatedAt: new Date(),
                    updatedAt: new Date(),
                },
            },
            lectures: [{ name: 'Unit 1', documents: [], isPublished: false }],
            courseStructure: { weeks: 1, lecturesPerWeek: 1, totalUnits: 1 },
            createdAt: new Date(),
            updatedAt: new Date(),
        });
    });
}

/**
 * Mock the course platform-state endpoints so the selector can be driven without
 * contacting a real provider.
 */
async function mockCourseKeyState(page, state) {
    const current = { ...state };

    await page.route('**/api/courses/*/llm-key', async (route) => {
        const request = route.request();
        if (request.method() === 'PUT') {
            const body = JSON.parse(request.postData() || '{}');
            current.llmProvider = body.llmProvider;
            current.llmKeysByProvider[body.llmProvider] = { status: 'valid', last4: '9999', validatedAt: new Date().toISOString() };
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({ success: true, message: 'Course API key saved', ...current, migration: null }),
            });
            return;
        }
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ success: true, providers: [], ...current, migration: current.migration || null }),
        });
    });

    return current;
}

function baseState(overrides = {}) {
    return {
        llmProvider: 'openai',
        pendingLlmProvider: null,
        providerMigrationId: null,
        llmKey: { status: 'valid', last4: '1111', validatedAt: null, updatedAt: null },
        llmKeysByProvider: {
            openai: { status: 'valid', last4: '1111', validatedAt: null, updatedAt: null },
            'ubc-llm-sandbox': { status: 'missing', last4: null, validatedAt: null, updatedAt: null },
            'ubc-llm-proxy': { status: 'missing', last4: null, validatedAt: null, updatedAt: null },
        },
        aiAvailable: true,
        ...overrides,
    };
}

async function openCourseKeySettings(page) {
    await page.goto(`/instructor/settings?courseId=${COURSE_ID}`);
    await expect(page.locator('h1')).toHaveText('Settings', { timeout: 15_000 });
    await page.locator('.settings-tile[data-panel="course-basics"]').click();
    await expect(page.locator('#course-llm-key-section')).toBeVisible({ timeout: 15_000 });
}

test.beforeAll(async () => {
    const instructor = await withDb(async (db) =>
        db.collection('users').findOne({ username: TEST_USERS.instructor.username }));
    if (!instructor) throw new Error('E2E instructor user not found.');
    instructorId = instructor.userId;

    const globalSettings = await withDb(async (db) => db.collection('settings').findOne({ _id: 'global' }));
    originalAcademicApiEnabled = globalSettings?.academicApiEnabled === true;
});

test.afterAll(async () => {
    await withDb(async (db) => { await db.collection('courses').deleteMany({ courseId: COURSE_ID }); });
    await setSystemAdmin(instructorId, false);
    await setAcademicApiEnabled(originalAcademicApiEnabled);
});

test.describe('Instructor platform selection', () => {
    test.use({ storageState: storageStatePath('instructor') });

    test.beforeEach(async () => {
        await setSystemAdmin(instructorId, false);
        await seedCourse();
    });

    test('onboarding offers all three platforms with platform-specific help text', async ({ page }) => {
        await openOnboardingCourseSetup(page);
        await expect(page.locator('#onboarding-llm-platform')).toBeVisible();

        // GPT is the default choice.
        await expect(page.locator('#onboarding-llm-provider-openai')).toBeChecked();
        await expect(page.locator('#onboarding-llm-platform-help')).toContainText(GPT_HELP);
        await expect(page.locator('#course-api-key-label')).toContainText('OpenAI Chat GPT');
        await expect(page.locator('#course-api-key')).toHaveAttribute('placeholder', 'sk-...');

        // Selecting Sandbox swaps the help text, label and placeholder.
        await page.locator('#onboarding-llm-provider-ubc-llm-sandbox').check();
        await expect(page.locator('#onboarding-llm-platform-help')).toHaveText(SANDBOX_HELP);
        await expect(page.locator('#course-api-key-label')).toContainText('UBC On-Premise LLM');
        await expect(page.locator('#course-api-key')).toHaveAttribute('placeholder', 'UBC LLM Sandbox API key');

        // Proxy is a separate keyed platform and does not expose model choices.
        await page.locator('#onboarding-llm-provider-ubc-llm-proxy').check();
        await expect(page.locator('#onboarding-llm-platform-help')).toContainText(PROXY_HELP);
        await expect(page.locator('#course-api-key-label')).toContainText('UBC LLM Proxy');
        await expect(page.locator('#course-api-key')).toHaveAttribute('placeholder', 'UBC LLM Proxy API key');

        // Switching back restores the GPT copy.
        await page.locator('#onboarding-llm-provider-openai').check();
        await expect(page.locator('#onboarding-llm-platform-help')).toContainText(GPT_HELP);
    });

    test('onboarding never exposes a chat or embedding model name', async ({ page }) => {
        await openOnboardingCourseSetup(page);
        await expect(page.locator('#onboarding-llm-platform')).toBeVisible();

        const visibleText = await page.locator('body').innerText();
        for (const modelName of MODEL_NAMES) {
            expect(visibleText).not.toContain(modelName);
        }
    });

    test('course settings show the platform selector, key status and help text', async ({ page }) => {
        await mockCourseKeyState(page, baseState());
        await openCourseKeySettings(page);

        await expect(page.locator('#course-llm-platform')).toBeVisible();
        await expect(page.locator('#course-llm-provider-openai')).toBeChecked();
        await expect(page.locator('#course-llm-platform-help')).toContainText(GPT_HELP);
        await expect(page.locator('#course-llm-key-status')).toContainText('Valid OpenAI Chat GPT key ending 1111');
        // No warning while the selected platform is the active one.
        await expect(page.locator('#course-llm-platform-change-note')).toBeHidden();
    });

    test('choosing a platform with no key asks for one before switching', async ({ page }) => {
        await mockCourseKeyState(page, baseState());
        await openCourseKeySettings(page);

        await page.locator('#course-llm-provider-ubc-llm-sandbox').check();

        await expect(page.locator('#course-llm-platform-help')).toHaveText(SANDBOX_HELP);
        await expect(page.locator('#course-llm-platform-change-note')).toBeVisible();
        await expect(page.locator('#course-llm-platform-change-note'))
            .toContainText('Save a UBC On-Premise LLM key, then switch platforms');
        // The current platform keeps serving until preparation finishes.
        await expect(page.locator('#course-llm-platform-change-note'))
            .toContainText('OpenAI Chat GPT keeps answering until then');
        // The status line follows the selected platform, not the active one.
        await expect(page.locator('#course-llm-key-status')).toContainText('No UBC On-Premise LLM key saved');
        await expect(page.locator('#course-llm-key-input')).toHaveAttribute('placeholder', 'UBC LLM Sandbox API key');
        // Without a valid key there is nothing to switch to.
        await expect(page.locator('#course-llm-prepare')).toBeDisabled();
    });

    test('choosing a platform whose key is already saved offers to switch and reuse material', async ({ page }) => {
        await mockCourseKeyState(page, baseState({
            llmKeysByProvider: {
                openai: { status: 'valid', last4: '1111', validatedAt: null, updatedAt: null },
                'ubc-llm-sandbox': { status: 'valid', last4: '2222', validatedAt: null, updatedAt: null },
            },
        }));
        await openCourseKeySettings(page);

        await page.locator('#course-llm-provider-ubc-llm-sandbox').check();

        await expect(page.locator('#course-llm-platform-change-note'))
            .toContainText('Your saved UBC On-Premise LLM key and embeddings are kept separately');
        await expect(page.locator('#course-llm-platform-change-note'))
            .toContainText('only missing or changed items need preparation');
        // The key is already valid, so a direct switch can be attempted.
        await expect(page.locator('#course-llm-prepare')).toBeEnabled();
        await expect(page.locator('#course-llm-prepare'))
            .toHaveText('Switch to UBC On-Premise LLM');

        // Back on the active platform the action becomes a refresh, not a switch.
        await page.locator('#course-llm-provider-openai').check();
        await expect(page.locator('#course-llm-platform-change-note')).toBeHidden();
        await expect(page.locator('#course-llm-prepare')).toHaveText('Refresh OpenAI Chat GPT material');
    });

    test('switching prepares missing material without re-entering the key', async ({ page }) => {
        let switchRequest = null;
        await mockCourseKeyState(page, baseState({
            llmKeysByProvider: {
                openai: { status: 'valid', last4: '1111', validatedAt: null, updatedAt: null },
                'ubc-llm-sandbox': { status: 'valid', last4: '2222', validatedAt: null, updatedAt: null },
            },
        }));
        // One round trip: the switch itself starts the indexing job and the
        // platform activates when that job finishes.
        await page.route('**/api/courses/*/llm-provider', async (route) => {
            switchRequest = JSON.parse(route.request().postData() || '{}');
            await route.fulfill({
                status: 202,
                contentType: 'application/json',
                body: JSON.stringify({
                    success: true,
                    message: 'Preparing course material for UBC On-Premise LLM. '
                        + 'It will switch automatically when preparation finishes.',
                    ...baseState({
                        pendingLlmProvider: 'ubc-llm-sandbox',
                        providerMigrationId: 'mig_saved_switch',
                        llmKeysByProvider: {
                            openai: { status: 'valid', last4: '1111' },
                            'ubc-llm-sandbox': { status: 'valid', last4: '2222' },
                        },
                    }),
                    migration: {
                        migrationId: 'mig_saved_switch', status: 'queued', toProvider: 'ubc-llm-sandbox',
                        total: 2, completed: 0, failed: 0, failures: [],
                        targetProfile: { provider: 'ubc-llm-sandbox' },
                    },
                }),
            });
        });

        await openCourseKeySettings(page);
        await page.locator('#course-llm-provider-ubc-llm-sandbox').check();

        // The key is already stored, so saving is only ever a replacement...
        await expect(page.locator('#save-course-llm-key')).toHaveText('Replace UBC On-Premise LLM key');
        // ...and one switch click covers both preparing and activating.
        await expect(page.locator('#course-llm-prepare')).toBeEnabled();
        await expect(page.locator('#course-llm-prepare')).toHaveText('Switch to UBC On-Premise LLM');

        // The switch/prepare confirmation goes through the in-page
        // #confirm-dialog-modal instead of window.confirm() (#632).
        await page.locator('#course-llm-prepare').click();
        await expect(page.locator('#confirm-dialog-modal')).toHaveClass(/show/, { timeout: 10_000 });
        await expect(page.locator('#confirm-dialog-message')).toHaveText(
            'Switch this AI surface to UBC On-Premise LLM? Existing embeddings are reused, '
                + 'and only missing or changed items are indexed before the switch completes.'
        );
        await page.locator('#confirm-dialog-confirm').click();

        await expect.poll(() => switchRequest).toEqual({ llmProvider: 'ubc-llm-sandbox' });
        // Progress replaces the button state; no key was ever re-entered.
        await expect(page.locator('#course-llm-migration')).toBeVisible();
        await expect(page.locator('#course-llm-key-input')).toHaveValue('');
    });

    test('a course key surface never exposes model names to an instructor', async ({ page }) => {
        await mockCourseKeyState(page, baseState());
        await openCourseKeySettings(page);

        // Admin model controls are hidden from a non-admin instructor entirely.
        await expect(page.locator('#llm-model-section')).toBeHidden();
        await expect(page.locator('#sandbox-llm-model-section')).toBeHidden();
        await expect(page.locator('#proxy-llm-model-section')).toBeHidden();

        const visibleText = await page.locator('body').innerText();
        for (const modelName of MODEL_NAMES) {
            expect(visibleText).not.toContain(modelName);
        }
    });

    test('a running migration shows persistent progress and a retry control on failure', async ({ page }) => {
        const surface = await mockCourseKeyState(page, baseState({
            pendingLlmProvider: 'ubc-llm-sandbox',
            providerMigrationId: 'mig_e2e_1',
            migration: {
                migrationId: 'mig_e2e_1',
                status: 'running',
                toProvider: 'ubc-llm-sandbox',
                total: 4,
                completed: 1,
                failed: 0,
                currentItem: { itemType: 'document', itemId: 'd2', title: 'Lecture 2.pdf' },
                failures: [],
                targetProfile: { provider: 'ubc-llm-sandbox' },
            },
        }));

        const failedMigration = {
            migrationId: 'mig_e2e_1',
            status: 'failed',
            toProvider: 'ubc-llm-sandbox',
            total: 4,
            completed: 3,
            failed: 1,
            currentItem: null,
            failures: [{
                itemType: 'document', itemId: 'd4', title: 'Lecture 4.pdf',
                error: 'Embedding request for qwen3-embedding-0.6b timed out after 30s',
                failureReason: 'provider_timeout', attempts: 3,
            }],
            failureSummary: {
                reason: 'provider_timeout',
                headline: 'UBC On-Premise LLM did not respond in time.',
                detail: 'No course material was changed, and OpenAI Chat GPT is still answering questions. '
                    + 'The platform may be temporarily unavailable or under maintenance — wait a few minutes and try again.',
                affected: [{ title: 'Lecture 4.pdf', cause: null }],
            },
            targetProfile: { provider: 'ubc-llm-sandbox' },
        };

        // The poller asks for the migration; report a failed item on the next tick.
        const migrationPolls = [];
        page.on('request', (request) => {
            if (request.url().includes('/api/provider-migrations/')) migrationPolls.push(request.url());
        });
        await page.route('**/api/provider-migrations/mig_e2e_1', async (route) => {
            // Reaching a terminal state makes the page reload the whole surface,
            // so the surface endpoint has to agree that the job finished —
            // exactly as the real server would once the job is written.
            surface.migration = failedMigration;
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({ success: true, migration: failedMigration }),
            });
        });

        await openCourseKeySettings(page);

        // Initial state from the surface payload.
        await expect(page.locator('#course-llm-migration')).toBeVisible();
        await expect(page.locator('#course-llm-migration-status'))
            .toContainText('Preparing course material for UBC On-Premise LLM: 1 of 4 done');
        await expect(page.locator('#course-llm-migration-status')).toContainText('Lecture 2.pdf');
        // While migrating, the selector shows the platform being migrated TO.
        await expect(page.locator('#course-llm-provider-ubc-llm-sandbox')).toBeChecked();

        // Progress is polled, not pushed: the panel updates without a reload.
        await expect.poll(() => migrationPolls.length, { timeout: 15_000 }).toBeGreaterThan(0);

        // After the poll the failure appears — as prose, not as an error dump.
        await expect(page.locator('#course-llm-migration-status'))
            .toHaveText('UBC On-Premise LLM did not respond in time.', { timeout: 15_000 });
        await expect(page.locator('#course-llm-migration-detail'))
            .toContainText('OpenAI Chat GPT is still answering questions');
        await expect(page.locator('#course-llm-migration-detail')).toContainText('try again');

        // The affected file is named; the provider's error text is not shown.
        await expect(page.locator('#course-llm-migration-failures-label')).toContainText('This item was affected');
        await expect(page.locator('#course-llm-migration-failures')).toHaveText('Lecture 4.pdf');

        const panelText = await page.locator('#course-llm-migration').innerText();
        for (const jargon of ['Embedding request', 'timed out after', 'qwen3', 'chunk']) {
            expect(panelText).not.toContain(jargon);
        }

        await expect(page.locator('#course-llm-migration-retry')).toBeVisible();
    });

    test('retrying a failed migration calls the retry endpoint', async ({ page }) => {
        let retried = false;
        await mockCourseKeyState(page, baseState({
            pendingLlmProvider: 'ubc-llm-sandbox',
            providerMigrationId: 'mig_e2e_2',
            migration: {
                migrationId: 'mig_e2e_2',
                status: 'failed',
                toProvider: 'ubc-llm-sandbox',
                total: 2,
                completed: 1,
                failed: 1,
                currentItem: null,
                failures: [{ itemType: 'document', itemId: 'd2', title: 'Lecture 2.pdf', error: 'quota', attempts: 3 }],
                targetProfile: { provider: 'ubc-llm-sandbox' },
            },
        }));

        await page.route('**/api/provider-migrations/mig_e2e_2/retry', async (route) => {
            retried = true;
            await route.fulfill({
                status: 202,
                contentType: 'application/json',
                body: JSON.stringify({
                    success: true,
                    migration: {
                        migrationId: 'mig_e2e_2', status: 'queued', toProvider: 'ubc-llm-sandbox',
                        total: 2, completed: 1, failed: 0, failures: [], targetProfile: { provider: 'ubc-llm-sandbox' },
                    },
                }),
            });
        });

        await openCourseKeySettings(page);
        await expect(page.locator('#course-llm-migration-retry')).toBeVisible();
        await page.locator('#course-llm-migration-retry').click();

        await expect(page.locator('.notification.success', { hasText: 'Retrying failed items' }))
            .toBeVisible({ timeout: 10_000 });
        expect(retried).toBe(true);
        await expect(page.locator('#course-llm-migration-status'))
            .toContainText('Preparing course material for UBC On-Premise LLM: 1 of 2 done');
    });
});

test.describe('Admin platform and model settings', () => {
    test.use({ storageState: storageStatePath('instructor') });

    test.beforeEach(async () => {
        await seedCourse();
        await setSystemAdmin(instructorId, true);
    });

    test('notes and global Super Course model controls toggle as inline accordions', async ({ page }) => {
        await page.route('**/api/settings/llm', async (route) => {
            if (route.request().method() !== 'GET') return route.continue();
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    success: true,
                    platforms: [{
                        provider: 'openai', label: 'OpenAI Chat GPT',
                        chatModel: 'gpt-5.6-luna', embeddingModel: 'text-embedding-3-small',
                        reasoningEffort: 'low', supportsReasoning: true,
                        backendChatModel: 'gpt-5.6-luna', backendReasoningEffort: 'low',
                        backendSupportsReasoning: true, backendInheritsFrontend: true,
                        allowedModels: ['gpt-5.6-luna'],
                        allowedEmbeddingModels: ['text-embedding-3-small'],
                        reasoningEffortsByModel: { 'gpt-5.6-luna': ['none', 'low'] },
                        defaultReasoningEffortByModel: { 'gpt-5.6-luna': 'low' },
                        collection: 'biocbot_documents', vectorSize: 1536, pendingEmbedding: null,
                    }],
                    settings: { model: 'gpt-5.6-luna', reasoningEffort: 'low', provider: 'openai' },
                }),
            });
        });

        await page.goto(`/instructor/settings?courseId=${COURSE_ID}`);
        await expect(page.locator('h1')).toHaveText('Settings', { timeout: 15_000 });
        await page.locator('.settings-tile[data-panel="admin-platform"]').click();

        const notesButton = page.locator('#configure-notes-models');
        await notesButton.click();
        await expect(notesButton).toHaveText('Hide model settings');
        await expect(notesButton).toHaveAttribute('aria-expanded', 'true');
        await expect(page.locator('#notes-llm-key-section + .scoped-model-accordion')).toBeVisible();
        await expect(page.locator('#instructor-superchat-llm-key-section')).toBeVisible();
        await expect(page.locator('#notes-llm-key-section + .scoped-model-accordion #llm-model-section')).toBeVisible();
        await notesButton.click();
        await expect(notesButton).toHaveText('Configure models');
        await expect(notesButton).toHaveAttribute('aria-expanded', 'false');
        await expect(page.locator('#notes-llm-key-section + .scoped-model-accordion')).toHaveCount(0);
        await expect(page.locator('#settings-panel-admin-platform > #llm-model-section')).toBeVisible();

        const globalButton = page.locator('#configure-instructor-superchat-models');
        await globalButton.click();
        await expect(globalButton).toHaveText('Hide model settings');
        await expect(page.locator('#settings-panel-admin-platform > .scoped-model-accordion')).toBeVisible();
        await expect(page.locator('#notes-llm-key-section')).toBeVisible();
        await globalButton.click();
        await expect(globalButton).toHaveText('Configure models');
        await expect(page.locator('#settings-panel-admin-platform > .scoped-model-accordion')).toHaveCount(0);

        // Leaving a course-scoped editor returns the shared controls home. The
        // defaults panel must not require a page refresh to show them again.
        await page.locator('.settings-rail-link[data-panel="course-basics"]').click();
        const courseButton = page.locator('#configure-course-models');
        await courseButton.click();
        await expect(page.locator('#course-llm-key-section > .scoped-model-accordion')).toBeVisible();
        await page.locator('.settings-rail-link[data-panel="admin-platform"]').click();
        await expect(page.locator('#settings-panel-admin-platform > #llm-model-section')).toBeVisible();
        await expect(page.locator('#notes-llm-key-section')).toBeVisible();
        await expect(page.locator('#instructor-superchat-llm-key-section')).toBeVisible();
    });

    test('model controls are grouped by platform, each with its own collection', async ({ page }) => {
        /** @type {Array<Record<string, any>>} */
        const savedBodies = [];
        await page.route('**/api/settings/llm/reasoning-efforts', async (route) => {
            const body = route.request().postDataJSON();
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    success: true,
                    provider: 'ubc-llm-proxy',
                    model: body.model,
                    reasoningEfforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
                }),
            });
        });
        await page.route('**/api/settings/llm', async (route) => {
            if (route.request().method() === 'POST') {
                savedBodies.push(route.request().postDataJSON());
                return route.fulfill({
                    status: 200,
                    contentType: 'application/json',
                    body: JSON.stringify({ success: true, settings: {} }),
                });
            }
            if (route.request().method() !== 'GET') return route.continue();
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    success: true,
                    platforms: [
                        {
                            provider: 'openai', label: 'OpenAI Chat GPT',
                            chatModel: 'gpt-5-nano', embeddingModel: 'text-embedding-3-small',
                            reasoningEffort: 'minimal', supportsReasoning: true,
                            backendChatModel: 'gpt-5-nano', backendReasoningEffort: 'minimal',
                            backendSupportsReasoning: true, backendInheritsFrontend: true,
                            allowedModels: ['gpt-4.1-mini', 'gpt-5-nano'],
                            allowedEmbeddingModels: ['text-embedding-3-small', 'text-embedding-3-large'],
                            reasoningEffortsByModel: { 'gpt-5-nano': ['minimal', 'low'], 'gpt-4.1-mini': [] },
                            defaultReasoningEffortByModel: { 'gpt-5-nano': 'minimal' },
                            collection: 'biocbot_documents', vectorSize: 1536, pendingEmbedding: null,
                        },
                        {
                            provider: 'ubc-llm-sandbox', label: 'UBC On-Premise LLM',
                            chatModel: 'qwen3.6-35b-a3b', embeddingModel: 'qwen3-embedding-0.6b',
                            reasoningEffort: 'none', supportsReasoning: true,
                            backendChatModel: 'gpt-oss-120b', backendReasoningEffort: 'low',
                            backendSupportsReasoning: true, backendInheritsFrontend: false,
                            allowedModels: ['qwen3.6-35b-a3b', 'gpt-oss-120b'],
                            allowedEmbeddingModels: ['qwen3-embedding-0.6b'],
                            reasoningEffortsByModel: { 'qwen3.6-35b-a3b': ['none', 'low'] },
                            defaultReasoningEffortByModel: { 'qwen3.6-35b-a3b': 'none' },
                            collection: 'biocbot_documents_qwen3_embedding_0_6b', vectorSize: 1024,
                            pendingEmbedding: null,
                        },
                        {
                            provider: 'ubc-llm-proxy', label: 'UBC LLM Proxy',
                            chatModel: null, embeddingModel: null,
                            reasoningEffort: null, supportsReasoning: false,
                            backendChatModel: null, backendReasoningEffort: null,
                            backendSupportsReasoning: false, backendInheritsFrontend: true,
                            allowedModels: ['openai/gpt-5.6-luna:2026', 'vendor/embed.model-v2'],
                            allowedEmbeddingModels: ['openai/gpt-5.6-luna:2026', 'vendor/embed.model-v2'],
                            reasoningEffortsByModel: {
                                'openai/gpt-5.6-luna:2026': ['none', 'low'],
                                'vendor/embed.model-v2': ['none', 'low'],
                            },
                            defaultReasoningEffortByModel: {
                                'openai/gpt-5.6-luna:2026': 'low',
                                'vendor/embed.model-v2': 'low',
                            },
                            collection: null, vectorSize: null, pendingEmbedding: null,
                            modelsDiscovered: true, configured: false,
                        },
                    ],
                    settings: { model: 'gpt-5-nano', reasoningEffort: 'minimal', provider: 'openai' },
                }),
            });
        });

        await page.goto(`/instructor/settings?courseId=${COURSE_ID}`);
        await expect(page.locator('h1')).toHaveText('Settings', { timeout: 15_000 });
        await page.locator('.settings-tile[data-panel="admin-platform"]').click();

        // GPT group.
        await expect(page.locator('#llm-model-section')).toBeVisible();
        await expect(page.locator('#llm-model-section h3')).toHaveText('OpenAI Chat GPT models');
        await expect(page.locator('#llm-model-select')).toHaveValue('gpt-5-nano');
        await expect(page.locator('#llm-backend-inherit')).toBeChecked();
        await expect(page.locator('#llm-backend-model-select')).toHaveValue('gpt-5-nano');
        await expect(page.locator('#llm-backend-model-select')).toBeDisabled();
        await expect(page.locator('#llm-embedding-select')).toHaveValue('text-embedding-3-small');
        await expect(page.locator('#llm-embedding-collection')).toContainText('biocbot_documents (1536 dimensions)');

        // Sandbox group, with its own separate collection and dimensionality.
        await expect(page.locator('#sandbox-llm-model-section')).toBeVisible();
        await expect(page.locator('#sandbox-llm-model-section h3')).toHaveText('UBC On-Premise LLM models');
        await expect(page.locator('#sandbox-llm-model-select')).toHaveValue('qwen3.6-35b-a3b');
        await expect(page.locator('#sandbox-llm-backend-inherit')).not.toBeChecked();
        await expect(page.locator('#sandbox-llm-backend-model-select')).toHaveValue('gpt-oss-120b');
        await expect(page.locator('#sandbox-llm-backend-model-select')).toBeEnabled();
        await expect(page.locator('#sandbox-llm-embedding-select')).toHaveValue('qwen3-embedding-0.6b');
        await expect(page.locator('#sandbox-llm-embedding-collection'))
            .toContainText('biocbot_documents_qwen3_embedding_0_6b (1024 dimensions)');

        // Proxy preserves discovered ids exactly, but no model is selected by
        // the application on an unconfigured installation.
        await expect(page.locator('#proxy-llm-model-section')).toBeVisible();
        await expect(page.locator('#proxy-llm-model-select')).toHaveValue('');
        await expect(page.locator('#proxy-llm-embedding-select')).toHaveValue('');
        await expect(page.locator('#proxy-llm-model-select option').nth(1))
            .toHaveAttribute('value', 'openai/gpt-5.6-luna:2026');
        await expect(page.locator('#proxy-llm-embedding-select option').nth(2))
            .toHaveAttribute('value', 'vendor/embed.model-v2');
        await expect(page.locator('#proxy-llm-embedding-collection')).toHaveText('Not configured');

        // Proxy reasoning values come from live operation probing, not model-id
        // naming rules. Unsupported `minimal` is hidden while `max` remains.
        await page.locator('#proxy-llm-model-select').selectOption('openai/gpt-5.6-luna:2026');
        await expect(page.locator('#proxy-llm-reasoning-select option[value="minimal"]')).toHaveCount(0);
        await expect(page.locator('#proxy-llm-reasoning-select option[value="max"]')).toBeEnabled();
        await expect(page.locator('#save-proxy-llm-settings')).toBeEnabled();

        // Each platform only offers its own models.
        await expect(page.locator('#llm-model-select option[value="qwen3.6-35b-a3b"]')).toHaveCount(0);
        await expect(page.locator('#sandbox-llm-model-select option[value="gpt-5-nano"]')).toHaveCount(0);
        await expect(page.locator('#llm-embedding-select option[value="qwen3-embedding-0.6b"]')).toHaveCount(0);

        // Splitting a lane sends an explicit override; re-linking sends only
        // the inheritance flag so the server can remove the stored override.
        const inheritBackendSettings = page.locator('label[for="llm-backend-inherit"]');
        await inheritBackendSettings.click();
        await expect(page.locator('#llm-backend-inherit')).not.toBeChecked();
        await page.locator('#llm-backend-model-select').selectOption('gpt-4.1-mini');
        await page.locator('#save-llm-settings').click();
        await expect.poll(() => savedBodies.length).toBe(1);
        expect(savedBodies[0]).toMatchObject({
            provider: 'openai',
            chatModel: 'gpt-5-nano',
            backendInheritsFrontend: false,
            backendChatModel: 'gpt-4.1-mini',
        });

        await inheritBackendSettings.click();
        await expect(page.locator('#llm-backend-inherit')).toBeChecked();
        await page.locator('#save-llm-settings').click();
        await expect.poll(() => savedBodies.length).toBe(2);
        expect(savedBodies[1]).toMatchObject({
            provider: 'openai',
            backendInheritsFrontend: true,
        });
        expect(savedBodies[1]).not.toHaveProperty('backendChatModel');
    });

    test('a staged embedding change is shown with a cancel control', async ({ page }) => {
        await page.route('**/api/settings/llm', async (route) => {
            if (route.request().method() !== 'GET') return route.continue();
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    success: true,
                    platforms: [{
                        provider: 'openai', label: 'OpenAI Chat GPT',
                        chatModel: 'gpt-4.1-mini', embeddingModel: 'text-embedding-3-small',
                        reasoningEffort: 'minimal', supportsReasoning: false,
                        allowedModels: ['gpt-4.1-mini'],
                        allowedEmbeddingModels: ['text-embedding-3-small', 'text-embedding-3-large'],
                        reasoningEffortsByModel: {}, defaultReasoningEffortByModel: {},
                        collection: 'biocbot_documents', vectorSize: 1536,
                        pendingEmbedding: { embeddingModel: 'text-embedding-3-large', migrationId: 'mig_admin_1' },
                    }],
                    settings: { model: 'gpt-4.1-mini', provider: 'openai' },
                }),
            });
        });

        await page.goto(`/instructor/settings?courseId=${COURSE_ID}`);
        await expect(page.locator('h1')).toHaveText('Settings', { timeout: 15_000 });
        await page.locator('.settings-tile[data-panel="admin-platform"]').click();

        await expect(page.locator('#llm-embedding-pending')).toBeVisible();
        await expect(page.locator('#llm-embedding-pending')).toContainText('Re-indexing: text-embedding-3-large');
        await expect(page.locator('#llm-embedding-pending'))
            .toContainText('text-embedding-3-small stays active until re-indexing finishes');
        await expect(page.locator('#reindex-llm-embedding')).toHaveCount(0);
        await expect(page.locator('#rollback-llm-embedding')).toBeVisible();
        await expect(page.locator('#rollback-llm-embedding')).toHaveText('Cancel re-indexing');
    });

    test('a saved embedding choice waits for a platform switch, not a button here', async ({ page }) => {
        await page.route('**/api/settings/llm', async (route) => {
            if (route.request().method() !== 'GET') return route.continue();
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    success: true,
                    platforms: [{
                        provider: 'openai', label: 'OpenAI Chat GPT',
                        chatModel: 'gpt-4.1-mini', embeddingModel: 'text-embedding-3-small',
                        reasoningEffort: 'minimal', supportsReasoning: false,
                        allowedModels: ['gpt-4.1-mini'],
                        allowedEmbeddingModels: ['text-embedding-3-small', 'text-embedding-3-large'],
                        reasoningEffortsByModel: {}, defaultReasoningEffortByModel: {},
                        collection: 'biocbot_documents', vectorSize: 1536,
                        // Saved, with no job of its own.
                        pendingEmbedding: { embeddingModel: 'text-embedding-3-large', migrationId: null },
                    }],
                    settings: { model: 'gpt-4.1-mini', provider: 'openai' },
                }),
            });
        });

        await page.goto(`/instructor/settings?courseId=${COURSE_ID}`);
        await expect(page.locator('h1')).toHaveText('Settings', { timeout: 15_000 });
        await page.locator('.settings-tile[data-panel="admin-platform"]').click();

        await expect(page.locator('#llm-embedding-pending')).toBeVisible();
        await expect(page.locator('#llm-embedding-pending'))
            .toContainText('Saved: text-embedding-3-large');
        await expect(page.locator('#llm-embedding-pending'))
            .toContainText('It is applied when this surface switches to OpenAI Chat GPT');
        // The panel records the choice and nothing else — no re-index control,
        // and the selector stays editable because no job is running.
        await expect(page.locator('#reindex-llm-embedding')).toHaveCount(0);
        await expect(page.locator('#llm-embedding-select')).toBeEnabled();
        await expect(page.locator('#rollback-llm-embedding')).toHaveText('Discard embedding change');
    });
});
