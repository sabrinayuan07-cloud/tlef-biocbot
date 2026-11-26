/**
 * Preview Session Bootstrap ("View as Student")
 *
 * Loaded first in the head of every student page. Two jobs:
 *
 *   1. Mark this tab. An instructor enters via /student?preview=1; the flag is
 *      then kept in sessionStorage, which is per-tab, so the instructor's other
 *      tabs keep their instructor session. Every same-origin request from this
 *      tab carries X-Preview-Session, which is what the server requires before
 *      it will swap in the sandboxed student identity.
 *
 *   2. Render the preview banner and controls, so it is never ambiguous that
 *      this is a sandbox and not a real student's account.
 *
 * The fetch patch is installed at parse time, before any page script runs, so
 * no request can escape unmarked.
 */

(function () {
    'use strict';

    const STORAGE_KEY = 'biocbot_preview_tab';
    const COURSE_KEY = 'biocbot_preview_course';
    // Shared with the instructor tab (which starts a preview), so it lives in
    // localStorage rather than per-tab sessionStorage.
    const FIRST_RUN_PENDING_KEY = 'biocbot_preview_first_run_pending';
    const PREVIEW_HEADER = 'X-Preview-Session';

    /**
     * Decide whether this tab is a preview tab, and remember the answer.
     * @returns {boolean} True when the tab is in preview mode
     */
    function detectPreviewTab() {
        let fromUrl = false;
        try {
            fromUrl = new URLSearchParams(window.location.search).get('preview') === '1';
        } catch (e) {
            fromUrl = false;
        }

        if (fromUrl) {
            try {
                sessionStorage.setItem(STORAGE_KEY, '1');
            } catch (e) {
                // Private browsing can refuse storage; the URL flag still works
                // for this navigation and the server re-adds it on the next one.
            }
            return true;
        }

        try {
            return sessionStorage.getItem(STORAGE_KEY) === '1';
        } catch (e) {
            return false;
        }
    }

    /**
     * Erase the browser-side state owned by a preview sandbox.
     *
     * Sandbox keys carry the preview id, so they are safe to match on: a real
     * student's chat history and autosave on the same browser can never collide
     * with the namespace, and the instructor's own keys are left alone.
     *
     * This is the wipe that runs when the previewer leaves — server-side data is
     * destroyed by /api/preview/stop, and this clears what the browser kept.
     */
    function wipeSandboxKeys() {
        try {
            const doomed = [];
            for (let index = 0; index < localStorage.length; index += 1) {
                const key = localStorage.key(index);
                if (key && key.includes('__preview__')) {
                    doomed.push(key);
                }
            }

            doomed.forEach(key => localStorage.removeItem(key));
        } catch (e) {
            console.warn('[PREVIEW] Could not clear sandbox keys', e);
        }
    }

    /**
     * Everything wipeSandboxKeys clears, plus the course selection shared with
     * the instructor's other tabs.
     *
     * Only for the first-run walkthrough, whose opening step asks the student to
     * choose a course: that dropdown renders only when no course is stored.
     * Clearing the stored course alone is not enough — the autosaved chat
     * carries its own courseId and the restore path writes it straight back,
     * leaving a course picker and a half-finished assessment on screen together.
     *
     * Runs synchronously at parse time, ahead of every page script, so nothing
     * reads a value that is about to disappear.
     */
    function wipeSandboxState() {
        wipeSandboxKeys();

        try {
            // selectedCourseId is shared with the instructor tabs, which read it
            // to decide which course they are managing. Stash it before clearing
            // so those pages can restore it instead of falling back to a stale
            // course and having their requests refused.
            const currentCourse = localStorage.getItem('selectedCourseId');
            if (currentCourse) {
                localStorage.setItem('biocbot_course_before_preview', currentCourse);
            }

            ['selectedCourseId', 'selectedCourseName', 'selectedUnitName', 'lastModeChange']
                .forEach(key => localStorage.removeItem(key));
        } catch (e) {
            console.warn('[PREVIEW] Could not clear the shared course selection', e);
        }
    }

    /**
     * Drop courseId from the address bar without reloading.
     *
     * getCurrentCourseId reads the URL before anything else, so a courseId left
     * in the query string re-selects the course the walkthrough is about to ask
     * the previewer to choose.
     */
    function stripCourseFromUrl() {
        try {
            const url = new URL(window.location.href);
            if (!url.searchParams.has('courseId')) {
                return;
            }
            url.searchParams.delete('courseId');
            window.history.replaceState({}, '', url.toString());
        } catch (e) {
            console.warn('[PREVIEW] Could not strip courseId from the URL', e);
        }
    }

    /**
     * Pin the previewed course for the student pages.
     *
     * Student code reads the active course from localStorage.selectedCourseId.
     * The entry URL carries the course, but later navigations do not, so the
     * value is kept per-tab and re-applied on every load — synchronously, ahead
     * of any page script, so nothing reads a stale or empty course first.
     *
     * Suspended while the first-run walkthrough is pending. Its opening step
     * asks the student to choose a course, and that dropdown only renders when
     * no course is stored — pinning one would skip the step the previewer asked
     * to see. The server narrows the dropdown to the granted course, so there is
     * nothing out of scope to pick.
     */
    function pinPreviewCourse() {
        let courseId = null;

        try {
            courseId = new URLSearchParams(window.location.search).get('courseId');
        } catch (e) {
            courseId = null;
        }

        try {
            if (courseId) {
                sessionStorage.setItem(COURSE_KEY, courseId);
            } else {
                courseId = sessionStorage.getItem(COURSE_KEY);
            }

            if (localStorage.getItem(FIRST_RUN_PENDING_KEY) !== null) {
                // The walkthrough opens on "choose your course", so the sandbox
                // has to genuinely look new. Clearing the stored course alone is
                // not enough — the autosaved chat carries its own courseId and
                // the restore path writes it straight back, leaving a course
                // picker and a half-finished assessment on screen together.
                wipeSandboxState();
                stripCourseFromUrl();
                return;
            }

            if (courseId) {
                localStorage.setItem('selectedCourseId', courseId);
            }
        } catch (e) {
            console.warn('[PREVIEW] Could not pin preview course', e);
        }
    }

    const isPreviewTab = detectPreviewTab();

    if (isPreviewTab) {
        pinPreviewCourse();

        // Reserve the banner's space before <body> is even parsed, via a class
        // on <html> (the one element guaranteed to exist this early) rather
        // than waiting for the real banner to land in init() on
        // DOMContentLoaded. Without this, the page lays out once without the
        // banner, then jumps down the moment init() inserts it - a visible
        // reflow on every navigation. See preview.css's html.preview-pending
        // rules, which mirror body.preview-mode so the swap is a no-op.
        document.documentElement.classList.add('preview-pending');
    }

    /**
     * Keep the preview marker on a script-driven navigation.
     *
     * markStudentLinks below rewrites anchors, but a script that assigns
     * window.location.href builds its own URL and would drop the flag. An
     * unmarked student page is refused and bounced to the instructor UI, so
     * every such navigation is routed through here first.
     *
     * Outside a preview tab, and for anything that is not a student page, the
     * path is handed back untouched.
     *
     * @param {string} path - Navigation target, usually under /student
     * @returns {string} The path, marked when this tab is previewing
     */
    function markUrl(path) {
        if (!isPreviewTab || typeof path !== 'string' || !path) {
            return path;
        }

        try {
            const url = new URL(path, window.location.href);

            if (url.origin !== window.location.origin || !url.pathname.startsWith('/student')) {
                return path;
            }

            url.searchParams.set('preview', '1');
            return `${url.pathname}${url.search}${url.hash}`;
        } catch (e) {
            return path;
        }
    }

    window.BiocBotPreview = {
        active: isPreviewTab,
        state: null,
        url: markUrl,
        /**
         * Leave preview mode and return to the instructor UI.
         *
         * Leaving destroys the sandbox rather than parking it: /api/preview/stop
         * deletes the server-side data, and the browser's copy goes with it, so
         * opening "View as Student" again starts from an empty student account
         * with no chat history to find.
         *
         * The awaited stop request has to land before the local wipe, because a
         * failure there is the one case where sandbox data outlives the exit and
         * the previewer should be told rather than silently returned.
         *
         * @returns {Promise<void>}
         */
        exit: async function () {
            let stopped = false;

            try {
                const response = await fetch('/api/preview/stop', { method: 'POST', credentials: 'include' });
                const result = await response.json();
                stopped = !!(result && result.success);
            } catch (e) {
                console.warn('[PREVIEW] stop request failed', e);
            }

            if (!stopped) {
                const leaveAnyway = window.confirm(
                    'Preview data could not be deleted — the server did not respond. Leave the preview anyway? '
                    + 'The sandbox may still hold this session\'s chats until you exit again.'
                );
                if (!leaveAnyway) {
                    return;
                }
            }

            wipeSandboxKeys();

            try {
                sessionStorage.removeItem(STORAGE_KEY);
                sessionStorage.removeItem(COURSE_KEY);
                localStorage.removeItem(FIRST_RUN_PENDING_KEY);
            } catch (e) {
                // Nothing to clean up if storage is unavailable.
            }

            window.location.href = '/instructor/home';
        }
    };

    if (!isPreviewTab) {
        return;
    }

    // ---------------------------------------------------------------------
    // Request marking
    // ---------------------------------------------------------------------

    const nativeFetch = window.fetch.bind(window);

    /**
     * Whether a request target is same-origin, and so ours to mark.
     * @param {string} url - Request URL
     * @returns {boolean} True when same-origin
     */
    function isSameOrigin(url) {
        try {
            return new URL(url, window.location.href).origin === window.location.origin;
        } catch (e) {
            return false;
        }
    }

    window.fetch = function (input, init) {
        const url = typeof input === 'string' ? input : (input && input.url) || '';

        if (!isSameOrigin(url)) {
            return nativeFetch(input, init);
        }

        // Request objects carry their own immutable-ish headers, so rebuild the
        // request rather than mutating the caller's argument.
        if (typeof Request !== 'undefined' && input instanceof Request) {
            const headers = new Headers(input.headers);
            headers.set(PREVIEW_HEADER, '1');
            return nativeFetch(new Request(input, { headers }), init);
        }

        const options = { credentials: 'include', ...(init || {}) };
        const headers = new Headers(options.headers || {});
        headers.set(PREVIEW_HEADER, '1');
        options.headers = headers;

        return nativeFetch(input, options);
    };

    // XMLHttpRequest is used by a few older call sites; mark those too.
    if (window.XMLHttpRequest) {
        const nativeOpen = XMLHttpRequest.prototype.open;
        const nativeSend = XMLHttpRequest.prototype.send;

        XMLHttpRequest.prototype.open = function (method, url, ...rest) {
            this.__biocbotPreviewSameOrigin = isSameOrigin(url);
            return nativeOpen.call(this, method, url, ...rest);
        };

        XMLHttpRequest.prototype.send = function (...args) {
            if (this.__biocbotPreviewSameOrigin) {
                try {
                    this.setRequestHeader(PREVIEW_HEADER, '1');
                } catch (e) {
                    // Header can only be set after open(); ignore odd orderings.
                }
            }
            return nativeSend.apply(this, args);
        };
    }

    // ---------------------------------------------------------------------
    // Navigation
    // ---------------------------------------------------------------------

    /**
     * Keep the marker on in-app student links.
     *
     * A top-level navigation cannot send a header, so student links carry
     * ?preview=1 instead. Without this the server would bounce each click
     * through a redirect to add the flag back.
     */
    function markStudentLinks() {
        document.querySelectorAll('a[href^="/student"]').forEach(link => {
            const href = link.getAttribute('href');
            if (!href || href.includes('preview=1')) {
                return;
            }
            link.setAttribute('href', `${href}${href.includes('?') ? '&' : '?'}preview=1`);
        });
    }

    /**
     * Hide surfaces that are out of scope for a preview.
     * Super Course spans courses beyond the one being previewed.
     */
    function hideOutOfScopeNav() {
        const superCourseNav = document.getElementById('super-course-nav-item');
        if (superCourseNav) {
            superCourseNav.style.display = 'none';
        }
    }

    // ---------------------------------------------------------------------
    // Banner + controls
    // ---------------------------------------------------------------------

    /**
     * Read the current preview state from the server.
     * @returns {Promise<Object|null>} Preview state, or null when unavailable
     */
    async function loadState() {
        try {
            const response = await fetch('/api/preview/state', { credentials: 'include' });
            const result = await response.json();
            return result && result.success && result.active ? result : null;
        } catch (e) {
            console.warn('[PREVIEW] Could not load preview state', e);
            return null;
        }
    }

    /**
     * Flag that the next preview load should replay the first-run walkthrough.
     *
     * The actual clearing happens in wipeSandboxState at bootstrap rather than
     * here, so a sandbox carrying leftovers from an earlier session is cleaned
     * up too — not just one reset from this exact click.
     */
    function markFirstRunPending() {
        try {
            localStorage.setItem(FIRST_RUN_PENDING_KEY, '1');
            wipeSandboxState();
        } catch (e) {
            console.warn('[PREVIEW] Could not flag the first-run replay', e);
        }
    }

    /**
     * Build the preview banner and its controls.
     * @param {Object} state - Preview state from the server
     * @returns {HTMLElement} The banner element
     */
    function buildBanner(state) {
        const banner = document.createElement('div');
        banner.className = 'preview-banner';
        banner.setAttribute('role', 'region');
        banner.setAttribute('aria-label', 'Student preview controls');

        banner.innerHTML = `
            <div class="preview-banner-main">
                <span class="preview-badge">Preview</span>
                <span class="preview-summary">
                    You are viewing <strong>${escapeHtml(state.courseName || state.courseId)}</strong>
                    as a student. Nothing here is recorded against a real student.
                </span>
                <div class="preview-actions">
                    <button type="button" class="preview-btn" id="preview-toggle-panel" aria-expanded="false">About this preview</button>
                    <button type="button" class="preview-btn preview-btn-exit" id="preview-exit">Exit preview</button>
                </div>
            </div>
            <div class="preview-panel" id="preview-panel" hidden>
                <p class="preview-lede">
                    A sandbox copy of your course as a student sees it — chat, quiz, and flashcards.
                    It is not a real student's account, and not any particular student's data.
                </p>
                <div class="preview-explainer">
                    <section>
                        <h3>Never reaches you or your TAs</h3>
                        <ul>
                            <li><strong>Flags</strong> — behave exactly as a student sees, but nothing is recorded and nobody is notified.</li>
                            <li><strong>Thumbs up / down</strong> — never counts toward your feedback list or ratings.</li>
                            <li><strong>End-of-chat surveys</strong> — excluded from your results and exports.</li>
                            <li><strong>Wellbeing detection</strong> — switched off here, so nothing you type can raise an alert.</li>
                        </ul>
                    </section>
                    <section>
                        <h3>Deleted when you leave</h3>
                        <ul>
                            <li><strong>Exit preview</strong> destroys the sandbox: chats, quiz attempts, flashcard progress, and struggle topics are all deleted.</li>
                            <li>Opening the preview again starts from an empty student account, with the first-run experience ahead of it.</li>
                            <li>While it exists, none of it reaches your dashboard, Student Hub, chat downloads, or any instructor-side analytic.</li>
                            <li>The preview student never appears in your roster and is never enrolled.</li>
                        </ul>
                    </section>
                    <section>
                        <h3>Worth knowing</h3>
                        <ul>
                            <li>You see the course exactly as a student does — published units only.</li>
                            <li>Chats use your course's real LLM settings and prompts, so they spend the same API budget a student would.</li>
                            <li>Super Course is out of scope — it spans courses beyond this one.</li>
                            <li>Your instructor session stays signed in in its own tab; closing this one changes nothing.</li>
                        </ul>
                    </section>
                </div>
                <div class="preview-controls">
                    <div class="preview-panel-actions">
                        <button type="button" class="preview-btn" id="preview-replay-first-run">Replay first-run experience</button>
                        <button type="button" class="preview-btn preview-btn-danger" id="preview-reset">Reset preview data</button>
                        <span class="preview-status" id="preview-status" role="status" aria-live="polite"></span>
                    </div>
                </div>
            </div>
        `;

        const status = banner.querySelector('#preview-status');

        /**
         * Show a short-lived confirmation next to the controls.
         * @param {string} message - Text to display
         */
        function setStatus(message) {
            status.textContent = message;
            window.setTimeout(() => {
                if (status.textContent === message) {
                    status.textContent = '';
                }
            }, 4000);
        }

        banner.querySelector('#preview-toggle-panel').addEventListener('click', event => {
            const panel = banner.querySelector('#preview-panel');
            const nowOpen = panel.hidden;
            panel.hidden = !nowOpen;
            event.currentTarget.setAttribute('aria-expanded', String(nowOpen));
        });

        banner.querySelector('#preview-exit').addEventListener('click', () => {
            window.BiocBotPreview.exit();
        });

        banner.querySelector('#preview-replay-first-run').addEventListener('click', async () => {
            try {
                await fetch('/api/preview/first-run', {
                    method: 'POST',
                    credentials: 'include',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ completed: false })
                });
                markFirstRunPending();
                window.location.href = '/student?preview=1';
            } catch (e) {
                setStatus('Could not restart the first-run experience.');
            }
        });

        banner.querySelector('#preview-reset').addEventListener('click', async () => {
            const confirmed = window.confirm(
                'Delete all preview chats, quiz attempts, and flashcard progress for this course? Real student data is not affected.'
            );
            if (!confirmed) {
                return;
            }

            try {
                const response = await fetch('/api/preview/reset', { method: 'POST', credentials: 'include' });
                const result = await response.json();
                if (result && result.success) {
                    markFirstRunPending();
                    window.location.href = '/student?preview=1';
                } else {
                    setStatus('Could not reset preview data.');
                }
            } catch (e) {
                setStatus('Could not reset preview data.');
            }
        });

        return banner;
    }

    /**
     * Escape text for safe interpolation into the banner markup.
     * @param {string} value - Raw text
     * @returns {string} Escaped text
     */
    function escapeHtml(value) {
        const div = document.createElement('div');
        div.textContent = value == null ? '' : String(value);
        return div.innerHTML;
    }

    /**
     * Re-point the preview grant at a course the previewer just chose.
     *
     * The sandbox is scoped to one course — its id encodes which — so choosing
     * a different one has to issue a fresh grant rather than leave every later
     * request refused. /api/preview/start already validates that the real user
     * may preview the course, so it is reused here.
     *
     * @param {string} courseId - Newly chosen course
     * @returns {Promise<boolean>} Whether the grant moved
     */
    async function repointGrant(courseId) {
        try {
            const response = await fetch('/api/preview/start', {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ courseId })
            });
            const result = await response.json();

            if (!result || !result.success) {
                console.warn('[PREVIEW] Could not switch preview course:', result && result.message);
                return false;
            }

            try {
                sessionStorage.setItem(COURSE_KEY, courseId);
            } catch (e) {
                // Non-fatal; the URL carries the course on the next navigation.
            }
            return true;
        } catch (e) {
            console.warn('[PREVIEW] Could not switch preview course', e);
            return false;
        }
    }

    /**
     * While the walkthrough waits on its course step, watch for the choice.
     *
     * The course dropdown is owned by the student page, which records the pick
     * in localStorage. Watching that is less brittle than binding to a control
     * this script does not render and which appears asynchronously.
     *
     * @param {Object} state - Preview state from the server
     */
    function watchForCourseChoice(state) {
        if (localStorage.getItem(FIRST_RUN_PENDING_KEY) === null) {
            return;
        }

        const timer = window.setInterval(async () => {
            const chosen = localStorage.getItem('selectedCourseId');
            if (!chosen) {
                return;
            }

            window.clearInterval(timer);
            localStorage.removeItem(FIRST_RUN_PENDING_KEY);

            // Only a different course needs a new grant; picking the one the
            // preview already covers can carry straight on.
            if (chosen !== state.courseId) {
                await repointGrant(chosen);
            }
        }, 300);
    }

    async function init() {
        markStudentLinks();
        hideOutOfScopeNav();

        const state = await loadState();

        if (!state) {
            // The grant is gone (stopped elsewhere, or the session expired).
            // Drop the tab marker so the page stops pretending to be a preview.
            try {
                sessionStorage.removeItem(STORAGE_KEY);
            } catch (e) {
                // Nothing to clean up.
            }
            window.BiocBotPreview.active = false;
            // No real banner is coming, so the reserved space from the
            // html.preview-pending class (added at parse time, before we
            // knew this) needs to go too.
            document.documentElement.classList.remove('preview-pending');
            return;
        }

        window.BiocBotPreview.state = state;
        document.body.classList.add('preview-mode');
        // The real banner (below) now reserves its own space the same way
        // html.preview-pending did, so the placeholder is redundant.
        document.documentElement.classList.remove('preview-pending');

        const banner = buildBanner(state);
        document.body.insertBefore(banner, document.body.firstChild);

        // The welcome flow itself needs no help: it is gated by
        // studentOnboardingComplete on the sandbox's user record, which starts
        // false and the flow flips to true exactly as it does for a real
        // student. "Replay first-run" sets it back.
        watchForCourseChoice(state);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
