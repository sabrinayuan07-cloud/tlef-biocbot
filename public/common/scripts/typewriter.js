/**
 * Word-by-word text reveal for bot chat responses, so an answer looks typed
 * out instead of appearing all at once. No backend streaming exists on any
 * chat surface (each returns one complete JSON response) - this replays text
 * that has already fully arrived, purely as a visual effect. The underlying
 * message data/autosave always uses the full text immediately; only the
 * on-screen reveal is staggered.
 */
(function () {
    function typeOutText(element, text, options = {}) {
        const fullText = String(text == null ? '' : text);

        // Reduced motion: show the whole answer at once instead of animating it.
        const prefersReducedMotion = window.matchMedia
            && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        if (prefersReducedMotion) {
            element.textContent = fullText;
            if (typeof options.onStep === 'function') {
                options.onStep();
            }
            return Promise.resolve();
        }

        // #chat-messages is role="log" aria-live="polite", so typing the
        // answer in one word at a time would have a screen reader announce
        // it in fragments (or only part of it, if something interrupts).
        // Hide the animating element from assistive tech and announce the
        // full text once instead, via a visually-hidden sibling.
        element.setAttribute('aria-hidden', 'true');
        const srText = document.createElement('span');
        srText.className = 'visually-hidden';
        srText.textContent = fullText;
        element.insertAdjacentElement('afterend', srText);

        const wordDelayMs = options.wordDelayMs || 35;
        const tokens = fullText.split(/(\s+)/).filter(token => token.length > 0);
        element.textContent = '';

        return new Promise((resolve) => {
            let index = 0;
            function step() {
                if (index >= tokens.length) {
                    resolve();
                    return;
                }
                element.textContent += tokens[index];
                index++;
                if (typeof options.onStep === 'function') {
                    options.onStep();
                }
                setTimeout(step, wordDelayMs);
            }
            step();
        });
    }

    window.typeOutText = typeOutText;
})();
