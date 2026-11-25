/**
 * Where BiocBot turns on the listeners for its events (src/services/events.js),
 * once, at startup. A toolkit that reacts to what students do subscribes to
 * BiocBot's publisher here, and the routes that publish don't change.
 *
 * - Gamification (src/services/gamification.js): BIOCBOT_GAMIFICATION=1
 *   counts what students do against their course's rules and keeps it in
 *   BiocBot's MongoDB. Off unless asked for.
 * - For development: BIOCBOT_EVENTS_LOG=1 prints each event in the terminal
 *   (src/listeners/eventLog.js, .env-example). It is ignored in production,
 *   because each line holds a student's pseudonymous id and what they did.
 *
 * Where the pub/sub toolkit isn't installed nothing is published, so nothing
 * here starts.
 */

const defaultEvents = require('../services/events');
const defaultGamification = require('../services/gamification');
const { startEventLog } = require('./eventLog');

/**
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   logger?: Pick<Console, 'log' | 'warn' | 'error'>,
 *   events?: { getEvents: () => unknown, subscribeAll: Function },
 *   db?: import('mongodb').Db,
 *   gamification?: { startGamification: Function }
 * }} [options] - `db` is BiocBot's database, for gamification
 * @returns {() => void} Stops every listener started here
 */
function startListeners({ env = process.env, logger = console, events = defaultEvents, db, gamification = defaultGamification } = {}) {
    const stops = [];
    const publisher = events.getEvents();
    if (!publisher) return () => {};

    if (env.BIOCBOT_GAMIFICATION === '1') {
        const started = gamification.startGamification({ events: publisher, db, logger });
        if (started) {
            stops.push(started.stop);
            logger.log('🏅 [GAMIFICATION] Counting what students do (BIOCBOT_GAMIFICATION=1).');
        } else {
            logger.warn('⚠️ [GAMIFICATION] BIOCBOT_GAMIFICATION=1, but the gamification toolkit is not installed.');
        }
    }

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
