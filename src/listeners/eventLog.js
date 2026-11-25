/**
 * Prints each event BiocBot publishes to this server's terminal, one line each:
 * its type, then where it came from (`origin`, and `source`: the server, and
 * for a page's report the browser and the page), who and where (the
 * pseudonymous user, the course, the chat session, whether it's a preview), and
 * its data. Its meaning (`meta`) is left out, as it's the same every time.
 *
 * For development on a laptop only (src/listeners/index.js). It listens on
 * everything without asking for sensitive events, so struggle changes are
 * never printed.
 */

const SHOWN_FIELDS = ['origin', 'source', 'user', 'course', 'session', 'preview', 'data'];

/**
 * One event as one line.
 * @param {object} event - A published event
 * @returns {string}
 */
function describeEvent(event) {
    const shown = {};
    for (const field of SHOWN_FIELDS) {
        if (event[field] !== undefined) shown[field] = event[field];
    }
    return `📣 [EVENT] ${event.type} ${JSON.stringify(shown)}`;
}

/**
 * Start printing.
 * @param {{ subscribeAll: (listener: (event: object) => void) => () => void, logger?: Pick<Console, 'log'> }} options
 * @returns {() => void} Stops printing
 */
function startEventLog({ subscribeAll, logger = console }) {
    return subscribeAll(event => logger.log(describeEvent(event)));
}

module.exports = { describeEvent, startEventLog };
