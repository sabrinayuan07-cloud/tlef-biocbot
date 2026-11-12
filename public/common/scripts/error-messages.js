/**
 * Shared helper for turning a failed fetch Response into a clean,
 * human-readable message. Kept separate from notifications.js (rather than
 * bundled with showNotification) so it can be loaded on any page - including
 * student pages, where public/student/scripts/flag-notifications.js already
 * defines its own differently-shaped window.showNotification(notification)
 * and would collide with the generic (message, type) one.
 */
(function () {
    /**
     * This API's normal error shape is a JSON body with a `message` field
     * (`{"success":false,"code":"...","message":"..."}`) - prefer that over
     * dumping the raw response body, which otherwise surfaces the raw JSON
     * straight into a notification/toast/thrown error, e.g. a 403 rendering
     * as `Upload failed: 403 {"success":false,"code":"LLM_KEY_INVALID",...}`
     * instead of just the message sentence.
     *
     * Falls back to `${fallbackLabel}: ${status} ${rawBody}` for non-JSON
     * responses and legacy endpoints that don't return the structured shape.
     *
     * @param {Response} response - The failed fetch Response (response.ok is false)
     * @param {string} fallbackLabel - Used in the fallback format, e.g. "Upload failed"
     * @returns {Promise<string>}
     */
    async function extractErrorMessage(response, fallbackLabel) {
        const raw = await response.text();
        try {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed.message === 'string' && parsed.message) {
                return parsed.message;
            }
        } catch (e) {
            // Not JSON - fall through to the raw body below.
        }
        return `${fallbackLabel}: ${response.status} ${raw}`;
    }

    window.extractErrorMessage = extractErrorMessage;
})();
