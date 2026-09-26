// @ts-check
/**
 * Broader coverage for public/instructor/scripts/settings.js.
 *
 * These tests drive the real /instructor/settings page through the Monocart
 * Playwright fixture and seed MongoDB directly for stable course/user state.
 */

require('dotenv').config();
const { MongoClient } = require('mongodb');
const { test, expect, request } = require('./fixtures/monocart');
const { TEST_USERS, storageStatePath } = require('./helpers/users');

const SETTINGS_COURSE_ID = 'BIOC-E2E-SETTINGS';
const SETTINGS_OTHER_COURSE_ID = 'BIOC-E2E-SETTINGS-OTHER';
const SETTINGS_COURSE_NAME = 'BIOC E2E Settings Test';
const SETTINGS_OTHER_COURSE_NAME = 'BIOC E2E Settings Other Owner';
const SETTINGS_COPY_NAME_PREFIX = 'BIOC E2E Settings Copy';
const SETTINGS_TEST_COURSE_IDS = [SETTINGS_COURSE_ID, SETTINGS_OTHER_COURSE_ID];
const VALID_API_KEY = 'sk-test-settings-transfer';

let instructorId;
let freshInstructorId;
let taId;
let originalGlobalSettings = null;
let originalLLMSettings = null;
let originalSuperCourseSettings = null;
let originalInstructorSystemAdmin = false;
let originalFreshSystemAdmin = false;
let originalInstructorPreferences;
let originalFreshInstructorPreferences;

async function withDb(fn) {
    if (!process.env.MONGO_URI) {
        throw new Error('MONGO_URI not set; cannot run instructor settings e2e tests.');
    }
    const client = new MongoClient(process.env.MONGO_URI);
    await client.connect();
    try {
        return await fn(client.db());
    } finally {
        await client.close();
    }
}

async function getUserByUsername(username) {
    return withDb(async (db) => {
        const user = await db.collection('users').findOne({ username });
        if (!user) throw new Error(`User ${username} not found in DB.`);
        return user;
    });
}

