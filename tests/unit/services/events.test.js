/**
 * src/services/events.js: the name of this application server, which every
 * event BiocBot publishes carries as `source.server` (the pub/sub toolkit's
 * decision 28, in 0.3.0-rc.2).
 */
const eventsService = require('../../../src/services/events');

const describeWithToolkit = eventsService.loadToolkit() !== null ? describe : describe.skip;

const SWITCH = Object.freeze({ user: 'user_5f1c', course: 'C1', data: { from: 'tutor', to: 'protege' } });

describe('serverName', () => {
    const laptop = () => 'Janes-MacBook-Pro.local';

    test('is BIOCBOT_SERVER_NAME, trimmed', () => {
        expect(eventsService.serverName({ BIOCBOT_SERVER_NAME: '  biocbot-prod-2 ', NODE_ENV: 'production' }, laptop))
            .toBe('biocbot-prod-2');
    });

    test('is cut to the 128 characters the toolkit takes', () => {
        const name = eventsService.serverName({ BIOCBOT_SERVER_NAME: 'b'.repeat(200) }, laptop);
        expect(name).toBe('b'.repeat(128));
    });

    test('is a production server\'s host name, up to the first dot, when unset or blank', () => {
        const host = () => 'tlef-biocbot-prod-1.it.ubc.ca';
        expect(eventsService.serverName({ NODE_ENV: 'production' }, host)).toBe('tlef-biocbot-prod-1');
        expect(eventsService.serverName({ NODE_ENV: 'production', BIOCBOT_SERVER_NAME: '   ' }, host)).toBe('tlef-biocbot-prod-1');
    });

    test('is biocbot-local anywhere else, so a laptop named after its owner never names an event', () => {
        expect(eventsService.serverName({ NODE_ENV: 'development' }, laptop)).toBe('biocbot-local');
        expect(eventsService.serverName({}, laptop)).toBe('biocbot-local');
        expect(eventsService.serverName({ NODE_ENV: 'production' }, () => '')).toBe('biocbot-local');
    });
});

describeWithToolkit('source.server', () => {
    test('every event BiocBot publishes carries this server\'s name', () => {
        const result = eventsService.publishEvent('chat.mode.changed', SWITCH);

        expect(result.ok).toBe(true);
        expect(result.event.source).toEqual({ server: eventsService.serverName() });
    });

    test('is the name BIOCBOT_SERVER_NAME sets', () => {
        const before = process.env.BIOCBOT_SERVER_NAME;
        process.env.BIOCBOT_SERVER_NAME = 'biocbot-web-2';
        try {
            jest.isolateModules(() => {
                const isolated = require('../../../src/services/events');
                const result = isolated.publishEvent('struggle.topic.activated', { user: 'user_5f1c', data: { topic: 'glycolysis' } });

                expect(result.ok).toBe(true);
                expect(result.event.source).toEqual({ server: 'biocbot-web-2' });
            });
        } finally {
            if (before === undefined) delete process.env.BIOCBOT_SERVER_NAME;
            else process.env.BIOCBOT_SERVER_NAME = before;
        }
    });
});
