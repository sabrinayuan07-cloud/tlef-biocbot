/**
 * Toast notifications.
 *
 * What a toast is announced as and what it looks like are kept apart:
 *
 *  - The words go into a visually hidden live region that holds text and
 *    nothing else, so a screen reader announces "Unit 2 is now published" and
 *    not "Unit 2 is now published, Dismiss notification, button".
 *  - The visible toast is not a live region. Success and info toasts are plain
 *    text and leave on their own. Error and warning toasts stay until the user
 *    dismisses them, because they carry a control (Dismiss) and a control must
 *    never be taken away on a timer.
 *  - The container is the first thing in the page (or in the open dialog), so
 *    a Dismiss button is the next Tab stop after the skip link rather than
 *    somewhere after everything else on the page.
 */
(function () {
    const DEFAULT_TYPE = 'info';
    const VALID_TYPES = new Set(['success', 'error', 'warning', 'info']);
    // Types that need the user to act on them: they persist and can be dismissed.
    const PERSISTENT_TYPES = new Set(['error', 'warning']);
    const AUTO_DISMISS_MS = 5000;
    // How long announcement text stays in the (invisible) live region. It only
    // has to outlive the screen reader picking it up.
    const ANNOUNCEMENT_LIFETIME_MS = 10000;
    const MAX_PERSISTENT = 4;

    // The last element that had focus outside the toast area, so dismissing a
    // toast from the keyboard can send focus back to where the user was.
    let lastFocusOutside = null;

    function normalizeType(type) {
        return VALID_TYPES.has(type) ? type : DEFAULT_TYPE;
    }

    function createLiveRegion(role, politeness) {
        const region = document.createElement('div');
        region.className = `notification-live notification-live-${politeness} visually-hidden`;
        region.setAttribute('role', role);
        region.setAttribute('aria-live', politeness);
        region.setAttribute('aria-atomic', 'false');
        return region;
    }

    function ensureNotificationContainer() {
        // Open modals (public/common/scripts/modal-a11y.js) run through a native
        // <dialog>.showModal(), which renders in the browser's top layer - a
        // layer that paints above every normal element regardless of z-index,
        // by spec - and makes everything outside the dialog inert. A toast left
        // in <body> is therefore stuck underneath an open modal, unreachable
        // and unannounced. Parenting the container inside the active dialog
        // instead puts it in that same top layer.
        const activeDialog = document.querySelector('dialog[open]');
        const parent = activeDialog || document.body;
        if (!parent) return null;

        let container = document.querySelector('.notification-container');
        if (!container) {
            container = document.createElement('div');
            container.className = 'notification-container';
            // The live regions live inside the container so they move into an
            // open dialog with it. They are created before any message exists:
            // a live region only announces changes made after it is in the page.
            container.appendChild(createLiveRegion('status', 'polite'));
            container.appendChild(createLiveRegion('alert', 'assertive'));
        }
        // The container itself must not be a live region: it holds the visible
        // toasts, and their Dismiss buttons would be read out with every message.
        container.removeAttribute('role');
        container.removeAttribute('aria-live');

        // First in its parent, after the skip link when there is one, so a
        // Dismiss button is reached early in the tab order.
        const skipLink = parent === document.body ? parent.querySelector(':scope > .skip-link') : null;
        const inPlace = container.parentElement === parent
            && (skipLink ? container.previousElementSibling === skipLink : parent.firstElementChild === container);
        if (!inPlace) {
            parent.insertBefore(container, skipLink ? skipLink.nextSibling : parent.firstChild);
        }
        return container;
    }

    function announce(container, message, type) {
        const politeness = type === 'error' ? 'assertive' : 'polite';
        const region = container.querySelector(`.notification-live-${politeness}`);
        if (!region) return;
        const line = document.createElement('div');
        line.textContent = message;
        region.appendChild(line);
        setTimeout(() => line.remove(), ANNOUNCEMENT_LIFETIME_MS);
    }

    function dismiss(notification, { fromKeyboard = false } = {}) {
        const container = notification.parentElement;
        const hadFocus = notification.contains(document.activeElement);
        const sibling = notification.nextElementSibling || notification.previousElementSibling;
        notification.remove();
        if (!hadFocus && !fromKeyboard) return;
        // Keep the keyboard user somewhere sensible: the next toast's Dismiss
        // button, else wherever they were before they came to the toasts.
        const nextDismiss = sibling && sibling.querySelector ? sibling.querySelector('.notification-close') : null;
        const fallback = lastFocusOutside && lastFocusOutside.isConnected ? lastFocusOutside : document.getElementById('main');
        const target = nextDismiss || (container && container.querySelector('.notification-close')) || fallback;
        if (target && typeof target.focus === 'function') target.focus();
    }

    function showNotification(message, type = DEFAULT_TYPE) {
        const normalizedType = normalizeType(type);
        const container = ensureNotificationContainer();
        const notification = document.createElement('div');
        notification.className = `notification ${normalizedType} notification-${normalizedType}`;

        const messageSpan = document.createElement('span');
        messageSpan.className = 'notification-message';
        messageSpan.textContent = message;
        notification.appendChild(messageSpan);

        if (PERSISTENT_TYPES.has(normalizedType)) {
            const closeButton = document.createElement('button');
            closeButton.className = 'notification-close';
            closeButton.type = 'button';
            // Named after its message, in visually hidden text, so several open
            // toasts can be told apart. The "×" is decoration.
            const icon = document.createElement('span');
            icon.setAttribute('aria-hidden', 'true');
            icon.textContent = '\u00d7';
            const name = document.createElement('span');
            name.className = 'visually-hidden';
            name.textContent = `Dismiss notification: ${message}`;
            closeButton.append(icon, name);
            closeButton.addEventListener('click', () => dismiss(notification));
            notification.appendChild(closeButton);

            // Persistent toasts would otherwise pile up without limit. The oldest
            // gives way to a newer one; that is a replacement, not a time limit.
            const persistent = container.querySelectorAll('.notification.error, .notification.warning');
            if (persistent.length >= MAX_PERSISTENT) dismiss(persistent[0]);
        } else {
            // No control inside, so nothing is lost when this leaves on its own.
            // Hovering holds it open for anyone still reading.
            let timer = null;
            const start = () => { timer = setTimeout(() => notification.remove(), AUTO_DISMISS_MS); };
            notification.addEventListener('mouseenter', () => clearTimeout(timer));
            notification.addEventListener('mouseleave', start);
            start();
        }

        container.appendChild(notification);
        announce(container, message, normalizedType);
        return notification;
    }

    document.addEventListener('focusin', (event) => {
        const target = event.target;
        if (target instanceof Element && !target.closest('.notification-container')) {
            lastFocusOutside = target;
        }
    });

    // Put the live regions in the page up front so the first message is announced.
    if (document.body) {
        ensureNotificationContainer();
    } else {
        document.addEventListener('DOMContentLoaded', ensureNotificationContainer);
    }

    window.showNotification = showNotification;
})();
