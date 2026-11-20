/**
 * A small in-app confirm dialog, styled like the rest of the app instead of
 * the browser's native confirm() box. Drop-in async replacement: resolves
 * true/false the same way `confirm()` returns synchronously, so call sites
 * just add `await` in front of their existing `confirm(message)` call.
 * Builds and injects its own markup/styles on first use, so any page can
 * use it just by loading this script - no HTML/CSS to add per page.
 */
(function () {
    let modal = null;

    function injectStyles() {
        if (document.getElementById('app-confirm-dialog-styles')) return;
        const style = document.createElement('style');
        style.id = 'app-confirm-dialog-styles';
        style.textContent = `
            .app-confirm-dialog-overlay {
                display: none;
                position: fixed;
                inset: 0;
                background: rgba(15, 23, 42, 0.5);
                align-items: center;
                justify-content: center;
                z-index: 10000;
            }
            .app-confirm-dialog-overlay.show {
                display: flex;
            }
            .app-confirm-dialog {
                background: #fff;
                border-radius: 10px;
                padding: 1.5rem;
                max-width: 420px;
                width: calc(100% - 2rem);
                box-shadow: 0 10px 30px rgba(0, 0, 0, 0.2);
            }
            .app-confirm-dialog-title {
                margin: 0 0 0.5rem;
                font-size: 1.1rem;
                color: #1f2937;
            }
            .app-confirm-dialog-message {
                margin: 0 0 1.25rem;
                color: #374151;
                font-size: 0.95rem;
                white-space: pre-line;
            }
            .app-confirm-dialog-actions {
                display: flex;
                justify-content: flex-end;
                gap: 0.5rem;
            }
        `;
        document.head.appendChild(style);
    }

    function ensureModal() {
        if (modal) return modal;
        injectStyles();
        modal = document.createElement('div');
        modal.className = 'app-confirm-dialog-overlay';
        modal.innerHTML = `
            <div class="app-confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="app-confirm-dialog-title">
                <h3 id="app-confirm-dialog-title" class="app-confirm-dialog-title"></h3>
                <p class="app-confirm-dialog-message"></p>
                <div class="app-confirm-dialog-actions">
                    <button type="button" class="secondary-button app-confirm-dialog-cancel"></button>
                    <button type="button" class="primary-button app-confirm-dialog-confirm"></button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
        return modal;
    }

    /**
     * @param {string} message
     * @param {Object} [options]
     * @param {string} [options.title]
     * @param {string} [options.confirmLabel]
     * @param {string} [options.cancelLabel]
     * @param {boolean} [options.danger] - use the danger button style for confirm
     * @returns {Promise<boolean>} true if confirmed, false if cancelled/dismissed
     */
    function showConfirmDialog(message, options = {}) {
        const {
            title = 'Are you sure?',
            confirmLabel = 'Confirm',
            cancelLabel = 'Cancel',
            danger = false
        } = options;

        const dialog = ensureModal();
        const titleEl = dialog.querySelector('.app-confirm-dialog-title');
        const messageEl = dialog.querySelector('.app-confirm-dialog-message');
        const confirmBtn = dialog.querySelector('.app-confirm-dialog-confirm');
        const cancelBtn = dialog.querySelector('.app-confirm-dialog-cancel');

        titleEl.textContent = title;
        messageEl.textContent = message;
        confirmBtn.textContent = confirmLabel;
        cancelBtn.textContent = cancelLabel;
        confirmBtn.className = `app-confirm-dialog-confirm ${danger ? 'danger-button' : 'primary-button'}`;

        return new Promise((resolve) => {
            let settled = false;
            const finish = (result) => {
                if (settled) return;
                settled = true;
                confirmBtn.removeEventListener('click', onConfirm);
                cancelBtn.removeEventListener('click', onCancel);
                dialog.removeEventListener('mousedown', onOverlayClick);
                document.removeEventListener('keydown', onKeydown);
                dialog.classList.remove('show');
                resolve(result);
            };
            const onConfirm = () => finish(true);
            const onCancel = () => finish(false);
            const onOverlayClick = (event) => { if (event.target === dialog) finish(false); };
            const onKeydown = (event) => { if (event.key === 'Escape') finish(false); };

            confirmBtn.addEventListener('click', onConfirm);
            cancelBtn.addEventListener('click', onCancel);
            dialog.addEventListener('mousedown', onOverlayClick);
            document.addEventListener('keydown', onKeydown);

            dialog.classList.add('show');
            confirmBtn.focus();
        });
    }

    window.showConfirmDialog = showConfirmDialog;
})();
