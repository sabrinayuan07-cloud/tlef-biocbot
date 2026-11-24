/**
 * BiocBot's page events, in the UBC GenAI pub/sub toolkit's format.
 *
 * Every page loads this before auth.js, right after ../vendor/pubsub.js, and
 * sets window.BiocbotEvents. A page's scripts announce what happened with
 * `BiocbotEvents.publish(type, data)` and listen with
 * `BiocbotEvents.subscribe(pattern, listener)`. Each event is `{ type, data }`,
 * the toolkit's shape, so a toolkit that listens on the page later (such as
 * gamification's widgets) gets BiocBot's events in the form it already knows.
 *
 * The page's events:
 *
 * | Type                | Data                  | Published by          | When |
 * | ------------------- | --------------------- | --------------------- | ---- |
 * | `auth.ready`        | none                  | auth.js               | The signed-in user is known. Read them with getCurrentUser() or waitForCurrentUser() |
 * | `agreement.accepted`| `{ agreement }`       | agreement-modal.js    | The server recorded the user agreement. The toolkit's general event |
 * | `chat.mode.changed` | `{ from, to }`        | student-events.js     | The student switched between tutor and protégé mode. Reported to the server |
 * | `chat.session.ended`| `{ reason }`          | student-session.js    | The student's chat session ended and a new one starts: `manual` or `inactivity` |
 *
 * Data never holds a name, an email or a student number: who the user is
 * stays with auth.js.
 *
 * Where the toolkit is installed, /vendor/pubsub.js sets UbcPubsub and the page
 * bus is the toolkit's browser bus, which also reports `chat.mode.changed` to
 * POST /api/events/:courseId. Where it isn't (an install without a GitHub
 * Packages token, as in the Playwright and accessibility CI jobs), that file
 * 404s and the page bus is the small one below, with the same contract and no
 * reporting, so every page works the same either way.
 *
 * The contract, the toolkit's (its PRD, section 4, rule 1):
 * - `publish` returns before any listener runs. Listeners run a moment later,
 *   on a microtask, so a publisher can't be held up or broken by one.
 * - Each listener gets a frozen copy of the event.
 * - Events arrive in the order they were published, and listeners run in the
 *   order they subscribed. A listener added after an event was published
 *   doesn't get that event.
 * - A listener that throws is reported as `bus.failed` and affects no other.
 *
 * Because listeners run later, an event is an announcement, not a command.
 * Something that must happen before the publisher goes on (stopping a reply
 * before the chat is cleared) is a direct call.
 */
