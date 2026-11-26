/**
 * Shared design-system replacement for window.confirm() (#759), extracted
 * from the version settings.js built for #605 so every instructor page can
 * use it instead of the native "localhost:8080 says..." dialog. Injects its
 * own modal markup on first use, so a page only needs to load this script
 * (and modal-a11y.js, for the focus trap) - no HTML to add.
 *
 * Usage: const ok = await confirmDialog('Delete this item?', { danger: true });
 * Resolves true if confirmed, false if cancelled/dismissed - the same
 * boolean a native confirm() call would have returned.
 */
(function () {
    let modalEl = null;
    let titleEl = null;
    let messageEl = null;
    let cancelBtn = null;
    let confirmBtn = null;

    function ensureModal() {
        if (modalEl) return;

        modalEl = document.createElement('div');
        modalEl.id = 'confirm-dialog-modal';
        modalEl.className = 'transfer-modal-overlay';
        modalEl.setAttribute('aria-hidden', 'true');
        modalEl.innerHTML = `
            <div class="transfer-modal confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="confirm-dialog-title">
                <div class="transfer-modal-header">
                    <h2 id="confirm-dialog-title">Are you sure?</h2>
                </div>
                <div class="transfer-modal-body">
                    <p id="confirm-dialog-message"></p>
                </div>
                <div class="transfer-modal-footer">
                    <button id="confirm-dialog-cancel" class="secondary-button" type="button">Cancel</button>
                    <button id="confirm-dialog-confirm" class="primary-button" type="button">Confirm</button>
                </div>
            </div>
        `;
        document.body.appendChild(modalEl);

        titleEl = modalEl.querySelector('#confirm-dialog-title');
        messageEl = modalEl.querySelector('#confirm-dialog-message');
        cancelBtn = modalEl.querySelector('#confirm-dialog-cancel');
        confirmBtn = modalEl.querySelector('#confirm-dialog-confirm');
    }

    /**
     * @param {string} message
     * @param {{title?: string, confirmLabel?: string, danger?: boolean}} [options]
     * @returns {Promise<boolean>}
     */
    function confirmDialog(message, { title = 'Are you sure?', confirmLabel = 'Confirm', danger = false } = {}) {
        ensureModal();

        return new Promise((resolve) => {
            titleEl.textContent = title;
            messageEl.textContent = message;
            confirmBtn.textContent = confirmLabel;
            confirmBtn.className = danger ? 'danger-button' : 'primary-button';

            let settled = false;
            const finish = (result) => {
                if (settled) return;
                settled = true;
                confirmBtn.removeEventListener('click', onConfirm);
                cancelBtn.removeEventListener('click', onCancel);
                modalEl.classList.remove('show');
                modalEl.setAttribute('aria-hidden', 'true');
                window.a11yModal?.close(modalEl);
                resolve(result);
            };
            const onConfirm = () => finish(true);
            const onCancel = () => finish(false);

            confirmBtn.addEventListener('click', onConfirm);
            cancelBtn.addEventListener('click', onCancel);

            modalEl.classList.add('show');
            modalEl.setAttribute('aria-hidden', 'false');
            window.a11yModal?.open(modalEl, {
                dialogEl: modalEl.querySelector('.transfer-modal'),
                onRequestClose: () => finish(false),
            });
        });
    }

    window.confirmDialog = confirmDialog;
})();
