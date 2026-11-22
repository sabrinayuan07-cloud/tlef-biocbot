/* Shared native-dialog keyboard and focus contract for application modals. */
(function () {
    const modalState = new WeakMap();
    const suspendedModalState = new WeakMap();
    const focusableSelector = [
        'a[href]',
        'button:not([disabled])',
        'input:not([disabled]):not([type="hidden"])',
        'select:not([disabled])',
        'textarea:not([disabled])',
        'iframe',
        '[contenteditable="true"]',
        '[tabindex]:not([tabindex="-1"])'
    ].join(', ');

    let activeModalRoot = null;
    let generatedId = 0;

    function resolveElement(modalRootEl, elementOrSelector) {
        if (typeof elementOrSelector === 'string') return modalRootEl.querySelector(elementOrSelector);
        return elementOrSelector || null;
    }

    function isVisible(element) {
        if (!(element instanceof HTMLElement) || element.hidden) return false;
        const style = window.getComputedStyle(element);
        return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
    }

    function getFocusables(modalRootEl) {
        return Array.from(modalRootEl.querySelectorAll(focusableSelector))
            .filter((element) => isVisible(element) && !element.closest('[inert]'));
    }

    function idIsUnique(element) {
        if (!element.id) return false;
        return Array.from(document.querySelectorAll('[id]')).filter((candidate) => candidate.id === element.id).length === 1;
    }

    function ensureHeading(modalRootEl, dialogEl, labelledBy) {
        const labelledElement = labelledBy ? document.getElementById(labelledBy) : null;
        const heading = labelledElement instanceof HTMLHeadingElement && labelledElement.matches('h2')
            ? labelledElement
            : modalRootEl.querySelector('h2');

        if (!heading) {
            throw new Error('Accessible modals require a visible h2 for their accessible name.');
        }

        if (!idIsUnique(heading)) {
            const baseId = `${modalRootEl.id || 'modal'}-title`;
            do {
                generatedId += 1;
                heading.id = `${baseId}-${generatedId}`;
            } while (!idIsUnique(heading));
        }

        heading.setAttribute('tabindex', '-1');
        dialogEl.setAttribute('aria-labelledby', heading.id);
        return heading;
    }

    function createNativeHost(modalRootEl) {
        if (modalRootEl instanceof HTMLDialogElement) {
            return { dialogEl: modalRootEl, isCompatibilityHost: false };
        }

        const dialogEl = document.createElement('dialog');
        dialogEl.className = 'a11y-modal-host';
        dialogEl.dataset.modalRoot = modalRootEl.id || 'generated-modal';
        dialogEl.style.cssText = [
            'position:fixed',
            'inset:0',
            'width:100vw',
            'height:100vh',
            'max-width:none',
            'max-height:none',
            'margin:0',
            'padding:0',
            'border:0',
            'background:transparent',
            'overflow:visible'
        ].join(';');

        modalRootEl.parentNode.insertBefore(dialogEl, modalRootEl);
        dialogEl.appendChild(modalRootEl);
        return { dialogEl, isCompatibilityHost: true };
    }

    function restoreLegacyRoot(modalRootEl, dialogEl) {
        if (!dialogEl.classList.contains('a11y-modal-host')) return;
        if (dialogEl.isConnected) {
            // The dialog's top layer is also where anything that needs to
            // paint above an open modal (e.g. notifications.js reparents its
            // toast container here) ends up living. Rescue any such content
            // back to <body> before discarding the dialog, or it gets
            // silently deleted along with it - including a just-shown error
            // toast from the same code path that's now closing the modal.
            Array.from(dialogEl.children).forEach((child) => {
                if (child !== modalRootEl) document.body.appendChild(child);
            });
            dialogEl.replaceWith(modalRootEl);
        }
    }

    function appendDismissalReason(modalRootEl, dialogEl, message) {
        const reason = document.createElement('p');
        generatedId += 1;
        reason.id = `${modalRootEl.id || 'modal'}-dismissal-reason-${generatedId}`;
        reason.className = 'visually-hidden a11y-modal-dismissal-reason';
        reason.setAttribute('role', 'status');
        reason.setAttribute('aria-live', 'polite');
        reason.textContent = message;
        dialogEl.appendChild(reason);

        const describedBy = dialogEl.getAttribute('aria-describedby');
        dialogEl.setAttribute('aria-describedby', [describedBy, reason.id].filter(Boolean).join(' '));
        return { reason, describedBy };
    }

    function announceBlockedDismissal(state) {
        const message = state.dismissalReason.textContent;
        state.dismissalReason.textContent = '';
        queueMicrotask(() => {
            if (state.dismissalReason.isConnected) state.dismissalReason.textContent = message;
        });
    }

    function isSafeRestoreTarget(element) {
        if (!(element instanceof HTMLElement) || !element.isConnected || element.hidden) return false;
        if (element.matches(':disabled') || element.closest('[inert], [hidden], [aria-hidden="true"]')) return false;
        const style = window.getComputedStyle(element);
        return style.display !== 'none' && style.visibility !== 'hidden';
    }

    function restoreFocus(state) {
        let target = state.restoreTarget;
        if (!isSafeRestoreTarget(target)) {
            target = resolveElement(document, state.fallbackFocus)
                || document.querySelector('[data-modal-focus-fallback], #main, main h1, main h2');
        }
        if (target instanceof HTMLElement && isSafeRestoreTarget(target)) target.focus();
    }

    function close(modalRootEl, { restoreFocus: shouldRestoreFocus = true } = {}) {
        if (!modalRootEl) return;
        const state = modalState.get(modalRootEl);
        if (!state) return;

        state.dialogEl.removeEventListener('cancel', state.onCancel);
        state.dialogEl.removeEventListener('keydown', state.onKeydown);
        state.dialogEl.removeEventListener('click', state.onClick);

        if (state.dialogEl.open) state.dialogEl.close();
        state.dismissalReason?.remove();
        if (state.originalDescribedBy === null) state.dialogEl.removeAttribute('aria-describedby');
        else state.dialogEl.setAttribute('aria-describedby', state.originalDescribedBy);

        modalState.delete(modalRootEl);
        if (activeModalRoot === modalRootEl) activeModalRoot = null;
        restoreLegacyRoot(modalRootEl, state.dialogEl);

        if (shouldRestoreFocus) restoreFocus(state);
    }

    function requestDismiss(modalRootEl, source) {
        const state = modalState.get(modalRootEl);
        if (!state) return;
        if (!state.escapable) {
            announceBlockedDismissal(state);
            return;
        }

        if (state.onRequestClose) state.onRequestClose({ source });
        else close(modalRootEl);
    }

    /**
     * Open a modal through the single native-dialog contract.
     *
     * Existing div overlays are placed in a temporary native dialog host until
     * Tasks 3 and 4 convert their markup. New integrations should pass a
     * HTMLDialogElement directly and should let the h2 receive initial focus.
     * `initialFocus` is reserved for a documented urgent/destructive exception.
     * Opening a second dialog replaces a dismissible dialog without restoring
     * focus between them; a forced-choice dialog cannot be replaced.
     *
     * @param {HTMLElement} modalRootEl
     * @param {Object} [options]
     * @param {string} [options.labelledBy]
     * @param {HTMLElement|string} [options.initialFocus]
     * @param {boolean} [options.escapable]
     * @param {(detail: {source: 'escape'|'backdrop'|'replacement'}) => void} [options.onRequestClose]
     * @param {HTMLElement|string} [options.dialogEl] Legacy compatibility only.
     * @param {HTMLElement|string} [options.fallbackFocus]
     * @param {HTMLElement|string} [options.restoreFocusTarget] Internal resume support.
     * @param {string} [options.dismissalBlockedMessage]
     */
    function open(modalRootEl, options = {}) {
        if (!(modalRootEl instanceof HTMLElement)) return;

        const explicitRestoreTarget = resolveElement(document, options.restoreFocusTarget);
        let restoreTarget = explicitRestoreTarget || document.activeElement;
        const existingState = modalState.get(modalRootEl);
        if (existingState) {
            if (!explicitRestoreTarget) restoreTarget = existingState.restoreTarget;
            close(modalRootEl, { restoreFocus: false });
        }

        if (activeModalRoot && activeModalRoot !== modalRootEl) {
            const activeState = modalState.get(activeModalRoot);
            if (activeState && !activeState.escapable) {
                throw new Error('A forced-choice modal must be completed before another modal opens.');
            }
            if (activeState) {
                if (!explicitRestoreTarget) restoreTarget = activeState.restoreTarget;
                if (activeState.onRequestClose) activeState.onRequestClose({ source: 'replacement' });
                if (modalState.has(activeModalRoot)) close(activeModalRoot, { restoreFocus: false });
            }
        }

        const {
            labelledBy,
            initialFocus,
            escapable = true,
            onRequestClose,
            fallbackFocus,
            dismissalBlockedMessage = 'This dialog cannot be dismissed until the required action is complete.'
        } = options;

        const { dialogEl, isCompatibilityHost } = createNativeHost(modalRootEl);
        const legacyDialogEl = resolveElement(modalRootEl, options.dialogEl);
        if (legacyDialogEl && legacyDialogEl !== dialogEl) {
            legacyDialogEl.removeAttribute('role');
            legacyDialogEl.removeAttribute('aria-modal');
            legacyDialogEl.removeAttribute('aria-labelledby');
        }
        dialogEl.removeAttribute('role');
        dialogEl.removeAttribute('aria-modal');

        const heading = ensureHeading(modalRootEl, dialogEl, labelledBy);
        const originalDescribedBy = dialogEl.getAttribute('aria-describedby');
        const blockedReason = !escapable
            ? appendDismissalReason(modalRootEl, dialogEl, dismissalBlockedMessage)
            : null;

        const state = {
            dialogEl,
            isCompatibilityHost,
            restoreTarget,
            fallbackFocus,
            escapable,
            onRequestClose,
            dismissalReason: blockedReason?.reason || null,
            originalDescribedBy,
            onCancel: null,
            onKeydown: null,
            onClick: null
        };

        state.onCancel = (event) => {
            event.preventDefault();
            requestDismiss(modalRootEl, 'escape');
        };
        state.onKeydown = (event) => {
            if (event.key !== 'Tab') return;
            // Enumerate the dialog host, not just the modal inside it: toasts
            // shown while a modal is open are parented into the host (see
            // notifications.js), and their Dismiss button has to be reachable.
            const focusables = getFocusables(dialogEl);
            if (!focusables.length) {
                event.preventDefault();
                heading.focus();
                return;
            }

            const first = focusables[0];
            const last = focusables[focusables.length - 1];
            if (focusables.length === 1 || (event.shiftKey && document.activeElement === first)) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
            } else if (!dialogEl.contains(document.activeElement)) {
                event.preventDefault();
                (event.shiftKey ? last : first).focus();
            }
        };
        state.onClick = (event) => {
            if (event.target === dialogEl || event.target === modalRootEl) {
                requestDismiss(modalRootEl, 'backdrop');
            }
        };

        modalState.set(modalRootEl, state);
        activeModalRoot = modalRootEl;
        dialogEl.addEventListener('cancel', state.onCancel);
        dialogEl.addEventListener('keydown', state.onKeydown);
        dialogEl.addEventListener('click', state.onClick);

        try {
            dialogEl.showModal();
        } catch (error) {
            close(modalRootEl, { restoreFocus: false });
            throw error;
        }

        const focusTarget = resolveElement(modalRootEl, initialFocus) || heading;
        focusTarget.focus();
    }

    function isOpen(modalRootEl) {
        return modalState.has(modalRootEl);
    }

    function suspend(modalRootEl) {
        const state = modalState.get(modalRootEl);
        if (!state) return false;

        suspendedModalState.set(modalRootEl, {
            restoreTarget: state.restoreTarget,
            fallbackFocus: state.fallbackFocus
        });
        close(modalRootEl, { restoreFocus: false });
        return true;
    }

    function resume(modalRootEl, options = {}) {
        const suspendedState = suspendedModalState.get(modalRootEl);
        suspendedModalState.delete(modalRootEl);
        open(modalRootEl, {
            ...options,
            fallbackFocus: options.fallbackFocus || suspendedState?.fallbackFocus,
            restoreFocusTarget: suspendedState?.restoreTarget
        });
    }

    window.a11yModal = { open, close, isOpen, suspend, resume };
})();
