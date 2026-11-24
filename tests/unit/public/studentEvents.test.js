/**
 * The student page's mode switch, reported on the pub/sub toolkit's browser
 * bus (rung 3 of its PRD, section 8).
 *
 * The page's own scripts run in a VM, loaded by URL in index.html's order
 * from a real server: the preview bootstrap, /vendor/pubsub.js (the toolkit's
 * file, from node_modules), biocbot-events.js (the page's bus),
 * student-events.js and student-calibration.js. The
 * DOM is a stand-in with just what the mode toggle touches. The page reports
 * to POST /api/events/:courseId on that server, with BiocBot's real guards,
 * and each test listens on BiocBot's publisher for what the server published.
 */
const fs = require('fs');
const http = require('http');
const path = require('path');
const vm = require('vm');
const express = require('express');
const { memoryDb } = require('../helpers/memory-db');
const createAuthMiddleware = require('../../../src/middleware/auth');
const previewSession = require('../../../src/services/previewSession');
const eventsService = require('../../../src/services/events');
const { createEventReportRoute } = require('../../../src/routes/events');
const vendorRoutes = require('../../../src/routes/vendor');

const describeWithToolkit = eventsService.loadToolkit() !== null ? describe : describe.skip;

const PUBLIC = path.join(__dirname, '../../../public');

/** What the student page loads for the mode toggle, in its order (public/student/index.html). */
const PAGE_SCRIPTS = [
    '/common/scripts/preview-session.js',
    '/vendor/pubsub.js',
    '/common/scripts/biocbot-events.js',
    '/student/scripts/student-events.js',
    '/student/scripts/student-calibration.js'
];

const student = { userId: 'user_5f1c', role: 'student', displayName: 'Jane Student' };
const instructor = { userId: 'user_17d0', role: 'instructor' };

function courses() {
    return [
        { courseId: 'C1', status: 'active', studentEnrollment: { [student.userId]: { enrolled: true } } },
        { courseId: 'C2', status: 'active', studentEnrollment: {} }
    ];
}

/** The server, as server.js mounts what the page uses, with `user` signed in. */
function serverApp({ user = student, session = null } = {}) {
    const db = memoryDb({ courses: courses(), users: [student, instructor] });
    const auth = createAuthMiddleware(db);
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        req.user = { ...user };
        if (session) req.session = session;
        next();
    });
    app.use(auth.resolvePreview);
    app.post('/api/events/:courseId', createEventReportRoute(auth));
    app.use('/common', express.static(path.join(PUBLIC, 'common')));
    app.use('/student', express.static(path.join(PUBLIC, 'student')));
    app.use('/vendor', vendorRoutes);
    return app;
}

const servers = [];
async function listen(app) {
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    return `http://127.0.0.1:${server.address().port}`;
}

function storage(initial = {}) {
    const values = new Map(Object.entries(initial));
    return {
        getItem: key => (values.has(key) ? values.get(key) : null),
        setItem: (key, value) => { values.set(key, String(value)); },
        removeItem: key => { values.delete(key); },
        key: index => [...values.keys()][index] ?? null,
        get length() { return values.size; }
    };
}

function classList() {
    const names = new Set();
    return { add: name => names.add(name), remove: name => names.delete(name), contains: name => names.has(name) };
}

/**
 * The page in a VM. As in a browser, a script that doesn't load (/vendor/pubsub.js
 * where the toolkit isn't installed, or one a test leaves out) doesn't run, and
 * the page goes on without it. `fetch` resolves relative URLs against the
 * server and records each request.
 */
