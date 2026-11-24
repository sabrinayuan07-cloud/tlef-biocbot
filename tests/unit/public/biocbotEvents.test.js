/**
 * The page's events (public/common/scripts/biocbot-events.js).
 *
 * The same checks run against both page buses: the toolkit's browser bus,
 * where /vendor/pubsub.js loads, and biocbot-events.js's own, where the
 * toolkit isn't installed (the Playwright and accessibility CI jobs). Each runs
 * in a VM with the page's file, loaded as the page loads it.
 *
 * Then the pages themselves: every page loads the helper before anything that
 * uses it, and no page script makes its own DOM events any more.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PUBLIC = path.join(__dirname, '../../../public');
const HELPER = path.join(PUBLIC, 'common/scripts/biocbot-events.js');

function toolkitFile() {
    try {
        return require.resolve('@ubc/genai-toolkit-pubsub-browser/pubsub.global.js');
    } catch (error) {
        if (error.code !== 'MODULE_NOT_FOUND') throw error;
        return null;
    }
}
const TOOLKIT_FILE = toolkitFile();

/** Lets queued deliveries run. */
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

/**
 * A page with biocbot-events.js, and the toolkit's file before it when
 * `toolkit` is set. `fetch` records each request and answers 202.
 */
function openPage({ toolkit, local = { selectedCourseId: 'C1' } } = {}) {
    const requests = [];
    const values = new Map(Object.entries(local));
    const errors = [];
    const warnings = [];
    const page = vm.createContext({
        console: {
            log() {},
            warn: (...args) => warnings.push(args),
            error: (...args) => errors.push(args)
        },
        setTimeout,
        clearTimeout,
        location: new URL('http://biocbot.test/student/?courseId=C1'),
        localStorage: {
            getItem: key => (values.has(key) ? values.get(key) : null),
            setItem: (key, value) => values.set(key, String(value))
        },
        fetch: (url, init) => {
            requests.push({ url: String(url), init });
            return Promise.resolve(new Response(JSON.stringify({ ok: true, id: 'e1' }), { status: 202 }));
        }
    });
    page.window = page;
    if (toolkit) vm.runInContext(fs.readFileSync(TOOLKIT_FILE, 'utf8'), page, { filename: '/vendor/pubsub.js' });
    vm.runInContext(fs.readFileSync(HELPER, 'utf8'), page, { filename: '/common/scripts/biocbot-events.js' });
    return { events: page.BiocbotEvents, requests, errors, warnings, page };
}

const BUSES = [['biocbot-events.js\'s own bus', false]];
if (TOOLKIT_FILE) BUSES.push(['the toolkit\'s browser bus', true]);

