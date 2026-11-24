/**
 * Browser libraries served from installed packages.
 *
 * The pages' other libraries (KaTeX, Chart.js, SmilesDrawer) load from a CDN
 * at a pinned version. The agents framework and the pub/sub toolkit are on
 * GitHub Packages, which no CDN serves, so their browser files are served from
 * node_modules, at the versions package.json pins.
 */
const path = require('path');
const express = require('express');

const router = express.Router();

/**
 * @param {string} file - A package's browser file, such as
 *   '@ubc/genai-toolkit-agents-chat/client.global.js'
 * @returns {string|null} Its path, or null where the package isn't installed
 */
function installedFile(file) {
    try {
        return require.resolve(file);
    } catch (error) {
        if (error.code !== 'MODULE_NOT_FOUND') throw error;
        return null;
    }
}

/**
 * Serves a package's browser file, or 404s where the package isn't installed.
 * @param {string|null} file
 */
function sendInstalledFile(file) {
    return (req, res) => {
        if (!file) return res.sendStatus(404);
        // Sent from its own folder, so the folders above it (such as a
        // .claude/worktrees checkout) aren't checked for dotfiles.
        res.sendFile(path.basename(file), { root: path.dirname(file) });
    };
}

// The agents framework's chat client as a classic script, which sets
// window.UbcAgentsChat for the student page (public/student/scripts/student-chat-request.js).
// Where the framework isn't installed, the agent path is off too.
router.get('/agents-chat.js', sendInstalledFile(installedFile('@ubc/genai-toolkit-agents-chat/client.global.js')));

// The pub/sub toolkit's browser bus as a classic script, which sets
// window.UbcPubsub for the student page (public/student/scripts/student-events.js).
// Where the toolkit isn't installed, the page reports nothing.
router.get('/pubsub.js', sendInstalledFile(installedFile('@ubc/genai-toolkit-pubsub-browser/pubsub.global.js')));

module.exports = router;