async function openPage(base, { scripts = PAGE_SCRIPTS, local = {}, url = '/student' } = {}) {
    const requests = [];
    const toggle = { checked: true, listeners: {}, addEventListener(type, listener) { this.listeners[type] = listener; } };
    const labels = { '.protege-label': { classList: classList() }, '.tutor-label': { classList: classList() } };
    const elements = { 'mode-toggle-checkbox': toggle, 'chat-messages': { innerHTML: '' } };
    const location = new URL(url, base);
    const page = vm.createContext({
        console,
        URL,
        URLSearchParams,
        Headers,
        Request,
        setTimeout,
        clearTimeout,
        location,
        localStorage: storage({ selectedCourseId: 'C1', ...local }),
        sessionStorage: storage(),
        history: { replaceState() {} },
        // The preview banner waits for DOMContentLoaded, which never comes here.
        document: {
            readyState: 'loading',
            addEventListener() {},
            getElementById: id => elements[id] || null,
            querySelector: selector => labels[selector] || null
        },
        fetch: (input, init) => {
            requests.push({ url: String(input), init });
            return fetch(new URL(input, base), init);
        },
        // What the toggle calls in student.js, student-course.js and student-session.js.
        getCurrentStudentId: () => null,
        collectAllChatData: () => Promise.resolve(null),
        scheduleChatSessionExpiration() {},
        enableChatInput() {}
    });
    page.window = page;
    const loaded = [];
    for (const src of scripts) {
        const response = await fetch(new URL(src, base));
        if (!response.ok) continue;
        vm.runInContext(await response.text(), page, { filename: src });
        loaded.push(src);
    }
    // The chat messages these add are student-calibration.js's own DOM work.
    page.showModeToggleResult = jest.fn();
    page.showModeResult = jest.fn();
    page.initializeModeToggle();
    const switchTo = mode => {
        toggle.checked = mode === 'tutor';
        toggle.listeners.change.call(toggle);
    };
    const reports = () => requests.filter(request => request.url.startsWith('/api/events/'));
    return { page, switchTo, toggle, labels, reports, loaded };
}

/** The next event BiocBot publishes on `pattern`, or null if none comes. */
function nextEvent(pattern, timeout = 1000) {
    return new Promise(resolve => {
        let stop = () => {};
        const timer = setTimeout(() => { stop(); resolve(null); }, timeout);
        stop = eventsService.subscribe(pattern, event => {
            clearTimeout(timer);
            stop();
            resolve(event);
        });
    });
}

/** Lets a report that was (or wasn't) sent reach the server and come back. */
const settled = () => new Promise(resolve => setTimeout(resolve, 100));

let published;
let stopListening;
beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    published = [];
    stopListening = eventsService.subscribeAll(event => { published.push(event); }, { sensitive: true });
});
afterEach(async () => {
    stopListening();
    jest.restoreAllMocks();
    await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))));
});

test('index.html loads the toolkit\'s file, the page bus and student-events.js after the preview bootstrap and before student-calibration.js', () => {
    const html = fs.readFileSync(path.join(PUBLIC, 'student/index.html'), 'utf8');
    const sources = [...html.matchAll(/<script src="([^"]+)"/g)].map(match => match[1]);
    const relevant = sources.filter(src => /preview-session|pubsub|biocbot-events|student-events|student-calibration/.test(src));

    expect(relevant).toEqual([
        '../common/scripts/preview-session.js',
        '../vendor/pubsub.js',
        '../common/scripts/biocbot-events.js',
        './scripts/student-events.js',
        './scripts/student-calibration.js'
    ]);
});

