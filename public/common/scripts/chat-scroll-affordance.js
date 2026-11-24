/**
 * Shared "jump to latest message" affordance for scrollable chat panels.
 * Wires a floating down-arrow button that shows once a student scrolls up
 * away from the bottom, and exposes isNearBottom() so callers (e.g. the
 * typewriter reveal's onStep) can decide whether to auto-scroll without
 * pulling someone back down while they're rereading an earlier message.
 */
(function () {
    const NEAR_BOTTOM_PX = 48;

    function isNearBottom(container) {
        return container.scrollHeight - container.scrollTop - container.clientHeight <= NEAR_BOTTOM_PX;
    }

    /**
     * @param {HTMLElement} container - The scrollable message list.
     * @param {HTMLElement} button - The floating scroll-to-bottom button.
     * @returns {{isNearBottom: () => boolean}}
     */
    function initChatScrollAffordance(container, button) {
        function updateVisibility() {
            button.hidden = isNearBottom(container);
        }

        container.addEventListener('scroll', updateVisibility, { passive: true });
        // A newly-appended message can change scrollHeight without a 'scroll'
        // event firing on its own.
        const observer = new MutationObserver(updateVisibility);
        observer.observe(container, { childList: true });

        button.addEventListener('click', () => {
            const prefersReducedMotion = window.matchMedia
                && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
            container.scrollTo({
                top: container.scrollHeight,
                behavior: prefersReducedMotion ? 'auto' : 'smooth'
            });
        });

        updateVisibility();

        return { isNearBottom: () => isNearBottom(container) };
    }

    window.initChatScrollAffordance = initChatScrollAffordance;
})();