(function () {
    'use strict';

    /**
     * The types the page reports to the server, which publishes them on
     * BiocBot's own bus. src/services/events.js's REPORTABLE_TYPES is the
     * server's list, and it refuses any other type.
     */
    const REPORT_TYPES = Object.freeze(['chat.mode.changed']);

    // How many listeners in a row can each publish from inside a delivery,
    // as in the toolkit, so a listener on `*` that publishes can't loop forever.
    const MAX_PUBLISH_DEPTH = 32;

    function selectedCourseId() {
        try {
            return localStorage.getItem('selectedCourseId');
        } catch (error) {
            return null;
        }
    }

    /**
     * Whether an event type matches a pattern. Segments are separated by dots.
     * `*` matches one segment, or everything left when it comes last.
     */
    function matchesPattern(pattern, type) {
        const wanted = pattern.split('.');
        const actual = type.split('.');
        const takesTheRest = wanted[wanted.length - 1] === '*';
        if (takesTheRest ? actual.length < wanted.length : actual.length !== wanted.length) {
            return false;
        }
        return wanted.every((segment, index) => segment === '*' || segment === actual[index]);
    }

    function isPlain(value) {
        if (typeof value !== 'object' || value === null) return false;
        if (Array.isArray(value)) return true;
        const prototype = Object.getPrototypeOf(value);
        return prototype === null || Object.getPrototypeOf(prototype) === null;
    }

    /** A deeply frozen copy of plain objects and arrays. Anything else as it is. */
    function freezeCopy(value, seen = new WeakMap()) {
        if (!isPlain(value)) return value;
        if (seen.has(value)) return seen.get(value);
        const result = Array.isArray(value) ? [] : Object.create(Object.getPrototypeOf(value));
        seen.set(value, result);
        for (const key of Object.keys(value)) {
            Object.defineProperty(result, key, { value: freezeCopy(value[key], seen), enumerable: true });
        }
        return Object.freeze(result);
    }

    /**
     * The page bus where the toolkit isn't installed: core's contract, in this
     * page only. Its tests run the same checks against the toolkit's bus
     * (tests/unit/public/biocbotEvents.test.js).
     */
    function createFallbackBus() {
        const subscriptions = [];
        const queue = [];
        let drainScheduled = false;
        let current;

        function nextDepth() {
            return current === undefined ? 0 : current.depth + 1;
        }

        function enqueue(event, targets, depth) {
            if (targets.length === 0) return;
            queue.push({ event, targets, depth });
            if (!drainScheduled) {
                drainScheduled = true;
                Promise.resolve().then(drain);
            }
        }

        function drain() {
            for (let delivery = queue.shift(); delivery !== undefined; delivery = queue.shift()) {
                current = delivery;
                for (const target of delivery.targets) {
                    // It may have unsubscribed since the event was published.
                    if (target.active) deliver(target, delivery.event);
                }
            }
            current = undefined;
            drainScheduled = false;
        }

        function deliver(target, event) {
            const onFailure = cause => report(event.type, cause, target.pattern);
            try {
                Promise.resolve(target.listener(event)).catch(onFailure);
            } catch (cause) {
                onFailure(cause);
            }
        }

        function report(eventType, cause, pattern) {
            // A failure while handling a failure goes no further.
            if (eventType === 'bus.failed' || (current && current.event.type === 'bus.failed')) return;
            const message = cause instanceof Error ? cause.message : String(cause);
            const failed = Object.freeze({
                type: 'bus.failed',
                eventType,
                pattern,
                failure: Object.freeze({ code: 'listener_failed', message, cause })
            });
            enqueue(failed, match('bus.failed'), nextDepth());
        }

        function match(type) {
            return subscriptions.filter(target => target.active && matchesPattern(target.pattern, type));
        }

        function publish(event) {
            if (!event || typeof event.type !== 'string' || event.type === '') {
                throw new TypeError('An event needs a non-empty string `type`.');
            }
            const depth = nextDepth();
            if (depth > MAX_PUBLISH_DEPTH) return;
            const targets = match(event.type);
            if (targets.length === 0) return;
            enqueue(freezeCopy(event), targets, depth);
        }

        function subscribe(pattern, listener) {
            if (typeof pattern !== 'string' || pattern === '') {
                throw new TypeError('A subscription needs a non-empty string pattern.');
            }
            if (typeof listener !== 'function') {
                throw new TypeError('A subscription needs a listener function.');
            }
            const target = { pattern, listener, active: true };
            subscriptions.push(target);
            return () => {
                target.active = false;
                const index = subscriptions.indexOf(target);
                if (index !== -1) subscriptions.splice(index, 1);
            };
        }

        return Object.freeze({ publish, subscribe });
    }

    const usesToolkit = typeof UbcPubsub !== 'undefined'
        && UbcPubsub !== null
        && typeof UbcPubsub.createBrowserBus === 'function';

    // Delivery to the user's other tabs (`tabs`) stays off: it would let what
    // happens in one tab change how the others behave.
    const bus = usesToolkit
        ? UbcPubsub.createBrowserBus({
            report: {
                url: () => '/api/events/' + encodeURIComponent(selectedCourseId()),
                types: REPORT_TYPES
            }
        })
        : createFallbackBus();

    // A listener that throws would otherwise fail silently. What it threw goes
    // to this page's console, as an uncaught error in a DOM listener did.
    bus.subscribe('bus.failed', failed => {
        const failure = failed.failure || {};
        console.error('[EVENTS] A listener on ' + failed.pattern + ' failed for ' + failed.eventType
            + ' (' + failure.code + ')', failure.cause !== undefined ? failure.cause : failure.message);
    });
    bus.subscribe('report.failed', failed => {
        console.warn('[EVENTS] The server did not take a ' + failed.eventType + ' report ('
            + (failed.failure && failed.failure.code) + ')');
    });

    /**
     * Announce that something happened on this page. It never throws, so the
     * work it sits next to can't fail because of it.
     *
     * @param {string} type - Such as `auth.ready`
     * @param {object} [data] - What listeners need to know. No personal details
     * @returns {boolean} Whether the event was published
     */
    function publish(type, data) {
        try {
            bus.publish(data === undefined ? { type } : { type, data });
            return true;
        } catch (error) {
            console.warn('[EVENTS] Could not publish ' + type, error);
            return false;
        }
    }

    /**
     * Listen for this page's events whose type matches a pattern, such as
     * `chat.*`. With `{ once: true }`, the listener runs for the first match
     * only.
     *
     * @param {string} pattern
     * @param {(event: { type: string, data?: object }) => unknown} listener
     * @param {{ once?: boolean }} [options]
     * @returns {() => void} Stops listening
     */
    function subscribe(pattern, listener, options) {
        if (!(options && options.once)) return bus.subscribe(pattern, listener);
        let done = false;
        const stop = bus.subscribe(pattern, event => {
            if (done) return undefined;
            done = true;
            stop();
            return listener(event);
        });
        return () => {
            done = true;
            stop();
        };
    }

    window.BiocbotEvents = Object.freeze({ publish, subscribe, usesToolkit, REPORT_TYPES });
})();
