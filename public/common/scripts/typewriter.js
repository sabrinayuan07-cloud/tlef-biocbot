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
        const wordDelayMs = options.wordDelayMs || 35;
        const tokens = String(text == null ? '' : text).split(/(\s+)/).filter(token => token.length > 0);
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