describe.each(BUSES)('on %s', (name, toolkit) => {
    test('says which bus the page has', () => {
        expect(openPage({ toolkit }).events.usesToolkit).toBe(toolkit);
    });

    test('publish returns before any listener runs, and the listener gets the event a moment later', async () => {
        const { events } = openPage({ toolkit });
        const seen = [];
        events.subscribe('auth.ready', event => seen.push(event));

        expect(events.publish('auth.ready')).toBe(true);
        expect(seen).toEqual([]);

        await flush();
        expect(seen).toHaveLength(1);
        expect(seen[0].type).toBe('auth.ready');
        expect(seen[0]).not.toHaveProperty('data');
    });

    test('each listener gets a frozen copy, made when the event was published', async () => {
        const { events } = openPage({ toolkit });
        const seen = [];
        events.subscribe('chat.session.ended', event => seen.push(event));
        const data = { reason: 'manual' };

        events.publish('chat.session.ended', data);
        data.reason = 'changed';
        await flush();

        expect(seen[0].data).toEqual({ reason: 'manual' });
        expect(Object.isFrozen(seen[0])).toBe(true);
        expect(Object.isFrozen(seen[0].data)).toBe(true);
    });

    test('events arrive in the order they were published, and listeners run in the order they subscribed', async () => {
        const { events } = openPage({ toolkit });
        const seen = [];
        events.subscribe('*', event => seen.push('first ' + event.type));
        events.subscribe('*', event => seen.push('second ' + event.type));

        events.publish('auth.ready');
        events.publish('agreement.accepted', { agreement: 'user-agreement-1.0' });
        await flush();

        expect(seen).toEqual([
            'first auth.ready',
            'second auth.ready',
            'first agreement.accepted',
            'second agreement.accepted'
        ]);
    });

    test('patterns match by segment: * is one segment, or the rest when it comes last', async () => {
        const { events } = openPage({ toolkit });
        const seen = { chat: [], ready: [], all: [] };
        events.subscribe('chat.*', event => seen.chat.push(event.type));
        events.subscribe('*.ready', event => seen.ready.push(event.type));
        events.subscribe('*', event => seen.all.push(event.type));

        events.publish('auth.ready');
        events.publish('chat.mode.changed', { from: 'tutor', to: 'protege' });
        events.publish('chat.session.ended', { reason: 'inactivity' });
        await flush();

        expect(seen.chat).toEqual(['chat.mode.changed', 'chat.session.ended']);
        expect(seen.ready).toEqual(['auth.ready']);
        expect(seen.all).toEqual(['auth.ready', 'chat.mode.changed', 'chat.session.ended']);
    });

    test('a listener added after an event was published does not get it, as with a DOM event', async () => {
        const { events } = openPage({ toolkit });
        const seen = [];

        events.publish('auth.ready');
        events.subscribe('auth.ready', event => seen.push(event));
        await flush();

        expect(seen).toEqual([]);
    });

    test('a listener that stops before its delivery runs gets nothing', async () => {
        const { events } = openPage({ toolkit });
        const seen = [];
        const stop = events.subscribe('auth.ready', event => seen.push(event));

        events.publish('auth.ready');
        stop();
        await flush();

        expect(seen).toEqual([]);
    });

    test('{ once: true } runs the listener for the first match only, even when two are waiting', async () => {
        const { events } = openPage({ toolkit });
        const seen = [];
        events.subscribe('chat.session.ended', event => seen.push(event.data.reason), { once: true });

        events.publish('chat.session.ended', { reason: 'manual' });
        events.publish('chat.session.ended', { reason: 'inactivity' });
        await flush();
        events.publish('chat.session.ended', { reason: 'manual' });
        await flush();

        expect(seen).toEqual(['manual']);
    });

    test('a listener that throws affects no other, and what it threw reaches the console', async () => {
        const { events, errors } = openPage({ toolkit });
        const seen = [];
        events.subscribe('auth.ready', () => { throw new Error('listener broke'); });
        events.subscribe('auth.ready', event => seen.push(event.type));

        expect(events.publish('auth.ready')).toBe(true);
        await flush();
        await flush();

        expect(seen).toEqual(['auth.ready']);
        expect(errors).toHaveLength(1);
        expect(errors[0][0]).toContain('auth.ready');
        expect(errors[0][0]).toContain('listener_failed');
        expect(String(errors[0][1])).toContain('listener broke');
    });

    test('publish never throws: an event without a type comes back false', () => {
        const { events, warnings } = openPage({ toolkit });

        expect(events.publish('')).toBe(false);
        expect(events.publish(undefined)).toBe(false);
        expect(warnings.length).toBeGreaterThan(0);
    });

    test('subscribe still throws for a programming error, as the toolkit does', () => {
        const { events } = openPage({ toolkit });

        // The page's TypeError, from the VM, so matched by its message.
        expect(() => events.subscribe('', () => {})).toThrow(/non-empty string pattern/);
        expect(() => events.subscribe('auth.ready', 'not a function')).toThrow(/listener function/);
    });

    test('the page\'s own events are never reported', async () => {
        const { events, requests } = openPage({ toolkit });

        events.publish('auth.ready');
        events.publish('agreement.accepted', { agreement: 'user-agreement-1.0' });
        events.publish('chat.session.ended', { reason: 'manual' });
        await flush();
        await flush();

        expect(requests).toEqual([]);
    });
});

(TOOLKIT_FILE ? describe : describe.skip)('reporting, on the toolkit\'s browser bus', () => {
    test('a mode switch is reported to the selected course with only its type, data and page', async () => {
        const { events, requests } = openPage({ toolkit: true, local: { selectedCourseId: 'C 1' } });

        events.publish('chat.mode.changed', { from: 'protege', to: 'tutor' });
        await flush();

        expect(requests).toHaveLength(1);
        expect(requests[0].url).toBe('/api/events/C%201');
        expect(JSON.parse(requests[0].init.body)).toEqual({
            type: 'chat.mode.changed',
            data: { from: 'protege', to: 'tutor' },
            page: 'http://biocbot.test/student/'
        });
    });

    test('the types the page reports are the ones the server takes', () => {
        const { REPORTABLE_TYPES } = require('../../../src/services/events');

        expect([...openPage({ toolkit: true }).events.REPORT_TYPES]).toEqual([...REPORTABLE_TYPES]);
    });
});

