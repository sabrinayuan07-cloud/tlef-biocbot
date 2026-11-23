// @ts-check
/**
 * Recorder for the audit-*.a11y.spec.js files.
 *
 * Those specs are an audit, not a gate: they drive a page through its states,
 * run every toolkit rule and axe-core in each one, and write down what they
 * found. Nothing here asserts, so a finding never fails the build. A state the
 * spec could not reach is written down too (as `notCovered`), because an audit
 * that silently skips a state reads as a clean result for it.
 *
 * Output: a11y-results/other-pages/raw/<page>.json, one file per page, plus a
 * screenshot of every state in a11y-results/other-pages/screens/.
 */
const fs = require('fs');
const path = require('path');
const AxeBuilder = require('@axe-core/playwright').default;
const toolkit = require('../toolkit');

const OUT_DIR = path.resolve(__dirname, '../../../a11y-results/other-pages');
const RAW_DIR = path.join(OUT_DIR, 'raw');
const SCREEN_DIR = path.join(OUT_DIR, 'screens');
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

const slug = (text) => String(text).replace(/^\//, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'root';
const firstLines = (error) => String((error && error.message) || error).split('\n').slice(0, 3).join(' ')
    .replace(/\u001b\[[0-9;]*m/g, '').slice(0, 400);

/**
 * @param {string} pagePath the page under audit, as the task names it (for example "/instructor/home")
 */
function createRecorder(pagePath, variant = '') {
    const fileSlug = variant ? `${slug(pagePath)}--${slug(variant)}` : slug(pagePath);
    /** @type {any} */
    const record = {
        page: pagePath,
        variant: variant || null,
        recordedAt: new Date().toISOString(),
        states: {},
        probes: [],
        notCovered: [],
    };

    const write = () => {
        fs.mkdirSync(RAW_DIR, { recursive: true });
        fs.writeFileSync(path.join(RAW_DIR, `${fileSlug}.json`), JSON.stringify(record, null, 2));
    };

    /** Something the audit meant to look at and could not. */
    const notCovered = (what, why) => {
        record.notCovered.push({ what, why: firstLines(why) });
        write();
    };

    /**
     * Run the full rule set and axe-core against the page as it is now.
     * @param {import('@playwright/test').Page} page
     * @param {string} name state name, unique within the page
     * @param {{ root?: string, note?: string, settleMs?: number }} [options] root: limit the scan to one subtree (an open dialog, the toast container)
     */
    async function capture(page, name, { root, note, settleMs = 450 } = {}) {
        try {
            // Let entrance animations finish: a half-faded toast or dialog gives
            // contrast readings for a frame nobody reads.
            await page.waitForTimeout(settleMs);
            if (root && (await page.locator(root).count()) === 0) throw new Error(`root ${root} is not on the page`);
            const findings = await toolkit.audit(page, root ? { root } : {});
            let builder = new AxeBuilder({ page }).withTags(WCAG_TAGS);
            if (root) builder = builder.include(root);
            const axe = (await builder.analyze()).violations.flatMap((v) => v.nodes.map((node) => ({
                rule: v.id,
                impact: v.impact,
                help: v.help,
                selector: node.target.join(' '),
                html: (node.html || '').replace(/\s+/g, ' ').slice(0, 220),
                summary: (node.failureSummary || '').split('\n').slice(0, 3).join(' ').slice(0, 300),
            })));
            fs.mkdirSync(SCREEN_DIR, { recursive: true });
            const shot = `${fileSlug}--${slug(name)}.png`;
            try {
                if (root) await page.locator(root).first().screenshot({ path: path.join(SCREEN_DIR, shot) });
                else await page.screenshot({ path: path.join(SCREEN_DIR, shot), fullPage: true });
            } catch (_) {
                await page.screenshot({ path: path.join(SCREEN_DIR, shot) }).catch(() => {});
            }
            record.states[name] = {
                url: page.url().replace(/^https?:\/\/[^/]+/, ''),
                root: root || null,
                note: note || null,
                screenshot: `screens/${shot}`,
                counts: {
                    fail: findings.filter((f) => f.tier === 'fail').length,
                    review: findings.filter((f) => f.tier === 'review').length,
                    house: findings.filter((f) => f.tier === 'house').length,
                    axe: axe.length,
                },
                findings,
                axe,
            };
            write();
        } catch (error) {
            notCovered(`state "${name}"`, error);
        }
    }

    /**
     * Drive the page into a state, then capture it. If the driving step fails,
     * the state is recorded as not covered and the audit carries on.
     * @param {import('@playwright/test').Page} page
     * @param {string} name
     * @param {() => Promise<any>} drive
     * @param {{ root?: string, note?: string, settleMs?: number }} [options]
     * @returns {Promise<boolean>} whether the state was reached
     */
    async function state(page, name, drive, options) {
        try {
            await drive();
        } catch (error) {
            notCovered(`state "${name}"`, error);
            return false;
        }
        await capture(page, name, options);
        return true;
    }

    /** Run a step that only moves the page along (closing a dialog, say); never throws. */
    async function step(what, fn) {
        try { await fn(); return true; } catch (error) { notCovered(what, error); return false; }
    }

    const probe = (kind, label, data) => {
        record.probes.push({ kind, label, ...data });
        write();
    };

    /** Where focus is after a control is activated from the keyboard. Defect when `lost`. */
    async function focus(label, locator, options) {
        try {
            const before = await toolkit.describe(locator);
            const result = await toolkit.focusAfterActivation(locator, options);
            probe('focus-after-activation', label, {
                control: { selector: before.selector, name: before.name },
                key: (options && options.key) || 'Enter',
                result,
                defect: result.lost,
            });
            return result;
        } catch (error) {
            notCovered(`focus check: ${label}`, error);
            return null;
        }
    }

    /** Whether a show/hide control exposes its state. Defect when it toggles content without aria-expanded/pressed changing. */
    async function disclosure(label, locator, options) {
        try {
            const before = await toolkit.describe(locator);
            const result = await toolkit.disclosureState(locator, options);
            probe('disclosure-state', label, {
                control: { selector: before.selector, name: before.name, role: before.role },
                result,
                defect: result.togglesContent && !(result.exposesState && result.stateChanged),
            });
            return result;
        } catch (error) {
            notCovered(`disclosure check: ${label}`, error);
            return null;
        }
    }

    /** Painted contrast of a graphic (icon, toggle, border). Defect when under 3:1. */
    async function graphic(label, locator, options) {
        try {
            const result = await toolkit.graphicContrast(locator, options);
            const selector = await locator.evaluate((el) => /** @type {any} */ (window).__a11yToolkit.selectorFor(el)).catch(() => '');
            probe('graphic-contrast', label, { control: { selector }, result, needed: 3, defect: result.ratio < 3 });
            return result;
        } catch (error) {
            notCovered(`graphic contrast: ${label}`, error);
            return null;
        }
    }

    /**
     * What is announced when an action runs, and what happens to the message.
     * Defects: nothing announced; a control inside the announcement; a message
     * with a control that is taken away on a timer.
     */
    async function status(label, page, action, options) {
        try {
            const result = await toolkit.observeStatusMessages(page, action, options);
            const problems = [];
            if (!result.announcements.some((a) => a.text)) problems.push('nothing was announced through a live region');
            // role="log" is exempt, as in the toolkit's own live-region rule: a chat log holds per-message controls by design.
            const withControls = result.announcements.filter((a) => a.controlsInside.length && a.role !== 'log');
            if (withControls.length) problems.push(`a control is inside the live region (${[...new Set(withControls.map((a) => a.role))].join(', ')}), so its name is announced with the message`);
            const timed = result.messages.filter((m) => m.controls.length && m.removedAfterMs !== null);
            if (timed.length) problems.push(`a message with a control was removed on a timer (${timed.map((m) => `${m.removedAfterMs}ms`).join(', ')})`);
            probe('status-message', label, { result, problems, defect: problems.length > 0 });
            return result;
        } catch (error) {
            notCovered(`status message check: ${label}`, error);
            return null;
        }
    }

    /** Whether a control can be reached with the Tab key. */
    async function reach(label, page, target, options) {
        try {
            const result = await toolkit.reachableByTab(page, target, options);
            probe('reachable-by-tab', label, { result, defect: !result.reached });
            return result;
        } catch (error) {
            notCovered(`tab reach: ${label}`, error);
            return null;
        }
    }

    /** A plain measurement that fits none of the helpers (a dialog's role and name, say). */
    const note = (label, data, defect = false) => probe('note', label, { data, defect });

    /**
     * Open a dialog, audit it, and check the things only an open dialog can
     * show: its role and name, where focus went, whether Escape closes it, and
     * where focus is once it has closed.
     *
     * @param {import('@playwright/test').Page} page
     * @param {string} name state name
     * @param {{ root: string, open: () => Promise<any>, close?: () => Promise<any>, trigger?: import('@playwright/test').Locator, inside?: (root: string) => Promise<any> }} options
     *   root: the dialog's container; trigger: the control that opened it (focus should return there);
     *   inside: extra work to do while the dialog is open (more states, probes)
     */
    async function dialog(page, name, { root, open, close, trigger, inside }) {
        try {
            await open();
            await page.locator(root).first().waitFor({ state: 'visible', timeout: 8000 });
            await page.waitForTimeout(350);
        } catch (error) {
            notCovered(`dialog "${name}"`, error);
            return false;
        }
        let info = null;
        try {
            // A helper may have wrapped the container in a native <dialog>; describe whichever is the real dialog.
            info = await page.locator(root).first().evaluate((el) => {
                const host = el.closest('dialog') || el.querySelector('dialog[open]') || el.querySelector('[role="dialog"], [role="alertdialog"]') || el;
                const dlg = host.matches('dialog, [role="dialog"], [role="alertdialog"]') ? host : (el.closest('[role="dialog"], [role="alertdialog"]') || host);
                const labelledby = (dlg.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean)
                    .map((id) => document.getElementById(id)).filter(Boolean).map((n) => (n.textContent || '').trim()).join(' ');
                const heading = dlg.querySelector('h1, h2, h3, h4, h5, h6');
                const active = document.activeElement;
                // @ts-ignore
                const toolkitApi = window.__a11yToolkit;
                return {
                    tag: dlg.tagName.toLowerCase(),
                    nativeModal: dlg.tagName === 'DIALOG' && dlg.matches(':modal'),
                    role: dlg.getAttribute('role') || (dlg.tagName === 'DIALOG' ? 'dialog' : null),
                    ariaModal: dlg.getAttribute('aria-modal'),
                    name: dlg.getAttribute('aria-label') || labelledby || '',
                    firstHeading: heading ? `${heading.tagName.toLowerCase()}: ${(heading.textContent || '').trim().slice(0, 60)}` : null,
                    focusInside: !!active && dlg.contains(active),
                    focusOn: active && active !== document.body ? (toolkitApi ? toolkitApi.selectorFor(active) : active.tagName.toLowerCase()) : 'body',
                    focusOnHeading: !!active && /^H[1-6]$/.test(active.tagName),
                };
            });
        } catch (error) {
            notCovered(`dialog "${name}": role and name`, error);
        }
        await capture(page, name, { root });
        if (inside) {
            try { await inside(root); } catch (error) { notCovered(`dialog "${name}": states inside it`, error); }
        }
        let closedByEscape = null;
        let focusAfterClose = null;
        try {
            await page.keyboard.press('Escape');
            await page.waitForTimeout(450);
            closedByEscape = !(await page.locator(root).first().isVisible());
            if (!closedByEscape && close) {
                await close();
                await page.waitForTimeout(450);
            }
            const stillOpen = await page.locator(root).first().isVisible();
            if (stillOpen) throw new Error('the dialog did not close');
            focusAfterClose = await page.evaluate(() => {
                const active = document.activeElement;
                // @ts-ignore
                const toolkitApi = window.__a11yToolkit;
                const onBody = !active || active === document.body;
                return { lost: onBody || (toolkitApi ? !toolkitApi.isRendered(active) : false), active: onBody ? 'body' : (toolkitApi ? toolkitApi.selectorFor(active) : active.tagName) };
            });
            if (trigger && focusAfterClose && !focusAfterClose.lost) {
                focusAfterClose.onTrigger = await trigger.evaluate((el) => document.activeElement === el).catch(() => null);
            }
        } catch (error) {
            notCovered(`dialog "${name}": closing it`, error);
        }
        const problems = [];
        const house = [];
        if (info) {
            if (!info.role) problems.push('no dialog role: assistive technology is not told a dialog opened');
            if (!info.name) problems.push('the dialog has no accessible name');
            if (!info.focusInside) problems.push(`focus was not moved into the dialog (it is on ${info.focusOn})`);
            if (!info.nativeModal && info.ariaModal !== 'true') problems.push('not modal: the page behind stays reachable (no native modal dialog, no aria-modal)');
            if (!info.nativeModal) house.push('not a native <dialog> opened with showModal()');
            if (info.firstHeading && !/^h2:/.test(info.firstHeading)) house.push(`first heading is ${info.firstHeading.split(':')[0]}, not h2`);
            if (info.focusInside && !info.focusOnHeading) house.push('focus does not start on the dialog heading');
        }
        if (closedByEscape === false) problems.push('Escape does not close the dialog');
        if (focusAfterClose && focusAfterClose.lost) problems.push('focus falls to the document body when the dialog closes');
        else if (focusAfterClose && focusAfterClose.onTrigger === false) problems.push(`focus does not return to the control that opened the dialog (it lands on ${focusAfterClose.active})`);
        probe('dialog', name, { root, info, closedByEscape, focusAfterClose, problems, house, defect: problems.length > 0 });
        return true;
    }

    /**
     * Every control on the page that carries aria-expanded, checked one by one.
     * Use where the page has many of the same toggle; `limit` keeps it bounded.
     */
    async function disclosures(page, selector, { limit = 6, scope, labelPrefix = '' } = {}) {
        try {
            const all = page.locator(selector);
            const count = Math.min(await all.count(), limit);
            for (let i = 0; i < count; i += 1) {
                const item = all.nth(i);
                if (!(await item.isVisible().catch(() => false))) continue;
                const described = await toolkit.describe(item).catch(() => ({ name: '' }));
                await disclosure(`${labelPrefix}${described.name || selector} [${i + 1}]`, item, scope ? { scope } : undefined);
            }
        } catch (error) {
            notCovered(`disclosure sweep: ${selector}`, error);
        }
    }

    write();
    return { capture, state, step, focus, disclosure, disclosures, dialog, graphic, status, reach, note, notCovered, record, write };
}

/**
 * Role, name and focus handling of whatever is acting as a dialog right now.
 * @param {import('@playwright/test').Page} page
 * @param {string} selector the dialog container
 */
async function describeDialog(page, selector) {
    await toolkit.inject(page);
    return page.locator(selector).first().evaluate((el) => {
        const labelledby = (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean)
            .map((id) => document.getElementById(id)).filter(Boolean).map((n) => (n.textContent || '').trim()).join(' ');
        const heading = el.querySelector('h1, h2, h3, h4, h5, h6');
        const active = document.activeElement;
        return {
            tag: el.tagName.toLowerCase(),
            nativeModal: el.tagName === 'DIALOG' && el.matches(':modal'),
            role: el.getAttribute('role') || (el.tagName === 'DIALOG' ? 'dialog' : null),
            ariaModal: el.getAttribute('aria-modal'),
            name: el.getAttribute('aria-label') || labelledby || '',
            firstHeading: heading ? `${heading.tagName.toLowerCase()}: ${(heading.textContent || '').trim().slice(0, 60)}` : null,
            focusInside: !!active && el.contains(active),
            // @ts-ignore
            focusOn: active && active !== document.body ? window.__a11yToolkit.selectorFor(active) : 'body',
            hasCloseControl: [...el.querySelectorAll('button, [role="button"], a[href]')]
                .some((c) => /close|cancel|dismiss|×|✕/i.test((c.getAttribute('aria-label') || '') + (c.textContent || ''))),
        };
    });
}

/**
 * Register one page audit as a Playwright test that cannot fail: whatever goes
 * wrong while driving the page is written to the page's record instead.
 *
 * @param {import('@playwright/test').TestType<any, any>} test
 * @param {string} pagePath
 * @param {(ctx: { page: import('@playwright/test').Page, rec: ReturnType<typeof createRecorder> }) => Promise<void>} body
 * @param {{ variant?: string, timeout?: number }} [options] variant: a second audit of the same page (its empty state, another role)
 */
function auditTest(test, pagePath, body, { variant = '', timeout = 420_000 } = {}) {
    test(`audit ${pagePath}${variant ? ` (${variant})` : ''}`, async ({ page }) => {
        test.setTimeout(timeout);
        // One control that is not there must cost seconds, not the whole run.
        page.setDefaultTimeout(12_000);
        const rec = createRecorder(pagePath, variant);
        try {
            await body({ page, rec });
        } catch (error) {
            rec.notCovered('everything after an unexpected error in the audit script', error);
        }
        rec.record.finished = true;
        rec.write();
    });
}

/**
 * The shared toast component (public/common/scripts/notifications.js), checked
 * on the page it is loaded into: all four kinds showing, whether the Dismiss
 * control can be reached and keeps focus, and what one message announces.
 *
 * @param {import('@playwright/test').Page} page
 * @param {ReturnType<typeof createRecorder>} rec
 */
async function toastStates(page, rec) {
    let has;
    try {
        has = await page.evaluate(() => typeof /** @type {any} */ (window).showNotification === 'function');
    } catch (error) {
        rec.notCovered('toast states', error);
        return false;
    }
    if (!has) {
        rec.note('shared toast component', { present: false, detail: 'window.showNotification is not defined on this page' });
        return false;
    }
    await rec.state(page, 'toasts-showing', async () => {
        await page.evaluate(() => {
            const w = /** @type {any} */ (window);
            w.showNotification('Saved.', 'success');
            w.showNotification('Heads up.', 'info');
            w.showNotification('Check this.', 'warning');
            w.showNotification('That did not work.', 'error');
        });
        await page.locator('.notification').first().waitFor({ state: 'visible', timeout: 5000 });
        await page.waitForTimeout(300);
    }, { root: '.notification-container', settleMs: 600 });

    const where = await page.evaluate(() => {
        const c = document.querySelector('.notification-container');
        if (!c) return null;
        const prev = c.previousElementSibling;
        return {
            parent: c.parentElement ? c.parentElement.tagName.toLowerCase() + (c.parentElement.id ? `#${c.parentElement.id}` : '') : null,
            after: prev ? prev.tagName.toLowerCase() + (prev.className ? `.${String(prev.className).split(/\s+/)[0]}` : '') : null,
            role: c.getAttribute('role'), ariaLive: c.getAttribute('aria-live'),
        };
    }).catch(() => null);
    rec.note('toast container position', where);

    const dismiss = page.locator('.notification .notification-close').last();
    if (await dismiss.count()) {
        const skip = page.locator('.skip-link a, a.skip-link, a[href="#main"], a[href="#main-content"]').first();
        if (await skip.count()) await rec.reach('toast Dismiss control from the skip link', page, dismiss, { from: skip, maxTabs: 15 });
        else rec.note('skip link', { present: false, detail: 'no "Skip to main content" link found, so Tab distance to the toast was not measured' }, true);
        await rec.focus('dismiss a toast from the keyboard', dismiss, { settleMs: 700 });
    }
    // Clear what is left, then listen to a single message from start to finish.
    await page.evaluate(() => document.querySelectorAll('.notification .notification-close').forEach((b) => /** @type {HTMLElement} */ (b).click())).catch(() => {});
    await page.waitForTimeout(300);
    await rec.status('one error toast, announced and watched for 7s', page,
        () => page.evaluate(() => /** @type {any} */ (window).showNotification('Could not save your changes.', 'error')));
    await rec.status('one success toast, announced and watched for 7s', page,
        () => page.evaluate(() => /** @type {any} */ (window).showNotification('Your changes were saved.', 'success')));
    await page.evaluate(() => document.querySelectorAll('.notification .notification-close').forEach((b) => /** @type {HTMLElement} */ (b).click())).catch(() => {});
    return true;
}

/**
 * Document-level house rules that are the same question on every page: lang,
 * viewport, title format, skip link, header/main order, the h1, the app nav.
 * @param {import('@playwright/test').Page} page
 * @param {ReturnType<typeof createRecorder>} rec
 */
async function pageShell(page, rec) {
    const shell = await page.evaluate(() => {
        const bodyChildren = [...document.body.children].filter((el) => !/^(SCRIPT|STYLE|TEMPLATE|SVG|NOSCRIPT)$/i.test(el.tagName))
            .map((el) => el.tagName.toLowerCase() + (el.id ? `#${el.id}` : '') + (el.classList[0] ? `.${el.classList[0]}` : ''));
        const viewport = document.querySelector('meta[name="viewport"]');
        const main = document.querySelector('main');
        const h1s = [...document.querySelectorAll('h1')].filter((h) => h.getClientRects().length);
        const skip = document.querySelector('.skip-link a, a.skip-link, a[href="#main"], a[href="#main-content"]');
        const navs = [...document.querySelectorAll('nav')].map((n) => ({
            label: n.getAttribute('aria-label'), inHeader: !!n.closest('header'),
            linksInList: [...n.querySelectorAll('a')].every((a) => !!a.closest('li')),
            hasHeading: !!n.querySelector('h1, h2, h3, h4, h5, h6'),
        }));
        return {
            lang: document.documentElement.getAttribute('lang'),
            viewport: viewport ? viewport.getAttribute('content') : null,
            title: document.title,
            bodyChildren: bodyChildren.slice(0, 12),
            skipLinkHref: skip ? skip.getAttribute('href') : null,
            skipLinkIsFirst: !!skip && (document.body.firstElementChild === skip || document.body.firstElementChild === skip.parentElement),
            hasHeader: !!document.querySelector('body > header'),
            mainIsBodyChild: !!main && main.parentElement === document.body,
            mainId: main ? main.id : null,
            mainTabindex: main ? main.getAttribute('tabindex') : null,
            h1Count: h1s.length,
            h1Text: h1s.map((h) => (h.textContent || '').trim().slice(0, 80)),
            h1IsFirstInMain: !!main && !!main.querySelector('h1') && main.firstElementChild === main.querySelector('h1'),
            navs,
        };
    }).catch((error) => ({ error: String(error) }));
    /** @type {string[]} */
    const problems = [];
    const s = /** @type {any} */ (shell);
    if (!s.error) {
        if (!s.lang) problems.push('<html> has no lang attribute');
        if (s.viewport !== 'width=device-width, initial-scale=1') problems.push(`viewport meta is "${s.viewport}", not the verbatim house value`);
        if (!/ \| /.test(s.title || '')) problems.push(`<title> "${s.title}" is not in the "Title | App" format`);
        if (!s.skipLinkHref) problems.push('no "Skip to main content" link');
        else if (s.skipLinkHref !== '#main') problems.push(`skip link points to "${s.skipLinkHref}", not "#main"`);
        if (s.skipLinkHref && !s.skipLinkIsFirst) problems.push('skip link is not the first child of <body>');
        if (!s.hasHeader) problems.push('no <header> as a direct child of <body>');
        if (!s.mainIsBodyChild) problems.push('<main> is missing or is not a direct child of <body>');
        if (s.mainIsBodyChild && (s.mainId !== 'main' || s.mainTabindex !== '-1')) problems.push(`<main> has id="${s.mainId}" tabindex="${s.mainTabindex}", not id="main" tabindex="-1"`);
        if (s.h1Count !== 1) problems.push(`${s.h1Count} visible <h1> elements`);
        if (s.h1Count === 1 && !s.h1IsFirstInMain) problems.push('<h1> is not the first child of <main>');
        if (s.h1Count === 1 && s.title && !String(s.title).toLowerCase().includes(String(s.h1Text[0]).toLowerCase())) problems.push(`<title> "${s.title}" does not contain the <h1> text "${s.h1Text[0]}"`);
        if (!s.navs.some((n) => n.label === 'App' && n.inHeader)) problems.push('no <nav aria-label="App"> inside <header>');
        if (s.navs.some((n) => !n.linksInList)) problems.push('navigation links are not all inside <li> elements');
        if (s.navs.some((n) => n.hasHeading)) problems.push('a <nav> contains a heading');
    }
    rec.note('page shell (house app-level rules)', { ...s, problems }, problems.length > 0);
}

/**
 * Make an endpoint answer with its real response, but with every list in it
 * emptied: the page's own "nothing here yet" state, without deleting data that
 * other tests share.
 * @param {import('@playwright/test').Page} page
 * @param {string|RegExp} url
 */
async function stubEmptyLists(page, url) {
    const empty = (value, depth) => {
        if (Array.isArray(value)) return [];
        if (value && typeof value === 'object' && depth < 3) {
            for (const key of Object.keys(value)) value[key] = empty(value[key], depth + 1);
        }
        return value;
    };
    await page.route(url, async (route) => {
        if (route.request().method() !== 'GET') return route.continue();
        try {
            const response = await route.fetch();
            const body = await response.json();
            await route.fulfill({ response, json: empty(body, 0) });
        } catch (_) {
            await route.continue().catch(() => {});
        }
    });
}

/** Queue replies on the in-process LLM stub (server started with BIOCBOT_TEST_LLM_STUB=1). */
async function queueLlmReplies(page, replies) {
    const res = await page.request.post('/api/test/llm-stub/enqueue', {
        data: { responses: replies.map((content) => ({ content })) }, failOnStatusCode: false,
    });
    if (!res.ok()) throw new Error(`LLM stub enqueue failed: ${res.status()}`);
}

module.exports = { createRecorder, describeDialog, auditTest, toastStates, pageShell, stubEmptyLists, queueLlmReplies, OUT_DIR, RAW_DIR, slug };
