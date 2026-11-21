// @ts-check
/**
 * Node-side half of the accessibility toolkit: injects the in-page checks and
 * adds the checks that need a real browser doing real things: pressing keys,
 * reading pixels, and watching what a live region announces over time.
 *
 * Nothing in here is specific to one application. A spec drives its own page
 * into a state (dialog open, toast showing, button pressed) and then calls
 * these to ask whether that state is accessible.
 */
const fs = require('fs');
const path = require('path');

const AXE_SOURCE = require('axe-core').source;
const CHECKS_SOURCE = fs.readFileSync(path.join(__dirname, 'browser-checks.js'), 'utf8');

/** @param {import('@playwright/test').Page} page */
async function inject(page) {
    const state = await page.evaluate(() => ({
        // @ts-ignore
        axe: typeof window.axe !== 'undefined', toolkit: typeof window.__a11yToolkit !== 'undefined',
    }));
    if (!state.axe) await page.evaluate(AXE_SOURCE);
    if (!state.toolkit) await page.evaluate(CHECKS_SOURCE);
}

/**
 * Run the static rule set against the page as it is right now.
 *
 * @param {import('@playwright/test').Page} page
 * @param {{ root?: string, rules?: string[], largeTextAt3?: boolean }} [options]
 * @returns {Promise<Array<{rule: string, tier: 'fail'|'review'|'house', wcag: string, selector: string, name: string, html: string, message: string, data: any}>>}
 */
async function audit(page, options = {}) {
    await inject(page);
    // @ts-ignore
    return page.evaluate((opts) => window.__a11yToolkit.audit(opts), options);
}

/**
 * Role, accessible name, and state of one element.
 * @param {import('@playwright/test').Locator} locator
 */
async function describe(locator) {
    await inject(locator.page());
    // @ts-ignore
    return locator.evaluate((el) => window.__a11yToolkit.describe(el));
}

/** @param {import('@playwright/test').Locator} locator */
async function describeAll(locator) {
    await inject(locator.page());
    // @ts-ignore
    return locator.evaluateAll((els) => els.map((el) => window.__a11yToolkit.describe(el)));
}