describeWithToolkit('the mode toggle', () => {
    test('a switch is reported once, and BiocBot publishes one event that names and describes both modes', async () => {
        const base = await listen(serverApp());
        const { switchTo, reports, labels } = await openPage(base, { local: { studentMode: 'protege' } });
        const event = nextEvent('chat.mode.changed');

        switchTo('tutor');

        expect(await event).toMatchObject({
            type: 'chat.mode.changed',
            origin: 'browser',
            user: student.userId,
            course: 'C1',
            preview: false,
            data: { from: 'protege', to: 'tutor' },
            meta: {
                label: 'switches chat mode',
                refs: {
                    modes: {
                        label: 'mode',
                        items: {
                            protege: { label: 'Protégé mode', description: expect.stringContaining('The student teaches') },
                            tutor: { label: 'Tutor mode', description: expect.stringContaining('BiocBot explains concepts') }
                        }
                    }
                }
            }
        });
        await settled();
        expect(published).toHaveLength(1);
        // Only the type, the data and the page's address leave the page, through its own fetch.
        expect(reports()).toHaveLength(1);
        const [{ url, init }] = reports();
        expect(url).toBe('/api/events/C1');
        expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin', keepalive: true });
        expect(JSON.parse(init.body)).toEqual({ type: 'chat.mode.changed', data: { from: 'protege', to: 'tutor' }, page: `${base}/student` });
        // The server names itself. Node's fetch says no browser the toolkit knows.
        expect(published[0].source).toEqual({ server: eventsService.serverName(), page: `${base}/student` });
        // The switch itself is as before.
        expect(labels['.tutor-label'].classList.contains('active')).toBe(true);
    });

    test('switching back and forth reports each switch with its own from and to', async () => {
        const base = await listen(serverApp());
        const { switchTo } = await openPage(base, { local: { studentMode: 'tutor' } });

        switchTo('protege');
        switchTo('tutor');
        await settled();

        expect(published.map(event => event.data)).toEqual([
            { from: 'tutor', to: 'protege' },
            { from: 'protege', to: 'tutor' }
        ]);
    });

    test('reports nothing when the page had no mode yet', async () => {
        const base = await listen(serverApp());
        const { page, switchTo, reports } = await openPage(base);

        switchTo('protege');
        await settled();

        expect(page.localStorage.getItem('studentMode')).toBe('protege');
        expect(page.showModeToggleResult).toHaveBeenCalledWith('protege');
        expect(reports()).toEqual([]);
        expect(published).toEqual([]);
    });

    test('marks a switch in a "View as Student" tab as a preview: the page\'s fetch adds the preview header to the report', async () => {
        const grant = previewSession.createGrant(instructor, 'C2');
        const base = await listen(serverApp({ user: instructor, session: { userId: instructor.userId, preview: grant } }));
        // The preview entry URL. The bootstrap pins the previewed course.
        const { page, switchTo, reports } = await openPage(base, { url: '/student?preview=1&courseId=C2', local: { studentMode: 'tutor' } });
        const event = nextEvent('chat.mode.changed');

        switchTo('protege');

        expect(page.localStorage.getItem('selectedCourseId')).toBe('C2');
        expect(await event).toMatchObject({
            user: previewSession.buildPreviewUserId(instructor.userId, 'C2'),
            course: 'C2',
            preview: true,
            data: { from: 'tutor', to: 'protege' }
        });
        expect(new Headers(reports()[0].init.headers).get('X-Preview-Session')).toBe('1');
        // The entry URL's query string (the preview flag, the course) never leaves the page.
        expect(JSON.parse(reports()[0].init.body).page).toBe(`${base}/student`);
        expect(published[0].source.page).toBe(`${base}/student`);
    });

    test('a report the server refuses comes back on the page\'s bus, and the switch still happens', async () => {
        const base = await listen(serverApp());
        // C2 is a course this student isn't enrolled in.
        const { page, switchTo, reports } = await openPage(base, { local: { studentMode: 'tutor', selectedCourseId: 'C2' } });
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

        switchTo('protege');
        await settled();

        expect(reports()).toHaveLength(1);
        expect(published).toEqual([]);
        expect(warn).toHaveBeenCalledWith('[EVENTS] The server did not take a chat.mode.changed report (report_refused)');
        expect(page.localStorage.getItem('studentMode')).toBe('protege');
    });
});

