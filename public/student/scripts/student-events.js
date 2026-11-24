/**
 * The student page's mode switch, on the page's events (biocbot-events.js).
 *
 * Where the pub/sub toolkit is installed, the page bus is its browser bus,
 * which reports a mode switch to POST /api/events/:courseId with only its type,
 * its data and the page's address up to its path (the reporter cuts off any
 * query string). The server decides who and where (src/routes/events.js).
 * Reports go through the page's own fetch, so a "View as Student" tab's
 * preview header goes with them and the server marks the event as a preview.
 *
 * Where the toolkit isn't installed, the switch is still published on the
 * page, and nothing is reported.
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

    /**
     * Publish a mode switch. Only a change from a mode the page already had:
     * restore, the guided tour and a first chat set a mode without the student
     * choosing one, and don't call this.
     *
     * @param {string|null} from - The mode before, from localStorage.studentMode
     * @param {string} to - The mode now
     * @returns {boolean} Whether an event was published
     */
    function publishModeChange(from, to) {
        if (!MODES.includes(from) || !MODES.includes(to) || from === to || !selectedCourseId()) {
            return false;
        }
        // Never in the way of the switch itself: publish doesn't throw.
        return BiocbotEvents.publish('chat.mode.changed', { from, to });
    }

    window.StudentEvents = Object.freeze({ publishModeChange });
})();
