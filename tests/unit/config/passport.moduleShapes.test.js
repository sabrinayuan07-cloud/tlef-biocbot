/**
 * Load-time export-shape handling for the optional passport-ubcshib dependency
 * (src/config/passport.js lines 16-49). The main passport.test.js mocks the
 * named-export shape; this file re-requires the module per shape via
 * jest.isolateModules to drive the default-export, function-export, invalid,
 * and load-failure branches — plus the "module not loaded" arm inside
 * initializePassport.
 */
const SAML_ENV = {
    SAML_ENTRY_POINT: 'https://idp.test/login',
    SAML_ISSUER: 'biocbot-test',
    SAML_CALLBACK_URL: 'https://app.test/callback',
    SAML_CERT_PATH: '/mock/cert.pem',
};

function loadPassportWith(ubcshibFactory) {
    const registered = [];
    let initializePassport;
    jest.isolateModules(() => {
        jest.doMock('passport', () => ({
            use: jest.fn((name) => registered.push(name)),
            serializeUser: jest.fn(),
            deserializeUser: jest.fn(),
        }));
        jest.doMock('passport-local', () => ({ Strategy: class { constructor(o, v) { this.o = o; this.v = v; } } }));
        jest.doMock('@node-saml/passport-saml', () => ({ Strategy: class { constructor(o, v) { this.o = o; this.v = v; } } }));
        jest.doMock('fs', () => ({ readFileSync: jest.fn(() => 'CERT') }));
        jest.doMock('../../../src/models/User', () => ({}));
        jest.doMock('passport-ubcshib', ubcshibFactory);
        initializePassport = require('../../../src/config/passport');
    });
    return { initializePassport, registered };
}

const OLD_ENV = process.env;
beforeEach(() => { process.env = { ...OLD_ENV, ...SAML_ENV }; });
afterAll(() => { process.env = OLD_ENV; });

beforeAll(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterAll(() => jest.restoreAllMocks());

class ShibStrategy { constructor(o, v) { this.o = o; this.v = v; } }

describe('passport-ubcshib export shapes', () => {
    test('default-export shape ({ default: { Strategy } }) still configures ubcshib', () => {
        const { initializePassport, registered } = loadPassportWith(() => ({
            default: { Strategy: ShibStrategy, ensureAuthenticated: jest.fn(), logout: jest.fn(), conditionalAuth: jest.fn() },
        }));
        initializePassport({});
        expect(registered).toEqual(['local', 'saml', 'ubcshib']);
    });

    test('direct constructor-function export configures ubcshib', () => {
        const factory = () => {
            function DirectStrategy(options, verify) { this.options = options; this.verify = verify; }
            return DirectStrategy;
        };
        const { initializePassport, registered } = loadPassportWith(factory);
        initializePassport({});
        expect(registered).toEqual(['local', 'saml', 'ubcshib']);
    });

    test('an unrecognized export shape disables UBC Shibboleth (strategy stays unregistered)', () => {
        const { initializePassport, registered } = loadPassportWith(() => ({ notAStrategy: true }));
        initializePassport({});
        expect(registered).toEqual(['local', 'saml']);
    });

    test('a module that fails to load entirely also disables UBC Shibboleth', () => {
        const { initializePassport, registered } = loadPassportWith(() => {
            throw new Error("Cannot find module 'passport-ubcshib'");
        });
        initializePassport({});
        expect(registered).toEqual(['local', 'saml']);
    });
});
