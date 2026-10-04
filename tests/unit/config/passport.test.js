const captured = { strategies: {}, serialize: null, deserialize: null };

class mockStrategyClass {
    constructor(options, verify) {
        if (mockStrategyClass.failWhen && mockStrategyClass.failWhen(options)) {
            throw new Error('strategy constructor failed');
        }
        this.options = options;
        this.verify = verify;
    }
}
// Optional per-test predicate: throw for matching options (reset in beforeEach).
mockStrategyClass.failWhen = null;

const mockPassport = {
    use: jest.fn((name, strategy) => { captured.strategies[name] = strategy; }),
    serializeUser: jest.fn(fn => { captured.serialize = fn; }),
    deserializeUser: jest.fn(fn => { captured.deserialize = fn; }),
};

jest.mock('passport', () => mockPassport);
jest.mock('passport-local', () => ({ Strategy: mockStrategyClass }));
jest.mock('@node-saml/passport-saml', () => ({ Strategy: mockStrategyClass }));
jest.mock('passport-ubcshib', () => ({
    Strategy: mockStrategyClass,
    ensureAuthenticated: jest.fn(),
    logout: jest.fn(),
    conditionalAuth: jest.fn(),
}));
jest.mock('fs', () => ({ readFileSync: jest.fn(() => 'MOCK CERTIFICATE') }));
jest.mock('../../../src/models/User', () => ({
    authenticateUser: jest.fn(),
    createOrGetSAMLUser: jest.fn(),
    getUserById: jest.fn(),
}));

const fs = require('fs');
const User = require('../../../src/models/User');
const originalConsoleLog = console.log;
console.log = jest.fn();
const initializePassport = require('../../../src/config/passport');
console.log = originalConsoleLog;

function callVerify(strategy, ...args) {
    return new Promise(resolve => strategy.verify(...args, (...doneArgs) => resolve(doneArgs)));
}