test('without the toolkit, a mode switch is published on the page and nothing is reported', async () => {
    const { events, requests } = openPage({ toolkit: false });
    const seen = [];
    events.subscribe('chat.mode.changed', event => seen.push(event.data));

    events.publish('chat.mode.changed', { from: 'protege', to: 'tutor' });
    await flush();

    expect(seen).toEqual([{ from: 'protege', to: 'tutor' }]);
    expect(requests).toEqual([]);
});

describe('the pages', () => {
    function htmlFiles(dir = PUBLIC) {
        return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) return htmlFiles(full);
            return entry.name.endsWith('.html') ? [full] : [];
        });
    }

    function scriptFiles(dir = PUBLIC) {
        return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) return scriptFiles(full);
            return entry.name.endsWith('.js') ? [full] : [];
        });
    }

    /** A page's scripts in order: each `src` resolved to a path, and each inline script as its text. */
    function pageScripts(file) {
        const html = fs.readFileSync(file, 'utf8');
        return [...html.matchAll(/<script(?:\s+src="([^"]+)")?[^>]*>([\s\S]*?)<\/script>/g)].map(match => (match[1]
            ? { src: path.resolve(path.dirname(file), match[1]) }
            : { inline: match[2] }));
    }

    const usesEvents = text => /\bBiocbotEvents\./.test(text);
    const helperUsers = new Set(scriptFiles()
        .filter(file => file !== HELPER && usesEvents(fs.readFileSync(file, 'utf8'))));
    const pages = htmlFiles();

    test('some pages and scripts use the page\'s events (the checks below aren\'t empty)', () => {
        expect(helperUsers.size).toBeGreaterThan(10);
        expect(pages.filter(file => pageScripts(file).some(script => script.src === HELPER)).length).toBe(20);
    });

    test.each(pages.map(file => [path.relative(PUBLIC, file), file]))('%s loads biocbot-events.js before anything that uses it', (name, file) => {
        const scripts = pageScripts(file);
        const helperAt = scripts.findIndex(script => script.src === HELPER);
        const users = scripts
            .map((script, index) => ({ script, index }))
            .filter(({ script }) => (script.src ? helperUsers.has(script.src) : usesEvents(script.inline)));

        if (users.length === 0) return;
        expect(helperAt).toBeGreaterThanOrEqual(0);
        for (const { script, index } of users) {
            expect({ script: script.src ? path.relative(PUBLIC, script.src) : 'inline', loadsAfterHelper: index > helperAt })
                .toEqual({ script: script.src ? path.relative(PUBLIC, script.src) : 'inline', loadsAfterHelper: true });
        }
    });

    test.each(pages
        .filter(file => pageScripts(file).some(script => script.src === HELPER))
        .map(file => [path.relative(PUBLIC, file), file]))('%s loads the toolkit\'s file just before biocbot-events.js, and both before auth.js', (name, file) => {
        const sources = pageScripts(file).filter(script => script.src).map(script => path.relative(PUBLIC, script.src));
        const helperAt = sources.indexOf('common/scripts/biocbot-events.js');

        expect(sources[helperAt - 1]).toBe('vendor/pubsub.js');
        expect(sources.indexOf('vendor/pubsub.js')).toBe(sources.lastIndexOf('vendor/pubsub.js'));
        expect(sources.indexOf('common/scripts/auth.js')).toBe(helperAt + 1);
    });

    test('no page script makes its own DOM events: they are the page\'s events now', () => {
        const madeByHand = scriptFiles()
            .filter(file => !file.includes(`${path.sep}vendor${path.sep}`))
            .flatMap(file => fs.readFileSync(file, 'utf8').split('\n')
                .map((line, index) => ({ file: path.relative(PUBLIC, file), line: index + 1, text: line.trim() }))
                .filter(({ text }) => /new CustomEvent\(/.test(text)));
        const inline = pages.flatMap(file => pageScripts(file)
            .filter(script => script.inline && /new CustomEvent\(/.test(script.inline))
            .map(() => path.relative(PUBLIC, file)));

        expect(madeByHand).toEqual([]);
        expect(inline).toEqual([]);
    });
});
