/**
 * The student page's events, on the UBC GenAI pub/sub toolkit's browser bus.
 *
 * ../vendor/pubsub.js (src/routes/vendor.js) sets UbcPubsub. Where the toolkit
 * isn't installed that file 404s, UbcPubsub is undefined, and the page works as
 * before: nothing is published or reported.
 *
 * A mode switch is reported to POST /api/events/:courseId with only its type
 * and data. The server decides who and where (src/routes/events.js). Reports
 * go through the page's own fetch, so a "View as Student" tab's preview header
 * goes with them and the server marks the event as a preview.
 *
 * Delivery to the student's other tabs (`tabs`) is off: it would let a switch
 * in one tab reach the others, which would change how the page behaves.
 */
(function () {
    'use strict';

    const MODES = ['tutor', 'protege'];

    function selectedCourseId() {
        try {
            return localStorage.getItem('selectedCourseId');
        } catch (error) {
            return null;
        }
    }

    const bus = typeof UbcPubsub === 'undefined'
        ? null
        : UbcPubsub.createBrowserBus({
            report: {
                url: () => '/api/events/' + encodeURIComponent(selectedCourseId()),
                types: ['chat.mode.changed']
            }
        });

    if (bus) {
        bus.subscribe('report.failed', event => {
            console.warn('[EVENTS] The server did not take a ' + event.eventType + ' report (' + event.failure.code + ')');
        });
    }

    /**
     * Publish a mode switch, which the bus reports to the server. Only a change
     * from a mode the page already had: restore, the guided tour and a first
     * chat set a mode without the student choosing one, and don't call this.
     *
     * @param {string|null} from - The mode before, from localStorage.studentMode
     * @param {string} to - The mode now
     * @returns {boolean} Whether an event was published
     */
    function publishModeChange(from, to) {
        if (!bus || !MODES.includes(from) || !MODES.includes(to) || from === to || !selectedCourseId()) {
            return false;
        }
        try {
            bus.publish({ type: 'chat.mode.changed', data: { from, to } });
            return true;
        } catch (error) {
            // Never in the way of the switch itself.
            console.warn('[EVENTS] Could not publish the mode change', error);
            return false;
        }
    }

    window.StudentEvents = Object.freeze({ publishModeChange });
})();
