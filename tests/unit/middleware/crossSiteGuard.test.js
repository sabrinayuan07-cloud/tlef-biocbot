const express = require('express');
const request = require('supertest');
const { crossSiteGuard, parseTrustProxy } = require('../../../src/middleware/crossSiteGuard');

function guardedApp(options) {
    const app = express();
    app.use('/api', crossSiteGuard(options));
    app.all('/api/{*rest}', (req, res) => res.json({ reached: true }));
    return app;
}

describe('cross-site guard', () => {
    const app = guardedApp({ exemptPaths: ['/auth/saml/callback'], trustedOrigins: ['https://biocbot.apps.ltic.ubc.ca/Shibboleth.sso/SAML2/POST'] });

    test('lets same-origin writes and every read through', async () => {
        await request(app).post('/api/lms/roster/courses/C1/sync').set('Sec-Fetch-Site', 'same-origin').expect(200);
        await request(app).get('/api/lms/grades/courses/C1').set('Sec-Fetch-Site', 'cross-site').expect(200);
        // Not from a browser page at all (curl, server-to-server, tests).
        await request(app).post('/api/lms/canvas/auth/logout').expect(200);
    });

    test('refuses writes another site sent, including sibling *.ubc.ca apps', async () => {
        for (const site of ['cross-site', 'same-site']) {
            const res = await request(app)
                .post('/api/lms/roster/courses/C1/sync?provider=canvas')
                .set('Sec-Fetch-Site', site)
                .type('form')
                .send({ provider: 'canvas' })
                .expect(403);
            expect(res.body.code).toBe('CROSS_SITE_REQUEST_REFUSED');
        }
    });

    test('falls back to Origin for browsers that do not send Sec-Fetch-Site', async () => {
        await request(app).post('/api/x').set('Host', 'biocbot.test').set('Origin', 'https://evil.example').expect(403);
        await request(app).post('/api/x').set('Host', 'biocbot.test').set('Origin', 'null').expect(403);
        await request(app).post('/api/x').set('Host', 'biocbot.test').set('Origin', 'https://biocbot.test').expect(200);
        // A proxy rewrote Host, but the Origin is this app's public address.
        await request(app).post('/api/x').set('Host', 'localhost:8080').set('Origin', 'https://biocbot.apps.ltic.ubc.ca').expect(200);
    });

    test('leaves the SAML callback open to the IdP', async () => {
        await request(app).post('/api/auth/saml/callback').set('Sec-Fetch-Site', 'cross-site').expect(200);
    });
});

describe('trust proxy setting', () => {
    test('trusts only a proxy on the same host unless told otherwise', () => {
        expect(parseTrustProxy(undefined)).toBe('loopback');
        expect(parseTrustProxy('')).toBe('loopback');
        expect(parseTrustProxy('false')).toBe(false);
        expect(parseTrustProxy('true')).toBe(true);
        expect(parseTrustProxy('2')).toBe(2);
        expect(parseTrustProxy('10.0.0.0/8, loopback')).toBe('10.0.0.0/8, loopback');
    });
});
