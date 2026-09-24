const {
    CANVAS_ENV_KEYS,
    createLmsIntegration,
    ensureLmsIndexes,
    getBiocBotUserKey,
    getCanvasConfigurationStatus,
    getLmsDiagnostics,
    parseCanvasScopes,
    revokeCanvasGrant,
    withCanvasScopeStamp
} = require('../../../src/services/lmsIntegration');

describe('lmsIntegration configuration', () => {
    test('Canvas is enabled only when all required variables are present', () => {
        const complete = Object.fromEntries(CANVAS_ENV_KEYS.map((key) => [key, `${key}-value`]));
        expect(getCanvasConfigurationStatus(complete)).toEqual({
            enabled: true,
            partial: false,
            missing: [],
            invalidScopes: [],
            scopes: []
        });

        const partial = { CANVAS_DOMAIN: 'http://localhost:9100' };
        expect(getCanvasConfigurationStatus(partial)).toMatchObject({
            enabled: false,
            partial: true
        });
        expect(getCanvasConfigurationStatus(partial).missing).toContain('CANVAS_CLIENT_ID');
    });

    // The toolkit is an optional dependency from GitHub Packages, so an install
    // without a registry token leaves it absent. Nothing here may require it.
    test('reports both providers disabled without loading the toolkit when nothing is configured', () => {
        const previous = { ...process.env };
        for (const key of [...CANVAS_ENV_KEYS, 'MOODLE_DOMAIN']) delete process.env[key];

        try {
            expect(createLmsIntegration({})).toMatchObject({
                canvas: null,
                moodle: null,
                toolkitMissing: false
            });
        } finally {
            Object.assign(process.env, previous);
        }
    });

    test('disables LMS integration instead of throwing when the toolkit is not installed', () => {
        jest.isolateModules(() => {
            jest.doMock('@ubc/ubc-genai-toolkit-lms-integration', () => {
                const error = new Error('Cannot find module');
                error.code = 'MODULE_NOT_FOUND';
                throw error;
            }, { virtual: true });

            const service = require('../../../src/services/lmsIntegration');
            const previous = process.env.MOODLE_DOMAIN;
            process.env.MOODLE_DOMAIN = 'http://moodle.test';

            try {
                expect(service.loadLmsToolkit()).toBeNull();
                expect(service.createLmsIntegration({})).toMatchObject({
                    canvas: null,
                    moodle: null,
                    toolkitMissing: true
                });
            } finally {
                if (previous === undefined) delete process.env.MOODLE_DOMAIN;
                else process.env.MOODLE_DOMAIN = previous;
            }
        });
    });

    test('reads CANVAS_SCOPES separated by spaces, commas, or newlines', () => {
        expect(parseCanvasScopes('url:GET|/api/v1/courses, url:GET|/api/v1/courses/:course_id/users\nurl:GET|/api/v1/courses'))
            .toEqual({
                scopes: ['url:GET|/api/v1/courses', 'url:GET|/api/v1/courses/:course_id/users'],
                invalid: []
            });
        expect(parseCanvasScopes(undefined)).toEqual({ scopes: [], invalid: [] });
    });

    test('disables Canvas when CANVAS_SCOPES holds something that is not a Canvas scope', () => {
        const env = {
            ...Object.fromEntries(CANVAS_ENV_KEYS.map((key) => [key, `${key}-value`])),
            CANVAS_SCOPES: 'url:GET|/api/v1/courses /api/v1/users/self'
        };
        const status = getCanvasConfigurationStatus(env);

        expect(status).toMatchObject({ enabled: false, partial: true, missing: [], invalidScopes: ['/api/v1/users/self'] });
        expect(getLmsDiagnostics({ canvasStatus: status, canvas: null }).providers.canvas).toMatchObject({
            enabled: false,
            environment: 'partial',
            invalid: ['CANVAS_SCOPES']
        });
    });

    test('passes CANVAS_SCOPES to the toolkit and stamps stored tokens with them', async () => {
        await jest.isolateModulesAsync(async () => {
            const loadConfigFromEnv = jest.fn((overrides) => overrides);
            // A row from before CANVAS_SCOPES, which a reconnect must revoke.
            const rawStore = {
                get: jest.fn(async () => ({ accessToken: 'old', refreshToken: 'r-old' })),
                set: jest.fn(async () => {}),
                delete: jest.fn()
            };
            const refreshTokens = jest.fn(async () => ({ accessToken: 'old-refreshed' }));
            const revokeToken = jest.fn(async () => {});
            jest.doMock('@ubc/ubc-genai-toolkit-lms-integration', () => ({
                canvas: { loadConfigFromEnv, refreshTokens, revokeToken },
                createMongoTokenStore: () => rawStore,
                moodle: { loadConfigFromEnv: jest.fn() }
            }), { virtual: true });
            const service = require('../../../src/services/lmsIntegration');
            const previous = { ...process.env };
            Object.assign(process.env, Object.fromEntries(CANVAS_ENV_KEYS.map((key) => [key, `${key}-value`])));
            process.env.CANVAS_SCOPES = 'url:GET|/api/v1/courses url:GET|/api/v1/courses/:course_id/users';
            delete process.env.MOODLE_DOMAIN;

            try {
                const integration = service.createLmsIntegration({});
                expect(loadConfigFromEnv).toHaveBeenCalledWith(expect.objectContaining({
                    basePath: '/api/lms/canvas/auth',
                    scopes: ['url:GET|/api/v1/courses', 'url:GET|/api/v1/courses/:course_id/users']
                }));
                await integration.canvas.config.tokenStore.set('user-1', { accessToken: 'a' });
                expect(rawStore.set).toHaveBeenCalledWith('user-1', {
                    accessToken: 'a',
                    scopeStamp: 'url:GET|/api/v1/courses url:GET|/api/v1/courses/:course_id/users'
                });
                await new Promise((resolve) => { setTimeout(resolve, 0); });
                expect(refreshTokens).toHaveBeenCalledWith(integration.canvas.config, 'r-old');
                expect(revokeToken).toHaveBeenCalledWith(integration.canvas.config, 'old-refreshed');
            } finally {
                for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
                Object.assign(process.env, previous);
            }
        });
    });

    test('treats a token requested under a different scope set as not connected', async () => {
        const rows = new Map();
        const store = {
            get: jest.fn(async (key) => rows.get(key) ?? null),
            set: jest.fn(async (key, tokens) => { rows.set(key, tokens); }),
            delete: jest.fn(async (key) => { rows.delete(key); })
        };
        const scoped = withCanvasScopeStamp(store, ['url:GET|/api/v1/courses/:course_id/users', 'url:GET|/api/v1/courses']);

        await scoped.set('user-1', { accessToken: 'a', refreshToken: 'r' });
        expect(rows.get('user-1').scopeStamp).toBe('url:GET|/api/v1/courses url:GET|/api/v1/courses/:course_id/users');
        expect(await scoped.get('user-1')).toMatchObject({ accessToken: 'a' });

        // Issued before BiocBot asked for scopes, or under a different list.
        rows.set('user-2', { accessToken: 'old', refreshToken: 'r' });
        rows.set('user-3', { accessToken: 'other', refreshToken: 'r', scopeStamp: 'url:GET|/api/v1/courses' });
        expect(await scoped.get('user-2')).toBeNull();
        expect(await scoped.get('user-3')).toBeNull();
        expect(await scoped.get('nobody')).toBeNull();

        // With no scopes configured, tokens stored before stamping still work.
        expect(await withCanvasScopeStamp(store, []).get('user-2')).toMatchObject({ accessToken: 'old' });

        // Disconnect can still find a stale token.
        expect(await scoped.peek('user-2')).toMatchObject({ accessToken: 'old' });

        await scoped.delete('user-1');
        expect(store.delete).toHaveBeenCalledWith('user-1');
    });

    test('revokes the grant a reconnect replaces only when it was issued under other scopes', async () => {
        const rows = new Map([
            ['stale', { accessToken: 'old', refreshToken: 'r-old' }],
            ['current', { accessToken: 'cur', refreshToken: 'r-cur', scopeStamp: 'url:GET|/api/v1/courses' }]
        ]);
        const store = {
            get: jest.fn(async (key) => rows.get(key) ?? null),
            set: jest.fn(async (key, tokens) => { rows.set(key, tokens); }),
            delete: jest.fn()
        };
        const revokeStaleGrant = jest.fn(async () => {});
        const scoped = withCanvasScopeStamp(store, ['url:GET|/api/v1/courses'], { revokeStaleGrant });

        await scoped.set('stale', { accessToken: 'new', refreshToken: 'r-new' });
        // A refresh of current tokens must never revoke the grant it refreshes.
        await scoped.set('current', { accessToken: 'cur-2', refreshToken: 'r-cur' });
        await scoped.set('nobody', { accessToken: 'first', refreshToken: 'r' });

        expect(revokeStaleGrant).toHaveBeenCalledTimes(1);
        expect(revokeStaleGrant).toHaveBeenCalledWith({ accessToken: 'old', refreshToken: 'r-old' });
        // The new grant is saved before the old one is revoked.
        expect(store.set.mock.invocationCallOrder[0]).toBeLessThan(revokeStaleGrant.mock.invocationCallOrder[0]);
        expect(rows.get('stale')).toMatchObject({ accessToken: 'new', scopeStamp: 'url:GET|/api/v1/courses' });
    });

    test('revokes a grant with a freshly refreshed token, falling back to the stored one', async () => {
        const config = { clientId: 'x' };
        const canvas = {
            refreshTokens: jest.fn(async () => ({ accessToken: 'fresh' })),
            revokeToken: jest.fn(async () => {})
        };
        await revokeCanvasGrant(canvas, config, { accessToken: 'stored', refreshToken: 'r' });
        expect(canvas.refreshTokens).toHaveBeenCalledWith(config, 'r');
        expect(canvas.revokeToken).toHaveBeenCalledWith(config, 'fresh');

        canvas.refreshTokens.mockRejectedValueOnce(new Error('invalid_grant'));
        await revokeCanvasGrant(canvas, config, { accessToken: 'stored', refreshToken: 'r' });
        expect(canvas.revokeToken).toHaveBeenLastCalledWith(config, 'stored');
    });

    test('uses BiocBot userId as the token-store key', () => {
        expect(getBiocBotUserKey({ user: { userId: 'user-123' } })).toBe('user-123');
        expect(() => getBiocBotUserKey({})).toThrow('authenticated BiocBot user');
    });

    test('keeps the deployed LMS import index definition stable', async () => {
        const createIndex = jest.fn().mockResolvedValue('unique_lms_file_import');
        const db = {
            collection: jest.fn().mockReturnValue({ createIndex })
        };

        await ensureLmsIndexes(db);

        expect(db.collection).toHaveBeenCalledWith('documents');
        expect(createIndex).toHaveBeenCalledWith(
            {
                courseId: 1,
                'metadata.lms.provider': 1,
                'metadata.lms.externalCourseId': 1,
                'metadata.lms.externalFileId': 1
            },
            {
                name: 'unique_lms_file_import',
                unique: true,
                partialFilterExpression: { 'metadata.lms.provider': { $exists: true } }
            }
        );
    });
});