async function setSystemAdmin(userId, isAdmin) {
    await withDb(async (db) => {
        if (isAdmin) {
            await db.collection('users').updateOne(
                { userId },
                { $set: { 'permissions.systemAdmin': true, updatedAt: new Date() } }
            );
            return;
        }

        await db.collection('users').updateOne(
            { userId },
            { $unset: { 'permissions.systemAdmin': '' }, $set: { updatedAt: new Date() } }
        );
    });
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

function deepClone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

async function restoreUserPreferences(userId, preferences) {
    await withDb(async (db) => {
        if (preferences === undefined) {
            await db.collection('users').updateOne(
                { userId },
                { $unset: { preferences: '' }, $set: { updatedAt: new Date() } }
            );
            return;
        }

        await db.collection('users').updateOne(
            { userId },
            { $set: { preferences: deepClone(preferences), updatedAt: new Date() } }
        );
    });
}

function buildSettingsCourse({
    courseId,
    courseName,
    ownerId,
    status = 'active',
    includeSettings = true,
}) {
    const now = new Date();
    const course = {
        courseId,
        courseName,
        courseCode: `${courseId}-STU`,
        instructorCourseCode: `${courseId}-INS`,
        instructorId: ownerId,
        instructors: [ownerId],
        tas: [taId],
        taPermissions: {
            [taId]: {
                materials: true, questions: true, flags: true, roster: true,
                transcripts: true, settings: true,
                updatedAt: now,
            },
        },
        courseDescription: '',
        assessmentCriteria: '',
        courseMaterials: [],
        approvedStruggleTopics: ['Cell signaling'],
        courseStructure: { weeks: 2, lecturesPerWeek: 1, totalUnits: 2 },
        isOnboardingComplete: true,
        status,
        lectures: [
            {
                name: 'Unit 1',
                displayName: 'Intro Unit',
                isPublished: true,
                learningObjectives: ['Describe ATP synthesis'],
                passThreshold: 1,
                documents: [],
                assessmentQuestions: [
                    {
                        questionId: 'settings-q1',
                        questionType: 'true-false',
                        question: 'ATP stores usable cellular energy.',
                        correctAnswer: 'true',
                        isActive: true,
                    },
                ],
                createdAt: now,
                updatedAt: now,
            },
            {
                name: 'Unit 2',
                displayName: 'Advanced Unit',
                isPublished: true,
                learningObjectives: ['Explain membrane gradients'],
                passThreshold: 1,
                documents: [],
                assessmentQuestions: [
                    {
                        questionId: 'settings-q2',
                        questionType: 'short-answer',
                        question: 'What does a proton gradient store?',
                        correctAnswer: 'Potential energy',
                        isActive: true,
                    },
                ],
                createdAt: now,
                updatedAt: now,
            },
        ],
        createdAt: now,
        updatedAt: now,
    };

    if (includeSettings) {
        course.prompts = {
            base: 'Seed base prompt',
            protege: 'Seed protege prompt',
            tutor: 'Seed tutor prompt',
            explain: 'Seed explain prompt',
            directive: 'Seed directive prompt',
            quizHelp: 'Seed quiz help prompt',
            chatSummary: 'Seed chat summary prompt',
            studentIdleTimeout: 180,
            studentSessionTimeout: 1800,
        };
        course.isAdditiveRetrieval = false;
        course.quizSettings = {
            enabled: true,
            testableUnits: ['Unit 1'],
            allowLectureMaterialAccess: true,
            allowSourceAttributionDownloads: false,
        };
        course.anonymizeStudents = {
            [ownerId]: {
                enabled: false,
                updatedAt: now,
            },
        };
        course.questionPrompts = {
            systemPrompt: 'Seed question system prompt',
            trueFalse: 'Seed true false prompt',
            multipleChoice: 'Seed multiple choice prompt',
            shortAnswer: 'Seed short answer prompt',
        };
        course.mentalHealthDetectionPrompt = 'Seed mental health detection prompt';
        course.superchatIds = [];
        course.ragSettings = {
            student: { topK: 6 },
        };
    }

    return course;
}

async function cleanupSettingsCourses() {
    await withDb(async (db) => {
        const copyCourses = await db.collection('courses')
            .find(
                { courseName: { $regex: `^${SETTINGS_COPY_NAME_PREFIX}` } },
                { projection: { courseId: 1 } }
            )
            .toArray();
        const courseIds = [
            ...SETTINGS_TEST_COURSE_IDS,
            ...copyCourses.map((course) => course.courseId),
        ];

        await db.collection('courses').deleteMany({
            $or: [
                { courseId: { $in: SETTINGS_TEST_COURSE_IDS } },
                { courseName: { $regex: `^${SETTINGS_COPY_NAME_PREFIX}` } },
            ],
        });
        await db.collection('documents').deleteMany({ courseId: { $in: courseIds } });
    });
}

async function resetSettingsData() {
    await cleanupSettingsCourses();
    await withDb(async (db) => {
        await db.collection('settings').updateOne(
            { _id: 'global' },
            { $set: { allowLocalLogin: true, updatedAt: new Date() } },
            { upsert: true }
        );
        // Seed the per-platform shape explicitly. The legacy flat `{ model }`
        // form is still read, but it maps to whichever platform LLM_PROVIDER
        // names, which would make these assertions depend on the local .env.
        await db.collection('settings').updateOne(
            { _id: 'llm' },
            {
                $set: {
                    providers: {
                        openai: { chatModel: 'gpt-5-nano', embeddingModel: 'text-embedding-3-small', reasoningEffort: 'minimal' },
                    },
                    updatedAt: new Date(),
                },
                $unset: { model: '', reasoningEffort: '' },
            },
            { upsert: true }
        );
        await db.collection('settings').updateOne(
            { _id: 'superCourseChat' },
            {
                $set: {
                    studentTopK: 9,
                    instructorTopK: 10,
                    includeInactiveCourses: true,
                    showStudentSuperCourse: true,
                    instructorPrompt: 'Seed instructor super prompt',
                    studentPrompt: 'Seed student super prompt',
                    updatedAt: new Date(),
                },
            },
            { upsert: true }
        );

        await db.collection('courses').insertMany([
            buildSettingsCourse({
                courseId: SETTINGS_COURSE_ID,
                courseName: SETTINGS_COURSE_NAME,
                ownerId: instructorId,
            }),
            buildSettingsCourse({
                courseId: SETTINGS_OTHER_COURSE_ID,
                courseName: SETTINGS_OTHER_COURSE_NAME,
                ownerId: freshInstructorId,
                includeSettings: false,
            }),
        ]);
    });
}

async function readCourse(courseId = SETTINGS_COURSE_ID) {
    return withDb((db) => db.collection('courses').findOne({ courseId }));
}

async function findCourseByName(courseName) {
    return withDb((db) => db.collection('courses').findOne({ courseName }));
}

async function readSetting(id) {
    return withDb((db) => db.collection('settings').findOne({ _id: id }));
}

async function openSettings(page, courseId = SETTINGS_COURSE_ID) {
    await page.goto(`/instructor/settings?courseId=${courseId}`);
    await expect(page.locator('h1')).toHaveText('Settings', { timeout: 15_000 });
    await expect(page.locator('#base-prompt')).toHaveValue('Seed base prompt', { timeout: 15_000 });
    await expect(page.locator('#testable-units-container .loading-text')).toHaveCount(0, { timeout: 15_000 });
    await expect(page.locator('#transfer-unit-grid .transfer-unit-row')).toHaveCount(2, { timeout: 15_000 });
}

async function openSettingsPanel(page, panelName) {
    const hub = page.locator('#settings-hub');
    if (await hub.isVisible()) {
        await page.locator(`.settings-tile[data-panel="${panelName}"]`).click();
    } else {
        await page.locator(`.settings-rail-link[data-panel="${panelName}"]`).click();
    }

    await expect(page).toHaveURL(new RegExp(`#${panelName}$`));
    await expect(page.locator('#settings-hub')).toBeHidden();
    await expect(page.locator('#settings-panels')).toBeVisible();
    await expect(page.locator(`#settings-panel-${panelName}`)).toBeVisible();
    await expect(page.locator(`.settings-rail-link[data-panel="${panelName}"]`)).toHaveAttribute('aria-current', 'true');
}

async function returnToSettingsHub(page) {
    await page.locator('.settings-rail-back').click();
    await expect(page).toHaveURL(/\/instructor\/settings(?:\?[^#]*)?#?$/);
    await expect(page.locator('#settings-hub')).toBeVisible();
    await expect(page.locator('#settings-panels')).toBeHidden();
}

async function setInputChecked(page, selector, checked) {
    await page.evaluate(
        ({ selector, checked }) => {
            const input = /** @type {HTMLInputElement | null} */ (document.querySelector(selector));
            if (!input) throw new Error(`${selector} not found`);
            input.checked = checked;
            input.dispatchEvent(new Event('change', { bubbles: true }));
        },
        { selector, checked }
    );
}

function jsonResponse(body, status = 200) {
    return {
        status,
        contentType: 'application/json',
        body: JSON.stringify(body),
    };
}

async function setupMockedSettingsRoutes(page, options = {}) {
    const state = {
        canDeleteAll: true,
        courseId: 'MOCK-SETTINGS',
        courseName: 'Mock Settings Course',
        courseStatus: 'active',
        lectures: [
            {
                name: 'Unit 1',
                displayName: 'Intro Unit',
                isPublished: true,
                learningObjectives: ['Objective 1'],
                assessmentQuestions: [{ questionId: 'mock-q1' }],
            },
            {
                name: 'Unit 2',
                displayName: 'Advanced Unit',
                isPublished: true,
                learningObjectives: ['Objective 2'],
                assessmentQuestions: [{ questionId: 'mock-q2' }],
            },
        ],
        admins: [
            {
                email: TEST_USERS.instructor.email,
                displayName: 'E2E Instructor',
                lastLogin: null,
            },
            {
                email: TEST_USERS.instructor_fresh.email,
                displayName: '<Fresh & Admin>',
                lastLogin: 'not-a-date',
            },
        ],
        systemAdminListError: false,
        grantResult: { success: true },
        revokeResult: { success: true },
        promptResetResult: {
            success: true,
            prompts: {
                base: 'Default base prompt',
                protege: 'Default protege prompt',
                tutor: 'Default tutor prompt',
                explain: 'Default explain prompt',
                directive: 'Default directive prompt',
                quizHelp: 'Default quiz help prompt',
                chatSummary: 'Default chat summary prompt',
            },
        },
        mhResetResult: { success: true, prompt: 'Default detection prompt' },
        questionResetResult: {
            success: true,
            prompts: {
                systemPrompt: 'Default question system',
                trueFalse: 'Default true false',
                multipleChoice: 'Default multiple choice',
                shortAnswer: 'Default short answer',
            },
        },
        deleteAllResult: {
            success: true,
            data: { qdrantDeletedCount: 4, mongoDeletedCount: 9 },
        },
        promptSaveResult: { success: true },
        aiSettings: {
            superchatIds: [],
            ragSettings: { student: { topK: 6 } },
            defaults: { studentTopK: 3, minTopK: 1, maxTopK: 20 },
        },
        aiSettingsResetResult: {
            success: true,
            settings: {
                superchatIds: [],
                ragSettings: { student: { topK: 3 } },
            },
        },
        chatSurveySettings: {
            enabled: false,
            triggerMessageCount: 10,
            promptText: 'Was this chat helpful?',
            ratingPrompt: 'How useful was this conversation?',
            allowFreeText: false,
        },
        chatSurveyDefaults: {
            enabled: false,
            triggerMessageCount: 10,
            promptText: 'Was this chat helpful?',
            ratingPrompt: 'How useful was this conversation?',
            allowFreeText: false,
            minTriggerMessageCount: 2,
            maxTriggerMessageCount: 30,
        },
        superCourseSettings: {
            studentTopK: 9,
            instructorTopK: 10,
            includeInactiveCourses: true,
            showStudentSuperCourse: true,
            instructorPrompt: 'Mock instructor super prompt',
            studentPrompt: 'Mock student super prompt',
        },
        superCourseResetResult: {
            success: true,
            settings: {
                studentTopK: 8,
                instructorTopK: 8,
                includeInactiveCourses: false,
                showStudentSuperCourse: false,
                instructorPrompt: 'Default instructor super prompt',
                studentPrompt: 'Default student super prompt',
            },
        },
        // Buckets returned by GET /api/superchats. Empty by default; mocked tests
        // that exercise bucket management can override state.superchats.
        superchats: [],
        transferStatus: 200,
        transferResult: {
            success: true,
            data: {
                courseId: 'MOCK-SETTINGS-COPY',
                courseName: 'Mock Settings Copy',
                warnings: [],
            },
        },
        transferRequests: [],
        notesLlmKey: {
            status: 'valid',
            last4: 'mock',
            validatedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        },
        courseGetStatus: 200,
        courseGetResult: null,
        courseProvider: 'openai',
        lifecycleStatus: 200,
        lifecycleResult: { success: true },
        abortPaths: new Set(),
        ...options,
    };

    if (!(state.abortPaths instanceof Set)) {
        state.abortPaths = new Set(state.abortPaths);
    }

    await page.route('**/*', async (route) => {
        const requestUrl = new URL(route.request().url());
        const { pathname } = requestUrl;
        const method = route.request().method();

        if (state.abortPaths.has(pathname)) {
            await route.abort();
            return;
        }

        if (pathname === '/api/settings/can-delete-all') {
            await route.fulfill(jsonResponse({ success: true, canDeleteAll: state.canDeleteAll }));
            return;
        }

        if (pathname === '/api/settings/prompts') {
            if (method === 'POST') {
                await route.fulfill(jsonResponse(state.promptSaveResult));
                return;
            }

            if (!requestUrl.searchParams.has('courseId')) {
                await route.fulfill(jsonResponse({
                    success: true,
                    prompts: {
                        base: 'Default base prompt',
                        protege: 'Default protege prompt',
                        tutor: 'Default tutor prompt',
                        explain: 'Default explain prompt',
                        directive: 'Default directive prompt',
                        quizHelp: 'Default quiz help prompt',
                        chatSummary: 'Default chat summary prompt',
                        additiveRetrieval: true,
                        studentIdleTimeout: 240,
                        studentSessionTimeout: 1800,
                    },
                }));
                return;
            }

            await route.fulfill(jsonResponse({
                success: true,
                prompts: {
                    base: 'Mock base prompt',
                    protege: 'Mock protege prompt',
                    tutor: 'Mock tutor prompt',
                    explain: 'Mock explain prompt',
                    directive: 'Mock directive prompt',
                    quizHelp: 'Mock quiz help prompt',
                    chatSummary: 'Mock chat summary prompt',
                    additiveRetrieval: true,
                    studentIdleTimeout: 300,
                    studentSessionTimeout: 1800,
                },
            }));
            return;
        }

        if (pathname === '/api/settings/prompts/reset') {
            await route.fulfill(jsonResponse(state.promptResetResult));
            return;
        }

        if (pathname === '/api/settings/quiz') {
            if (method === 'POST') {
                await route.fulfill(jsonResponse({ success: true }));
                return;
            }

            await route.fulfill(jsonResponse({
                success: true,
                settings: {
                    enabled: false,
                    testableUnits: 'all',
                    allowLectureMaterialAccess: false,
                    allowSourceAttributionDownloads: true,
                },
            }));
            return;
        }

        if (pathname === '/api/settings/chat-survey') {
            if (method === 'POST') {
                const body = route.request().postDataJSON();
                state.chatSurveySettings = {
                    enabled: body.enabled === true,
                    triggerMessageCount: body.triggerMessageCount,
                    promptText: body.promptText,
                    ratingPrompt: body.ratingPrompt,
                    allowFreeText: body.allowFreeText === true,
                };
                await route.fulfill(jsonResponse({
                    success: true,
                    message: 'Chat survey settings saved successfully',
                    settings: state.chatSurveySettings,
                    defaults: state.chatSurveyDefaults,
                }));
                return;
            }

            await route.fulfill(jsonResponse({
                success: true,
                settings: state.chatSurveySettings,
                defaults: state.chatSurveyDefaults,
            }));
            return;
        }

        if (pathname.startsWith('/api/courses/') && pathname.endsWith('/transfer')) {
            try {
                state.transferRequests.push(route.request().postDataJSON());
            } catch (error) {
                state.transferRequests.push(null);
            }
            await route.fulfill(jsonResponse(state.transferResult, state.transferStatus));
            return;
        }

        if (pathname.startsWith('/api/courses/') && (pathname.endsWith('/llm-key') || pathname.endsWith('/llm-key/test'))) {
            await route.fulfill(jsonResponse({
                success: true,
                message: 'Course API key is valid',
                llmKey: {
                    status: 'valid',
                    last4: 'mock',
                    validatedAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                },
            }));
            return;
        }

        if (pathname.startsWith('/api/courses/') && pathname.endsWith('/publish-status')) {
            await route.fulfill(jsonResponse({ success: true, isPublished: true }));
            return;
        }

        if (pathname.startsWith('/api/courses/')) {
            if (method === 'PUT') {
                await route.fulfill(jsonResponse(state.lifecycleResult, state.lifecycleStatus));
                return;
            }

            const courseId = decodeURIComponent(pathname.split('/').pop() || state.courseId);
            if (state.courseGetResult) {
                await route.fulfill(jsonResponse(state.courseGetResult, state.courseGetStatus));
                return;
            }

            await route.fulfill(jsonResponse({
                success: true,
                data: {
                    courseId,
                    name: courseId === 'MOCK-SETTINGS-COPY' ? 'Mock Settings Copy' : state.courseName,
                    courseName: courseId === 'MOCK-SETTINGS-COPY' ? 'Mock Settings Copy' : state.courseName,
                    status: state.courseStatus,
                    llmProvider: state.courseProvider,
                    lectures: state.lectures,
                },
            }));
            return;
        }

        if (pathname === '/api/settings/anonymize-students') {
            if (method === 'POST') {
                await route.fulfill(jsonResponse({ success: true }));
                return;
            }

            await route.fulfill(jsonResponse({ success: true, enabled: true }));
            return;
        }

        if (pathname === '/api/settings/mental-health-prompt') {
            if (method === 'POST') {
                await route.fulfill(jsonResponse({ success: true }));
                return;
            }

            await route.fulfill(jsonResponse({ success: true, prompt: 'Mock detection prompt' }));
            return;
        }

        if (pathname === '/api/settings/mental-health-prompt/reset') {
            await route.fulfill(jsonResponse(state.mhResetResult));
            return;
        }

        if (pathname === '/api/settings/global') {
            if (method === 'POST') {
                await route.fulfill(jsonResponse({ success: true }));
                return;
            }

            await route.fulfill(jsonResponse({ success: true, settings: { allowLocalLogin: false } }));
            return;
        }

        if (pathname === '/api/settings/llm') {
            if (method === 'POST') {
                await route.fulfill(jsonResponse({ success: true }));
                return;
            }

            // Model settings are grouped per platform. `settings` is kept as the
            // legacy single-platform mirror older clients still read.
            await route.fulfill(jsonResponse({
                success: true,
                platforms: [
                    {
                        provider: 'openai',
                        label: 'OpenAI Chat GPT',
                        chatModel: 'gpt-4.1-mini',
                        embeddingModel: 'text-embedding-3-small',
                        reasoningEffort: 'minimal',
                        supportsReasoning: false,
                        allowedModels: ['gpt-4.1-mini', 'gpt-5-nano', 'gpt-5.4-nano', 'gpt-5.6-luna'],
                        allowedEmbeddingModels: ['text-embedding-3-small', 'text-embedding-3-large'],
                        reasoningEffortsByModel: {
                            'gpt-4.1-mini': [],
                            'gpt-5-nano': ['minimal', 'low', 'medium', 'high'],
                            'gpt-5.4-nano': ['none', 'low', 'medium', 'high', 'xhigh'],
                            'gpt-5.6-luna': ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
                        },
                        defaultReasoningEffortByModel: {
                            'gpt-5-nano': 'minimal', 'gpt-5.4-nano': 'low', 'gpt-5.6-luna': 'low',
                        },
                        collection: 'biocbot_documents',
                        vectorSize: 1536,
                        pendingEmbedding: null,
                    },
                    {
                        provider: 'ubc-llm-sandbox',
                        label: 'UBC On-Premise LLM',
                        chatModel: 'qwen3.6-35b-a3b',
                        embeddingModel: 'qwen3-embedding-0.6b',
                        reasoningEffort: 'none',
                        supportsReasoning: true,
                        allowedModels: ['qwen3.6-35b-a3b', 'gpt-oss-120b'],
                        allowedEmbeddingModels: ['qwen3-embedding-0.6b'],
                        reasoningEffortsByModel: {
                            'qwen3.6-35b-a3b': ['none', 'low', 'medium', 'high'],
                            'gpt-oss-120b': ['low', 'medium', 'high'],
                        },
                        defaultReasoningEffortByModel: { 'qwen3.6-35b-a3b': 'none', 'gpt-oss-120b': 'low' },
                        collection: 'biocbot_documents_qwen3_embedding_0_6b',
                        vectorSize: 1024,
                        pendingEmbedding: null,
                    },
                ],
                settings: { model: 'gpt-4.1-mini', reasoningEffort: 'minimal', provider: 'openai' },
            }));
            return;
        }

        if (pathname === '/api/settings/notes-llm-key' || pathname === '/api/settings/notes-llm-key/test') {
            await route.fulfill(jsonResponse({
                success: true,
                message: 'Notes API key is valid',
                llmKey: state.notesLlmKey,
            }));
            return;
        }

        if (pathname === '/api/settings/instructor-superchat-llm-key' || pathname === '/api/settings/instructor-superchat-llm-key/test') {
            await route.fulfill(jsonResponse({
                success: true,
                message: 'Instructor Super Course chat API key is valid',
                llmKey: {
                    status: 'valid',
                    last4: 'mock',
                    validatedAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                },
                aiAvailable: true,
            }));
            return;
        }

        if (pathname === '/api/settings/ai-settings') {
            if (method === 'PUT') {
                await route.fulfill(jsonResponse({ success: true }));
                return;
            }

            await route.fulfill(jsonResponse({
                success: true,
                settings: state.aiSettings,
                availableSuperchats: state.superchats || [],
            }));
            return;
        }

        // Superchat bucket CRUD (instructor/admin). The mocked settings page calls
        // GET /api/superchats (list) and GET /api/superchats/:id (editor) on load.
        if (pathname === '/api/superchats') {
            await route.fulfill(jsonResponse({ success: true, superchats: state.superchats || [] }));
            return;
        }
        if (pathname.startsWith('/api/superchats/')) {
            if (pathname.endsWith('/llm-key') || pathname.endsWith('/llm-key/test')) {
                await route.fulfill(jsonResponse({
                    success: true,
                    message: 'Bucket API key is valid',
                    llmKey: {
                        status: 'valid',
                        last4: 'mock',
                        validatedAt: new Date().toISOString(),
                        updatedAt: new Date().toISOString(),
                    },
                }));
                return;
            }

            if (method === 'GET') {
                const id = pathname.split('/').pop();
                const bucket = (state.superchats || []).find((b) => b.superchatId === id);
                await route.fulfill(jsonResponse(
                    bucket ? { success: true, superchat: { ...bucket, settings: state.superCourseSettings } } : { success: false, message: 'Not found' },
                    bucket ? 200 : 404
                ));
                return;
            }
            await route.fulfill(jsonResponse({ success: true }));
            return;
        }

        if (pathname === '/api/settings/ai-settings/reset') {
            await route.fulfill(jsonResponse(state.aiSettingsResetResult));
            return;
        }

        if (pathname === '/api/settings/super-course-chat') {
            if (method === 'PUT') {
                await route.fulfill(jsonResponse({ success: true }));
                return;
            }

            await route.fulfill(jsonResponse({
                success: true,
                settings: state.superCourseSettings,
            }));
            return;
        }

        if (pathname === '/api/settings/super-course-chat/reset') {
            await route.fulfill(jsonResponse(state.superCourseResetResult));
            return;
        }

        if (pathname === '/api/settings/question-prompts') {
            if (method === 'POST') {
                await route.fulfill(jsonResponse({ success: true }));
                return;
            }

            await route.fulfill(jsonResponse({
                success: true,
                prompts: {
                    systemPrompt: 'Mock question system prompt',
                    trueFalse: 'Mock true false prompt',
                    multipleChoice: 'Mock multiple choice prompt',
                    shortAnswer: 'Mock short answer prompt',
                },
            }));
            return;
        }

        if (pathname === '/api/settings/question-prompts/reset') {
            await route.fulfill(jsonResponse(state.questionResetResult));
            return;
        }

        if (pathname === '/api/settings/system-admins') {
            if (method === 'POST') {
                await route.fulfill(jsonResponse(state.grantResult));
                return;
            }

            if (state.systemAdminListError) {
                await route.fulfill(jsonResponse({ success: false, error: 'Admin list unavailable' }, 500));
                return;
            }

            await route.fulfill(jsonResponse({ success: true, admins: state.admins }));
            return;
        }

        if (pathname === '/api/settings/system-admins/revoke') {
            await route.fulfill(jsonResponse(state.revokeResult));
            return;
        }

        if (pathname === '/api/qdrant/delete-all-collections') {
            await route.fulfill(jsonResponse(state.deleteAllResult));
            return;
        }

        if (pathname === '/api/auth/set-course') {
            await route.fulfill(jsonResponse({ success: true }));
            return;
        }

        await route.continue();
    });

    return state;
}

async function openMockedSettings(page, options = {}) {
    const state = await setupMockedSettingsRoutes(page, options);
    await page.goto(`/instructor/settings?courseId=${state.courseId}`);
    await expect(page.locator('h1')).toHaveText('Settings', { timeout: 15_000 });
    await expect(page.locator('#base-prompt')).toHaveValue('Mock base prompt', { timeout: 15_000 });
    await expect(page.locator('#testable-units-container .loading-text')).toHaveCount(0, { timeout: 15_000 });
    return state;
}

test.beforeAll(async () => {
    const instructor = await getUserByUsername(TEST_USERS.instructor.username);
    const freshInstructor = await getUserByUsername(TEST_USERS.instructor_fresh.username);
    const ta = await getUserByUsername(TEST_USERS.ta.username);
    instructorId = instructor.userId;
    freshInstructorId = freshInstructor.userId;
    taId = ta.userId;
    originalInstructorSystemAdmin = instructor.permissions?.systemAdmin === true;
    originalFreshSystemAdmin = freshInstructor.permissions?.systemAdmin === true;
    originalInstructorPreferences = deepClone(instructor.preferences);
    originalFreshInstructorPreferences = deepClone(freshInstructor.preferences);
    originalGlobalSettings = await readSetting('global');
    originalLLMSettings = await readSetting('llm');
    originalSuperCourseSettings = await readSetting('superCourseChat');
});

test.beforeEach(async () => {
    await setSystemAdmin(instructorId, false);
    await setSystemAdmin(freshInstructorId, false);
    await resetSettingsData();
});

test.afterEach(async () => {
    await setSystemAdmin(instructorId, false);
    await setSystemAdmin(freshInstructorId, false);
    await restoreUserPreferences(instructorId, originalInstructorPreferences);
    await restoreUserPreferences(freshInstructorId, originalFreshInstructorPreferences);
    await restoreSettingDoc('global', originalGlobalSettings);
    await restoreSettingDoc('llm', originalLLMSettings);
    await restoreSettingDoc('superCourseChat', originalSuperCourseSettings);
});

test.afterAll(async () => {
    await cleanupSettingsCourses();
    await setSystemAdmin(instructorId, originalInstructorSystemAdmin);
    await setSystemAdmin(freshInstructorId, originalFreshSystemAdmin);
    await restoreUserPreferences(instructorId, originalInstructorPreferences);
    await restoreUserPreferences(freshInstructorId, originalFreshInstructorPreferences);
    await restoreSettingDoc('global', originalGlobalSettings);
    await restoreSettingDoc('llm', originalLLMSettings);
    await restoreSettingDoc('superCourseChat', originalSuperCourseSettings);
});

test.describe('Instructor settings UI', () => {
    test.use({ storageState: storageStatePath('instructor') });

    test('hides system-admin-only settings for a regular instructor and loads course-scoped settings', async ({ page }) => {
        await openSettings(page);

        await expect(page.locator('#settings-hub')).toBeVisible();
        await expect(page.locator('#settings-panels')).toBeHidden();
        await expect(page.locator('.settings-tile:visible')).toHaveCount(7);
        await expect(page.locator('.settings-tile[data-panel="course-basics"]')).toContainText('Course basics');
        await expect(page.locator('.settings-tile[data-panel="student-chat"]')).toContainText('Student chat');
        await expect(page.locator('.settings-tile[data-panel="super-course"]')).toContainText('Super course');
        await expect(page.locator('#admin-tile-group')).toBeHidden();
        await expect(page.locator('#admin-rail-group')).toBeHidden();
        await expect(page.locator('#database-management-section')).toBeHidden();
        await expect(page.locator('#login-restriction-section')).toBeHidden();
        await expect(page.locator('#question-generation-section')).toBeHidden();
        await expect(page.locator('#mental-health-detection-section')).toBeHidden();
        await expect(page.locator('#system-admin-section')).toBeHidden();
        await expect(page.locator('#llm-model-section')).toBeHidden();

        await openSettingsPanel(page, 'prompts');
        await expect(page.locator('#chat-summary-prompt')).toHaveValue('Seed chat summary prompt');
        await returnToSettingsHub(page);

        await openSettingsPanel(page, 'student-chat');
        await expect(page.locator('#student-chat-section')).toBeVisible();
        await expect(page.locator('#student-chat-topk-input')).toHaveValue('6');
        await expect(page.locator('#additive-retrieval-toggle')).not.toBeChecked();
        await expect(page.locator('#additional-material-secondary-toggle')).not.toBeChecked();
        await expect(page.locator('#source-attribution-download-toggle')).not.toBeChecked();

        await openSettingsPanel(page, 'super-course');
        await expect(page.locator('#course-superchats-section')).toBeVisible();
        await expect(page.locator('#super-course-chat-section')).toBeVisible();

        await openSettingsPanel(page, 'privacy');
        await expect(page.locator('#idle-timeout-input')).toHaveValue('3');
        await expect(page.locator('#session-timeout-input')).toHaveValue('30');
        await expect(page.locator('#anonymize-students-toggle')).not.toBeChecked();

        await openSettingsPanel(page, 'quiz');
        await expect(page.locator('#quiz-enabled-toggle')).toBeChecked();
        await expect(page.locator('.testable-unit-checkbox[value="Unit 1"]')).toBeChecked();
        await expect(page.locator('.testable-unit-checkbox[value="Unit 2"]')).not.toBeChecked();
    });

    test('navigates settings hub tiles, rail links, and back control', async ({ page }) => {
        await openSettings(page);

        await openSettingsPanel(page, 'student-chat');
        await expect(page.locator('#settings-panel-student-chat .settings-panel-title')).toHaveText('Student chat');
        await expect(page.locator('.settings-rail-link[aria-current="true"]')).toHaveText('Student chat');

        await openSettingsPanel(page, 'privacy');
        await expect(page.locator('#settings-panel-privacy .settings-panel-title')).toHaveText('Privacy & sessions');
        await expect(page.locator('.settings-rail-link[aria-current="true"]')).toHaveText('Privacy & sessions');
        await expect(page.locator('.settings-rail-link[data-panel="student-chat"]')).not.toHaveAttribute('aria-current', 'true');

        await returnToSettingsHub(page);
        await openSettingsPanel(page, 'lifecycle');
        await expect(page.locator('#settings-panel-lifecycle .settings-panel-title')).toHaveText('Course lifecycle');
    });

    test('saves prompts, retrieval, idle timeout, quiz download, and anonymize settings for the selected course', async ({ page }) => {
        await openSettings(page);

        await openSettingsPanel(page, 'prompts');
        await page.locator('#base-prompt').fill('Updated base prompt from settings UI');
        await page.locator('#protege-prompt').fill('Updated protege prompt from settings UI');
        await page.locator('#tutor-prompt').fill('Updated tutor prompt from settings UI');
        await page.locator('#explain-prompt').fill('Updated explain prompt from settings UI');
        await page.locator('#directive-prompt').fill('Updated directive prompt from settings UI');
        await page.locator('#quiz-help-prompt').fill('Updated quiz help prompt from settings UI');
        await page.locator('#chat-summary-prompt').fill('Updated chat summary prompt from settings UI');
        await page.locator('#save-prompts').click();
        await expect(page.locator('.notification.success', { hasText: 'Prompts saved' })).toBeVisible({
            timeout: 10_000,
        });

        await openSettingsPanel(page, 'privacy');
        await page.locator('#idle-timeout-input').fill('5.5');
        await page.locator('#session-timeout-input').fill('45');
        await setInputChecked(page, '#anonymize-students-toggle', true);
        await page.locator('#save-privacy-settings').click();
        await expect(page.locator('.notification.success', { hasText: 'Privacy settings saved' })).toBeVisible({
            timeout: 10_000,
        });

        await openSettingsPanel(page, 'student-chat');
        await setInputChecked(page, '#additive-retrieval-toggle', true);
        await setInputChecked(page, '#additional-material-secondary-toggle', true);
        await setInputChecked(page, '#source-attribution-download-toggle', true);
        await page.locator('#save-student-chat').click();
        await expect(page.locator('.notification.success', { hasText: 'Student chat settings saved' })).toBeVisible({
            timeout: 10_000,
        });

        await expect.poll(async () => {
            const course = await readCourse();
            return {
                base: course.prompts?.base,
                protege: course.prompts?.protege,
                tutor: course.prompts?.tutor,
                explain: course.prompts?.explain,
                directive: course.prompts?.directive,
                quizHelp: course.prompts?.quizHelp,
                chatSummary: course.prompts?.chatSummary,
                studentIdleTimeout: course.prompts?.studentIdleTimeout,
                studentSessionTimeout: course.prompts?.studentSessionTimeout,
                isAdditiveRetrieval: course.isAdditiveRetrieval,
                additionalMaterialSecondarySearch: course.additionalMaterialSecondarySearch,
                allowSourceAttributionDownloads: course.quizSettings?.allowSourceAttributionDownloads,
                anonymizeEnabled: course.anonymizeStudents?.[instructorId]?.enabled,
            };
        }, { timeout: 10_000 }).toMatchObject({
            base: 'Updated base prompt from settings UI',
            protege: 'Updated protege prompt from settings UI',
            tutor: 'Updated tutor prompt from settings UI',
            explain: 'Updated explain prompt from settings UI',
            directive: 'Updated directive prompt from settings UI',
            quizHelp: 'Updated quiz help prompt from settings UI',
            chatSummary: 'Updated chat summary prompt from settings UI',
            studentIdleTimeout: 330,
            studentSessionTimeout: 2700,
            isAdditiveRetrieval: true,
            additionalMaterialSecondarySearch: true,
            allowSourceAttributionDownloads: true,
            anonymizeEnabled: true,
        });
    });

    test('shows admin settings, enforces newer GPT-5 reasoning rules, and saves global admin controls', async ({ page }) => {
        await setSystemAdmin(instructorId, true);
        await openSettings(page);

        await expect(page.locator('#admin-tile-group')).toBeVisible();
        await expect(page.locator('#admin-rail-group')).toBeHidden();

        await openSettingsPanel(page, 'admin-safety');
        await expect(page.locator('#question-generation-section')).toBeVisible();
        await expect(page.locator('#mental-health-detection-section')).toBeVisible();
        await expect(page.locator('#mental-health-detection-prompt')).toHaveValue('Seed mental health detection prompt');
        await expect(page.locator('#question-system-prompt')).toHaveValue(
            /^Seed question system prompt[\s\S]*CRITICAL LaTeX FORMATTING[\s\S]*CRITICAL SMILES FORMATTING/
        );

        await openSettingsPanel(page, 'student-chat');
        await expect(page.locator('#student-chat-section')).toBeVisible();
        await expect(page.locator('#student-chat-topk-input')).toHaveValue('6');
        // NOTE: Super Course bucket membership + bucket management are covered by
        // the dedicated superchats specs; this test focuses on the admin-only
        // controls (LLM model rules, login restriction) plus per-course Top-K.

        await openSettingsPanel(page, 'super-course');
        await expect(page.locator('#course-superchats-section')).toBeVisible();
        await expect(page.locator('#super-course-chat-section')).toBeVisible();

        await openSettingsPanel(page, 'admin-platform');
        await expect(page.locator('#admin-rail-group')).toBeVisible();
        await expect(page.locator('#llm-model-section')).toBeVisible();
        await expect(page.locator('#llm-model-select')).toHaveValue('gpt-5-nano');
        await expect(page.locator('#llm-reasoning-item')).toBeVisible();
        await expect(page.locator('#llm-reasoning-select')).toHaveValue('minimal');

        await page.locator('#llm-model-select').selectOption('gpt-5.6-luna');
        await expect(page.locator('#llm-reasoning-select')).toHaveValue('low');
        await expect(page.locator('#llm-reasoning-select option[value="minimal"]')).toBeDisabled();
        await expect(page.locator('#llm-reasoning-select option[value="max"]')).toBeEnabled();
        await page.locator('#save-llm-settings').click();
        await expect(page.locator('.notification.success', { hasText: 'Model settings saved' })).toBeVisible({
            timeout: 10_000,
        });

        await openSettingsPanel(page, 'admin-access');
        await expect(page.locator('#login-restriction-section')).toBeVisible();
        await expect(page.locator('#system-admin-section')).toBeVisible();
        await setInputChecked(page, '#allow-local-login-toggle', false);
        await page.locator('#save-access-settings').click();
        await expect(page.locator('.notification.success', { hasText: 'Login settings saved' })).toBeVisible({
            timeout: 10_000,
        });

        await openSettingsPanel(page, 'student-chat');
        await page.locator('#student-chat-topk-input').fill('4');
        await page.locator('#save-student-chat').click();
        await expect(page.locator('.notification.success', { hasText: 'Student chat settings saved' })).toBeVisible({
            timeout: 10_000,
        });

        await expect.poll(async () => {
            const [globalSettings, llmSettings, course] = await Promise.all([
                readSetting('global'),
                readSetting('llm'),
                readCourse(),
            ]);
            return {
                allowLocalLogin: globalSettings?.allowLocalLogin,
                // Model settings are stored per platform under `providers`;
                // the GPT controls on this page write providers.openai.
                model: llmSettings?.providers?.openai?.chatModel,
                reasoningEffort: llmSettings?.providers?.openai?.reasoningEffort,
                studentTopK: course?.ragSettings?.student?.topK,
            };
        }, { timeout: 10_000 }).toMatchObject({
            allowLocalLogin: false,
            model: 'gpt-5.6-luna',
            reasoningEffort: 'low',
            studentTopK: 4,
        });
    });

    test('deactivates and reactivates the selected course from the lifecycle panel', async ({ page }) => {
        await openSettings(page);
        await openSettingsPanel(page, 'lifecycle');

        await expect(page.locator('#course-status-badge')).toHaveText('Active');
        page.once('dialog', (dialog) => dialog.accept());
        await page.locator('#toggle-course-active-btn').click();

        await expect(page.locator('.notification.success', { hasText: 'Course deactivated' })).toBeVisible({
            timeout: 10_000,
        });
        await expect(page.locator('#course-status-badge')).toHaveText('Inactive');
        await expect.poll(async () => (await readCourse()).status, { timeout: 10_000 }).toBe('inactive');

        page.once('dialog', (dialog) => dialog.accept());
        await page.locator('#toggle-course-active-btn').click();

        await expect(page.locator('.notification.success', { hasText: 'Course reactivated successfully' })).toBeVisible({
            timeout: 10_000,
        });
        await expect(page.locator('#course-status-badge')).toHaveText('Active');
        await expect.poll(async () => (await readCourse()).status, { timeout: 10_000 }).toBe('active');
    });

    test('previews transfer selections and creates a course copy with selected units and options', async ({ page }) => {
        const copyName = `${SETTINGS_COPY_NAME_PREFIX} ${Date.now()}`;
        await openSettings(page);
        await openSettingsPanel(page, 'lifecycle');

        await page.locator('#transfer-course-name').fill(copyName);
        await page.locator('#transfer-course-api-key').fill(VALID_API_KEY);
        await setInputChecked(page, '#transfer-settings-toggle', false);
        await setInputChecked(page, '#transfer-tas-toggle', false);
        await setInputChecked(page, '#deactivate-source-after-transfer-toggle', true);
        await setInputChecked(page, '.transfer-unit-row[data-unit-name="Unit 2"] .transfer-objectives-checkbox', false);
        await setInputChecked(page, '.transfer-unit-row[data-unit-name="Unit 1"] .transfer-questions-checkbox', false);

        await page.locator('#transfer-course-btn').click();

        const modal = page.locator('#transfer-course-modal');
        await expect(modal).toHaveClass(/show/);
        await expect(page.locator('#transfer-modal-summary')).toContainText(`New course name: ${copyName}`);
        await expect(page.locator('#transfer-modal-summary')).toContainText('AI platform: OpenAI Chat GPT.');
        await expect(page.locator('#transfer-modal-summary')).toContainText('A new API key for OpenAI Chat GPT will be validated before the copy is created.');
        await expect(page.locator('#transfer-modal-summary')).toContainText('2 of 2 units will copy docs and existing chunks.');
        await expect(page.locator('#transfer-modal-summary')).toContainText('1 of 2 units will copy learning objectives.');
        await expect(page.locator('#transfer-modal-summary')).toContainText('1 of 2 units will copy assessment questions.');
        await expect(page.locator('#transfer-modal-summary')).toContainText('Course settings will not be copied.');
        await expect(page.locator('#transfer-modal-summary')).toContainText('TAs will not be copied.');
        await expect(page.locator('#transfer-modal-summary')).toContainText('The source course will be deactivated after the transfer finishes.');

        await page.locator('#transfer-modal-confirm').click();

        await expect.poll(async () => Boolean(await findCourseByName(copyName)), { timeout: 15_000 }).toBe(true);
        const copiedCourse = await findCourseByName(copyName);
        const unit1 = copiedCourse.lectures.find((lecture) => lecture.name === 'Unit 1');
        const unit2 = copiedCourse.lectures.find((lecture) => lecture.name === 'Unit 2');

        await expect(page).toHaveURL(new RegExp(`/instructor/settings\\?courseId=${copiedCourse.courseId}`), {
            timeout: 15_000,
        });

        // The copy document appears part-way through the request; deactivating
        // the source is one of the last things the handler does. Read the source
        // only once the redirect proves the whole transfer returned.
        const sourceCourse = await readCourse();
        expect(sourceCourse.status).toBe('inactive');
        expect(copiedCourse.status).toBe('active');
        expect(copiedCourse.instructorId).toBe(instructorId);
        expect(copiedCourse.tas).toEqual([]);
        expect(copiedCourse.activeLlmProvider).toBe('openai');
        expect(copiedCourse.llmCredentials?.openai?.status).toBe('valid');
        expect(copiedCourse.quizSettings).toBeUndefined();
        expect(copiedCourse.prompts).toBeUndefined();
        expect(unit1.isPublished).toBe(false);
        expect(unit2.isPublished).toBe(false);
        expect(unit1.learningObjectives).toEqual(['Describe ATP synthesis']);
        expect(unit1.assessmentQuestions).toEqual([]);
        expect(unit2.learningObjectives).toEqual([]);
        expect(unit2.assessmentQuestions).toHaveLength(1);
    });

    test('sends the selected UBC Sandbox platform when copying an OpenAI course', async ({ page }) => {
        const state = await openMockedSettings(page, { canDeleteAll: false, courseProvider: 'openai' });
        await openSettingsPanel(page, 'lifecycle');

        await expect(page.locator('#transfer-llm-provider-openai')).toBeChecked();
        await setInputChecked(page, '#transfer-llm-provider-ubc-llm-sandbox', true);
        await expect(page.locator('label[for="transfer-course-api-key"]')).toHaveText('UBC On-Premise LLM API key for new course');
        await expect(page.locator('#transfer-course-api-key')).toHaveAttribute('placeholder', 'UBC LLM Sandbox API key');
        await expect(page.locator('#transfer-llm-platform-help')).toContainText('Contact the LTIC team');

        await page.locator('#transfer-course-name').fill('Sandbox Course Copy');
        await page.locator('#transfer-course-api-key').fill('sbx-test-course-copy');
        await page.locator('#transfer-course-btn').click();

        await expect(page.locator('#transfer-modal-summary')).toContainText('AI platform: UBC On-Premise LLM.');
        await expect(page.locator('#transfer-modal-summary')).toContainText('A new API key for UBC On-Premise LLM will be validated before the copy is created.');

        state.transferStatus = 400;
        state.transferResult = {
            success: false,
            data: { courseId: '', courseName: '', warnings: [] },
        };
        await page.locator('#transfer-modal-confirm').click();

        await expect.poll(() => state.transferRequests.length).toBe(1);
        const capturedRequest = /** @type {any} */ (state.transferRequests[0]);
        expect(capturedRequest).toMatchObject({
            newCourseName: 'Sandbox Course Copy',
            apiKey: 'sbx-test-course-copy',
            llmProvider: 'ubc-llm-sandbox',
        });
    });

    test('resets section defaults after confirmation', async ({ page }) => {
        await openMockedSettings(page, { canDeleteAll: false });

        await openSettingsPanel(page, 'prompts');
        await page.locator('#base-prompt').fill('Dirty base prompt');

        page.once('dialog', (dialog) => dialog.dismiss());
        await page.locator('#reset-prompts').click();
        await expect(page.locator('#base-prompt')).toHaveValue('Dirty base prompt');

        page.once('dialog', (dialog) => dialog.accept());
        await page.locator('#reset-prompts').click();

        await expect(page.locator('#base-prompt')).toHaveValue('Default base prompt');
        await expect(page.locator('#protege-prompt')).toHaveValue('Default protege prompt');
        await expect(page.locator('#tutor-prompt')).toHaveValue('Default tutor prompt');
        await expect(page.locator('#explain-prompt')).toHaveValue('Default explain prompt');
        await expect(page.locator('#directive-prompt')).toHaveValue('Default directive prompt');
        await expect(page.locator('#quiz-help-prompt')).toHaveValue('Default quiz help prompt');
        await expect(page.locator('#chat-summary-prompt')).toHaveValue('Default chat summary prompt');
        await expect(page.locator('.notification.success', { hasText: 'Prompts reset to defaults' })).toBeVisible();

        await openSettingsPanel(page, 'student-chat');
        await setInputChecked(page, '#additive-retrieval-toggle', false);
        await setInputChecked(page, '#additional-material-secondary-toggle', true);
        await setInputChecked(page, '#source-attribution-download-toggle', true);
        page.once('dialog', (dialog) => dialog.accept());
        await page.locator('#reset-student-chat').click();
        await expect(page.locator('#additive-retrieval-toggle')).toBeChecked();
        await expect(page.locator('#additional-material-secondary-toggle')).not.toBeChecked();
        await expect(page.locator('#source-attribution-download-toggle')).not.toBeChecked();
        await expect(page.locator('#student-chat-topk-input')).toHaveValue('3');
        await expect(page.locator('.notification.success', { hasText: 'Student chat settings reset to defaults' })).toBeVisible();

        await openSettingsPanel(page, 'privacy');
        await page.locator('#idle-timeout-input').fill('9');
        await page.locator('#session-timeout-input').fill('60');
        await setInputChecked(page, '#anonymize-students-toggle', true);
        page.once('dialog', (dialog) => dialog.accept());
        await page.locator('#reset-privacy-settings').click();
        await expect(page.locator('#idle-timeout-input')).toHaveValue('4');
        await expect(page.locator('#session-timeout-input')).toHaveValue('30');
        await expect(page.locator('#anonymize-students-toggle')).not.toBeChecked();
        await expect(page.locator('.notification.success', { hasText: 'Privacy settings reset to defaults' })).toBeVisible();

        await openSettingsPanel(page, 'quiz');
        await setInputChecked(page, '#quiz-enabled-toggle', true);
        await setInputChecked(page, '#quiz-material-access-toggle', false);
        await setInputChecked(page, '.testable-unit-checkbox[value="Unit 1"]', false);
        page.once('dialog', (dialog) => dialog.accept());
        await page.locator('#reset-quiz-settings').click();
        await expect(page.locator('#quiz-enabled-toggle')).not.toBeChecked();
        await expect(page.locator('#quiz-material-access-toggle')).toBeChecked();
        await expect(page.locator('.testable-unit-checkbox[value="Unit 1"]')).toBeChecked();
        await expect(page.locator('.notification.success', { hasText: 'Quiz settings reset to defaults' })).toBeVisible();
    });

    test('covers admin reset, delete-all, and system-admin management states', async ({ page }) => {
        const state = await openMockedSettings(page);

        await openSettingsPanel(page, 'admin-platform');
        await expect(page.locator('#llm-model-select')).toHaveValue('gpt-4.1-mini');
        await expect(page.locator('#llm-reasoning-item')).toBeHidden();

        await openSettingsPanel(page, 'admin-access');
        await expect(page.locator('#system-admin-list')).toContainText('E2E Instructor');
        await expect(page.locator('#system-admin-list')).toContainText('You');
        await expect(page.locator('#system-admin-list')).toContainText('<Fresh & Admin>');
        await expect(page.locator('#system-admin-list')).toContainText('Last login: Never');

        await page.locator('#grant-system-admin-btn').click();
        await expect(page.locator('.notification.error', { hasText: 'Enter an email address first.' })).toBeVisible();

        await page.locator('#system-admin-email-input').fill(TEST_USERS.instructor_fresh.email);
        await page.locator('#grant-system-admin-btn').click();
        await expect(page.locator('#system-admin-email-input')).toHaveValue('');
        await expect(page.locator('.notification.success', { hasText: `System admin access granted to ${TEST_USERS.instructor_fresh.email}.` })).toBeVisible();

        state.grantResult = { success: false, error: 'Grant rejected' };
        await page.locator('#system-admin-email-input').fill('missing-admin@test.local');
        await page.locator('#grant-system-admin-btn').click();
        await expect(page.locator('.notification.error', { hasText: 'Grant rejected' })).toBeVisible();

        const freshRevoke = page.locator(`.system-admin-revoke-btn[data-email="${TEST_USERS.instructor_fresh.email}"]`);
        page.once('dialog', (dialog) => dialog.dismiss());
        await freshRevoke.click();
        await expect(freshRevoke).toHaveText('Revoke');

        page.once('dialog', (dialog) => dialog.accept());
        await freshRevoke.click();
        await expect(page.locator('.notification.success', { hasText: `System admin access revoked for ${TEST_USERS.instructor_fresh.email}.` })).toBeVisible();

        state.revokeResult = { success: false, error: 'Revoke rejected' };
        page.once('dialog', (dialog) => dialog.accept());
        await freshRevoke.click();
        await expect(page.locator('.notification.error', { hasText: 'Revoke rejected' })).toBeVisible();

        await openSettingsPanel(page, 'admin-safety');
        page.once('dialog', (dialog) => dialog.dismiss());
        await page.locator('#reset-mh-prompt').click();
        await expect(page.locator('#mental-health-detection-prompt')).toHaveValue('Mock detection prompt');

        page.once('dialog', (dialog) => dialog.accept());
        await page.locator('#reset-mh-prompt').click();
        await expect(page.locator('#mental-health-detection-prompt')).toHaveValue('Default detection prompt');
        await expect(page.locator('.notification.success', { hasText: 'Detection prompt reset to default' })).toBeVisible();

        page.once('dialog', (dialog) => dialog.accept());
        await page.locator('#reset-question-prompts').click();
        await expect(page.locator('#question-system-prompt')).toHaveValue('Default question system');
        await expect(page.locator('#question-true-false-prompt')).toHaveValue('Default true false');
        await expect(page.locator('#question-multiple-choice-prompt')).toHaveValue('Default multiple choice');
        await expect(page.locator('#question-short-answer-prompt')).toHaveValue('Default short answer');
        await expect(page.locator('.notification.success', { hasText: 'Question prompts reset to defaults' })).toBeVisible();

        await openSettingsPanel(page, 'student-chat');
        page.once('dialog', (dialog) => dialog.accept());
        await page.locator('#reset-student-chat').click();
        await expect(page.locator('#student-chat-topk-input')).toHaveValue('3');
        await expect(page.locator('.notification.success', { hasText: 'Student chat settings reset to defaults' })).toBeVisible();
        // (Super Course bucket reset/management is covered by the dedicated
        // superchats specs; the standalone "reset super course" button is gone.)

        await openSettingsPanel(page, 'admin-database');
        page.once('dialog', (dialog) => dialog.dismiss());
        await page.locator('#delete-collection').click();
        await expect(page.locator('#delete-collection')).toHaveText('Delete All Data');

        page.once('dialog', (dialog) => dialog.accept());
        await page.locator('#delete-collection').click();
        await expect(page.locator('.notification.success', { hasText: 'All data deleted successfully! Qdrant: 4, MongoDB: 9 documents removed.' })).toBeVisible();

        state.deleteAllResult = {
            success: false,
            message: 'Delete rejected',
            data: { qdrantDeletedCount: 0, mongoDeletedCount: 0 },
        };
        page.once('dialog', (dialog) => dialog.accept());
        await page.locator('#delete-collection').click();
        await expect(page.locator('.notification.error', { hasText: 'Failed to delete data: Delete rejected' })).toBeVisible();
    });

    test('handles transfer validation, master toggles, modal closing, errors, and warning success', async ({ page }) => {
        const state = await openMockedSettings(page, { canDeleteAll: false });
        await openSettingsPanel(page, 'lifecycle');

        await page.locator('#transfer-course-name').fill('');
        await page.locator('#transfer-course-btn').click();
        await expect(page.locator('.notification.error', { hasText: 'Please enter a name for the new course.' })).toBeVisible();
        await expect(page.locator('#transfer-course-name')).toBeFocused();

        await page.locator('#transfer-course-name').fill('Mock Copy One');
        await page.locator('#transfer-course-btn').click();
        await expect(page.locator('.notification.error', { hasText: 'Please enter the OpenAI Chat GPT API key for the new course.' })).toBeVisible();
        await expect(page.locator('#transfer-course-api-key')).toBeFocused();
        await page.locator('#transfer-course-api-key').fill(VALID_API_KEY);

        await setInputChecked(page, '#transfer-all-docs', false);
        await expect(page.locator('.transfer-docs-checkbox:checked')).toHaveCount(0);
        await setInputChecked(page, '.transfer-unit-row[data-unit-name="Unit 1"] .transfer-docs-checkbox', true);
        await expect.poll(async () => page.locator('#transfer-all-docs').evaluate((element) => /** @type {HTMLInputElement} */ (element).indeterminate)).toBe(true);

        await page.locator('#transfer-course-btn').click();
        await expect(page.locator('#transfer-course-modal')).toHaveClass(/show/);
        await expect(page.locator('#transfer-modal-summary')).toContainText('1 of 2 units will copy docs and existing chunks.');
        await page.keyboard.press('Escape');
        await expect(page.locator('#transfer-course-modal')).not.toHaveClass(/show/);

        await page.locator('#transfer-course-btn').click();
        await expect(page.locator('#transfer-course-modal')).toHaveClass(/show/);
        await page.locator('#transfer-modal-cancel').click();
        await expect(page.locator('#transfer-course-modal')).not.toHaveClass(/show/);

        await page.locator('#transfer-course-btn').click();
        await expect(page.locator('#transfer-course-modal')).toHaveClass(/show/);
        await page.locator('#transfer-course-modal').click({ position: { x: 5, y: 5 } });
        await expect(page.locator('#transfer-course-modal')).not.toHaveClass(/show/);

        state.transferStatus = 500;
        state.transferResult = {
            success: false,
            message: 'Transfer rejected',
            data: { courseId: '', courseName: '', warnings: [] },
        };
        await page.locator('#transfer-course-btn').click();
        await page.locator('#transfer-modal-confirm').click();
        await expect(page.locator('.notification.error', { hasText: 'Transfer rejected' })).toBeVisible();
        await expect(page.locator('#transfer-course-btn')).toHaveText('Create Course Copy');
        expect(state.transferRequests[0]?.apiKey).toBe(VALID_API_KEY);
        expect(state.transferRequests[0]?.llmProvider).toBe('openai');

        state.transferStatus = 200;
        state.transferResult = {
            success: true,
            data: {
                courseId: 'MOCK-SETTINGS-COPY',
                courseName: 'Mock Settings Copy',
                warnings: ['Document chunks were skipped'],
                preparation: {
                    started: true,
                    provider: 'openai',
                    providerLabel: 'OpenAI Chat GPT',
                    migration: { migrationId: 'mig-copy', status: 'queued', total: 1 },
                },
            },
        };
        await page.locator('#transfer-course-btn').click();
        page.once('dialog', async (dialog) => {
            expect(dialog.message()).toContain('Course copy created with 1 warning.');
            expect(dialog.message()).toContain('Document chunks were skipped');
            await dialog.accept();
        });
        await page.locator('#transfer-modal-confirm').click();
        await expect(page).toHaveURL(/courseId=MOCK-SETTINGS-COPY/, { timeout: 10_000 });
        await expect(page.locator('.notification.info', {
            hasText: 'Course copy created with 1 warning. OpenAI Chat GPT material is being prepared in the background. Switched to Mock Settings Copy.',
        })).toBeVisible();
    });

    test('handles lifecycle cancel and API failure without changing status', async ({ page }) => {
        const state = await openMockedSettings(page, { canDeleteAll: false });
        await openSettingsPanel(page, 'lifecycle');

        page.once('dialog', (dialog) => dialog.dismiss());
        await page.locator('#toggle-course-active-btn').click();
        await expect(page.locator('#course-status-badge')).toHaveText('Active');

        state.lifecycleStatus = 500;
        state.lifecycleResult = { success: false, message: 'Lifecycle rejected' };
        page.once('dialog', (dialog) => dialog.accept());
        await page.locator('#toggle-course-active-btn').click();
        await expect(page.locator('.notification.error', { hasText: 'Lifecycle rejected' })).toBeVisible();
        await expect(page.locator('#course-status-badge')).toHaveText('Active');
        await expect(page.locator('#toggle-course-active-btn')).toHaveText('Deactivate Course');
    });

    test('renders empty/error states and endpoint failures defensively', async ({ page }) => {
        await setupMockedSettingsRoutes(page, {
            canDeleteAll: true,
            lectures: [],
            admins: [],
            abortPaths: [
                '/api/settings/global',
                '/api/settings/llm',
                '/api/settings/prompts',
                '/api/settings/quiz',
                '/api/settings/anonymize-students',
                '/api/settings/mental-health-prompt',
                '/api/settings/question-prompts',
            ],
        });
        await page.goto('/instructor/settings?courseId=MOCK-SETTINGS');
        await expect(page.locator('h1')).toHaveText('Settings', { timeout: 15_000 });

        await openSettingsPanel(page, 'admin-access');
        await expect(page.locator('#system-admin-list')).toContainText('No system admins found.');

        await openSettingsPanel(page, 'lifecycle');
        await expect(page.locator('#transfer-unit-grid')).toContainText('No units found for this course yet.');

        await openSettingsPanel(page, 'quiz');
        await expect(page.locator('#testable-units-container')).toContainText('Loading units...');

        await openSettingsPanel(page, 'prompts');
        await page.locator('#base-prompt').fill('Mock base prompt');
        await page.locator('#protege-prompt').fill('Mock protege prompt');
        await page.locator('#tutor-prompt').fill('Mock tutor prompt');
        await page.unroute('**/*');
        const state = await setupMockedSettingsRoutes(page, {
            canDeleteAll: false,
            promptSaveResult: { success: false, message: 'Prompt save rejected' },
        });
        state.abortPaths.add('/api/settings/quiz');
        await page.locator('#save-prompts').click();
        await expect(page.locator('.notification.error', { hasText: 'Prompt save rejected' })).toBeVisible();
    });

    test('uses defensive lifecycle states when course context or course load is missing', async ({ page }) => {
        await page.route('**/api/**', async (route) => {
            const requestUrl = new URL(route.request().url());
            if (requestUrl.pathname === '/api/settings/can-delete-all') {
                await route.fulfill(jsonResponse({ success: true, canDeleteAll: true }));
                return;
            }

            await route.fulfill(jsonResponse({ success: true }));
        });
        await page.route('**/instructor/settings**', async (route) => {
            await route.fulfill({
                status: 200,
                contentType: 'text/html',
                body: `
                    <!doctype html>
                    <html>
                        <body>
                            <section id="course-lifecycle-section">
                                <button id="toggle-course-active-btn">Deactivate Course</button>
                                <input id="transfer-course-name">
                                <input id="transfer-course-api-key">
                                <button id="transfer-course-btn">Create Course Copy</button>
                                <div id="transfer-unit-grid"></div>
                            </section>
                            <input type="checkbox" id="transfer-all-docs" checked>
                            <input type="checkbox" id="transfer-all-objectives" checked>
                            <input type="checkbox" id="transfer-all-questions" checked>
                            <script>
                                window.waitForAuth = async () => {};
                                window.getCurrentUser = () => ({ role: 'instructor', email: '${TEST_USERS.instructor.email}' });
                                window.getCurrentCourseId = async () => '';
                                window.getCurrentInstructorId = () => '${instructorId || 'instructor'}';
                                window.setCurrentCourseId = async () => {};
                            </script>
                            <script src="/common/scripts/notifications.js"></script>
                            <script src="/instructor/scripts/settings.js"></script>
                        </body>
                    </html>
                `,
            });
        });
        await page.goto('/instructor/settings?courseId=');
        await expect(page.locator('#transfer-unit-grid')).toContainText('Select a course first to use transfer and deactivate tools.');
        await expect(page.locator('#toggle-course-active-btn')).toBeDisabled();
        await expect(page.locator('#transfer-course-btn')).toBeDisabled();

        await page.unroute('**/api/**');
        await page.unroute('**/instructor/settings**');
        await openMockedSettings(page, {
            canDeleteAll: false,
            courseGetStatus: 500,
            courseGetResult: { success: false, message: 'Course load rejected' },
        });
        await expect(page.locator('#transfer-unit-grid')).toContainText('Unable to load course transfer options right now.');
        await expect(page.locator('#toggle-course-active-btn')).toBeDisabled();
        await expect(page.locator('#transfer-course-btn')).toBeDisabled();
    });

    test('covers defensive admin failures, non-instructor lifecycle, and notification cleanup', async ({ page }) => {
        await page.addInitScript(() => {
            window.sessionStorage.setItem('settingsFlashMessage', '{bad json');
        });
        const state = await openMockedSettings(page, {
            systemAdminListError: true,
            promptSaveResult: { success: false, message: 'Prompt save rejected' },
        });

        await openSettingsPanel(page, 'admin-access');
        await expect(page.locator('#system-admin-list')).toContainText('Failed to load system admins.');

        await openSettingsPanel(page, 'prompts');
        await page.locator('#base-prompt').fill('Mock base prompt');
        await page.locator('#protege-prompt').fill('Mock protege prompt');
        await page.locator('#tutor-prompt').fill('Mock tutor prompt');
        await page.locator('#save-prompts').click();
        await expect(page.locator('.notification.error', { hasText: 'Prompt save rejected' })).toBeVisible();

        page.once('dialog', (dialog) => dialog.accept());
        await page.locator('#reset-prompts').click();
        await expect(page.locator('.notification.error', { hasText: 'Prompt save rejected' }).last()).toBeVisible();

        await openSettingsPanel(page, 'admin-safety');

        state.abortPaths.add('/api/settings/mental-health-prompt/reset');
        page.once('dialog', (dialog) => dialog.accept());
        await page.locator('#reset-mh-prompt').click();
        await expect(page.locator('.notification.error', { hasText: 'Failed to fetch' })).toBeVisible();
        state.abortPaths.delete('/api/settings/mental-health-prompt/reset');

        state.questionResetResult = {
            success: false,
            message: 'Question reset rejected',
            prompts: { systemPrompt: '', trueFalse: '', multipleChoice: '', shortAnswer: '' },
        };
        page.once('dialog', (dialog) => dialog.dismiss());
        await page.locator('#reset-question-prompts').click();
        await expect(page.locator('#reset-question-prompts')).toHaveText('Reset Question Prompts to Default');

        page.once('dialog', (dialog) => dialog.accept());
        await page.locator('#reset-question-prompts').click();
        await expect(page.locator('.notification.error', { hasText: 'Question reset rejected' })).toBeVisible();

        state.abortPaths.add('/api/settings/question-prompts/reset');
        page.once('dialog', (dialog) => dialog.accept());
        await page.locator('#reset-question-prompts').click();
        await expect(page.locator('.notification.error', { hasText: 'Failed to fetch' }).last()).toBeVisible();
        state.abortPaths.delete('/api/settings/question-prompts/reset');

        await openSettingsPanel(page, 'admin-database');
        state.abortPaths.add('/api/qdrant/delete-all-collections');
        page.once('dialog', (dialog) => dialog.accept());
        await page.locator('#delete-collection').click();
        await expect(page.locator('.notification.error', { hasText: 'Failed to delete data: Network or server error' })).toBeVisible();
        state.abortPaths.delete('/api/qdrant/delete-all-collections');

        await openSettingsPanel(page, 'admin-access');
        state.systemAdminListError = false;
        state.abortPaths.add('/api/settings/system-admins');
        await page.locator('#system-admin-email-input').fill('grant-catch@test.local');
        await page.locator('#grant-system-admin-btn').click();
        await expect(page.locator('.notification.error', { hasText: 'Failed to grant system admin access.' })).toBeVisible();
        state.abortPaths.delete('/api/settings/system-admins');

        await page.locator('#system-admin-email-input').fill(TEST_USERS.instructor_fresh.email);
        await page.locator('#grant-system-admin-btn').click();
        await expect(page.locator(`.system-admin-revoke-btn[data-email="${TEST_USERS.instructor_fresh.email}"]`)).toBeVisible();

        await page.locator('#system-admin-list').click({ position: { x: 5, y: 5 } });
        await page.evaluate((email) => {
            const button = document.querySelector(`.system-admin-revoke-btn[data-email="${email}"]`);
            if (button) button.removeAttribute('data-email');
        }, TEST_USERS.instructor_fresh.email);
        await page.locator('.system-admin-revoke-btn').last().click();
        await expect(page.locator('.system-admin-revoke-btn').last()).toHaveText('Revoke');

        await page.evaluate((email) => {
            const button = document.querySelectorAll('.system-admin-revoke-btn')[1];
            if (button) button.setAttribute('data-email', email);
        }, TEST_USERS.instructor_fresh.email);
        state.abortPaths.add('/api/settings/system-admins/revoke');
        page.once('dialog', (dialog) => dialog.accept());
        await page.locator(`.system-admin-revoke-btn[data-email="${TEST_USERS.instructor_fresh.email}"]`).click();
        await expect(page.locator('.notification.error', { hasText: 'Failed to revoke system admin access.' })).toBeVisible();

        const closeButtons = page.locator('.notification-close');
        const closeButtonCount = await closeButtons.count();
        await closeButtons.first().click();
        await expect.poll(async () => closeButtons.count()).toBe(closeButtonCount - 1);

        await openSettingsPanel(page, 'lifecycle');
        await setInputChecked(page, '#transfer-all-objectives', false);
        await expect(page.locator('.transfer-objectives-checkbox:checked')).toHaveCount(0);
        await setInputChecked(page, '#transfer-all-questions', false);
        await expect(page.locator('.transfer-questions-checkbox:checked')).toHaveCount(0);

        await page.unroute('**/*');
        await page.route('**/api/**', async (route) => {
            const requestUrl = new URL(route.request().url());
            if (requestUrl.pathname === '/api/settings/can-delete-all') {
                await route.fulfill(jsonResponse({ success: false, canDeleteAll: false }));
                return;
            }
            await route.fulfill(jsonResponse({ success: true }));
        });
        await page.route('**/instructor/settings**', async (route) => {
            await route.fulfill({
                status: 200,
                contentType: 'text/html',
                body: `
                    <!doctype html>
                    <html>
                        <body>
                            <section id="course-lifecycle-section">
                                <button id="transfer-course-btn">Create Course Copy</button>
                            </section>
                            <script>
                                window.waitForAuth = async () => {};
                                window.getCurrentUser = () => ({ role: 'student', email: 'student@test.local' });
                                window.getCurrentCourseId = async () => 'STUDENT-COURSE';
                            </script>
                            <script src="/common/scripts/notifications.js"></script>
                            <script src="/instructor/scripts/settings.js"></script>
                        </body>
                    </html>
                `,
            });
        });
        await page.goto('/instructor/settings?student-role');
        await expect(page.locator('#course-lifecycle-section')).toBeHidden();
        await page.locator('#transfer-course-btn').dispatchEvent('click');
        await expect(page.locator('.notification.warning', { hasText: 'Course data is still loading. Please try again.' })).toBeVisible();

        await page.unroute('**/api/**');
        await page.unroute('**/instructor/settings**');
        await openMockedSettings(page, { abortPaths: ['/api/settings/can-delete-all'] });
        await expect(page.locator('#database-management-section')).toBeHidden();
        await expect(page.locator('#system-admin-section')).toBeHidden();
    });
});

test.describe('Settings API authorization', () => {
    test('non-owner instructor cannot update another instructor course through direct settings API', async ({ baseURL }) => {
        const api = await request.newContext({
            baseURL,
            storageState: storageStatePath('instructor_fresh'),
        });

        try {
            const response = await api.post('/api/settings/prompts', {
                data: {
                    courseId: SETTINGS_COURSE_ID,
                    base: 'Unauthorized base prompt',
                    protege: 'Unauthorized protege prompt',
                    tutor: 'Unauthorized tutor prompt',
                    explain: 'Unauthorized explain prompt',
                    directive: 'Unauthorized directive prompt',
                    quizHelp: 'Unauthorized quiz help prompt',
                    chatSummary: 'Unauthorized chat summary prompt',
                    additiveRetrieval: true,
                    studentIdleTimeout: 120,
                },
                failOnStatusCode: false,
            });

            expect.soft(response.status()).toBe(403);
            const course = await readCourse();
            expect.soft(course.prompts.base).toBe('Seed base prompt');
            expect.soft(course.isAdditiveRetrieval).toBe(false);
        } finally {
            await api.dispose();
        }
    });

    test('AI settings enforce course access and round-trip bucket membership; Super Course chat settings round-trip defaults', async ({ baseURL }) => {
        const SUPER_BUCKET = 'BIOC-E2E-SETTINGS-BUCKET';
        const regularApi = await request.newContext({
            baseURL,
            storageState: storageStatePath('instructor'),
        });
        try {
            // A regular instructor may read their OWN course's AI settings...
            const ownCourse = await regularApi.get(`/api/settings/ai-settings?courseId=${SETTINGS_COURSE_ID}`);
            expect(ownCourse.status()).toBe(200);
            // ...but not a course they don't own.
            const denied = await regularApi.get(`/api/settings/ai-settings?courseId=${SETTINGS_OTHER_COURSE_ID}`, {
                failOnStatusCode: false,
            });
            expect(denied.status()).toBe(403);
        } finally {
            await regularApi.dispose();
        }

        await setSystemAdmin(instructorId, true);
        const adminApi = await request.newContext({
            baseURL,
            storageState: storageStatePath('instructor'),
        });

        try {
            const defaultAi = await adminApi.get(`/api/settings/ai-settings?courseId=${SETTINGS_OTHER_COURSE_ID}`);
            expect(await defaultAi.json()).toMatchObject({
                success: true,
                settings: {
                    superchatIds: [],
                    ragSettings: { student: { topK: 3 } },
                },
            });

            const invalidAi = await adminApi.put('/api/settings/ai-settings', {
                data: { courseId: SETTINGS_OTHER_COURSE_ID, superchatIds: [SUPER_BUCKET], studentTopK: 21 },
                failOnStatusCode: false,
            });
            expect(invalidAi.status()).toBe(400);

            const saveAi = await adminApi.put('/api/settings/ai-settings', {
                data: { courseId: SETTINGS_OTHER_COURSE_ID, superchatIds: [SUPER_BUCKET], studentTopK: 5 },
            });
            expect((await saveAi.json()).success).toBe(true);
            expect(await readCourse(SETTINGS_OTHER_COURSE_ID)).toMatchObject({
                superchatIds: [SUPER_BUCKET],
                ragSettings: { student: { topK: 5 } },
            });

            const resetAi = await adminApi.post('/api/settings/ai-settings/reset', {
                data: { courseId: SETTINGS_OTHER_COURSE_ID },
            });
            expect(await resetAi.json()).toMatchObject({
                success: true,
                settings: {
                    superchatIds: [],
                    ragSettings: { student: { topK: 3 } },
                },
            });

            const saveSuper = await adminApi.put('/api/settings/super-course-chat', {
                data: {
                    studentTopK: 6,
                    instructorTopK: 7,
                    includeInactiveCourses: true,
                    showStudentSuperCourse: true,
                    instructorPrompt: 'API instructor super prompt',
                    studentPrompt: 'API student super prompt',
                    studentLevelModifiers: {
                        intro: 'API student intro modifier',
                        undergraduate: 'API student undergrad modifier',
                        graduate: 'API student graduate modifier',
                    },
                    instructorLevelModifiers: {
                        overview: 'API instructor overview modifier',
                        standard: 'API instructor standard modifier',
                        deepDive: 'API instructor deep dive modifier',
                    },
                },
            });
            expect((await saveSuper.json()).success).toBe(true);
            expect(await readSetting('superCourseChat')).toMatchObject({
                studentTopK: 6,
                instructorTopK: 7,
                includeInactiveCourses: true,
                showStudentSuperCourse: true,
                instructorPrompt: 'API instructor super prompt',
                studentPrompt: 'API student super prompt',
                studentLevelModifiers: {
                    intro: 'API student intro modifier',
                    undergraduate: 'API student undergrad modifier',
                    graduate: 'API student graduate modifier',
                },
                instructorLevelModifiers: {
                    overview: 'API instructor overview modifier',
                    standard: 'API instructor standard modifier',
                    deepDive: 'API instructor deep dive modifier',
                },
            });

            const invalidSuper = await adminApi.put('/api/settings/super-course-chat', {
                data: {
                    studentTopK: 0,
                    instructorTopK: 7,
                    includeInactiveCourses: false,
                    showStudentSuperCourse: false,
                    instructorPrompt: 'Prompt',
                    studentPrompt: 'Prompt',
                },
                failOnStatusCode: false,
            });
            expect(invalidSuper.status()).toBe(400);

            const resetSuper = await adminApi.post('/api/settings/super-course-chat/reset');
            const resetSuperBody = await resetSuper.json();
            expect(resetSuperBody).toMatchObject({
                success: true,
                settings: {
                    studentTopK: 8,
                    instructorTopK: 8,
                    includeInactiveCourses: false,
                    showStudentSuperCourse: false,
                },
            });
            // Reset restores the default level modifiers (non-empty for every level).
            const resetStudentMods = resetSuperBody.settings.studentLevelModifiers;
            const resetInstructorMods = resetSuperBody.settings.instructorLevelModifiers;
            for (const key of ['intro', 'undergraduate', 'graduate']) {
                expect(typeof resetStudentMods[key]).toBe('string');
                expect(resetStudentMods[key].length).toBeGreaterThan(0);
            }
            for (const key of ['overview', 'standard', 'deepDive']) {
                expect(typeof resetInstructorMods[key]).toBe('string');
                expect(resetInstructorMods[key].length).toBeGreaterThan(0);
            }
            expect(resetStudentMods.intro).not.toBe('API student intro modifier');
        } finally {
            await adminApi.dispose();
        }
    });
});
