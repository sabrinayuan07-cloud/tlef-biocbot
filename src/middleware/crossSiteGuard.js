/**
 * Refuses state-changing API requests that another site's page sent.
 *
 * In production the session cookie is SameSite=None — the CWL SAML response
 * arrives as a cross-site POST — so the browser attaches it to a form post
 * from any site. A form post is a "simple" request that CORS never stops from
 * being sent, so without this, any page a signed-in instructor opened could,
 * for example, re-point a course roster at Canvas or disconnect their Canvas
 * account.
 *
 * Modern browsers label every request with Sec-Fetch-Site; older ones still
 * send Origin on a cross-origin POST. A request with neither did not come from
 * another site's page.
 */

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function hostnameOf(url) {
    try {
        return new URL(url).hostname;
    } catch {
        return null;
    }
}

/**
 * @param {Object} [options]
 * @param {string[]} [options.exemptPaths] Paths (relative to the mount point)
 *   that legitimately receive cross-site POSTs, such as the SAML callback.
 * @param {string[]} [options.trustedOrigins] Extra origins whose pages may
 *   post, for when a proxy rewrites the Host header.
 */
function crossSiteGuard({ exemptPaths = [], trustedOrigins = [] } = {}) {
    const exempt = new Set(exemptPaths);
    const trustedHostnames = new Set(trustedOrigins.map(hostnameOf).filter(Boolean));

    return function refuseCrossSiteWrites(req, res, next) {
        if (SAFE_METHODS.has(req.method) || exempt.has(req.path)) return next();

        const fetchSite = req.get('sec-fetch-site');
        let crossSite;
        if (fetchSite) {
            // 'same-site' still covers every other *.ubc.ca app, so only an
            // exact-origin request (or one the user typed) counts.
            crossSite = fetchSite !== 'same-origin' && fetchSite !== 'none';
        } else {
            const origin = req.get('origin');
            const hostname = origin ? hostnameOf(origin) : undefined;
            crossSite = origin !== undefined
                && hostname !== req.hostname
                && !trustedHostnames.has(hostname);
        }

        if (!crossSite) return next();
        return res.status(403).json({
            success: false,
            code: 'CROSS_SITE_REQUEST_REFUSED',
            message: 'This request came from another website and was refused.'
        });
    };
}

/**
 * The Express `trust proxy` setting, from TRUST_PROXY. Behind the
 * TLS-terminating proxy the app itself speaks plain HTTP, so express-session
 * only issues the production Secure cookie when Express trusts the proxy's
 * X-Forwarded-Proto. Defaults to trusting a proxy on the same host only.
 */
function parseTrustProxy(value) {
    const text = String(value ?? '').trim();
    if (!text) return 'loopback';
    if (text === 'true') return true;
    if (text === 'false') return false;
    if (/^\d+$/.test(text)) return Number(text);
    return text;
}

module.exports = {
    crossSiteGuard,
    parseTrustProxy
};
