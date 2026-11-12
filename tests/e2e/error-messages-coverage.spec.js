// @ts-check
/**
 * Focused browser coverage for public/common/scripts/error-messages.js.
 */

const { test, expect } = require('./fixtures/monocart');

const SCRIPT_PATH = 'public/common/scripts/error-messages.js';

test.describe('extractErrorMessage', () => {
    test('prefers the structured message field over the raw JSON body', async ({ page }) => {
        await page.setContent('<!doctype html><html><body></body></html>');
        await page.addScriptTag({ path: SCRIPT_PATH });

        const result = await page.evaluate(async () => {
            const response = new Response(
                JSON.stringify({ success: false, code: 'LLM_KEY_INVALID', message: 'API key for this AI surface is invalid.' }),
                { status: 403 }
            );
            return /** @type {any} */ (window).extractErrorMessage(response, 'Upload failed');
        });

        expect(result).toBe('API key for this AI surface is invalid.');
    });

    test('falls back to status + raw body for a non-JSON response', async ({ page }) => {
        await page.setContent('<!doctype html><html><body></body></html>');
        await page.addScriptTag({ path: SCRIPT_PATH });

        const result = await page.evaluate(async () => {
            const response = new Response('Internal Server Error', { status: 500 });
            return /** @type {any} */ (window).extractErrorMessage(response, 'Save failed');
        });

        expect(result).toBe('Save failed: 500 Internal Server Error');
    });

    test('falls back to status + raw body for JSON without a message field', async ({ page }) => {
        await page.setContent('<!doctype html><html><body></body></html>');
        await page.addScriptTag({ path: SCRIPT_PATH });

        const result = await page.evaluate(async () => {
            const response = new Response(JSON.stringify({ success: false, code: 'UNKNOWN' }), { status: 400 });
            return /** @type {any} */ (window).extractErrorMessage(response, 'Request failed');
        });

        expect(result).toBe('Request failed: 400 {"success":false,"code":"UNKNOWN"}');
    });

    test('falls back to status + raw body when message is present but empty/non-string', async ({ page }) => {
        await page.setContent('<!doctype html><html><body></body></html>');
        await page.addScriptTag({ path: SCRIPT_PATH });

        const result = await page.evaluate(async () => {
            const response = new Response(JSON.stringify({ success: false, message: '' }), { status: 422 });
            return /** @type {any} */ (window).extractErrorMessage(response, 'Validation failed');
        });

        expect(result).toBe('Validation failed: 422 {"success":false,"message":""}');
    });
});
