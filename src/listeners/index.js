/**
 * Where BiocBot turns on the listeners for its events (src/services/events.js),
 * once, at startup. A toolkit that reacts to what students do, such as the
 * gamification toolkit's listener, is added here: it subscribes to BiocBot's
 * publisher, and the routes that publish don't change.
 *
 * Today there is one, for development: BIOCBOT_EVENTS_LOG=1 prints each event
 * in the terminal (src/listeners/eventLog.js, .env-example). It is ignored in
 * production, because each line holds a student's pseudonymous id and what
 * they did.
 *
 * Where the pub/sub toolkit isn't installed nothing is published, so nothing
 * here starts.
 */

const defaultEvents = require('../services/events');
const { startEventLog } = require('./eventLog');

/**
 * @param {{ env?: NodeJS.ProcessEnv, logger?: Pick<Console, 'log' | 'warn'>, events?: { getEvents: () => unknown, subscribeAll: Function } }} [options]
 * @returns {() => void} Stops every listener started here
 */
function startListeners({ env = process.env, logger = console, events = defaultEvents } = {}) {
    const stops = [];
    if (!events.getEvents()) return () => {};

    if (env.BIOCBOT_EVENTS_LOG === '1') {
        if (env.NODE_ENV === 'production') {
            logger.warn('⚠️ [EVENTS] BIOCBOT_EVENTS_LOG is ignored in production: it would put what students do in the server log.');
        } else {
            stops.push(startEventLog({ subscribeAll: events.subscribeAll, logger }));
            logger.log('📣 [EVENTS] Printing each event here (BIOCBOT_EVENTS_LOG=1). Sensitive ones are left out.');
        }
    }

    return () => {
        for (const stop of stops.splice(0)) stop();
    };
}

module.exports = { startListeners };