describeWithToolkit('the assessment', () => {
    function assess(page, mode) {
        page.AssessmentScoring = { evaluateAssessment: () => ({ mode, results: [] }) };
        page.currentCalibrationQuestions = [];
        page.studentAnswers = [];
        page.currentPassThreshold = 0;
        return page.calculateStudentMode();
    }

    test('a result that changes a mode the student chose is reported', async () => {
        const base = await listen(serverApp());
        const { page } = await openPage(base, { local: { studentMode: 'tutor' } });
        const event = nextEvent('chat.mode.changed');

        await assess(page, 'protege');

        expect((await event).data).toEqual({ from: 'tutor', to: 'protege' });
        await settled();
        expect(published).toHaveLength(1);
    });

    test('a result is not reported when it sets the first mode, which it usually does: starting the assessment clears the mode', async () => {
        const base = await listen(serverApp());
        const { page, reports } = await openPage(base);

        await assess(page, 'protege');
        await settled();

        expect(page.localStorage.getItem('studentMode')).toBe('protege');
        expect(reports()).toEqual([]);
        expect(published).toEqual([]);
    });

    test('a result that keeps the mode is not reported', async () => {
        const base = await listen(serverApp());
        const { page, reports } = await openPage(base, { local: { studentMode: 'tutor' } });

        await assess(page, 'tutor');
        await settled();

        expect(reports()).toEqual([]);
    });
});

describeWithToolkit('modes set without the student choosing', () => {
    test('a first chat sets tutor mode and reports nothing', async () => {
        const base = await listen(serverApp());
        const { page, reports } = await openPage(base, { local: { studentMode: 'protege' } });
        Object.assign(page, { clearCurrentChatData() {}, addMessage() {}, getAIUseDisclaimerHtml: () => '' });

        await page.prepareFirstStudentGuidedChat('Unit 1');
        await settled();

        expect(page.localStorage.getItem('studentMode')).toBe('tutor');
        expect(reports()).toEqual([]);
    });

    test('only the toggle and the assessment\'s result call publishModeChange (not restore, the guided tour or a first chat)', () => {
        const scripts = path.join(PUBLIC, 'student/scripts');
        const callers = fs.readdirSync(scripts)
            .filter(file => file.endsWith('.js'))
            .flatMap(file => fs.readFileSync(path.join(scripts, file), 'utf8').split('\n')
                .filter(line => line.includes('publishModeChange(') && !line.trim().startsWith('*') && !line.includes('function publishModeChange'))
                .map(line => `${file}: ${line.trim()}`));

        expect(callers).toEqual([
            'student-calibration.js: window.StudentEvents?.publishModeChange(previousMode, mode);',
            'student-calibration.js: window.StudentEvents?.publishModeChange(previousMode, newMode);'
        ]);
    });
});

describe('without the toolkit\'s file', () => {
    test('the toggle works as before and the switch is published on the page only, when /vendor/pubsub.js does not load', async () => {
        const base = await listen(serverApp());
        const scripts = PAGE_SCRIPTS.filter(src => src !== '/vendor/pubsub.js');
        const { page, switchTo, reports, labels } = await openPage(base, { scripts, local: { studentMode: 'tutor' } });

        expect(page.UbcPubsub).toBeUndefined();
        expect(page.BiocbotEvents.usesToolkit).toBe(false);
        const onThePage = [];
        page.BiocbotEvents.subscribe('chat.mode.changed', event => onThePage.push(event.data));
        switchTo('protege');
        await settled();

        expect(page.localStorage.getItem('studentMode')).toBe('protege');
        expect(page.showModeToggleResult).toHaveBeenCalledWith('protege');
        expect(labels['.protege-label'].classList.contains('active')).toBe(true);
        expect(onThePage).toEqual([{ from: 'tutor', to: 'protege' }]);
        expect(reports()).toEqual([]);
        expect(published).toEqual([]);
    });

    test('the toggle works as before on a page without student-events.js (the Playwright harnesses)', async () => {
        const base = await listen(serverApp());
        const scripts = ['/student/scripts/student-calibration.js'];
        const { page, switchTo, reports } = await openPage(base, { scripts, local: { studentMode: 'tutor' } });

        switchTo('protege');
        await settled();

        expect(page.StudentEvents).toBeUndefined();
        expect(page.localStorage.getItem('studentMode')).toBe('protege');
        expect(reports()).toEqual([]);
    });
});
