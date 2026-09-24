const express = require('express');
const { memoryDb } = require('../helpers/memory-db');
const { makeRouteApp, request } = require('../helpers/route-app');
const { createCanvasLmsRouter } = require('../../../src/routes/canvasLms');

const instructor = { userId: 'inst-1', role: 'instructor' };

function canvasHarness({ client, getCourses, getSections, getFiles, downloadFile } = {}) {
    const authRouter = express.Router();
    authRouter.get('/login', (req, res) => res.json({ returnTo: req.query.returnTo || null }));
    // Stands in for the toolkit's code exchange: it clears the session state
    // like the real one, then succeeds or fails on demand.
    authRouter.get('/callback', (req, res, next) => {
        delete req.session.canvasOAuthState;
        delete req.session.canvasOAuthReturnTo;
        if (req.query.code === 'bad-code') return next(new Error('Canvas token exchange failed with status 401'));
        return res.redirect('/instructor/after-connect');
    });
    authRouter.post('/logout', (req, res) => res.status(204).end());
    const canvasClient = client || { get: jest.fn() };
    const api = {
        baseUrl: jest.fn(() => 'http://canvas.test'),
        createAuthRouter: jest.fn(() => authRouter),
        requireAuth: jest.fn(() => (req, res, next) => {
            req.canvasApi = canvasClient;
            next();
        }),
        getCourses: getCourses || jest.fn(async () => []),
        getCourseSections: getSections || jest.fn(async () => []),
        getCourseFiles: getFiles || jest.fn(async () => []),
        downloadFile: downloadFile || jest.fn(),
        refreshTokens: jest.fn(async () => ({ accessToken: 'fresh-access-token' })),
        revokeToken: jest.fn(async () => {})
    };
    return {
        api,
        canvasClient,
        integration: {
            api,
            config: {
                canvasDomain: 'http://canvas.test',
                getUserKey: jest.fn((req) => req.user.userId),
                tokenStore: {
                    get: jest.fn(async () => ({ accessToken: 'canvas-access-token' })),
                    delete: jest.fn(async () => {})
                }
            }
        }
    };
}

function course(overrides = {}) {
    return {
        courseId: 'BIOC-1',
        courseName: 'BIOC 301',
        instructorId: 'inst-1',
        instructors: ['inst-1'],
        lectures: [{ name: 'Unit 1', documents: [] }],
        ...overrides
    };
}

