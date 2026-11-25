/**
 * BiocBot on the UBC GenAI gamification toolkit
 * (@ubc/genai-toolkit-gamification-*, rung 4 of its PRD).
 *
 * Gamification listens on BiocBot's events (src/services/events.js), counts
 * what students do against the rules a course's instructors publish, and
 * announces what a student earned as `gamification.*` events on the same bus.
 * It stores in BiocBot's own MongoDB, in four `gamification_*` collections:
 * rules, what each student has earned, whether they hid gamification, and the
 * events it counted. Students are their pseudonymous `user_<uuid>` ids, as on
 * every event; never a name or an email.
 *
 * This first step only counts. There's no page or route yet, so no one sees
 * anything, and it's off unless BIOCBOT_GAMIFICATION=1 (.env-example).
 *
 * The packages are on GitHub Packages, so, like pub/sub, they are optional
 * dependencies. Without them, or without pub/sub, nothing here starts.
 */

const CORE_PACKAGE = '@ubc/genai-toolkit-gamification-core';
const STORE_PACKAGE = '@ubc/genai-toolkit-gamification-store-mongo';
const PUBSUB_PACKAGE = '@ubc/genai-toolkit-gamification-pubsub';

/**
 * The events instructors can build rules on, in the order the rule builder
 * lists them. A chat about a unit is the main one, so it comes first: "describe
 * it" falls back to the first that fits. Messages and practice questions are
 * volume (capped points only). Struggle is never a metric: it's sensitive, and
 * the listener never hears it.
 */
const METRICS = Object.freeze([
    'chat.session.started',
    'chat.mode.changed',
    'quiz.question.answered',
    'chat.message.sent'
]);

/** Days and weeks (streaks, "3 different days") are counted in UBC's time. */
const TIME_ZONE = 'America/Vancouver';

/** @type {{ core: any, store: any, pubsub: any } | null | undefined} */
let toolkit;

/**
 * @returns {{ core: any, store: any, pubsub: any } | null} Null where the
 *   packages aren't installed
 */
function loadGamificationToolkit() {
    if (toolkit === undefined) {
        try {
            toolkit = { core: require(CORE_PACKAGE), store: require(STORE_PACKAGE), pubsub: require(PUBSUB_PACKAGE) };
        } catch (error) {
            if (error.code !== 'MODULE_NOT_FOUND') throw error;
            toolkit = null;
        }
    }
    return toolkit;
}

/**
 * BiocBot's catalog: the palette its instructors build rules from, made from
 * its event dictionary so each event is described once.
 *
 * @param {any} dictionary - BiocBot's dictionary (`events.dictionary`)
 * @returns {any} The toolkit's `Catalog`
 */
function buildCatalog(dictionary) {
    return loadGamificationToolkit().pubsub.catalogFromDictionary(dictionary, { app: 'BiocBot', metrics: METRICS });
}

/** @type {any | null} */
let gamification = null;

/**
 * Starts counting: makes BiocBot's gamification and its listener. Called once
 * at startup, from src/listeners/index.js.
 *
 * @param {{
 *   events: any,
 *   db?: import('mongodb').Db,
 *   store?: any,
 *   logger?: Pick<Console, 'log' | 'error'>
 * }} options - `events` is BiocBot's publisher (getEvents()). `db` is
 *   BiocBot's database; tests pass an in-memory `store` instead.
 * @returns {{ gamification: any, stop: () => void } | null} Null where the
 *   packages aren't installed
 */
function startGamification({ events, db, store, logger = console }) {
    const loaded = loadGamificationToolkit();
    if (!loaded || !events) return null;

    let storeToUse = store;
    if (!storeToUse) {
        const mongoStore = loaded.store.createMongoStore(db);
        // Safe on every start, and not waited for: these indexes are for
        // lookups only. A retried event counts once regardless, because the
        // store keys each event by its id (`_id`). Two processes saving the
        // same student's state can't overwrite each other: the store checks a
        // version before it saves (0.1.0-rc.2).
        mongoStore.ensureIndexes().catch(error => {
            logger.error('❌ [GAMIFICATION] Could not create its indexes:', error && error.message);
        });
        storeToUse = mongoStore;
    }

    gamification = loaded.core.createGamification({
        catalog: buildCatalog(events.dictionary),
        store: storeToUse,
        timeZone: TIME_ZONE,
        logger
    });
    const stopListening = loaded.pubsub.listenForGamification({ events, gamification, logger });

    return {
        gamification,
        stop: () => {
            stopListening();
            gamification = null;
        }
    };
}

/**
 * BiocBot's gamification, once startGamification has run; null before, or
 * where it's off. For the routes that come next.
 *
 * @returns {any | null}
 */
function getGamification() {
    return gamification;
}

module.exports = {
    METRICS,
    TIME_ZONE,
    loadGamificationToolkit,
    buildCatalog,
    startGamification,
    getGamification
};
