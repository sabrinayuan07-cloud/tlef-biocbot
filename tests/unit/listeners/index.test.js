/**
 * Where BiocBot turns on its event listeners (src/listeners), and the one it
 * has today: BIOCBOT_EVENTS_LOG=1 prints each event in a laptop's terminal.
 * It's off unless asked for, ignored in production, does nothing without the
 * toolkit, and never prints a sensitive event or an event's meaning.
 */
const eventsService = require('../../../src/services/events');
const { startListeners } = require('../../../src/listeners');
const { describeEvent } = require('../../../src/listeners/eventLog');

const describeWithToolkit = eventsService.loadToolkit() !== null ? describe : describe.skip;

const settled = () => new Promise(resolve => setTimeout(resolve, 0));

function fakeEvents({ installed = true } = {}) {
    const listeners = [];
    return {
        listeners,
        getEvents: () => (installed ? {} : null),
        subscribeAll: jest.fn(listener => {
            listeners.push(listener);
            return () => listeners.splice(listeners.indexOf(listener), 1);
        })
    };
}

const logger = () => ({ log: jest.fn(), warn: jest.fn() });

describe('startListeners', () => {
    test('starts nothing unless BIOCBOT_EVENTS_LOG is 1', () => {
        for (const env of [{}, { BIOCBOT_EVENTS_LOG: '0' }, { BIOCBOT_EVENTS_LOG: 'true' }]) {
            const events = fakeEvents();
            const log = logger();
            startListeners({ env, logger: log, events });
            expect(events.subscribeAll).not.toHaveBeenCalled();
            expect(log.log).not.toHaveBeenCalled();
        }
    });

    test('prints each event, one line each, and stops when asked', () => {
        const events = fakeEvents();
        const log = logger();

        const stop = startListeners({ env: { BIOCBOT_EVENTS_LOG: '1', NODE_ENV: 'development' }, logger: log, events });
        expect(log.log).toHaveBeenCalledWith(expect.stringContaining('Printing each event here'));
        events.listeners[0]({ type: 'chat.message.sent', origin: 'server', user: 'user_5f1c', course: 'C1', session: 's1', data: {}, meta: { label: 'x' } });
        expect(log.log).toHaveBeenLastCalledWith('📣 [EVENT] chat.message.sent {"origin":"server","user":"user_5f1c","course":"C1","session":"s1","data":{}}');

        stop();
        expect(events.listeners).toEqual([]);
    });

    test('is ignored in production, with a warning that says why', () => {
        const events = fakeEvents();
        const log = logger();

        startListeners({ env: { BIOCBOT_EVENTS_LOG: '1', NODE_ENV: 'production' }, logger: log, events });

        expect(events.subscribeAll).not.toHaveBeenCalled();
        expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('ignored in production'));
    });

    test('does nothing where the toolkit is not installed', () => {
        const events = fakeEvents({ installed: false });
        const log = logger();

        startListeners({ env: { BIOCBOT_EVENTS_LOG: '1' }, logger: log, events });

        expect(events.subscribeAll).not.toHaveBeenCalled();
        expect(log.log).not.toHaveBeenCalled();
        expect(log.warn).not.toHaveBeenCalled();
    });
});

describe('describeEvent', () => {
    test("where it came from, who and where, and its data, but not its meaning or ids", () => {
        const line = describeEvent({
            id: 'e1',
            type: 'chat.mode.changed',
            version: 1,
            at: '2026-11-24T22:52:20.089Z',
            app: 'biocbot',
            origin: 'browser',
            course: 'C1',
            user: 'user_5f1c',
            preview: true,
            source: { server: 'biocbot-local', browser: 'Chrome 142 on macOS', page: 'http://localhost:8050/student/' },
            data: { from: 'tutor', to: 'protege' },
            meta: { label: 'switches chat mode' }
        });

        expect(line).toBe('📣 [EVENT] chat.mode.changed {"origin":"browser","source":{"server":"biocbot-local","browser":"Chrome 142 on macOS","page":"http://localhost:8050/student/"},"user":"user_5f1c","course":"C1","preview":true,"data":{"from":"tutor","to":"protege"}}');
    });
});

describeWithToolkit("on BiocBot's real publisher", () => {
    test('prints a chat message, and never a struggle change', async () => {
        const log = logger();
        const stop = startListeners({ env: { BIOCBOT_EVENTS_LOG: '1', NODE_ENV: 'development' }, logger: log });

        eventsService.publishEvent('struggle.topic.activated', { user: 'user_5f1c', course: 'C1', data: { topic: 'glycolysis' } });
        eventsService.publishEvent('chat.message.sent', { user: 'user_5f1c', course: 'C1', session: 's1' });
        await settled();
        stop();

        const printed = log.log.mock.calls.map(call => call[0]).filter(line => line.startsWith('📣 [EVENT]'));
        expect(printed).toHaveLength(1);
        expect(printed[0]).toContain('chat.message.sent');
        expect(JSON.stringify(log.log.mock.calls)).not.toContain('glycolysis');
    });
});
