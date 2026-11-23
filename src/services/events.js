/**
 * BiocBot's events, on the UBC GenAI pub/sub toolkit
 * (@ubc/genai-toolkit-pubsub-*, rung 3 of its PRD, section 8).
 *
 * BiocBot announces two things it only recorded before: a student's switch
 * between tutor and protégé mode, and a struggle topic becoming active or being
 * cleared. Each event carries what it means, copied from BiocBot's dictionary
 * below, so a listener needs nothing else. The toolkit stores nothing: the
 * chat, the saved chat and the struggleActivity rows are unchanged, and only
 * listeners BiocBot registers get the events.
 *
 * The packages are on GitHub Packages, so, like the agents framework, they are
 * optional dependencies. An install without a registry token has none of
 * them: nothing is published, the report route answers 404, and BiocBot
 * otherwise works as before.
 */

const CORE_PACKAGE = '@ubc/genai-toolkit-pubsub-core';
const EVENTS_PACKAGE = '@ubc/genai-toolkit-pubsub-events';
const SERVER_PACKAGE = '@ubc/genai-toolkit-pubsub-server';

/**
 * Tutor and protégé, in BiocBot's own words (the guided tour and the protégé
 * prompt). The ids are the values the student page keeps in
 * localStorage.studentMode. The agents path's `explain` is not a mode a student
 * switches to, and nothing reports it, so it isn't here.
 */
const MODES = Object.freeze({
    label: 'mode',
    items: [
        {
            id: 'tutor',
            label: 'Tutor mode',
            description: "BiocBot explains concepts and answers the student's questions about the course material."
        },
        {
            id: 'protege',
            label: 'Protégé mode',
            description: 'The student teaches. BiocBot plays a curious but slightly confused student who asks follow-up questions and never explains the concept itself.'
        }
    ]
});

/**
 * BiocBot's own events. Every event's `user` is the pseudonymous
 * `req.user.userId` (`user_<uuid>`, or a preview sandbox's id), never a name,
 * an email, a PUID or a student number, and no data holds one either.
 */
const EVENT_DEFINITIONS = Object.freeze([
    {
        type: 'chat.mode.changed',
        version: 1,
        label: 'switches chat mode',
        description: "The student moved BiocBot between tutor and protégé mode, with the mode toggle or through the assessment's result.",
        requires: ['user', 'course'],
        props: {
            from: { type: 'ref', label: 'Mode before', collection: 'modes' },
            to: { type: 'ref', label: 'Mode after', collection: 'modes' }
        }
    },
    {
        type: 'struggle.topic.activated',
        version: 1,
        label: 'starts struggling with a topic',
        description: 'BiocBot noticed the student struggling with this topic in three messages, so it now answers about it in directive mode.',
        // Signals about struggle are held back from a listener on everything.
        sensitive: true,
        requires: ['user'],
        props: {
            topic: { type: 'text', label: 'Topic' }
        }
    },
    {
        type: 'struggle.topic.cleared',
        version: 1,
        label: 'clears a struggle topic',
        description: 'The student reset what BiocBot had counted of their struggle with this topic, so the count starts again and directive mode is off for it.',
        sensitive: true,
        requires: ['user'],
        props: {
            topic: { type: 'text', label: 'Topic' }
        }
    }
]);

/**
 * The only types the student page may report (POST /api/events/:courseId).
 * Struggle changes are the server's own: a page can't report one.
 */
const REPORTABLE_TYPES = Object.freeze(['chat.mode.changed']);

const NOT_INSTALLED = Object.freeze({
    ok: false,
    problems: Object.freeze([
        Object.freeze({ field: 'type', code: 'not_installed', message: 'Events are off: the pub/sub toolkit is not installed.' })
    ])
});

/** @type {{ core: any, events: any, server: any } | null | undefined} */
let toolkit;

/**
 * @returns {{ core: any, events: any, server: any } | null} Null where the
 *   packages aren't installed
 */
function loadToolkit() {
    if (toolkit === undefined) {
        try {
            toolkit = { core: require(CORE_PACKAGE), events: require(EVENTS_PACKAGE), server: require(SERVER_PACKAGE) };
        } catch (error) {
            if (error.code !== 'MODULE_NOT_FOUND') throw error;
            toolkit = null;
        }
    }
    return toolkit;
}

