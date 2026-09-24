/**
 * Turns an error raised inside an LMS route into the status and JSON body the
 * browser receives.
 *
 * Canvas answers 401 for three different things: a dead token, a token without
 * the scope the request needed, and a user whose Canvas role does not allow the
 * request. The toolkit refreshes and retries once on any 401 and deletes the
 * stored tokens only when that refresh fails. So a 401 that reaches here while
 * tokens are still stored is a scope or permission refusal — connecting again
 * cannot fix a permission, and answering with the "not connected" 401 would
 * send the browser round the OAuth flow and straight back into the same wall.
 *
 * Canvas also throttles with 403, the same status as a plain refusal, and the
 * toolkit's error carries only the status, so the two cannot be told apart.
 */

function httpStatusOf(error) {
    const status = Number(error?.statusCode);
    return status >= 400 && status < 600 ? status : null;
}

async function hasStoredCanvasTokens(req, config) {
    try {
        return Boolean(await config.tokenStore.get(await config.getUserKey(req)));
    } catch (lookupError) {
        console.warn('Could not re-check stored Canvas tokens:', lookupError.message);
        return true;
    }
}

/**
 * @param {Error} error
 * @param {Object} options
 * @param {'canvas'|'moodle'|null} options.provider
 * @param {Object} [options.config] The provider's toolkit config (token store and user key).
 * @param {import('express').Request} options.req
 * @param {string} options.fallbackMessage
 * @returns {Promise<{ status: number, body: Object }>}
 */
async function lmsErrorResponse(error, { provider, config, req, fallbackMessage }) {
    const status = httpStatusOf(error);

    if (provider === 'canvas' && status === 401 && config) {
        if (!await hasStoredCanvasTokens(req, config)) {
            return {
                status: 401,
                body: {
                    success: false,
                    provider,
                    connected: false,
                    code: 'CANVAS_NOT_CONNECTED',
                    message: 'Your Canvas connection has expired. Connect Canvas again to continue.'
                }
            };
        }
        return {
            status: 403,
            body: {
                success: false,
                provider,
                code: 'CANVAS_ACCESS_DENIED',
                message: 'Canvas refused this request. Your Canvas role may not allow it in this course: '
                    + 'for example, you do not teach the linked Canvas course, or BiocBot is connected to a '
                    + 'different Canvas account. To switch accounts, use Disconnect in the Canvas import on the '
                    + 'Course Upload page, sign out of Canvas, then connect again. If it still happens with the '
                    + 'account that teaches the course, contact BiocBot support.'
            }
        };
    }

    if (provider === 'canvas' && status === 403) {
        return {
            status: 403,
            body: {
                success: false,
                provider,
                code: 'CANVAS_FORBIDDEN',
                message: 'Canvas refused this request. If it happened during a large import, Canvas may be '
                    + 'limiting how fast BiocBot can read — wait a minute and try again. If it keeps happening, '
                    + 'your Canvas role may not allow this.'
            }
        };
    }

    return {
        status: status || 502,
        body: {
            success: false,
            provider,
            message: error?.message || fallbackMessage
        }
    };
}

module.exports = {
    lmsErrorResponse
};