describe('Passport configuration', () => {
    const originalEnv = process.env;
    const db = { name: 'mock-db' };

    beforeAll(() => {
        jest.spyOn(console, 'log').mockImplementation(() => {});
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        jest.spyOn(console, 'error').mockImplementation(() => {});
    });

    beforeEach(() => {
        process.env = {
            ...originalEnv,
            SAML_ENTRY_POINT: 'https://idp.test/login',
            SAML_ISSUER: 'biocbot-test',
            SAML_CALLBACK_URL: 'https://app.test/callback',
            SAML_CERT_PATH: '/mock/cert.pem',
        };
        captured.strategies = {};
        captured.serialize = null;
        captured.deserialize = null;
        mockPassport.use.mockClear();
        User.authenticateUser.mockReset();
        User.createOrGetSAMLUser.mockReset();
        User.getUserById.mockReset();
        fs.readFileSync.mockReset().mockReturnValue('MOCK CERTIFICATE');
        mockStrategyClass.failWhen = null;
    });

    afterAll(() => {
        process.env = originalEnv;
        jest.restoreAllMocks();
    });

    test('registers local, generic SAML, and UBC Shibboleth strategies', () => {
        const result = initializePassport(db);
        expect(result).toBe(mockPassport);
        expect(Object.keys(captured.strategies)).toEqual(['local', 'saml', 'ubcshib']);
        expect(captured.strategies.local.options).toMatchObject({ usernameField: 'username', passwordField: 'password' });
        expect(captured.strategies.saml.options).toMatchObject({ entryPoint: 'https://idp.test/login', idpCert: 'MOCK CERTIFICATE', signatureAlgorithm: 'sha256' });
        expect(captured.strategies.ubcshib.options).toMatchObject({ issuer: 'biocbot-test', cert: 'MOCK CERTIFICATE', enableSLO: true });
        expect(mockPassport.ubcShibHelpers).toBeDefined();
    });

    test('maps optional SAML environment settings into both strategy configurations', () => {
        Object.assign(process.env, {
            SAML_PRIVATE_KEY: 'inline-private-key',
            SAML_PRIVATE_KEY_PATH: '/mock/private-key.pem',
            SAML_SIGNATURE_ALGORITHM: 'sha512',
            SAML_DIGEST_ALGORITHM: 'sha512',
            SAML_CLOCK_SKEW_MS: '4500',
            SAML_VALIDATE_IN_RESPONSE_TO: 'true',
            SAML_DISABLE_REQUEST_ACS_URL: 'true',
            SAML_LOGOUT_URL: 'https://idp.test/logout',
            ENABLE_SLO: 'false',
        });

        initializePassport(db);

        expect(captured.strategies.saml.options).toMatchObject({
            privateKey: 'inline-private-key',
            signatureAlgorithm: 'sha512',
            digestAlgorithm: 'sha512',
            acceptedClockSkewMs: 4500,
            validateInResponseTo: 'always',
            disableRequestAcsUrl: true,
        });
        expect(captured.strategies.ubcshib.options).toMatchObject({
            acceptedClockSkewMs: 4500,
            validateInResponseTo: true,
            logoutUrl: 'https://idp.test/logout',
            enableSLO: false,
        });
    });

    test('uses safe SAML option defaults when optional environment values are invalid or absent', () => {
        process.env.SAML_CLOCK_SKEW_MS = 'not-a-number';
        process.env.SAML_VALIDATE_IN_RESPONSE_TO = 'false';
        process.env.SAML_DISABLE_REQUEST_ACS_URL = 'false';
        delete process.env.SAML_PRIVATE_KEY;
        delete process.env.SAML_PRIVATE_KEY_PATH;
        delete process.env.SAML_SIGNATURE_ALGORITHM;
        delete process.env.SAML_DIGEST_ALGORITHM;

        initializePassport(db);

        expect(captured.strategies.saml.options).toMatchObject({
            privateKey: null,
            signatureAlgorithm: 'sha256',
            digestAlgorithm: 'sha256',
            acceptedClockSkewMs: 0,
            validateInResponseTo: 'never',
            disableRequestAcsUrl: false,
        });
        expect(captured.strategies.ubcshib.options).toMatchObject({
            acceptedClockSkewMs: 0,
            validateInResponseTo: false,
            logoutUrl: process.env.SAML_ENTRY_POINT,
        });
    });

    test('local strategy returns authenticated users, failures, and errors', async () => {
        initializePassport(db);
        User.authenticateUser.mockResolvedValueOnce({ success: true, user: { userId: 'u1' } });
        expect(await callVerify(captured.strategies.local, 'alice', 'pw')).toEqual([null, { userId: 'u1' }]);
        User.authenticateUser.mockResolvedValueOnce({ success: false, error: 'Invalid credentials' });
        expect(await callVerify(captured.strategies.local, 'alice', 'bad')).toEqual([null, false, { message: 'Invalid credentials' }]);
        User.authenticateUser.mockRejectedValueOnce(new Error('db failed'));
        expect((await callVerify(captured.strategies.local, 'alice', 'pw'))[0].message).toBe('db failed');
    });

    test('generic SAML validates attributes and creates a student by default', async () => {
        initializePassport(db);
        expect(await callVerify(captured.strategies.saml, {})).toEqual([null, false, { message: 'SAML profile missing required attributes' }]);
        User.createOrGetSAMLUser.mockResolvedValueOnce({ success: true, user: { userId: 's1' } });
        expect(await callVerify(captured.strategies.saml, { nameID: 'id1', email: 'student@test.ca', displayName: 'Student' })).toEqual([null, { userId: 's1' }]);
        expect(User.createOrGetSAMLUser).toHaveBeenCalledWith(db, {
            samlId: 'id1', email: 'student@test.ca', username: 'student', displayName: 'Student', role: 'student',
        });
        User.createOrGetSAMLUser.mockResolvedValueOnce({ success: false, error: 'rejected' });
        expect(await callVerify(captured.strategies.saml, { nameID: 'id2', mail: 'fail@test.ca' })).toEqual([null, false, { message: 'rejected' }]);
    });

    test.each([
        [['faculty'], 'instructor'],
        [['faculty', 'student'], 'student'],
        [['staff'], 'student'],
        ['faculty', 'instructor'],
    ])('UBC strategy maps affiliation %j to %s', async (affiliation, expectedRole) => {
        initializePassport(db);
        User.createOrGetSAMLUser.mockResolvedValueOnce({ success: true, user: { userId: 'ubc' } });
        const profile = { attributes: { ubcEduCwlPuid: 'P123', mail: 'person@ubc.ca', displayName: 'Person', eduPersonAffiliation: affiliation } };
        expect(await callVerify(captured.strategies.ubcshib, profile)).toEqual([null, { userId: 'ubc' }]);
        expect(User.createOrGetSAMLUser.mock.calls[0][1]).toMatchObject({ puid: 'P123', username: 'P123', role: expectedRole });
    });

    test.each([
        [
            {
                'urn:mace:dir:attribute-def:ubcEduCwlPuid': 'puid-mace',
                'urn:oid:0.9.2342.19200300.100.1.3': 'mace@test.ca',
                'urn:oid:2.16.840.1.113730.3.1.241': 'Mace User',
                'urn:oid:1.3.6.1.4.1.5923.1.1.1.1': 'faculty',
            },
            { puid: 'puid-mace', email: 'mace@test.ca', displayName: 'Mace User', role: 'instructor' },
        ],
        [
            {
                'urn:oid:1.3.6.1.4.1.60.6.1.6': 'puid-oid',
                mail: 'oid@test.ca',
            },
            { puid: 'puid-oid', email: 'oid@test.ca', displayName: 'oid@test.ca', role: 'student' },
        ],
    ])('UBC strategy reads supported alternate attribute names', async (profile, expected) => {
        initializePassport(db);
        User.createOrGetSAMLUser.mockResolvedValueOnce({ success: true, user: { userId: expected.puid } });

        await expect(callVerify(captured.strategies.ubcshib, profile))
            .resolves.toEqual([null, { userId: expected.puid }]);
        expect(User.createOrGetSAMLUser).toHaveBeenCalledWith(db, expect.objectContaining(expected));
    });

    test('UBC strategy falls back to profile email or nameID when attributes omit email', async () => {
        initializePassport(db);
        User.createOrGetSAMLUser
            .mockResolvedValueOnce({ success: true, user: { userId: 'profile-email' } })
            .mockResolvedValueOnce({ success: true, user: { userId: 'name-id-email' } });

        await callVerify(captured.strategies.ubcshib, {
            email: 'profile@test.ca',
            attributes: { ubcEduCwlPuid: 'profile-email' },
        });
        await callVerify(captured.strategies.ubcshib, {
            nameID: 'nameid@test.ca',
            attributes: { ubcEduCwlPuid: 'name-id-email' },
        });

        expect(User.createOrGetSAMLUser.mock.calls[0][1].email).toBe('profile@test.ca');
        expect(User.createOrGetSAMLUser.mock.calls[1][1].email).toBe('nameid@test.ca');
    });

    test('UBC strategy rejects profiles without PUID or email', async () => {
        initializePassport(db);
        expect(await callVerify(captured.strategies.ubcshib, { attributes: { mail: 'x@ubc.ca' } })).toEqual([
            null, false, { message: 'UBC Shibboleth profile missing required attribute: ubcEduCwlPuid' },
        ]);
        expect(await callVerify(captured.strategies.ubcshib, { attributes: { ubcEduCwlPuid: 'P1' } })).toEqual([
            null, false, { message: 'UBC Shibboleth profile missing required attributes (email or nameID)' },
        ]);
    });

    test('serialize and deserialize use only userId and handle missing users/errors', async () => {
        initializePassport(db);
        expect(await new Promise(resolve => captured.serialize({ userId: 'u1' }, (...args) => resolve(args)))).toEqual([null, 'u1']);
        User.getUserById.mockResolvedValueOnce({ userId: 'u1' });
        expect(await new Promise(resolve => captured.deserialize('u1', (...args) => resolve(args)))).toEqual([null, { userId: 'u1' }]);
        User.getUserById.mockResolvedValueOnce(null);
        expect(await new Promise(resolve => captured.deserialize('missing', (...args) => resolve(args)))).toEqual([null, false]);
        User.getUserById.mockRejectedValueOnce(new Error('lookup failed'));
        expect((await new Promise(resolve => captured.deserialize('bad', (...args) => resolve(args))))[0].message).toBe('lookup failed');
    });

    test('missing or unreadable SAML certificate leaves only local strategy configured', () => {
        delete process.env.SAML_CERT_PATH;
        initializePassport(db);
        expect(captured.strategies.saml).toBeUndefined();
        expect(captured.strategies.ubcshib).toBeUndefined();
        fs.readFileSync.mockImplementationOnce(() => { throw new Error('unreadable'); });
        process.env.SAML_CERT_PATH = '/bad.pem';
        captured.strategies = {};
        initializePassport(db);
        // The certificate is read independently for generic SAML and UBC; this mock fails only the first read.
        expect(Object.keys(captured.strategies)).toEqual(['local', 'ubcshib']);
    });

    test('a certificate unreadable for BOTH reads also drops the UBC strategy', () => {
        fs.readFileSync.mockImplementation(() => { throw new Error('unreadable'); });
        initializePassport(db);
        expect(Object.keys(captured.strategies)).toEqual(['local']);
    });

    test('generic SAML verify converts an unexpected model failure into done(error)', async () => {
        initializePassport(db);
        User.createOrGetSAMLUser.mockRejectedValueOnce(new Error('mongo down'));
        const [err] = await callVerify(captured.strategies.saml, { nameID: 'id1', email: 's@test.ca' });
        expect(err.message).toBe('mongo down');
    });

    test('UBC verify surfaces model rejection and unexpected failures', async () => {
        initializePassport(db);
        const profile = { attributes: { ubcEduCwlPuid: 'P9', mail: 'p@ubc.ca', eduPersonAffiliation: ['staff'] } };
        User.createOrGetSAMLUser.mockResolvedValueOnce({ success: false, error: 'blocked' });
        expect(await callVerify(captured.strategies.ubcshib, profile)).toEqual([null, false, { message: 'blocked' }]);
        User.createOrGetSAMLUser.mockRejectedValueOnce(new Error('mongo down'));
        expect((await callVerify(captured.strategies.ubcshib, profile))[0].message).toBe('mongo down');
    });

    test('strategy constructor failures are caught per-strategy, keeping local usable', () => {
        // The local strategy is constructed with usernameField options; fail the
        // SAML-style constructions (entryPoint / issuer options) only.
        mockStrategyClass.failWhen = options => !!(options && (options.entryPoint || options.enableSLO !== undefined));
        initializePassport(db);
        expect(Object.keys(captured.strategies)).toEqual(['local']);
    });
});