/** @type {any | null | undefined} */
let events;

/**
 * BiocBot's one publisher, on its own bus. It is made the first time it is
 * needed, which is at startup, when server.js mounts the report route. The
 * agents framework has a bus of its own, per chat run, and the two never meet.
 *
 * @returns {any | null} The toolkit's `Events`, or null where it isn't installed
 */
function getEvents() {
    if (events === undefined) {
        const loaded = loadToolkit();
        if (!loaded) {
            events = null;
            return events;
        }
        const bus = loaded.core.createEventBus();
        const dictionary = loaded.events.defineDictionary({
            app: 'biocbot',
            extends: loaded.events.generalDictionary,
            events: EVENT_DEFINITIONS,
            collections: { modes: MODES }
        });
        // A listener that throws affects nobody else and comes back here. Only
        // the type and the code are logged: never an event's data.
        bus.subscribe('bus.failed', failed => {
            console.error(`⚠️ [EVENTS] A listener on ${failed.pattern} failed for ${failed.eventType} (${failed.failure && failed.failure.code})`);
        });
        events = loaded.events.createEvents({ bus, dictionary });
    }
    return events;
}

/**
 * Publish one of BiocBot's events. It never throws, so the work it sits next
 * to (a struggleActivity row, a reply) can't fail because of it.
 *
 * @param {string} type - A type from BiocBot's dictionary
 * @param {{ user?: string, course?: string, session?: string, preview?: boolean, data?: object }} input
 * @returns {{ ok: true, event: object } | { ok: false, problems: Array<{ field: string, code: string, message: string }> }}
 */
function publishEvent(type, input) {
    try {
        const publisher = getEvents();
        if (!publisher) return NOT_INSTALLED;
        const result = publisher.publish(type, input);
        if (!result.ok) {
            // Fields and codes only, so no data reaches the log.
            const why = result.problems.map(problem => `${problem.field} ${problem.code}`).join(', ');
            console.warn(`⚠️ [EVENTS] ${type} was not published: ${why}`);
        }
        return result;
    } catch (error) {
        console.error(`❌ [EVENTS] Could not publish ${type}:`, error && error.message);
        return {
            ok: false,
            problems: [{ field: 'type', code: 'publish_failed', message: 'The event could not be published.' }]
        };
    }
}

/**
 * Listen for BiocBot's events whose type matches a pattern, such as
 * `struggle.*`. A listener on a sensitive event's own type gets it.
 * @param {string} pattern
 * @param {(event: object) => unknown} listener
 * @returns {() => void} Stops listening
 */
function subscribe(pattern, listener) {
    const publisher = getEvents();
    return publisher ? publisher.subscribe(pattern, listener) : () => {};
}

/**
 * Listen for every event BiocBot publishes. Sensitive ones (struggle) are left
 * out unless `{ sensitive: true }` is passed, so a listener that logs or saves
 * everything can't keep them by accident.
 * @param {(event: object) => unknown} listener
 * @param {{ sensitive?: boolean }} [options]
 * @returns {() => void} Stops listening
 */
function subscribeAll(listener, options) {
    const publisher = getEvents();
    return publisher ? publisher.subscribeAll(listener, options) : () => {};
}

/**
 * The handler for POST /api/events/:courseId, after src/routes/events.js's
 * guards. The page sends a type, data and a session hint. Who and where come
 * from what the server has checked: the signed-in user's pseudonymous id, the
 * course in the path (which the enrollment guard checked), and whether this is
 * a "View as Student" preview. The page's session hint isn't kept.
 *
 * @returns {(req: object, res: object) => void}
 */
function createReportHandler() {
    const publisher = getEvents();
    if (!publisher) {
        return (req, res) => res.status(404).json(NOT_INSTALLED);
    }
    return loadToolkit().server.createReportHandler({
        events: publisher,
        accept: REPORTABLE_TYPES,
        identify: req => (req.user && req.user.userId
            ? {
                user: req.user.userId,
                course: req.params.courseId,
                preview: req.user.isPreview === true
            }
            : undefined)
    });
}

module.exports = {
    MODES,
    EVENT_DEFINITIONS,
    REPORTABLE_TYPES,
    loadToolkit,
    getEvents,
    publishEvent,
    subscribe,
    subscribeAll,
    createReportHandler
};