describe('Canvas LMS routes', () => {
    test('lists teacher courses and Canvas sections through the toolkit', async () => {
        const getCourses = jest.fn(async () => [{ id: '10', provider: 'canvas', name: 'BIOC 301' }]);
        const getSections = jest.fn(async () => [{ id: '20', provider: 'canvas', name: 'Section 001' }]);
        const harness = canvasHarness({ getCourses, getSections });
        const router = createCanvasLmsRouter(harness.integration);
        const app = makeRouteApp(router, { db: memoryDb(), user: instructor });

        const courses = await request(app).get('/courses').expect(200);
        expect(courses.body.data[0].id).toBe('10');
        expect(getCourses).toHaveBeenCalledWith(harness.canvasClient, { enrollment_type: 'teacher' });

        const sections = await request(app).get('/courses/10/sections').expect(200);
        expect(sections.body.data[0].id).toBe('20');
        expect(getSections).toHaveBeenCalledWith(harness.canvasClient, '10');
    });

    test('lists supported Canvas files in a normalized shape', async () => {
        const getFiles = jest.fn(async () => [{
                id: 31,
                name: 'Week 1.pdf',
                filename: 'week-1.pdf',
                mimeType: 'application/pdf',
                size: 1234,
                updatedAt: '2026-08-04T00:00:00Z'
            }]);
        const harness = canvasHarness({ getFiles });
        const app = makeRouteApp(createCanvasLmsRouter(harness.integration), {
            db: memoryDb(),
            user: instructor
        });

        const res = await request(app).get('/courses/10/files').expect(200);
        expect(res.body.data[0]).toMatchObject({
            id: '31',
            name: 'Week 1.pdf',
            filename: 'week-1.pdf',
            mimeType: 'application/pdf',
            supported: true
        });
        expect(getFiles).toHaveBeenCalledWith(harness.canvasClient, '10', expect.objectContaining({
            sort: 'updated_at',
            order: 'desc'
        }));
    });

    test('links an owned BiocBot course to a verified Canvas course', async () => {
        const getCourses = jest.fn(async () => [{ id: '10', name: 'BIOC 301 001', code: 'BIOC301' }]);
        const harness = canvasHarness({ getCourses });
        const db = memoryDb({ courses: [course()] });
        const app = makeRouteApp(createCanvasLmsRouter(harness.integration), { db, user: instructor });

        const res = await request(app)
            .put('/courses/BIOC-1/link')
            .send({ canvasCourseId: '10' })
            .expect(200);
        expect(res.body.data.lmsSync).toMatchObject({
            provider: 'canvas',
            courseId: '10',
            linkedBy: 'inst-1'
        });
        expect(getCourses).toHaveBeenCalledWith(harness.canvasClient, { enrollment_type: 'teacher' });
        expect((await db.collection('courses').findOne({ courseId: 'BIOC-1' })).lmsSync.courseId).toBe('10');
    });

    test('returns the saved Canvas link so the instructor UI can restore it after reload', async () => {
        const harness = canvasHarness();
        const db = memoryDb({
            courses: [course({
                lmsSync: { provider: 'canvas', courseId: '10', name: 'BIOC 301', code: 'BIOC301' }
            })]
        });
        const app = makeRouteApp(createCanvasLmsRouter(harness.integration), { db, user: instructor });

        const res = await request(app).get('/courses/BIOC-1/link').expect(200);
        expect(res.body.data).toEqual({
            courseId: 'BIOC-1',
            lmsSync: { provider: 'canvas', courseId: '10', name: 'BIOC 301', code: 'BIOC301' }
        });
    });

    test('imports a linked Canvas file through the reusable BiocBot ingestion service', async () => {
        const file = {
            id: '31',
            name: 'Week 1 Notes.txt',
            filename: 'week-1.txt',
            mimeType: 'text/plain',
            size: 17,
            updatedAt: '2026-08-04T00:00:00Z'
        };
        const getFiles = jest.fn(async () => [file]);
        const downloadFile = jest.fn(async () => ({
            data: new Uint8Array(Buffer.from('Canvas notes body')),
            contentType: 'text/plain',
            filename: 'week-1.txt',
            size: 17
        }));
        const harness = canvasHarness({ getFiles, downloadFile });
        const ingestFile = jest.fn(async (input) => ({
            result: { documentId: 'doc-1', filename: input.title },
            courseResult: { success: true },
            qdrantResult: { success: true, chunksStored: 2 }
        }));
        const resolveAi = jest.fn(async () => ({ llm: {}, qdrant: {} }));
        const db = memoryDb({
            courses: [course({ lmsSync: { provider: 'canvas', courseId: '10' } })],
            documents: []
        });
        const router = createCanvasLmsRouter(harness.integration, { ingestFile, resolveAi });
        const app = makeRouteApp(router, { db, user: instructor });

        const res = await request(app)
            .post('/courses/BIOC-1/import-file')
            .send({ canvasFileId: '31', lectureName: 'Unit 1', documentType: 'lecture-notes' })
            .expect(201);

        expect(res.body.data).toMatchObject({ documentId: 'doc-1', chunksStored: 2 });
        expect(downloadFile).toHaveBeenCalledWith(
            harness.canvasClient,
            '10',
            '31',
            { maxBytes: 50 * 1024 * 1024 }
        );
        expect(ingestFile).toHaveBeenCalledWith(expect.objectContaining({
            courseId: 'BIOC-1',
            lectureName: 'Unit 1',
            instructorId: 'inst-1',
            buffer: expect.any(Buffer),
            metadata: expect.objectContaining({
                lms: expect.objectContaining({
                    provider: 'canvas',
                    externalCourseId: '10',
                    externalFileId: '31'
                })
            })
        }));
    });

    test('refuses duplicate imports and courses owned by another instructor', async () => {
        const file = {
            id: '31',
            name: 'notes.txt',
            filename: 'notes.txt',
            mimeType: 'text/plain',
            size: 10
        };
        const harness = canvasHarness({ getFiles: jest.fn(async () => [file]) });
        const duplicateDb = memoryDb({
            courses: [course({ lmsSync: { provider: 'canvas', courseId: '10' } })],
            documents: [{
                documentId: 'existing-doc',
                courseId: 'BIOC-1',
                metadata: { lms: { provider: 'canvas', externalCourseId: '10', externalFileId: '31' } }
            }]
        });
        const duplicateApp = makeRouteApp(createCanvasLmsRouter(harness.integration), {
            db: duplicateDb,
            user: instructor
        });
        const duplicate = await request(duplicateApp)
            .post('/courses/BIOC-1/import-file')
            .send({ canvasFileId: '31', lectureName: 'Unit 1' })
            .expect(409);
        expect(duplicate.body.code).toBe('CANVAS_FILE_ALREADY_IMPORTED');

        const forbiddenDb = memoryDb({ courses: [course({ instructorId: 'other', instructors: ['other'] })] });
        const forbiddenApp = makeRouteApp(createCanvasLmsRouter(harness.integration), {
            db: forbiddenDb,
            user: instructor
        });
        await request(forbiddenApp)
            .put('/courses/BIOC-1/link')
            .send({ canvasCourseId: '10' })
            .expect(403);
    });

    test('streams per-stage progress when the client asks for NDJSON', async () => {
        const file = {
            id: '31',
            name: 'Week 1 Notes.txt',
            filename: 'week-1.txt',
            mimeType: 'text/plain',
            size: 17
        };
        const harness = canvasHarness({
            getFiles: jest.fn(async () => [file]),
            downloadFile: jest.fn(async () => ({
                data: new Uint8Array(Buffer.from('Canvas notes body')),
                size: 17
            }))
        });
        // Replays the phases the real ingestion service emits so the route's
        // translation from ingestion phase to import stage is exercised.
        const ingestFile = jest.fn(async ({ onProgress }) => {
            onProgress({ phase: 'storing' });
            onProgress({ phase: 'extracting' });
            onProgress({ phase: 'extracted', characters: 17, slides: 0 });
            onProgress({ phase: 'saving' });
            onProgress({ phase: 'indexing' });
            return {
                result: { documentId: 'doc-1', filename: 'Week 1 Notes.txt' },
                courseResult: { success: true },
                qdrantResult: { success: true, chunksStored: 3 }
            };
        });
        const db = memoryDb({
            courses: [course({ lmsSync: { provider: 'canvas', courseId: '10' } })],
            documents: []
        });
        const router = createCanvasLmsRouter(harness.integration, {
            ingestFile,
            resolveAi: jest.fn(async () => ({ llm: {}, qdrant: {} }))
        });
        const app = makeRouteApp(router, { db, user: instructor });

        const res = await request(app)
            .post('/courses/BIOC-1/import-file')
            .set('Accept', 'application/x-ndjson')
            .send({ canvasFileId: '31', lectureName: 'Unit 1' })
            .expect(200);

        expect(res.headers['content-type']).toContain('application/x-ndjson');
        const events = res.text.trim().split('\n').map((line) => JSON.parse(line));
        expect(events.filter((event) => event.type === 'step').map((event) => event.step))
            .toEqual(['download', 'store', 'extract', 'save', 'index']);
        expect(events).toContainEqual({ type: 'detail', step: 'extract', detail: '17 characters read' });
        expect(events.at(-1)).toEqual({
            type: 'done',
            data: expect.objectContaining({ documentId: 'doc-1', lectureName: 'Unit 1', chunksStored: 3 })
        });
    });

    test('reports a mid-stream failure in band rather than as a dead connection', async () => {
        const errorLog = jest.spyOn(console, 'error').mockImplementation(() => {});
        const harness = canvasHarness({
            getFiles: jest.fn(async () => [{
                id: '31',
                name: 'notes.txt',
                filename: 'notes.txt',
                mimeType: 'text/plain',
                size: 10,
                raw: { url: 'https://files.canvas.test/notes.txt?verifier=secret' }
            }]),
            downloadFile: jest.fn(async () => {
                const error = new Error('Canvas file download returned 502');
                error.name = 'CanvasApiError';
                error.statusCode = 502;
                error.provider = 'canvas';
                throw error;
            })
        });
        const db = memoryDb({
            courses: [course({ lmsSync: { provider: 'canvas', courseId: '10' } })],
            documents: []
        });
        const router = createCanvasLmsRouter(harness.integration, {
            resolveAi: jest.fn(async () => ({ llm: {}, qdrant: {} }))
        });
        const app = makeRouteApp(router, { db, user: instructor });

        const res = await request(app)
            .post('/courses/BIOC-1/import-file')
            .set('Accept', 'application/x-ndjson')
            .send({ canvasFileId: '31', lectureName: 'Unit 1' })
            .expect(200);

        const events = res.text.trim().split('\n').map((line) => JSON.parse(line));
        expect(events.at(-1)).toMatchObject({
            type: 'error',
            message: 'Canvas file download returned 502',
            diagnostic: {
                reference: expect.any(String),
                provider: 'canvas',
                stage: 'download',
                errorName: 'CanvasApiError',
                statusCode: 502,
                fileHost: 'https://files.canvas.test',
                lmsHost: 'http://canvas.test',
                occurredAt: expect.any(String)
            }
        });
        expect(errorLog).toHaveBeenCalledWith(expect.stringContaining(events.at(-1).diagnostic.reference));
        expect(errorLog.mock.calls[0][0]).not.toContain('verifier=secret');
        errorLog.mockRestore();
    });

    test('validation still fails with a real status code before the stream opens', async () => {
        const harness = canvasHarness({ getFiles: jest.fn(async () => []) });
        const db = memoryDb({
            courses: [course({ lmsSync: { provider: 'canvas', courseId: '10' } })],
            documents: []
        });
        const app = makeRouteApp(createCanvasLmsRouter(harness.integration), { db, user: instructor });

        await request(app)
            .post('/courses/BIOC-1/import-file')
            .set('Accept', 'application/x-ndjson')
            .send({ canvasFileId: 'missing', lectureName: 'Unit 1' })
            .expect(404);
    });

    test('rejects external OAuth return paths', async () => {
        const harness = canvasHarness();
        const app = makeRouteApp(createCanvasLmsRouter(harness.integration), {
            db: memoryDb(),
            user: instructor
        });
        await request(app)
            .get('/auth/login?returnTo=https%3A%2F%2Fevil.example')
            .expect(400);
    });

    test('rejects return paths a browser would read as another site', async () => {
        const harness = canvasHarness();
        const app = makeRouteApp(createCanvasLmsRouter(harness.integration), { db: memoryDb(), user: instructor });

        for (const returnTo of ['/%09/evil.example', '/%0A/evil.example', '/%5Cevil.example']) {
            await request(app).get(`/auth/login?returnTo=${returnTo}`).expect(400);
        }
        // Repeated params arrive as an array, not a string.
        await request(app).get('/auth/login?returnTo=/a&returnTo=/b').expect(400);
        await request(app).get('/auth/login?returnTo=%2Finstructor%2Fstudent-hub%3FcourseId%3DBIOC-1').expect(200);
    });

    test('disconnect revokes the Canvas grant — refreshing first — and deletes it, whatever scopes it was issued under', async () => {
        const harness = canvasHarness();
        const stale = { accessToken: 'expired-access', refreshToken: 'refresh-1', scopeStamp: 'old' };
        harness.integration.config.tokenStore.get = jest.fn(async () => null);
        harness.integration.config.tokenStore.peek = jest.fn(async () => stale);
        const app = makeRouteApp(createCanvasLmsRouter(harness.integration), { db: memoryDb(), user: instructor });

        await request(app).post('/auth/logout').expect(204);

        expect(harness.api.refreshTokens).toHaveBeenCalledWith(harness.integration.config, 'refresh-1');
        expect(harness.api.revokeToken).toHaveBeenCalledWith(harness.integration.config, 'fresh-access-token');
        expect(harness.integration.config.tokenStore.delete).toHaveBeenCalledWith('inst-1');
    });

    test('disconnect still forgets the grant when Canvas will not revoke it', async () => {
        const harness = canvasHarness();
        harness.api.refreshTokens.mockRejectedValue(new Error('invalid_grant'));
        harness.api.revokeToken.mockRejectedValue(new Error('Canvas token revoke failed with status 401'));
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const app = makeRouteApp(createCanvasLmsRouter(harness.integration), { db: memoryDb(), user: instructor });

        await request(app).post('/auth/logout').expect(204);
        warn.mockRestore();

        expect(harness.api.revokeToken).toHaveBeenCalledWith(harness.integration.config, 'canvas-access-token');
        expect(harness.integration.config.tokenStore.delete).toHaveBeenCalledWith('inst-1');
    });

    test('disconnect with nothing stored is a no-op', async () => {
        const harness = canvasHarness();
        harness.integration.config.tokenStore.get = jest.fn(async () => null);
        const app = makeRouteApp(createCanvasLmsRouter(harness.integration), { db: memoryDb(), user: instructor });

        await request(app).post('/auth/logout').expect(204);

        expect(harness.api.revokeToken).not.toHaveBeenCalled();
        expect(harness.integration.config.tokenStore.delete).not.toHaveBeenCalled();
    });

    describe('OAuth callback errors', () => {
        function callbackApp(session) {
            const harness = canvasHarness();
            return makeRouteApp(createCanvasLmsRouter(harness.integration), { db: memoryDb(), user: instructor, session });
        }
        const pending = () => ({ canvasOAuthState: 'state-1', canvasOAuthReturnTo: '/instructor/student-hub?courseId=BIOC-1' });

        test('passes a matching callback with a code through to the token exchange', async () => {
            const res = await request(callbackApp(pending())).get('/auth/callback?state=state-1&code=good').expect(302);
            expect(res.headers.location).toBe('/instructor/after-connect');
        });

        test.each([
            ['access_denied', 400, 'You chose not to authorize BiocBot'],
            ['invalid_scope', 502, 'refused the permissions BiocBot asked for'],
            ['unauthorized_client', 502, 'not switched on for this Canvas account']
        ])('explains a Canvas %s answer and links back to where the instructor started', async (error, status, text) => {
            const session = pending();
            const res = await request(callbackApp(session))
                .get(`/auth/callback?state=state-1&error=${error}&error_description=${encodeURIComponent('<b>raw</b>')}`)
                .expect(status);

            expect(res.headers['content-type']).toMatch(/text\/html/);
            expect(res.text).toContain(text);
            expect(res.text).toContain('href="/instructor/student-hub?courseId=BIOC-1"');
            // Canvas's own description is logged, never echoed into the page.
            expect(res.text).not.toContain('<b>raw</b>');
            expect(session.canvasOAuthState).toBeUndefined();
        });

        test('refuses a callback whose state does not match the session, without exchanging the code', async () => {
            const res = await request(callbackApp(pending())).get('/auth/callback?state=forged&code=good').expect(400);
            expect(res.text).toContain('could not be matched to your BiocBot session');
            expect(res.text).toContain('href="/instructor/student-hub?courseId=BIOC-1"');
        });

        test('shows a page, not JSON, when the token exchange fails', async () => {
            const error = jest.spyOn(console, 'error').mockImplementation(() => {});
            const res = await request(callbackApp(pending())).get('/auth/callback?state=state-1&code=bad-code').expect(502);
            error.mockRestore();

            expect(res.text).toContain('could not finish it');
            expect(res.text).toContain('href="/instructor/student-hub?courseId=BIOC-1"');
        });

        test.each(['//evil.example', '/\t/evil.example', '/\n/evil.example', '/\\evil.example'])(
            'never links back off-site, whatever the session holds (%j)',
            async (returnTo) => {
                const res = await request(callbackApp({ canvasOAuthState: 'state-1', canvasOAuthReturnTo: returnTo }))
                    .get('/auth/callback?state=state-1&error=access_denied')
                    .expect(400);
                expect(res.text).toContain('href="/instructor"');
            }
        );
    });

    describe('Canvas refusals after the connection check', () => {
        const refusal = (statusCode) => Object.assign(new Error(`Canvas API request to /api/v1/courses returned ${statusCode}`), { statusCode });

        async function listCourses({ statusCode, tokensStored }) {
            const harness = canvasHarness({ getCourses: jest.fn(async () => { throw refusal(statusCode); }) });
            harness.integration.config.tokenStore.get = jest.fn(async () => (tokensStored ? { accessToken: 'still-here' } : null));
            const app = makeRouteApp(createCanvasLmsRouter(harness.integration), { db: memoryDb(), user: instructor });
            const error = jest.spyOn(console, 'error').mockImplementation(() => {});
            const res = await request(app).get('/courses');
            error.mockRestore();
            return res;
        }

        test('reports "not connected" when the refresh failed and the tokens were cleared', async () => {
            const res = await listCourses({ statusCode: 401, tokensStored: false });
            expect(res.status).toBe(401);
            expect(res.body).toMatchObject({ connected: false, code: 'CANVAS_NOT_CONNECTED' });
        });

        test('reports a Canvas refusal, not a lost connection, when the tokens are still stored', async () => {
            const res = await listCourses({ statusCode: 401, tokensStored: true });
            expect(res.status).toBe(403);
            expect(res.body).toMatchObject({ code: 'CANVAS_ACCESS_DENIED' });
            expect(res.body.connected).toBeUndefined();
        });

        test('labels a Canvas 403 as a refusal that may be throttling', async () => {
            const res = await listCourses({ statusCode: 403, tokensStored: true });
            expect(res.status).toBe(403);
            expect(res.body).toMatchObject({ code: 'CANVAS_FORBIDDEN' });
            expect(res.body.message).toContain('wait a minute');
        });
    });
});