function luminance([r, g, b]) {
    const ch = [r, g, b].map((v) => {
        const c = v / 255;
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

function contrastRatio(a, b) {
    const la = luminance(a);
    const lb = luminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const toHex = (c) => `#${c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;

/**
 * Measure the contrast of a graphic from the pixels the browser actually
 * painted, not from stylesheet values, so pseudo-elements, gradients, opacity
 * and SVG strokes are all accounted for.
 *
 * The background is the most common colour in the capture. The foreground is
 * whichever other colour (covering a meaningful number of pixels) contrasts
 * most with it. That makes the result a best case: if even the best pair
 * falls short of the threshold, the graphic fails.
 *
 * @param {import('@playwright/test').Locator} locator
 * @param {{ pad?: number }} [options] pad: extra pixels around the element, to include its surroundings
 * @returns {Promise<{ ratio: number, background: string, foreground: string, pixels: number }>}
 */
async function graphicContrast(locator, { pad = 0 } = {}) {
    const page = locator.page();
    await locator.scrollIntoViewIfNeeded();
    const box = await locator.boundingBox();
    if (!box) throw new Error('graphicContrast: element has no box');
    const clip = {
        x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad),
        width: box.width + pad * 2, height: box.height + pad * 2,
    };
    const png = await page.screenshot({ clip, animations: 'disabled', caret: 'hide' });

    // Decode the PNG with the browser's own decoder on a blank page, so the
    // toolkit needs no image library.
    const decoder = await page.context().newPage();
    try {
        const buckets = await decoder.evaluate(async (base64) => {
            const img = new Image();
            img.src = `data:image/png;base64,${base64}`;
            await img.decode();
            const canvas = document.createElement('canvas');
            canvas.width = img.width;
            canvas.height = img.height;
            const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
            ctx.drawImage(img, 0, 0);
            const { data } = ctx.getImageData(0, 0, img.width, img.height);
            /** @type {Map<number, {n: number, r: number, g: number, b: number}>} */
            const map = new Map();
            for (let i = 0; i < data.length; i += 4) {
                // 5 bits per channel groups anti-aliasing noise without merging real colours.
                const key = ((data[i] >> 3) << 10) | ((data[i + 1] >> 3) << 5) | (data[i + 2] >> 3);
                const b = map.get(key) || { n: 0, r: 0, g: 0, b: 0 };
                b.n += 1; b.r += data[i]; b.g += data[i + 1]; b.b += data[i + 2];
                map.set(key, b);
            }
            return {
                total: data.length / 4,
                colors: [...map.values()].map((b) => ({ n: b.n, rgb: [b.r / b.n, b.g / b.n, b.b / b.n] })),
            };
        }, png.toString('base64'));

        const sorted = buckets.colors.sort((a, b) => b.n - a.n);
        const background = sorted[0];
        const minPixels = Math.max(4, Math.round(buckets.total * 0.003));
        let best = { ratio: 1, rgb: background.rgb, n: 0 };
        for (const candidate of sorted.slice(1)) {
            if (candidate.n < minPixels) continue;
            const r = contrastRatio(candidate.rgb, background.rgb);
            if (r > best.ratio) best = { ratio: r, rgb: candidate.rgb, n: candidate.n };
        }
        return {
            ratio: Math.round(best.ratio * 100) / 100,
            background: toHex(background.rgb),
            foreground: toHex(best.rgb),
            pixels: best.n,
        };
    } finally {
        await decoder.close();
    }
}

/**
 * Activate a control from the keyboard and report where focus ends up.
 *
 * Focus is "lost" when, after the page settles, the active element is the
 * body (or nothing), or is no longer rendered: the next Tab would then start
 * from the top of the document.
 *
 * @param {import('@playwright/test').Locator} locator
 * @param {{ key?: string, settleMs?: number }} [options]
 */
async function focusAfterActivation(locator, { key = 'Enter', settleMs = 900 } = {}) {
    const page = locator.page();
    await inject(page);
    await locator.focus();
    const focused = await locator.evaluate((el) => document.activeElement === el);
    if (!focused) throw new Error('focusAfterActivation: control could not take focus');
    await page.keyboard.press(key);
    await page.waitForTimeout(settleMs);
    return page.evaluate(() => {
        const active = document.activeElement;
        // @ts-ignore
        const toolkit = window.__a11yToolkit;
        const onBody = !active || active === document.body || active === document.documentElement;
        const rendered = !onBody && toolkit.isRendered(active);
        return {
            lost: onBody || !rendered,
            active: onBody ? 'body' : toolkit.selectorFor(active),
            activeText: onBody ? '' : (active.getAttribute('aria-label') || active.textContent || '').trim().slice(0, 60),
        };
    });
}

/**
 * Activate a control and report whether something on the page appeared or
 * disappeared, and whether the control said so through aria-expanded or
 * aria-pressed. A control that shows and hides content must expose that state.
 *
 * The control is activated twice, so the page is left as it was found.
 *
 * @param {import('@playwright/test').Locator} locator
 * @param {{ scope?: string }} [options] scope: selector whose descendants are watched (default: the control's parent's parent)
 */
async function disclosureState(locator, { scope } = {}) {
    const page = locator.page();
    await inject(page);
    const snapshot = () => locator.evaluate((el, scopeSelector) => {
        // @ts-ignore
        const toolkit = window.__a11yToolkit;
        const region = scopeSelector ? el.closest(scopeSelector) : (el.parentElement?.parentElement || document.body);
        const visible = [...(region || document.body).querySelectorAll('*')].filter((n) => toolkit.isRendered(n)).length;
        return {
            visible,
            expanded: el.getAttribute('aria-expanded'),
            pressed: el.getAttribute('aria-pressed'),
        };
    }, scope || null);

    const before = await snapshot();
    await locator.click();
    await page.waitForTimeout(250);
    const after = await snapshot();
    await locator.click();
    await page.waitForTimeout(250);

    const togglesContent = before.visible !== after.visible;
    const stateChanged = before.expanded !== after.expanded || before.pressed !== after.pressed;
    return {
        togglesContent,
        exposesState: before.expanded !== null || before.pressed !== null,
        stateChanged,
        before,
        after,
    };
}

/**
 * Run an action and record what the page's live regions announce and what
 * happens to the message afterwards.
 *
 * @param {import('@playwright/test').Page} page
 * @param {() => Promise<any>} action
 * @param {{ watchMs?: number }} [options] watchMs: how long to keep watching for a message being taken away
 * @returns {Promise<{
 *   announcements: Array<{ text: string, role: string, controlsInside: string[] }>,
 *   messages: Array<{ text: string, controls: string[], removedAfterMs: number|null, inLiveRegion: boolean }>
 * }>}
 */
async function observeStatusMessages(page, action, { watchMs = 7000 } = {}) {
    await inject(page);
    await page.evaluate(() => {
        // @ts-ignore
        const toolkit = window.__a11yToolkit;
        const LIVE = '[role="status"], [role="alert"], [aria-live="polite"], [aria-live="assertive"]';
        const start = performance.now();
        const record = { announcements: [], messages: [] };
        const tracked = new Map();
        const controlNames = (node) => [...node.querySelectorAll(toolkit.INTERACTIVE)]
            .map((c) => toolkit.describe(c).name || c.textContent.trim());

        const observer = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                for (const node of mutation.addedNodes) {
                    const el = node.nodeType === 1 ? /** @type {Element} */ (node) : node.parentElement;
                    if (!el) continue;
                    const region = el.closest(LIVE);
                    if (region) {
                        record.announcements.push({
                            // What a screen reader speaks: the text of the inserted node,
                            // including the names of any controls inside it.
                            text: node.nodeType === 1
                                ? [...el.querySelectorAll('*')].reduce((text, child) => {
                                    const label = child.getAttribute('aria-label');
                                    return label ? `${text} ${label}` : text;
                                }, (el.textContent || '').trim()).replace(/\s+/g, ' ').trim()
                                : (node.nodeValue || '').trim(),
                            role: region.getAttribute('role') || `aria-live=${region.getAttribute('aria-live')}`,
                            controlsInside: node.nodeType === 1 ? controlNames(el) : [],
                        });
                    }
                    // Track anything that looks like a transient message: a node added
                    // to a live region, or a node that itself carries a live role.
                    if (node.nodeType === 1 && (region || el.matches(LIVE) || el.querySelector(LIVE))) {
                        const entry = {
                            text: (el.textContent || '').replace(/\s+/g, ' ').trim(),
                            controls: controlNames(el),
                            removedAfterMs: null,
                            inLiveRegion: !!region,
                        };
                        if (entry.text) { record.messages.push(entry); tracked.set(el, entry); }
                    }
                }
                for (const node of mutation.removedNodes) {
                    const entry = tracked.get(node);
                    if (entry && entry.removedAfterMs === null) entry.removedAfterMs = Math.round(performance.now() - start);
                }
            }
        });
        observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
        // @ts-ignore
        window.__a11yStatusWatch = { observer, record };
    });

    await action();
    await page.waitForTimeout(watchMs);

    return page.evaluate(() => {
        // @ts-ignore
        const watch = window.__a11yStatusWatch;
        watch.observer.disconnect();
        // @ts-ignore
        delete window.__a11yStatusWatch;
        return watch.record;
    });
}

/**
 * Walk the page with the Tab key and report whether a control is reached.
 * This is the only honest test of "can a keyboard user get to it".
 *
 * @param {import('@playwright/test').Page} page
 * @param {import('@playwright/test').Locator} target
 * @param {{ maxTabs?: number, from?: import('@playwright/test').Locator }} [options]
 */
async function reachableByTab(page, target, { maxTabs = 150, from } = {}) {
    if (from) await from.focus();
    for (let i = 1; i <= maxTabs; i += 1) {
        await page.keyboard.press('Tab');
        if ((await target.count()) === 0) return { reached: false, tabs: i, reason: 'target no longer exists' };
        if (await target.first().evaluate((el) => document.activeElement === el)) return { reached: true, tabs: i };
    }
    return { reached: false, tabs: maxTabs, reason: 'not in the first tab stops' };
}

module.exports = {
    audit,
    describe,
    describeAll,
    disclosureState,
    focusAfterActivation,
    graphicContrast,
    inject,
    observeStatusMessages,
    reachableByTab,
    contrastRatio,
};
