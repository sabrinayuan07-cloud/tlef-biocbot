document.addEventListener('DOMContentLoaded', async () => {
    const SUPER_STUDENT_LEVELS = ['intro', 'undergraduate', 'graduate'];
    const SUPER_INSTRUCTOR_LEVELS = ['overview', 'standard', 'deepDive'];
    const LLM_KEY_CONTACT_EMAIL = 'LT.hub@ubc.ca';
    const DEFAULT_CHAT_SURVEY_SETTINGS = {
        enabled: false,
        triggerMessageCount: 10,
        promptText: 'How useful is this chat so far',
        introText: 'So BIOCBOT would like your help to improve the user and learning experience, if you are able to please rate your recent experience with BIOCBOT',
        accuracyPrompt: 'Has BIOCBOT been presenting accurate and appropriate content?',
        satisfactionPrompt: 'Are you satisfied with your learning experience using BIOCBOT?',
        allowFreeText: false,
        summaryTriggerMessageCount: 25,
        minTriggerMessageCount: 2,
        maxTriggerMessageCount: 30,
        minSummaryTriggerMessageCount: 2,
        maxSummaryTriggerMessageCount: 40
    };

    const settingsHub = document.getElementById('settings-hub');
    const settingsPanels = document.getElementById('settings-panels');
    const deleteCollectionBtn = document.getElementById('delete-collection');
    const courseLifecycleSection = document.getElementById('course-lifecycle-section');
    const toggleCourseActiveBtn = document.getElementById('toggle-course-active-btn');
    const transferCourseBtn = document.getElementById('transfer-course-btn');
    const transferUnitGrid = document.getElementById('transfer-unit-grid');
    const transferCourseNameInput = document.getElementById('transfer-course-name');
    const transferCourseApiKeyInput = document.getElementById('transfer-course-api-key');
    const transferAllDocsToggle = document.getElementById('transfer-all-docs');
    const transferAllObjectivesToggle = document.getElementById('transfer-all-objectives');
    const transferAllQuestionsToggle = document.getElementById('transfer-all-questions');
    const transferCourseModal = document.getElementById('transfer-course-modal');
    const transferModalTitle = document.getElementById('transfer-modal-title');
    const transferModalDescription = document.getElementById('transfer-modal-description');
    const transferModalSummary = document.getElementById('transfer-modal-summary');
    const transferModalConfirmation = document.getElementById('transfer-modal-confirmation');
    const transferModalLoading = document.getElementById('transfer-modal-loading');
    const transferModalLoadingText = document.getElementById('transfer-modal-loading-text');
    const transferModalCancelBtn = document.getElementById('transfer-modal-cancel');
    const transferModalConfirmBtn = document.getElementById('transfer-modal-confirm');
    const systemAdminList = document.getElementById('system-admin-list');
    const systemAdminEmailInput = document.getElementById('system-admin-email-input');
    const grantSystemAdminBtn = document.getElementById('grant-system-admin-btn');
    let lifecycleCourseData = null;
    let pendingTransferPayload = null;
    let isTransferInProgress = false;
    // Currently-selected Super Course bucket in the bucket editor (null = none yet).
    let selectedSuperchatId = null;
    // Cached bucket summaries so the per-course checklist can re-render without a
    // page refresh whenever buckets are created/renamed/deleted.
    let availableSuperchats = [];
    // Per-surface platform state (active platform, key status per platform, and
    // any in-flight migration). Declared here because loadSettings() runs before
    // the helper definitions further down would otherwise be evaluated.
    const llmSurfaceState = {};
    const llmMigrationWatchers = {};
    const LLM_SURFACES = [
        { prefix: 'course', statusId: 'course-llm-key-status' },
        { prefix: 'superchat', statusId: 'superchat-llm-key-status' },
        { prefix: 'notes', statusId: 'notes-llm-key-status' },
        { prefix: 'instructor-superchat', statusId: 'instructor-superchat-llm-key-status' }
    ];
    // Element-id prefixes for each platform's admin model controls. GPT keeps
    // the historical un-prefixed ids.
    const LLM_PLATFORM_UI = {
        openai: { idPrefix: 'llm', label: 'OpenAI Chat GPT' },
        'ubc-llm-sandbox': { idPrefix: 'sandbox-llm', label: 'UBC On-Premise LLM' },
        'ubc-llm-proxy': { idPrefix: 'proxy-llm', label: 'UBC LLM Proxy' }
    };
    // Latest per-platform settings from /api/settings/llm, keyed by provider.
    let llmPlatformSettings = {};
    let llmModelScope = null;
    let llmSettingsRequestId = 0;
    let activeModelAccordion = null;
    let markAdminSettingsReady;
    const adminSettingsReady = new Promise(resolve => { markAdminSettingsReady = resolve; });
    const modelEditorContext = document.getElementById('llm-model-scope-context');
    const modelEditorHome = modelEditorContext?.parentElement || null;
    const modelEditorHomeMarker = modelEditorContext ? document.createComment('llm-model-editor-home') : null;
    if (modelEditorContext && modelEditorHomeMarker) {
        modelEditorContext.before(modelEditorHomeMarker);
    }

    function llmScopePayload() {
        return llmModelScope
            ? { scopeType: llmModelScope.type, scopeId: llmModelScope.id }
            : {};
    }

    function modelSections() {
        return ['llm-model-section', 'sandbox-llm-model-section', 'proxy-llm-model-section']
            .map(id => document.getElementById(id))
            .filter(Boolean);
    }

    function restoreModelEditorHome() {
        if (!modelEditorHome || !modelEditorHomeMarker || !modelEditorContext) return;
        modelEditorHomeMarker.after(modelEditorContext, ...modelSections());
    }

    async function closeScopedModelEditor({ reloadDefaults = true } = {}) {
        if (!activeModelAccordion) return;
        const { button, body } = activeModelAccordion;
        activeModelAccordion = null;
        button.textContent = 'Configure models';
        button.setAttribute('aria-expanded', 'false');
        button.removeAttribute('aria-controls');
        restoreModelEditorHome();
        body.remove();
        llmModelScope = null;
        if (reloadDefaults) await loadLLMSettings(null);
    }

    async function openScopedModelEditor(scope, container, label, button, placeAfter = null) {
        if (!container || !modelEditorContext) return;
        if (activeModelAccordion?.button === button) {
            await closeScopedModelEditor();
            return;
        }
        if (activeModelAccordion) await closeScopedModelEditor({ reloadDefaults: false });

        const body = document.createElement('div');
        body.id = `${button.id}-panel`;
        body.className = 'scoped-model-accordion';
        body.setAttribute('role', 'region');
        body.setAttribute('aria-label', `${label} model settings`);
        if (placeAfter) placeAfter.after(body);
        else container.append(body);

        const context = modelEditorContext;
        context.textContent = scope
            ? `System-admin model configuration for ${label}. Changes affect only this AI surface.`
            : 'Default templates for newly created AI configurations. Existing surfaces are not changed.';
        body.append(context, ...modelSections());
        activeModelAccordion = { button, body };
        button.textContent = 'Hide model settings';
        button.setAttribute('aria-expanded', 'true');
        button.setAttribute('aria-controls', body.id);
        await loadLLMSettings(scope);
    }

    function setupScopedModelButtons() {
        const definitions = [
            {
                id: 'configure-course-models',
                controls: document.querySelector('#course-llm-key-section .llm-key-controls'),
                resolve: async () => {
                    const id = await getCurrentCourseId();
                    return id ? { scope: { type: 'course', id }, label: 'this course' } : null;
                }
            },
            {
                id: 'configure-superchat-models',
                controls: document.querySelector('#super-course-chat-section .llm-key-controls'),
                resolve: async () => selectedSuperchatId
                    ? { scope: { type: 'superchat', id: selectedSuperchatId }, label: 'this Super Course bucket' }
                    : null
            },
            {
                id: 'configure-notes-models',
                controls: document.querySelector('#notes-llm-key-section .llm-key-controls'),
                placeAfter: document.getElementById('notes-llm-key-section'),
                resolve: async () => ({ scope: { type: 'notes', id: 'notesLlm' }, label: 'instructor notes' })
            },
            {
                id: 'configure-instructor-superchat-models',
                controls: document.querySelector('#instructor-superchat-llm-key-section .llm-key-controls'),
                container: document.getElementById('settings-panel-admin-platform'),
                resolve: async () => ({ scope: { type: 'superCourseChat', id: 'superCourseChat' }, label: 'global instructor Super Course chat' })
            }
        ];
        for (const definition of definitions) {
            if (!definition.controls || document.getElementById(definition.id)) continue;
            const button = document.createElement('button');
            button.id = definition.id;
            button.type = 'button';
            button.className = 'secondary-button';
            button.textContent = 'Configure models';
            button.setAttribute('aria-expanded', 'false');
            button.addEventListener('click', async () => {
                // The page loads defaults and key state asynchronously. Wait
                // for that first pass so it cannot overwrite this scoped load
                // and leave the dropdowns empty.
                await adminSettingsReady;
                const resolved = await definition.resolve();
                if (!resolved) {
                    showNotification('Select an AI surface first.', 'error');
                    return;
                }
                const container = definition.container || definition.controls.closest('.settings-section');
                await openScopedModelEditor(resolved.scope, container, resolved.label, button, definition.placeAfter);
            });
            definition.controls.append(button);
        }

    }
    // Proxy `/models` responses do not include reasoning capabilities. Cache
    // operation-probed results for this settings-page session by exact model id.
    const proxyReasoningEffortCache = new Map();
    let proxyReasoningProbeCount = 0;
    // Buckets created in this session get a "New" badge until membership is saved.
    const newlyCreatedSuperchatIds = new Set();

    /* =============================================
       Hub / panel navigation (hash-routed)
       ============================================= */

    const BASE_PANEL_NAMES = ['course-basics', 'student-chat', 'prompts', 'quiz', 'privacy', 'super-course'];
    const ADMIN_PANEL_NAMES = ['admin-platform', 'admin-access', 'admin-safety', 'admin-database'];

    function getVisiblePanelNames() {
        const names = [...BASE_PANEL_NAMES];
        const lifecycleTile = document.getElementById('lifecycle-tile');
        if (lifecycleTile && !lifecycleTile.hidden) {
            names.push('lifecycle');
        }
        const adminTileGroup = document.getElementById('admin-tile-group');
        if (adminTileGroup && !adminTileGroup.hidden) {
            names.push(...ADMIN_PANEL_NAMES);
        }
        return names;
    }

    function currentPanelName() {
        const hash = decodeURIComponent((window.location.hash || '').replace(/^#/, ''));
        return getVisiblePanelNames().includes(hash) ? hash : null;
    }

    // Show either the hub (tile grid) or the panel view for the current hash.
    // Deep links (/instructor/settings#quiz), refresh, and the browser back
    // button all work because the hash is the source of truth.
    function renderSettingsView({ focusHeading = false } = {}) {
        if (!settingsHub || !settingsPanels) return;

        const active = currentPanelName();
        const accordionPanel = activeModelAccordion?.body.closest('.settings-panel')?.dataset.panel;
        if (activeModelAccordion && accordionPanel !== active) {
            // The model controls are a single shared editor. Always return it
            // to the defaults panel when leaving a scoped accordion so the
            // Platform & models page can never appear empty until refresh.
            void closeScopedModelEditor();
        }
        settingsHub.hidden = !!active;
        settingsPanels.hidden = !active;

        document.querySelectorAll('.settings-panel').forEach(panel => {
            panel.hidden = panel.dataset.panel !== active;
        });

        document.querySelectorAll('.settings-rail-link').forEach(link => {
            if (link.dataset.panel === active) {
                link.setAttribute('aria-current', 'true');
            } else {
                link.removeAttribute('aria-current');
            }
        });

        // Move focus to the panel heading so keyboard and screen-reader users
        // land on the section they navigated to.
        if (active && focusHeading) {
            const heading = document.querySelector(`.settings-panel[data-panel="${active}"] .settings-panel-title`);
            if (heading) heading.focus();
        }
    }

    window.addEventListener('hashchange', () => renderSettingsView({ focusHeading: true }));
    renderSettingsView();

    /* =============================================
       Per-section dirty tracking
       ============================================= */

    function initDirtyTracking() {
        document.querySelectorAll('.settings-section').forEach(section => {
            const note = section.querySelector('.settings-dirty-note');
            if (!note) return;
            const markDirty = (event) => {
                if (event.target.closest('.settings-section-actions')) return;
                note.hidden = false;
            };
            section.addEventListener('input', markDirty);
            section.addEventListener('change', markDirty);
        });
    }

    function clearDirty(elementInSection) {
        const section = elementInSection && elementInSection.closest
            ? elementInSection.closest('.settings-section')
            : null;
        const note = section ? section.querySelector('.settings-dirty-note') : null;
        if (note) note.hidden = true;
    }

    function markSectionDirty(sectionId) {
        const note = document.querySelector(`#${sectionId} .settings-dirty-note`);
        if (note) note.hidden = false;
    }

    // Shared wiring for section save/reset buttons: confirm (optional), busy
    // state, error notification, and clearing the section's dirty note.
    function wireSectionButton(buttonId, handler, { confirmMessage, busyLabel } = {}) {
        const btn = document.getElementById(buttonId);
        if (!btn) return;
        btn.addEventListener('click', async () => {
            if (confirmMessage && !confirm(confirmMessage)) return;
            const originalLabel = btn.textContent;
            btn.disabled = true;
            if (busyLabel) btn.textContent = busyLabel;
            try {
                await handler();
                clearDirty(btn);
            } catch (error) {
                console.error(`Error handling ${buttonId}:`, error);
                showNotification(error.message || 'Something went wrong', 'error');
            } finally {
                btn.disabled = false;
                btn.textContent = originalLabel;
            }
        });
    }

    function addKeyboardPickerActivation(selectElement) {
        if (!selectElement) return;
        selectElement.addEventListener('keydown', event => {
            if (event.key !== 'Enter' && event.key !== ' ') return;

            try {
                if (typeof selectElement.showPicker === 'function') {
                    selectElement.showPicker();
                    event.preventDefault();
                }
            } catch (error) {
                // Preserve the browser's native select behavior when unavailable.
            }
        });
    }

    initDirtyTracking();
    addKeyboardPickerActivation(document.getElementById('course-year-level-select'));
    addKeyboardPickerActivation(document.getElementById('superchat-select'));
    addKeyboardPickerActivation(document.getElementById('superchat-year-select'));

    document.addEventListener('keydown', event => {
        const toggle = event.target;
        if (!(toggle instanceof HTMLInputElement)
            || toggle.type !== 'checkbox'
            || !toggle.closest('#settings-panels, #transfer-course-modal')
            || event.key !== 'Enter') return;

        event.preventDefault();
        toggle.click();
    });

    // Check if user has system admin access
    await waitForAuth();
    const canManageDB = await checkDeleteAllPermission();

    // Load initial settings including prompts
    await loadSettings(canManageDB);
    markAdminSettingsReady();

    // Visibility of the lifecycle and admin groups may have changed during load;
    // re-resolve the current hash against what this user can actually see.
    renderSettingsView();

    async function loadSettings(canManageDB) {
        // Super Course settings (per-course bucket membership + bucket management)
        // are available to instructors, not just admins, so they can curate their
        // own Super Course groupings. Load these FIRST and independently, so a
        // failure in an unrelated section below can never hide them.
        try {
            await loadAiSettings();
            await loadSuperCourseChatSettings();
        } catch (error) {
            console.error('Error loading Super Course settings:', error);
        }

        try {
            // Load global config (prompts and additive retrieval)
            await loadGlobalConfig();

            // Load quiz practice settings
            await loadQuizSettings();
            await loadChatSurveySettings();

            // Load course year level
            await loadCourseLevel();

            // Inject the GPT/Sandbox selectors before any surface state loads
            // so the first paint already reflects the chosen platform.
            initLlmPlatformSelectors();
            await loadCourseLlmKey();

            // Load privacy settings (anonymize students)
            await loadAnonymizeStudentsSetting();

            // Load mental health detection prompt
            await loadMentalHealthDetectionPrompt();

            // Load course lifecycle controls for instructors
            await initializeCourseLifecycle();

            // If user has permission, load global settings (login restriction)
            // and question generation prompts
            if (canManageDB) {
                await loadAdminSettings();
                await loadLLMSettings(null);
                await loadNotesLlmKey();
                await loadInstructorSuperchatLlmKey();
                await loadQuestionPrompts();
                await loadSystemAdmins();
            }

            consumeDeferredFlashMessage();
        } catch (error) {
            console.error('Error loading settings:', error);
            showNotification('Failed to load settings', 'error');
        }
    }

    function updateReasoningVisibility(idPrefix, lane, reasoningEffortsByModel, defaultReasoningEffortByModel) {
        const lanePrefix = lane === 'backend' ? `${idPrefix}-backend` : idPrefix;
        const modelSelect = document.getElementById(`${lanePrefix}-model-select`);
        const reasoningItem = document.getElementById(`${lanePrefix}-reasoning-item`);
        const reasoningSelect = document.getElementById(`${lanePrefix}-reasoning-select`);
        if (!modelSelect || !reasoningItem) return;

        const efforts = reasoningEffortsByModel[modelSelect.value] || [];
        reasoningItem.style.display = efforts.length > 0 ? '' : 'none';

        if (reasoningSelect) {
            const selected = reasoningSelect.value;
            const allEfforts = [...new Set([
                ...Array.from(reasoningSelect.options, option => option.value),
                ...Object.values(reasoningEffortsByModel).flat()
            ])];
            for (const effort of allEfforts) {
                let option = reasoningSelect.querySelector(`option[value="${effort}"]`);
                if (!option) {
                    option = document.createElement('option');
                    option.value = effort;
                    option.textContent = effort;
                    reasoningSelect.appendChild(option);
                }
                const supported = efforts.includes(effort);
                option.hidden = !supported;
                option.disabled = !supported;
            }
            const modelDefault = defaultReasoningEffortByModel[modelSelect.value];
            const fallback = efforts.includes(modelDefault) ? modelDefault : (efforts[0] || '');
            reasoningSelect.value = efforts.includes(selected) ? selected : fallback;
        }
    }

    async function refreshProxyReasoningEfforts(platform, lane) {
        const { idPrefix } = LLM_PLATFORM_UI[platform.provider];
        const lanePrefix = lane === 'backend' ? `${idPrefix}-backend` : idPrefix;
        const modelSelect = document.getElementById(`${lanePrefix}-model-select`);
        const reasoningItem = document.getElementById(`${lanePrefix}-reasoning-item`);
        const reasoningSelect = document.getElementById(`${lanePrefix}-reasoning-select`);
        const saveButton = document.getElementById('save-proxy-llm-settings');
        const model = modelSelect?.value;
        if (!model || !reasoningItem || !reasoningSelect) return;

        const previouslySelected = reasoningSelect.value;
        let discoverySucceeded = false;
        proxyReasoningProbeCount += 1;
        if (saveButton) saveButton.disabled = true;
        reasoningItem.style.display = '';
        reasoningSelect.disabled = true;
        reasoningSelect.replaceChildren(new Option('Checking supported efforts…', '', true, true));
        const discoveryKey = `${llmModelScope?.type || 'defaults'}:${llmModelScope?.id || 'new'}:${model}`;

        try {
            let discovery = proxyReasoningEffortCache.get(discoveryKey);
            if (!discovery) {
                discovery = fetch('/api/settings/llm/reasoning-efforts', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'include',
                    body: JSON.stringify({ provider: platform.provider, model, ...llmScopePayload() })
                }).then(async response => {
                    const result = await parseJsonResponse(response);
                    if (!response.ok || !result.success) {
                        throw new Error(result.error || 'Unable to detect supported reasoning efforts');
                    }
                    return {
                        efforts: result.reasoningEfforts || [],
                        defaultReasoningEffort: result.defaultReasoningEffort || null
                    };
                });
                proxyReasoningEffortCache.set(discoveryKey, discovery);
            }

            const { efforts, defaultReasoningEffort } = await discovery;
            platform.reasoningEffortsByModel ||= {};
            platform.defaultReasoningEffortByModel ||= {};
            platform.reasoningEffortsByModel[model] = efforts;
            const savedModel = lane === 'backend' ? platform.backendChatModel : platform.chatModel;
            const savedEffort = lane === 'backend' ? platform.backendReasoningEffort : platform.reasoningEffort;
            platform.defaultReasoningEffortByModel[model] = savedModel === model && efforts.includes(savedEffort)
                ? savedEffort
                : efforts.includes(defaultReasoningEffort)
                    ? defaultReasoningEffort
                    : efforts.includes(previouslySelected)
                        ? previouslySelected
                        : efforts.includes('low') ? 'low' : efforts[0];

            reasoningSelect.replaceChildren();
            updateReasoningVisibility(
                idPrefix,
                lane,
                platform.reasoningEffortsByModel,
                platform.defaultReasoningEffortByModel
            );
            discoverySucceeded = true;
        } catch (error) {
            proxyReasoningEffortCache.delete(discoveryKey);
            reasoningSelect.replaceChildren(new Option('Reasoning check failed', '', true, true));
            reasoningItem.style.display = '';
            showNotification(error.message, 'error');
        } finally {
            const inherits = document.getElementById(`${idPrefix}-backend-inherit`)?.checked !== false;
            reasoningSelect.disabled = !discoverySucceeded || (lane === 'backend' && inherits);
            proxyReasoningProbeCount = Math.max(0, proxyReasoningProbeCount - 1);
            if (saveButton && proxyReasoningProbeCount === 0) saveButton.disabled = false;
        }
    }

    function formatLlmKeyTimestamp(value) {
        if (!value) return '';
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return '';
        return date.toLocaleString();
    }

    async function llmProviderActionUrl(prefix, action) {
        if (prefix === 'course') {
            const courseId = await getCurrentCourseId();
            if (!courseId) throw new Error('Select a course first');
            const base = `/api/courses/${encodeURIComponent(courseId)}/llm-provider`;
            return action === 'prepare' ? `${base}/prepare` : base;
        }
        if (prefix === 'superchat') {
            if (!selectedSuperchatId) throw new Error('Select a bucket first');
            const base = `/api/superchats/${encodeURIComponent(selectedSuperchatId)}/llm-provider`;
            return action === 'prepare' ? `${base}/prepare` : base;
        }
        if (prefix === 'notes') {
            const base = '/api/settings/notes-llm-key/provider';
            return action === 'prepare' ? `${base}/prepare` : base;
        }
        const base = '/api/settings/instructor-superchat-llm-key/provider';
        return action === 'prepare' ? `${base}/prepare` : base;
    }

    async function runLlmProviderAction(prefix, action, options = {}) {
        const provider = selectedLlmProvider(prefix);
        const label = llmProviderLabel(provider);
        const prompt = action === 'prepare'
            ? `Refresh current material for ${label}? Only missing or changed items will be embedded.`
            : `Switch this AI surface to ${label}? Existing embeddings are reused, and only missing `
                + `or changed items are indexed before the switch completes.`;
        if (!options.confirmed && !confirm(prompt)) return;

        const url = await llmProviderActionUrl(prefix, action);
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ llmProvider: provider })
        });
        const result = await parseJsonResponse(response);

        // Switching is one round trip. When the target profile is already
        // current (the common GPT -> Sandbox -> GPT case) the backend activates
        // it immediately; otherwise it starts the indexing job itself and
        // activates the platform when that job finishes.
        if (!response.ok || !result.success) {
            throw new Error(result.message || `Could not ${action} ${label}`);
        }

        applyLlmSurfaceState(prefix, result, { resetSelection: false });
        if (result.migration) watchLlmMigration(prefix, result.migration.migrationId);
        showNotification(result.message, 'success');
    }

    /**
     * Inject the shared GPT/Sandbox selector and migration panel into every
     * keyed surface, and keep help text + key status in sync with the choice.
     */
    function initLlmPlatformSelectors() {
        if (!window.LlmPlatform) return;

        for (const surface of LLM_SURFACES) {
            const statusElement = document.getElementById(surface.statusId);
            if (!statusElement) continue;

            const item = statusElement.closest('.setting-item') || statusElement.parentElement;
            const controls = item ? item.querySelector('.llm-key-controls') : null;
            if (!controls) continue;

            window.LlmPlatform.renderSelector(surface.prefix, controls);
            window.LlmPlatform.renderMigrationPanel(surface.prefix, item);

            const radios = document.querySelectorAll(`input[name="${surface.prefix}-llm-provider"]`);
            radios.forEach(radio => radio.addEventListener('change', () => {
                const state = llmSurfaceState[surface.prefix] || {};
                window.LlmPlatform.refreshSelector(surface.prefix, state);
                window.LlmPlatform.renderKeyStatus(surface.prefix, state);
            }));

            const keyInput = document.getElementById(`${surface.prefix}-llm-key-input`);
            if (keyInput) {
                keyInput.addEventListener('input', () => {
                    const state = llmSurfaceState[surface.prefix] || {};
                    window.LlmPlatform.refreshSelector(surface.prefix, state);
                });
            }

            const retry = document.getElementById(`${surface.prefix}-llm-migration-retry`);
            if (retry) {
                retry.addEventListener('click', async () => {
                    const panel = document.getElementById(`${surface.prefix}-llm-migration`);
                    const migrationId = panel && panel.dataset.migrationId;
                    if (!migrationId) return;
                    try {
                        const result = await window.LlmPlatform.retryMigration(migrationId);
                        if (result && result.migration) {
                            window.LlmPlatform.renderMigration(surface.prefix, result.migration);
                            watchLlmMigration(surface.prefix, migrationId);
                        }
                        showNotification('Retrying failed items', 'success');
                    } catch (error) {
                        showNotification('Could not retry the migration', 'error');
                    }
                });
            }

            const prepare = document.getElementById(`${surface.prefix}-llm-prepare`);
            if (prepare) {
                prepare.addEventListener('click', async () => {
                    prepare.disabled = true;
                    try {
                        await runLlmProviderAction(
                            surface.prefix,
                            prepare.dataset.action === 'switch' ? 'switch' : 'prepare'
                        );
                    } catch (error) {
                        showNotification(error.message || 'Could not prepare material', 'error');
                    } finally {
                        window.LlmPlatform.refreshSelector(
                            surface.prefix,
                            llmSurfaceState[surface.prefix] || {}
                        );
                    }
                });
            }

            const cancel = document.getElementById(`${surface.prefix}-llm-migration-cancel`);
            if (cancel) {
                cancel.addEventListener('click', async () => {
                    const panel = document.getElementById(`${surface.prefix}-llm-migration`);
                    const migrationId = panel && panel.dataset.migrationId;
                    if (!migrationId || !confirm(
                        'Cancel this preparation and delete the partial vectors created for it?'
                    )) return;
                    cancel.disabled = true;
                    try {
                        const result = await window.LlmPlatform.cancelMigration(migrationId);
                        window.LlmPlatform.renderMigration(surface.prefix, result.migration);
                        await refreshLlmSurfaceState(surface.prefix);
                        showNotification(result.message, 'success');
                    } catch (error) {
                        cancel.disabled = false;
                        showNotification(error.message || 'Could not cancel preparation', 'error');
                    }
                });
            }
        }
    }

    function watchLlmMigration(prefix, migrationId) {
        if (!window.LlmPlatform || !migrationId) return;
        if (llmMigrationWatchers[prefix]) clearInterval(llmMigrationWatchers[prefix]);
        llmMigrationWatchers[prefix] = window.LlmPlatform.watchMigration(prefix, migrationId, (migration) => {
            // A completed migration atomically changes the active provider in
            // MongoDB. Reload the whole surface state so the selector, saved-key
            // statuses and action label do not keep showing the pre-migration
            // provider until the instructor refreshes the page.
            if (migration && ['completed', 'failed', 'cancelled'].includes(migration.status)) {
                const selected = selectedLlmProvider(prefix);
                refreshLlmSurfaceState(prefix).then(() => {
                    window.LlmPlatform.setProvider(prefix, selected);
                    const state = llmSurfaceState[prefix] || {};
                    window.LlmPlatform.refreshSelector(prefix, state);
                    window.LlmPlatform.renderKeyStatus(prefix, state);
                }).catch(error => {
                    console.error(`Error refreshing ${prefix} platform state:`, error);
                });
            }
        });
    }

    async function refreshLlmSurfaceState(prefix) {
        if (prefix === 'course') return loadCourseLlmKey();
        if (prefix === 'superchat') {
            return selectedSuperchatId ? loadSuperchatLlmKeyState(selectedSuperchatId) : undefined;
        }
        if (prefix === 'notes') return loadNotesLlmKey();
        if (prefix === 'instructor-superchat') return loadInstructorSuperchatLlmKey();
        return undefined;
    }

    /**
     * Apply a surface's platform + key state to the UI.
     * @param {string} prefix
     * @param {Object} state - { llmProvider, llmKey, llmKeysByProvider, migration }
     */
    function applyLlmSurfaceState(prefix, state = {}, options = {}) {
        llmSurfaceState[prefix] = state;
        if (!window.LlmPlatform) {
            renderLlmKeyStatus(prefix, state.llmKey);
            return;
        }

        // While a migration runs, show the platform being migrated TO so the
        // instructor sees what they asked for, not the still-active one.
        if (options.resetSelection !== false) {
            window.LlmPlatform.setProvider(prefix, state.pendingLlmProvider || state.llmProvider || 'openai');
        }
        window.LlmPlatform.refreshSelector(prefix, state);
        window.LlmPlatform.renderKeyStatus(prefix, state);
        if (state.llmConfigurationStatus === 'needs_admin_configuration') {
            const status = document.getElementById(`${prefix}-llm-key-status`);
            if (status) {
                status.className = 'llm-key-status invalid';
                status.textContent += ' AI is waiting for a system administrator to select compatible models.';
            }
        }

        if (state.migration) {
            const running = window.LlmPlatform.renderMigration(prefix, state.migration);
            if (running) watchLlmMigration(prefix, state.migration.migrationId);
        } else {
            window.LlmPlatform.renderMigration(prefix, null);
        }
    }

    function renderLlmKeyStatus(prefix, llmKey) {
        const statusElement = document.getElementById(`${prefix}-llm-key-status`);
        if (!statusElement) return;

        const keyStatus = llmKey && llmKey.status ? llmKey.status : 'missing';
        const last4 = llmKey && llmKey.last4 ? ` ending ${llmKey.last4}` : '';
        const checkedAt = formatLlmKeyTimestamp(llmKey && llmKey.validatedAt);
        statusElement.className = `llm-key-status ${keyStatus}`;

        if (keyStatus === 'valid') {
            statusElement.textContent = checkedAt
                ? `Valid key${last4}. Last checked ${checkedAt}.`
                : `Valid key${last4}.`;
            return;
        }

        if (keyStatus === 'quota_exhausted') {
            statusElement.textContent = `AI disabled. Saved key is out of quota. Contact ${LLM_KEY_CONTACT_EMAIL}.`;
            return;
        }

        if (keyStatus === 'invalid') {
            statusElement.textContent = `AI disabled. Saved key failed validation. Contact ${LLM_KEY_CONTACT_EMAIL}.`;
            return;
        }

        statusElement.textContent = `AI disabled. Save a key or contact ${LLM_KEY_CONTACT_EMAIL}.`;
    }

    async function parseJsonResponse(response) {
        try {
            return await response.json();
        } catch (error) {
            return { success: false, message: response.statusText || 'Request failed' };
        }
    }

    function selectedLlmProvider(statusPrefix) {
        return window.LlmPlatform
            ? window.LlmPlatform.selectedProvider(statusPrefix)
            : 'openai';
    }

    function llmProviderLabel(provider) {
        return window.LlmPlatform ? window.LlmPlatform.providerLabel(provider) : 'OpenAI Chat GPT';
    }

    /**
     * Save a key for the platform selected on this surface.
     *
     * This action only saves/replaces the selected platform's encrypted key.
     * Preparing material and changing the active platform is a separate action.
     */
    async function saveLlmKey({ inputId, statusPrefix, url, successMessage }) {
        const input = document.getElementById(inputId);
        const apiKey = input && input.value ? input.value.trim() : '';
        const llmProvider = selectedLlmProvider(statusPrefix);
        if (!apiKey) {
            input?.focus();
            throw new Error(`Enter a ${llmProviderLabel(llmProvider)} API key first`);
        }

        const response = await fetch(url, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ apiKey, llmProvider })
        });
        const result = await parseJsonResponse(response);
        if (response.ok && result.success) {
            input.value = '';
            applyLlmSurfaceState(statusPrefix, result, { resetSelection: false });
            if (llmProvider === 'ubc-llm-proxy') {
                // System admins see the newly discovered exact ids immediately.
                // For regular instructors the admin-only endpoint simply
                // returns 403 and loadLLMSettings() leaves the UI unchanged.
                await loadLLMSettings();
            }
        } else if (result.llmKey) {
            renderLlmKeyStatus(statusPrefix, result.llmKey);
        }
        if (!response.ok || !result.success) {
            throw new Error(result.message || 'API key validation failed');
        }

        showNotification(
            successMessage || result.message || 'API key saved',
            'success'
        );
        // wireSectionButton restores its generic enabled state in `finally`;
        // repaint on the next turn so an empty replacement field ends disabled.
        setTimeout(() => {
            if (window.LlmPlatform) {
                window.LlmPlatform.refreshSelector(statusPrefix, llmSurfaceState[statusPrefix] || {});
            }
        }, 0);
        return result;
    }

    async function testSavedLlmKey({ statusPrefix, url, successMessage }) {
        const llmProvider = selectedLlmProvider(statusPrefix);
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ llmProvider })
        });
        const result = await parseJsonResponse(response);
        if (result.llmKey) {
            const state = llmSurfaceState[statusPrefix] || {};
            const merged = {
                ...state,
                llmKeysByProvider: { ...(state.llmKeysByProvider || {}), [llmProvider]: result.llmKey }
            };
            applyLlmSurfaceState(statusPrefix, merged, { resetSelection: false });
        }
        if (!response.ok || !result.success) {
            throw new Error(result.message || 'Saved API key failed validation');
        }

        showNotification(successMessage || result.message || 'Saved API key is valid', 'success');
        return result;
    }

    async function loadCourseLlmKey() {
        try {
            const courseId = await getCurrentCourseId();
            if (!courseId) {
                renderLlmKeyStatus('course', null);
                return;
            }

            const response = await fetch(`/api/courses/${encodeURIComponent(courseId)}/llm-key`, {
                credentials: 'include'
            });
            const result = await parseJsonResponse(response);
            if (response.ok && result.success) {
                applyLlmSurfaceState('course', result);
            }
        } catch (error) {
            console.error('Error loading course API key status:', error);
        }
    }

    async function loadSuperchatLlmKeyState(superchatId) {
        try {
            const response = await fetch(`/api/superchats/${encodeURIComponent(superchatId)}/llm-key`, {
                credentials: 'include'
            });
            const result = await parseJsonResponse(response);
            if (response.ok && result.success) {
                applyLlmSurfaceState('superchat', result);
            }
        } catch (error) {
            console.error('Error loading bucket API key status:', error);
        }
    }

    async function loadNotesLlmKey() {
        try {
            const response = await fetch('/api/settings/notes-llm-key', {
                credentials: 'include'
            });
            const result = await parseJsonResponse(response);
            if (response.ok && result.success) {
                applyLlmSurfaceState('notes', result);
            }
        } catch (error) {
            console.error('Error loading notes API key status:', error);
        }
    }

    async function loadInstructorSuperchatLlmKey() {
        try {
            const response = await fetch('/api/settings/instructor-superchat-llm-key', {
                credentials: 'include'
            });
            const result = await parseJsonResponse(response);
            if (response.ok && result.success) {
                applyLlmSurfaceState('instructor-superchat', result);
            }
        } catch (error) {
            console.error('Error loading instructor Super Course chat API key status:', error);
        }
    }

    function fillSelect(select, values, selected) {
        if (!select) return;

        // An empty list means the server told us nothing about this control —
        // an older server shape, or a failed lookup. Keep whatever options the
        // markup already ships rather than emptying the control entirely.
        if (Array.isArray(values) && values.length > 0) {
            select.replaceChildren(...values.map(value => {
                const option = document.createElement('option');
                option.value = value;
                option.textContent = value;
                return option;
            }));
        }

        // Select against the options actually present, so the static fallback
        // options still resolve when the server sent no list.
        if (selected && Array.from(select.options).some(option => option.value === selected)) {
            select.value = selected;
        }
    }

    /**
     * Render one platform's admin model controls: chat model, reasoning effort,
     * embedding model, its Qdrant collection, and any staged embedding change.
     */
    function renderPlatformModelControls(platform) {
        const ui = LLM_PLATFORM_UI[platform.provider];
        if (!ui) return;
        const { idPrefix, label } = ui;
        const effortsByModel = platform.reasoningEffortsByModel || {};
        const defaultsByModel = platform.defaultReasoningEffortByModel || {};

        const modelSelect = document.getElementById(`${idPrefix}-model-select`);
        fillSelect(modelSelect, platform.allowedModels || [], platform.chatModel);
        if (platform.provider === 'ubc-llm-proxy' && !platform.chatModel && modelSelect) {
            const placeholder = new Option('Select a front-end model', '', true, true);
            placeholder.disabled = true;
            modelSelect.prepend(placeholder);
        }
        const reasoningSelect = document.getElementById(`${idPrefix}-reasoning-select`);
        updateReasoningVisibility(idPrefix, 'frontend', effortsByModel, defaultsByModel);
        if (reasoningSelect && (effortsByModel[platform.chatModel] || []).includes(platform.reasoningEffort)) {
            reasoningSelect.value = platform.reasoningEffort;
        }

        const backendModelSelect = document.getElementById(`${idPrefix}-backend-model-select`);
        const backendModelItem = document.getElementById(`${idPrefix}-backend-model-item`);
        const backendReasoningSelect = document.getElementById(`${idPrefix}-backend-reasoning-select`);
        const backendReasoningItem = document.getElementById(`${idPrefix}-backend-reasoning-item`);
        const inheritToggle = document.getElementById(`${idPrefix}-backend-inherit`);
        fillSelect(backendModelSelect, platform.allowedModels || [], platform.backendChatModel || platform.chatModel);
        if (platform.provider === 'ubc-llm-proxy' && !platform.backendChatModel && backendModelSelect) {
            const placeholder = new Option('Select a back-end model', '', true, true);
            placeholder.disabled = true;
            backendModelSelect.prepend(placeholder);
        }
        updateReasoningVisibility(idPrefix, 'backend', effortsByModel, defaultsByModel);
        if (backendReasoningSelect
            && (effortsByModel[backendModelSelect?.value] || []).includes(platform.backendReasoningEffort)) {
            backendReasoningSelect.value = platform.backendReasoningEffort;
        }
        if (inheritToggle) inheritToggle.checked = platform.backendInheritsFrontend !== false;

        const syncBackendInheritance = () => {
            const inherits = inheritToggle?.checked !== false;
            if (backendModelSelect) backendModelSelect.disabled = inherits;
            if (backendReasoningSelect) backendReasoningSelect.disabled = inherits;
            if (backendModelItem) backendModelItem.hidden = inherits;
            if (backendReasoningItem) backendReasoningItem.hidden = inherits;
            if (inherits && modelSelect && backendModelSelect) {
                backendModelSelect.value = modelSelect.value;
                updateReasoningVisibility(idPrefix, 'backend', effortsByModel, defaultsByModel);
                if (reasoningSelect && backendReasoningSelect) {
                    backendReasoningSelect.value = reasoningSelect.value;
                }
            } else {
                updateReasoningVisibility(idPrefix, 'backend', effortsByModel, defaultsByModel);
            }
        };

        if (modelSelect) modelSelect.onchange = async () => {
            if (platform.provider === 'ubc-llm-proxy') {
                await refreshProxyReasoningEfforts(platform, 'frontend');
            } else {
                updateReasoningVisibility(idPrefix, 'frontend', effortsByModel, defaultsByModel);
            }
            syncBackendInheritance();
        };
        if (reasoningSelect) reasoningSelect.onchange = syncBackendInheritance;
        if (backendModelSelect) backendModelSelect.onchange = async () => {
            if (platform.provider === 'ubc-llm-proxy') {
                await refreshProxyReasoningEfforts(platform, 'backend');
            } else {
                updateReasoningVisibility(idPrefix, 'backend', effortsByModel, defaultsByModel);
            }
        };
        if (inheritToggle) inheritToggle.onchange = async () => {
            syncBackendInheritance();
            if (platform.provider === 'ubc-llm-proxy' && !inheritToggle.checked) {
                await refreshProxyReasoningEfforts(platform, 'backend');
            }
        };
        syncBackendInheritance();
        if (platform.provider === 'ubc-llm-proxy' && modelSelect?.value) {
            void refreshProxyReasoningEfforts(platform, 'frontend').then(syncBackendInheritance);
        }

        const embeddingSelect = document.getElementById(`${idPrefix}-embedding-select`);
        fillSelect(
            embeddingSelect,
            platform.allowedEmbeddingModels || [],
            platform.pendingEmbedding?.embeddingModel || platform.embeddingModel
        );
        if (platform.provider === 'ubc-llm-proxy'
            && !platform.pendingEmbedding?.embeddingModel
            && !platform.embeddingModel
            && embeddingSelect) {
            const placeholder = new Option('Select an embedding model', '', true, true);
            placeholder.disabled = true;
            embeddingSelect.prepend(placeholder);
        }

        const discovery = document.getElementById(`${idPrefix}-discovery-status`);
        if (discovery) {
            discovery.textContent = platform.modelsDiscovered
                ? 'Models loaded from saved UBC LLM Proxy keys. Selections are validated with chat and embedding operations when saved.'
                : 'Save a UBC LLM Proxy key on a course, Super Course, notes, or instructor chat to load models.';
        }

        const collection = document.getElementById(`${idPrefix}-embedding-collection`);
        if (collection) {
            collection.textContent = platform.collection
                ? `${platform.collection} (${platform.vectorSize} dimensions)`
                : 'Not configured';
        }

        const pending = document.getElementById(`${idPrefix}-embedding-pending`);
        const rollback = document.getElementById(`rollback-${idPrefix}-embedding`);
        const isReindexing = Boolean(platform.pendingEmbedding?.migrationId);
        if (pending) {
            if (platform.pendingEmbedding) {
                const activeDescription = platform.embeddingModel
                    ? `${platform.embeddingModel} stays active until re-indexing finishes.`
                    : 'No embedding model is active yet.';
                pending.hidden = false;
                // Re-indexing is never started from this panel. The surface's own
                // platform control applies the saved choice when it switches to
                // (or refreshes) that platform.
                pending.textContent = isReindexing
                    ? `Re-indexing: ${platform.pendingEmbedding.embeddingModel}. ${activeDescription}`
                    : `Saved: ${platform.pendingEmbedding.embeddingModel}. `
                        + `It is applied when this surface switches to ${label}. ${activeDescription}`;
            } else {
                pending.hidden = true;
                pending.textContent = '';
            }
        }
        if (embeddingSelect) embeddingSelect.disabled = isReindexing;
        if (rollback) {
            rollback.hidden = !platform.pendingEmbedding;
            rollback.textContent = isReindexing ? 'Cancel re-indexing' : 'Discard embedding change';
        }
    }

    async function loadLLMSettings(scope = undefined) {
        const requestId = ++llmSettingsRequestId;
        try {
            if (scope !== undefined) llmModelScope = scope;
            if (scope === undefined && !llmModelScope) {
                const courseId = await getCurrentCourseId();
                if (courseId) llmModelScope = { type: 'course', id: courseId };
            }
            const query = llmModelScope
                ? `?scopeType=${encodeURIComponent(llmModelScope.type)}&scopeId=${encodeURIComponent(llmModelScope.id)}`
                : '';
            const response = await fetch(`/api/settings/llm${query}`, { credentials: 'include' });
            const result = await response.json();
            if (requestId !== llmSettingsRequestId) return;
            if (!result.success) return;

            const platforms = Array.isArray(result.platforms) ? result.platforms : [];
            llmPlatformSettings = {};
            const visibleProviders = new Set(platforms.map(platform => platform.provider));
            for (const [provider, ui] of Object.entries(LLM_PLATFORM_UI)) {
                const section = document.getElementById(`${ui.idPrefix}-model-section`);
                if (section) section.style.display = visibleProviders.has(provider) ? '' : 'none';
            }
            for (const platform of platforms) {
                llmPlatformSettings[platform.provider] = platform;
                renderPlatformModelControls(platform);
            }

            // Older server shape (single active platform) — keep the GPT group
            // populated so the screen still works during a rolling deploy.
            if (platforms.length === 0 && result.settings) {
                renderPlatformModelControls({
                    provider: 'openai',
                    chatModel: result.settings.model,
                    reasoningEffort: result.settings.reasoningEffort,
                    allowedModels: result.settings.allowedModels || [],
                    reasoningEffortsByModel: result.settings.reasoningEffortsByModel || {},
                    defaultReasoningEffortByModel: result.settings.defaultReasoningEffortByModel || {},
                    allowedEmbeddingModels: [],
                    collection: '',
                    vectorSize: ''
                });
            }
        } catch (error) {
            console.error('Error loading LLM settings:', error);
        }
    }

    /**
     * Save everything in a platform's model section.
     *
     * The chat model and reasoning effort apply immediately. If the embedding
     * model was also changed, the admin is shown the re-indexing impact and, on
     * confirmation, the change is staged — one Save button, no second control
     * that silently owns half the section.
     */
    async function fetchModelSettings(url, options) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15_000);
        try {
            return await fetch(url, { ...options, signal: controller.signal });
        } catch (error) {
            if (error.name === 'AbortError') {
                throw new Error('The model-settings request timed out. Please try again.');
            }
            throw error;
        } finally {
            clearTimeout(timeout);
        }
    }

    async function savePlatformModelSettings(provider) {
        const { idPrefix, label } = LLM_PLATFORM_UI[provider];
        const chatModel = document.getElementById(`${idPrefix}-model-select`)?.value;
        const reasoningEffort = document.getElementById(`${idPrefix}-reasoning-select`)?.value || 'minimal';
        const backendInheritsFrontend = document.getElementById(`${idPrefix}-backend-inherit`)?.checked !== false;
        const backendChatModel = document.getElementById(`${idPrefix}-backend-model-select`)?.value;
        const backendReasoningEffort = document.getElementById(`${idPrefix}-backend-reasoning-select`)?.value || 'minimal';
        if (!chatModel) throw new Error('Select a model first');
        if (!backendInheritsFrontend && !backendChatModel) throw new Error('Select a back-end model first');

        const response = await fetchModelSettings('/api/settings/llm', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({
                provider,
                ...llmScopePayload(),
                chatModel,
                model: chatModel,
                reasoningEffort,
                backendInheritsFrontend,
                ...(backendInheritsFrontend ? {} : { backendChatModel, backendReasoningEffort })
            })
        });
        const result = await response.json();
        if (!response.ok || !result.success) {
            throw new Error(result.error || 'Failed to save LLM settings');
        }

        const embeddingStaged = await stagePlatformEmbeddingModel(provider);
        if (!embeddingStaged) {
            showNotification(`${label} model settings saved`, 'success');
        }
    }

    /**
     * Stage an embedding-model change: show the admin the impact first, then
     * create the migration. The previous model stays active throughout.
     *
     * @returns {Promise<boolean>} true when a change was actually staged
     */
    async function stagePlatformEmbeddingModel(provider) {
        const { idPrefix, label } = LLM_PLATFORM_UI[provider];
        const embeddingModel = document.getElementById(`${idPrefix}-embedding-select`)?.value;
        if (!embeddingModel) return false;

        const current = llmPlatformSettings[provider];
        if (current?.pendingEmbedding?.migrationId) {
            if (current.pendingEmbedding.embeddingModel === embeddingModel) return false;
            throw new Error('Cancel the current re-indexing job before choosing another embedding model.');
        }
        if (current?.pendingEmbedding?.embeddingModel === embeddingModel) return false;
        if (current?.embeddingModel === embeddingModel && !current.pendingEmbedding) {
            return false;
        }

        const response = await fetchModelSettings('/api/settings/llm/embedding/stage', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ provider, embeddingModel, ...llmScopePayload() })
        });
        const result = await response.json();
        if (!response.ok || !result.success) {
            throw new Error(result.error || 'Failed to save the embedding model selection');
        }
        showNotification(result.message || `${label} embedding selection saved`, 'success');
        await loadLLMSettings();
        return true;
    }

    async function rollbackPlatformEmbeddingModel(provider) {
        const response = await fetchModelSettings('/api/settings/llm/embedding/rollback', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ provider, ...llmScopePayload() })
        });
        const result = await response.json();
        if (!response.ok || !result.success) {
            throw new Error(result.error || 'Failed to cancel the staged change');
        }
        showNotification(result.message || 'Staged change cancelled', 'success');
        await loadLLMSettings();
    }

    async function loadAdminSettings() {
        try {
            const response = await fetch('/api/settings/global');
            const result = await response.json();

            if (result.success && result.settings) {
                const allowLocalLoginToggle = document.getElementById('allow-local-login-toggle');
                if (allowLocalLoginToggle) {
                    allowLocalLoginToggle.checked = result.settings.allowLocalLogin !== false; // Default true
                }
                const academicApiToggle = document.getElementById('academic-api-enabled-toggle');
                if (academicApiToggle) {
                    academicApiToggle.checked = result.settings.academicApiEnabled === true; // Default off
                }
            }
        } catch (error) {
            console.error('Error loading admin settings:', error);
        }
    }

    async function loadSystemAdmins() {
        if (!systemAdminList) {
            return;
        }

        systemAdminList.innerHTML = '<div class="system-admin-empty">Loading system admins...</div>';

        try {
            const response = await fetch('/api/settings/system-admins', {
                credentials: 'include'
            });
            const result = await response.json();

            if (!result.success || !Array.isArray(result.admins)) {
                throw new Error(result.error || 'Failed to load system admins');
            }

            renderSystemAdmins(result.admins);
        } catch (error) {
            console.error('Error loading system admins:', error);
            systemAdminList.innerHTML = '<div class="system-admin-empty">Failed to load system admins.</div>';
        }
    }

    async function loadAiSettings() {
        try {
            const courseId = await getCurrentCourseId();
            if (!courseId) return;

            const response = await fetch(`/api/settings/ai-settings?courseId=${encodeURIComponent(courseId)}`, {
                credentials: 'include'
            });
            const result = await response.json();
            if (!result.success || !result.settings) return;

            const topKInput = document.getElementById('student-chat-topk-input');
            if (topKInput) topKInput.value = result.settings.ragSettings?.student?.topK || 3;

            availableSuperchats = result.availableSuperchats || [];
            renderCourseSuperchatChecklist(
                availableSuperchats,
                result.settings.superchatIds || []
            );
        } catch (error) {
            console.error('Error loading AI settings:', error);
        }
    }

    // Render the per-course bucket checklist. Each bucket is a checkbox; checked
    // state reflects the course's current superchatIds. Read on save.
    function renderCourseSuperchatChecklist(buckets, selectedIds) {
        const container = document.getElementById('course-superchat-checklist');
        if (!container) return;

        if (!buckets.length) {
            container.innerHTML = '<p class="superchat-checklist-empty">No Super Course buckets exist yet. Create one below.</p>';
            return;
        }

        const selected = new Set(selectedIds || []);
        container.innerHTML = buckets.map(b => {
            const id = `course-superchat-${b.superchatId}`;
            const checked = selected.has(b.superchatId) ? 'checked' : '';
            const isNew = newlyCreatedSuperchatIds.has(b.superchatId);
            return `
                <label class="superchat-checklist-item${isNew ? ' is-new' : ''}" for="${id}">
                    <input type="checkbox" id="${id}" class="course-superchat-checkbox" value="${escapeHtml(b.superchatId)}" ${checked}>
                    <span>${escapeHtml(b.name)}</span>
                    ${isNew ? '<span class="superchat-checklist-new-badge">New</span>' : ''}
                </label>`;
        }).join('');
    }

    // Re-render the checklist from the cached bucket list, preserving whatever
    // the user currently has checked (plus any ids passed in, e.g. a bucket that
    // was just created and should start checked for this course).
    function refreshCourseSuperchatChecklist(extraCheckedIds = []) {
        const checked = new Set(collectCourseSuperchatIds());
        extraCheckedIds.forEach(id => checked.add(id));
        renderCourseSuperchatChecklist(availableSuperchats, Array.from(checked));
    }

    // Collect the checked bucket ids from the per-course checklist.
    function collectCourseSuperchatIds() {
        return Array.from(document.querySelectorAll('.course-superchat-checkbox'))
            .filter(cb => cb.checked)
            .map(cb => cb.value);
    }

    function applyLevelModifiersToFields(prefix, levels, modifiers) {
        const map = modifiers && typeof modifiers === 'object' ? modifiers : {};
        levels.forEach(level => {
            const el = document.getElementById(`${prefix}-${level}`);
            if (el) el.value = typeof map[level] === 'string' ? map[level] : '';
        });
    }

    function collectLevelModifiersFromFields(prefix, levels) {
        const result = {};
        levels.forEach(level => {
            const el = document.getElementById(`${prefix}-${level}`);
            result[level] = el ? el.value : '';
        });
        return result;
    }

    // Fill the bucket editor form from a superchat object ({ name, yearLevel,
    // showToStudents, settings }).
    function fillSuperchatForm(superchat) {
        const s = (superchat && superchat.settings) || {};
        const nameInput = document.getElementById('superchat-name-input');
        const yearSelect = document.getElementById('superchat-year-select');
        const showStudentToggle = document.getElementById('show-student-super-course-toggle');

        if (nameInput) nameInput.value = (superchat && superchat.name) || '';
        if (yearSelect) yearSelect.value = (superchat && superchat.yearLevel) ? String(superchat.yearLevel) : '';
        if (showStudentToggle) showStudentToggle.checked = superchat && superchat.showToStudents === true;
        applyLlmSurfaceState('superchat', superchat || {});
        if (superchat && superchat.superchatId) loadSuperchatLlmKeyState(superchat.superchatId);
        fillSuperchatChatSettingsFields(s);
    }

    // Fill only the chat-settings fields (the "Advanced" group) of the bucket
    // editor. Used by both fillSuperchatForm and the per-bucket reset, which
    // restores defaults without touching the bucket's name/year/visibility.
    function fillSuperchatChatSettingsFields(s) {
        const instructorTopKInput = document.getElementById('super-instructor-topk-input');
        const studentTopKInput = document.getElementById('super-student-topk-input');
        const includeInactiveToggle = document.getElementById('include-inactive-super-course-toggle');
        const includeNotesToggle = document.getElementById('include-notes-super-course-toggle');
        const noteRatioInput = document.getElementById('super-note-ratio-input');
        const noteMinScoreInput = document.getElementById('super-note-min-score-input');
        const instructorPrompt = document.getElementById('super-instructor-prompt');
        const studentPrompt = document.getElementById('super-student-prompt');

        if (instructorTopKInput) instructorTopKInput.value = s.instructorTopK || 8;
        if (studentTopKInput) studentTopKInput.value = s.studentTopK || 8;
        if (includeInactiveToggle) includeInactiveToggle.checked = s.includeInactiveCourses === true;
        if (includeNotesToggle) includeNotesToggle.checked = s.includeNotesInRetrieval !== false;
        if (noteRatioInput) noteRatioInput.value = s.noteRetrievalRatio ?? 0.25;
        if (noteMinScoreInput) noteMinScoreInput.value = s.noteMinScore ?? 0.25;
        if (instructorPrompt) instructorPrompt.value = s.instructorPrompt || '';
        if (studentPrompt) studentPrompt.value = s.studentPrompt || '';
        applyLevelModifiersToFields('super-student-level', SUPER_STUDENT_LEVELS, s.studentLevelModifiers);
        applyLevelModifiersToFields('super-instructor-level', SUPER_INSTRUCTOR_LEVELS, s.instructorLevelModifiers);
    }

    // Enable/disable the editor fields based on whether a bucket is selected.
    function setSuperchatEditorEnabled(enabled) {
        const ids = [
            'superchat-name-input', 'superchat-year-select', 'delete-superchat-btn',
            'super-instructor-topk-input', 'super-student-topk-input',
            'include-inactive-super-course-toggle', 'show-student-super-course-toggle',
            'include-notes-super-course-toggle', 'super-note-ratio-input', 'super-note-min-score-input',
            'super-instructor-prompt', 'super-student-prompt',
            'superchat-llm-key-input', 'test-superchat-llm-key', 'save-superchat-llm-key',
            'reset-superchat-bucket', 'save-superchat-bucket'
        ];
        for (const id of ids) {
            const el = document.getElementById(id);
            if (el) el.disabled = !enabled;
        }
    }

    // Load a single bucket into the editor by id.
    async function loadSuperchatIntoForm(superchatId) {
        if (!superchatId) {
            selectedSuperchatId = null;
            setSuperchatEditorEnabled(false);
            renderLlmKeyStatus('superchat', null);
            return;
        }
        try {
            const response = await fetch(`/api/superchats/${encodeURIComponent(superchatId)}`, { credentials: 'include' });
            const result = await response.json();
            if (!response.ok || !result.success) throw new Error(result.message || 'Failed to load bucket');
            selectedSuperchatId = superchatId;
            setSuperchatEditorEnabled(true);
            fillSuperchatForm(result.superchat);
            clearDirty(document.getElementById('superchat-select'));
        } catch (error) {
            console.error('Error loading superchat:', error);
        }
    }

    // Populate the bucket <select> from the list endpoint, refresh the cached
    // bucket summaries, and load the preferred (or first) bucket into the editor.
    async function loadSuperchatList(preferredId) {
        const select = document.getElementById('superchat-select');
        if (!select) return;
        try {
            const response = await fetch('/api/superchats', { credentials: 'include' });
            const result = await response.json();
            if (!response.ok || !result.success) throw new Error(result.message || 'Failed to list buckets');

            const buckets = result.superchats || [];
            availableSuperchats = buckets;
            select.innerHTML = buckets.length
                ? buckets.map(b => `<option value="${escapeHtml(b.superchatId)}">${escapeHtml(b.name)} (${b.courseCount} course${b.courseCount === 1 ? '' : 's'})</option>`).join('')
                : '<option value="">No buckets yet</option>';

            if (!buckets.length) {
                await loadSuperchatIntoForm(null);
                return;
            }

            const toSelect = (preferredId && buckets.some(b => b.superchatId === preferredId))
                ? preferredId
                : buckets[0].superchatId;
            select.value = toSelect;
            await loadSuperchatIntoForm(toSelect);
        } catch (error) {
            console.error('Error loading superchat list:', error);
        }
    }

    // Wire up bucket management controls (select / create / delete).
    function initSuperchatManagement() {
        const select = document.getElementById('superchat-select');
        const newBtn = document.getElementById('new-superchat-btn');
        const newNameInput = document.getElementById('new-superchat-name');
        const newKeyInput = document.getElementById('new-superchat-key');
        const deleteBtn = document.getElementById('delete-superchat-btn');

        if (select) {
            select.addEventListener('change', () => loadSuperchatIntoForm(select.value || null));
        }

        async function createBucket() {
            const name = (newNameInput?.value || '').trim();
            if (!name) {
                showNotification('Enter a name for the new bucket first.', 'error');
                newNameInput?.focus();
                return;
            }
            const apiKey = (newKeyInput?.value || '').trim();
            if (!apiKey) {
                showNotification('Enter an OpenAI API key for the new bucket first.', 'error');
                newKeyInput?.focus();
                return;
            }
            newBtn.disabled = true;
            try {
                const response = await fetch('/api/superchats', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'include',
                    body: JSON.stringify({ name, apiKey })
                });
                const result = await response.json();
                if (!response.ok || !result.success) throw new Error(result.message || 'Failed to create bucket');

                const newId = result.superchat.superchatId;
                newlyCreatedSuperchatIds.add(newId);
                if (newNameInput) newNameInput.value = '';
                if (newKeyInput) newKeyInput.value = '';

                // Refresh the bucket editor select AND the per-course checklist in
                // place (no page refresh needed). The new bucket starts checked for
                // this course; saving bucket membership confirms it.
                await loadSuperchatList(newId);
                refreshCourseSuperchatChecklist([newId]);
                markSectionDirty('course-superchats-section');
                showNotification('Bucket created and checked for this course. Save bucket membership to confirm.', 'success');
            } catch (error) {
                console.error('Error creating bucket:', error);
                showNotification(error.message || 'Failed to create bucket', 'error');
            } finally {
                newBtn.disabled = false;
            }
        }

        if (newBtn) {
            newBtn.addEventListener('click', createBucket);
        }
        if (newNameInput) {
            newNameInput.addEventListener('keydown', (event) => {
                if (event.key === 'Enter') {
                    event.preventDefault();
                    createBucket();
                }
            });
        }
        if (newKeyInput) {
            newKeyInput.addEventListener('keydown', (event) => {
                if (event.key === 'Enter') {
                    event.preventDefault();
                    createBucket();
                }
            });
        }
        if (deleteBtn) {
            deleteBtn.addEventListener('click', async () => {
                if (!selectedSuperchatId) return;
                if (!confirm('Delete this Super Course bucket? It will be removed from every course and hidden from students.')) return;
                try {
                    const response = await fetch(`/api/superchats/${encodeURIComponent(selectedSuperchatId)}`, {
                        method: 'DELETE',
                        credentials: 'include'
                    });
                    const result = await response.json();
                    if (!response.ok || !result.success) throw new Error(result.message || 'Failed to delete bucket');
                    newlyCreatedSuperchatIds.delete(selectedSuperchatId);
                    await loadSuperchatList();
                    // Drop the deleted bucket from the per-course checklist too.
                    refreshCourseSuperchatChecklist();
                    showNotification('Super Course bucket deleted', 'success');
                } catch (error) {
                    console.error('Error deleting bucket:', error);
                    showNotification(error.message || 'Failed to delete bucket', 'error');
                }
            });
        }
    }

    async function loadSuperCourseChatSettings() {
        initSuperchatManagement();
        await loadSuperchatList();
    }

    function formatSystemAdminTimestamp(value) {
        if (!value) {
            return 'Never';
        }

        const date = new Date(value);
        if (Number.isNaN(date.getTime())) {
            return 'Never';
        }

        return date.toLocaleString();
    }

    function renderSystemAdmins(admins) {
        if (!systemAdminList) {
            return;
        }

        if (!admins.length) {
            systemAdminList.innerHTML = '<div class="system-admin-empty">No system admins found.</div>';
            return;
        }

        const currentUser = typeof getCurrentUser === 'function' ? getCurrentUser() : null;
        const currentUserEmail = currentUser && currentUser.email ? String(currentUser.email).toLowerCase() : '';

        systemAdminList.innerHTML = admins.map(admin => {
            const adminEmail = admin.email || '';
            const isCurrentUser = adminEmail.toLowerCase() === currentUserEmail;
            const displayName = admin.displayName || adminEmail;
            const lastLogin = formatSystemAdminTimestamp(admin.lastLogin);

            return `
                <div class="system-admin-row${isCurrentUser ? ' is-self' : ''}">
                    <div class="system-admin-details">
                        <div class="system-admin-name-row">
                            <strong>${escapeHtml(displayName)}</strong>
                            ${isCurrentUser ? '<span class="system-admin-badge">You</span>' : ''}
                        </div>
                        <div class="system-admin-email">${escapeHtml(adminEmail)}</div>
                        <div class="system-admin-meta">Last login: ${escapeHtml(lastLogin)}</div>
                    </div>
                    <button
                        class="secondary-button system-admin-revoke-btn"
                        data-email="${escapeHtml(adminEmail)}"
                    >
                        Revoke
                    </button>
                </div>
            `;
        }).join('');
    }

    function escapeHtml(value) {
        return String(value || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    async function loadGlobalConfig() {
        try {
            const courseId = await getCurrentCourseId();
            const response = await fetch(`/api/settings/prompts?courseId=${courseId}`);
            const result = await response.json();

            if (result.success && result.prompts) {
                applyPromptValues(result.prompts);

                const additiveToggle = document.getElementById('additive-retrieval-toggle');
                if (additiveToggle) additiveToggle.checked = !!result.prompts.additiveRetrieval;

                const additionalSecondaryToggle = document.getElementById('additional-material-secondary-toggle');
                if (additionalSecondaryToggle) additionalSecondaryToggle.checked = !!result.prompts.additionalMaterialSecondarySearch;

                // Convert seconds to minutes for display
                const idleTimeoutInput = document.getElementById('idle-timeout-input');
                if (idleTimeoutInput && result.prompts.studentIdleTimeout) {
                    idleTimeoutInput.value = result.prompts.studentIdleTimeout / 60;
                }
                const sessionTimeoutInput = document.getElementById('session-timeout-input');
                if (sessionTimeoutInput && result.prompts.studentSessionTimeout) {
                    sessionTimeoutInput.value = result.prompts.studentSessionTimeout / 60;
                }
            }
        } catch (error) {
            console.error('Error fetching global config:', error);
        }
    }

    // Fill the course prompt textareas from a prompts object.
    function applyPromptValues(promptValues) {
        const fields = {
            'base-prompt': promptValues.base,
            'protege-prompt': promptValues.protege,
            'tutor-prompt': promptValues.tutor,
            'explain-prompt': promptValues.explain,
            'directive-prompt': promptValues.directive,
            'quiz-help-prompt': promptValues.quizHelp,
            'flashcard-prompt': promptValues.flashcards,
            'chat-summary-prompt': promptValues.chatSummary
        };
        for (const [id, value] of Object.entries(fields)) {
            const el = document.getElementById(id);
            if (el) el.value = value || '';
        }
        const flashcardTokenBudget = document.getElementById('flashcard-token-budget');
        if (flashcardTokenBudget) {
            flashcardTokenBudget.value = String(promptValues.flashcardSourceTokenBudget || 12000);
        }
    }

    /**
     * Load question generation prompts for system admins only
     * These are course-specific prompts used for AI question generation
     */
    async function loadQuestionPrompts() {
        try {
            const courseId = await getCurrentCourseId();
            const response = await fetch(`/api/settings/question-prompts?courseId=${courseId}`);
            const result = await response.json();

            if (result.success && result.prompts) {
                applyQuestionPromptValues(result.prompts);
            }
        } catch (error) {
            console.error('Error fetching question prompts:', error);
        }
    }

    function applyQuestionPromptValues(promptValues) {
        const systemPromptInput = document.getElementById('question-system-prompt');
        const trueFalseInput = document.getElementById('question-true-false-prompt');
        const multipleChoiceInput = document.getElementById('question-multiple-choice-prompt');
        const shortAnswerInput = document.getElementById('question-short-answer-prompt');

        if (systemPromptInput) systemPromptInput.value = promptValues.systemPrompt || '';
        if (trueFalseInput) trueFalseInput.value = promptValues.trueFalse || '';
        if (multipleChoiceInput) multipleChoiceInput.value = promptValues.multipleChoice || '';
        if (shortAnswerInput) shortAnswerInput.value = promptValues.shortAnswer || '';
    }

    /**
     * Load quiz practice settings and populate the testable units checkboxes
     */
    async function loadQuizSettings() {
        try {
            const courseId = await getCurrentCourseId();
            if (!courseId) return;

            // Fetch quiz settings and course lectures in parallel
            const [settingsRes, courseRes] = await Promise.all([
                fetch(`/api/settings/quiz?courseId=${courseId}`),
                fetch(`/api/courses/${courseId}`)
            ]);

            const settingsData = await settingsRes.json();
            const courseData = await courseRes.json();

            // Populate toggles
            const quizEnabledToggle = document.getElementById('quiz-enabled-toggle');
            const materialAccessToggle = document.getElementById('quiz-material-access-toggle');
            const sourceAttributionDownloadToggle = document.getElementById('source-attribution-download-toggle');

            if (settingsData.success && settingsData.settings) {
                if (quizEnabledToggle) quizEnabledToggle.checked = settingsData.settings.enabled === true;
                if (materialAccessToggle) materialAccessToggle.checked = settingsData.settings.allowLectureMaterialAccess !== false;
                if (sourceAttributionDownloadToggle) sourceAttributionDownloadToggle.checked = settingsData.settings.allowSourceAttributionDownloads === true;
            }

            // Populate testable units checkboxes
            const container = document.getElementById('testable-units-container');
            if (!container) return;
            container.innerHTML = '';

            let publishedLectures = [];
            if (courseData.success && courseData.data && courseData.data.lectures) {
                publishedLectures = courseData.data.lectures.filter(l => l.isPublished);
            }

            if (publishedLectures.length === 0) {
                container.innerHTML = '<p style="color: var(--text-secondary, #666); font-size: 0.9rem;">No published units yet. Publish units from Course Upload to make them available for quiz practice.</p>';
                return;
            }

            const testableUnits = settingsData.success && settingsData.settings
                ? settingsData.settings.testableUnits
                : 'all';

            for (const lecture of publishedLectures) {
                const label = document.createElement('label');

                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.className = 'testable-unit-checkbox';
                checkbox.value = lecture.name;
                checkbox.checked = testableUnits === 'all' || (Array.isArray(testableUnits) && testableUnits.includes(lecture.name));

                const text = document.createElement('span');
                text.textContent = lecture.displayName || lecture.name;

                label.appendChild(checkbox);
                label.appendChild(text);
                container.appendChild(label);
            }
        } catch (error) {
            console.error('Error loading quiz settings:', error);
        }
    }

    function applyChatSurveySettings(settings = DEFAULT_CHAT_SURVEY_SETTINGS, defaults = DEFAULT_CHAT_SURVEY_SETTINGS) {
        const merged = { ...DEFAULT_CHAT_SURVEY_SETTINGS, ...(defaults || {}), ...(settings || {}) };
        const enabledToggle = document.getElementById('chat-survey-enabled-toggle');
        const triggerInput = document.getElementById('chat-survey-trigger-input');
        const promptInput = document.getElementById('chat-survey-prompt-input');
        const introInput = document.getElementById('chat-survey-intro-input');
        const accuracyInput = document.getElementById('chat-survey-accuracy-input');
        const satisfactionInput = document.getElementById('chat-survey-satisfaction-input');
        const freeTextToggle = document.getElementById('chat-survey-free-text-toggle');
        const summaryTriggerInput = document.getElementById('chat-summary-trigger-input');

        if (enabledToggle) enabledToggle.checked = merged.enabled === true;
        if (triggerInput) {
            triggerInput.min = merged.minTriggerMessageCount || DEFAULT_CHAT_SURVEY_SETTINGS.minTriggerMessageCount;
            triggerInput.max = merged.maxTriggerMessageCount || DEFAULT_CHAT_SURVEY_SETTINGS.maxTriggerMessageCount;
            triggerInput.value = merged.triggerMessageCount || DEFAULT_CHAT_SURVEY_SETTINGS.triggerMessageCount;
        }
        if (promptInput) promptInput.value = merged.promptText || DEFAULT_CHAT_SURVEY_SETTINGS.promptText;
        if (introInput) introInput.value = merged.introText || DEFAULT_CHAT_SURVEY_SETTINGS.introText;
        if (accuracyInput) accuracyInput.value = merged.accuracyPrompt || DEFAULT_CHAT_SURVEY_SETTINGS.accuracyPrompt;
        if (satisfactionInput) satisfactionInput.value = merged.satisfactionPrompt || DEFAULT_CHAT_SURVEY_SETTINGS.satisfactionPrompt;
        if (freeTextToggle) freeTextToggle.checked = merged.allowFreeText === true;
        if (summaryTriggerInput) {
            summaryTriggerInput.min = merged.minSummaryTriggerMessageCount || DEFAULT_CHAT_SURVEY_SETTINGS.minSummaryTriggerMessageCount;
            summaryTriggerInput.max = merged.maxSummaryTriggerMessageCount || DEFAULT_CHAT_SURVEY_SETTINGS.maxSummaryTriggerMessageCount;
            summaryTriggerInput.value = merged.summaryTriggerMessageCount || DEFAULT_CHAT_SURVEY_SETTINGS.summaryTriggerMessageCount;
        }
    }

    async function loadChatSurveySettings() {
        try {
            const courseId = await getCurrentCourseId();
            if (!courseId) return;

            const response = await fetch(`/api/settings/chat-survey?courseId=${encodeURIComponent(courseId)}`, {
                credentials: 'include'
            });
            const result = await response.json();

            if (result.success && result.settings) {
                applyChatSurveySettings(result.settings, result.defaults);
            }
        } catch (error) {
            console.error('Error loading chat survey settings:', error);
        }
    }

    function collectChatSurveySettingsFromForm() {
        const triggerInput = document.getElementById('chat-survey-trigger-input');
        const triggerMessageCount = Number(triggerInput?.value || DEFAULT_CHAT_SURVEY_SETTINGS.triggerMessageCount);
        const min = Number(triggerInput?.min || DEFAULT_CHAT_SURVEY_SETTINGS.minTriggerMessageCount);
        const max = Number(triggerInput?.max || DEFAULT_CHAT_SURVEY_SETTINGS.maxTriggerMessageCount);

        if (!Number.isInteger(triggerMessageCount) || triggerMessageCount < min || triggerMessageCount > max) {
            throw new Error(`Survey trigger must be a whole number from ${min} to ${max}`);
        }

        const summaryTriggerInput = document.getElementById('chat-summary-trigger-input');
        const summaryTriggerMessageCount = Number(summaryTriggerInput?.value || DEFAULT_CHAT_SURVEY_SETTINGS.summaryTriggerMessageCount);
        const summaryMin = Number(summaryTriggerInput?.min || DEFAULT_CHAT_SURVEY_SETTINGS.minSummaryTriggerMessageCount);
        const summaryMax = Number(summaryTriggerInput?.max || DEFAULT_CHAT_SURVEY_SETTINGS.maxSummaryTriggerMessageCount);
        if (!Number.isInteger(summaryTriggerMessageCount) || summaryTriggerMessageCount < summaryMin || summaryTriggerMessageCount > summaryMax) {
            throw new Error(`Summary trigger must be a whole number from ${summaryMin} to ${summaryMax}`);
        }

        return {
            enabled: document.getElementById('chat-survey-enabled-toggle')?.checked === true,
            triggerMessageCount,
            promptText: document.getElementById('chat-survey-prompt-input')?.value || DEFAULT_CHAT_SURVEY_SETTINGS.promptText,
            introText: document.getElementById('chat-survey-intro-input')?.value || DEFAULT_CHAT_SURVEY_SETTINGS.introText,
            accuracyPrompt: document.getElementById('chat-survey-accuracy-input')?.value || DEFAULT_CHAT_SURVEY_SETTINGS.accuracyPrompt,
            satisfactionPrompt: document.getElementById('chat-survey-satisfaction-input')?.value || DEFAULT_CHAT_SURVEY_SETTINGS.satisfactionPrompt,
            allowFreeText: document.getElementById('chat-survey-free-text-toggle')?.checked === true,
            summaryTriggerMessageCount
        };
    }

    /**
     * Load the course's year level into the Course Level select.
     */
    async function loadCourseLevel() {
        const select = document.getElementById('course-year-level-select');
        if (!select) return;
        try {
            const courseId = await getCurrentCourseId();
            if (!courseId) return;

            const response = await fetch(`/api/courses/${courseId}`);
            const result = await response.json();
            if (result.success && result.data) {
                const level = result.data.yearLevel;
                select.value = (level === null || level === undefined) ? '' : String(level);
            }
        } catch (error) {
            console.error('Error loading course year level:', error);
        }
    }

    async function loadAnonymizeStudentsSetting() {
        try {
            const courseId = await getCurrentCourseId();
            if (!courseId) return;
            const response = await fetch(`/api/settings/anonymize-students?courseId=${courseId}`);
            const result = await response.json();
            if (result.success) {
                const toggle = document.getElementById('anonymize-students-toggle');
                if (toggle) toggle.checked = !!result.enabled;
            }
        } catch (error) {
            console.error('Error loading anonymize students setting:', error);
        }
    }

    async function loadMentalHealthDetectionPrompt() {
        try {
            const courseId = await getCurrentCourseId();
            const response = await fetch(`/api/settings/mental-health-prompt?courseId=${courseId}`);
            const result = await response.json();
            if (result.success) {
                const textarea = document.getElementById('mental-health-detection-prompt');
                if (textarea) textarea.value = result.prompt || '';
            }
        } catch (error) {
            console.error('Error loading mental health detection prompt:', error);
        }
    }

    function consumeDeferredFlashMessage() {
        try {
            const rawMessage = sessionStorage.getItem('settingsFlashMessage');
            if (!rawMessage) return;

            sessionStorage.removeItem('settingsFlashMessage');
            const parsed = JSON.parse(rawMessage);
            if (parsed && parsed.message) {
                showNotification(parsed.message, parsed.type || 'info');
            }
        } catch (error) {
            console.warn('Unable to display deferred settings message:', error);
        }
    }

    /* =============================================
       Shared save helpers (one per backend document)

       The /prompts, /quiz, and /ai-settings endpoints are full-document
       writes, so each helper collects every field the endpoint owns from the
       DOM (values are loaded fresh on page load, so untouched fields simply
       round-trip their current server values).
       ============================================= */

    async function saveAiSettingsToServer() {
        const courseId = await getCurrentCourseId();
        const superchatIds = collectCourseSuperchatIds();
        const studentTopK = Number(document.getElementById('student-chat-topk-input')?.value || 3);
        const response = await fetch('/api/settings/ai-settings', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ courseId, superchatIds, studentTopK })
        });
        const result = await response.json();
        if (!response.ok || !result.success) {
            throw new Error(result.message || 'Failed to save AI settings');
        }
        return result;
    }

    async function savePromptsConfigToServer() {
        const courseId = await getCurrentCourseId();
        const idleTimeoutInput = document.getElementById('idle-timeout-input');
        let studentIdleTimeout = 240;
        if (idleTimeoutInput && idleTimeoutInput.value !== '') {
            studentIdleTimeout = Math.round(parseFloat(idleTimeoutInput.value) * 60);
        }
        const sessionTimeoutInput = document.getElementById('session-timeout-input');
        let studentSessionTimeout = 1800;
        if (sessionTimeoutInput && sessionTimeoutInput.value !== '') {
            studentSessionTimeout = Math.round(parseFloat(sessionTimeoutInput.value) * 60);
        }

        const response = await fetch('/api/settings/prompts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                base: document.getElementById('base-prompt')?.value ?? '',
                protege: document.getElementById('protege-prompt')?.value ?? '',
                tutor: document.getElementById('tutor-prompt')?.value ?? '',
                explain: document.getElementById('explain-prompt')?.value ?? '',
                directive: document.getElementById('directive-prompt')?.value ?? '',
                quizHelp: document.getElementById('quiz-help-prompt')?.value ?? '',
                flashcards: document.getElementById('flashcard-prompt')?.value ?? '',
                flashcardSourceTokenBudget: Number(document.getElementById('flashcard-token-budget')?.value || 12000),
                chatSummary: document.getElementById('chat-summary-prompt')?.value ?? '',
                additiveRetrieval: document.getElementById('additive-retrieval-toggle')?.checked === true,
                additionalMaterialSecondarySearch: document.getElementById('additional-material-secondary-toggle')?.checked === true,
                studentIdleTimeout,
                studentSessionTimeout,
                courseId
            })
        });
        const result = await response.json();
        if (!response.ok || !result.success) {
            throw new Error(result.message || 'Failed to save course settings');
        }
        if (result.prompts?.flashcards) {
            const flashcardPrompt = document.getElementById('flashcard-prompt');
            if (flashcardPrompt) flashcardPrompt.value = result.prompts.flashcards;
        }
        return result;
    }

    async function saveQuizConfigToServer() {
        const courseId = await getCurrentCourseId();
        const unitCheckboxes = document.querySelectorAll('.testable-unit-checkbox');
        let testableUnits = 'all';
        if (unitCheckboxes.length > 0) {
            const checkedUnits = Array.from(unitCheckboxes).filter(cb => cb.checked).map(cb => cb.value);
            // If all are checked, store 'all'; otherwise store the selected names
            testableUnits = checkedUnits.length === unitCheckboxes.length ? 'all' : checkedUnits;
        }

        const response = await fetch('/api/settings/quiz', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                courseId,
                enabled: document.getElementById('quiz-enabled-toggle')?.checked === true,
                testableUnits,
                allowLectureMaterialAccess: document.getElementById('quiz-material-access-toggle')?.checked === true,
                allowSourceAttributionDownloads: document.getElementById('source-attribution-download-toggle')?.checked === true
            })
        });
        const result = await response.json();
        if (!response.ok || !result.success) {
            throw new Error(result.message || 'Failed to save quiz settings');
        }
        return result;
    }

    async function saveChatSurveySettingsToServer() {
        const courseId = await getCurrentCourseId();
        const response = await fetch('/api/settings/chat-survey', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({
                courseId,
                ...collectChatSurveySettingsFromForm()
            })
        });
        const result = await response.json();
        if (!response.ok || !result.success) {
            throw new Error(result.message || 'Failed to save chat survey settings');
        }
        if (result.settings) {
            applyChatSurveySettings(result.settings);
        }
        return result;
    }

    async function saveAnonymizeStudentsToServer() {
        const courseId = await getCurrentCourseId();
        const enabled = document.getElementById('anonymize-students-toggle')?.checked === true;
        const response = await fetch('/api/settings/anonymize-students', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ courseId, enabled })
        });
        const result = await response.json();
        if (!response.ok || !result.success) {
            throw new Error(result.message || 'Failed to save anonymize students setting');
        }
        return result;
    }

    async function saveSuperchatBucketToServer() {
        if (!selectedSuperchatId) {
            throw new Error('Select a bucket first');
        }
        const yearValue = document.getElementById('superchat-year-select')?.value || '';
        const response = await fetch(`/api/superchats/${encodeURIComponent(selectedSuperchatId)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({
                name: document.getElementById('superchat-name-input')?.value || '',
                yearLevel: yearValue ? Number(yearValue) : null,
                showToStudents: document.getElementById('show-student-super-course-toggle')?.checked === true,
                instructorTopK: Number(document.getElementById('super-instructor-topk-input')?.value || 8),
                studentTopK: Number(document.getElementById('super-student-topk-input')?.value || 8),
                includeInactiveCourses: document.getElementById('include-inactive-super-course-toggle')?.checked === true,
                includeNotesInRetrieval: document.getElementById('include-notes-super-course-toggle')?.checked !== false,
                noteRetrievalRatio: Number(document.getElementById('super-note-ratio-input')?.value ?? 0.25),
                noteMinScore: Number(document.getElementById('super-note-min-score-input')?.value ?? 0.25),
                instructorPrompt: document.getElementById('super-instructor-prompt')?.value || '',
                studentPrompt: document.getElementById('super-student-prompt')?.value || '',
                studentLevelModifiers: collectLevelModifiersFromFields('super-student-level', SUPER_STUDENT_LEVELS),
                instructorLevelModifiers: collectLevelModifiersFromFields('super-instructor-level', SUPER_INSTRUCTOR_LEVELS)
            })
        });
        const result = await response.json();
        if (!response.ok || !result.success) {
            throw new Error(result.message || 'Failed to save Super Course settings');
        }
        return result;
    }

    /* =============================================
       Per-section save / reset wiring
       ============================================= */

    wireSectionButton('save-course-llm-key', async () => {
        const courseId = await getCurrentCourseId();
        if (!courseId) throw new Error('Select a course first');
        await saveLlmKey({
            inputId: 'course-llm-key-input',
            statusPrefix: 'course',
            url: `/api/courses/${encodeURIComponent(courseId)}/llm-key`,
            successMessage: 'Course API key saved'
        });
    }, { busyLabel: 'Saving...' });

    wireSectionButton('test-course-llm-key', async () => {
        const courseId = await getCurrentCourseId();
        if (!courseId) throw new Error('Select a course first');
        await testSavedLlmKey({
            statusPrefix: 'course',
            url: `/api/courses/${encodeURIComponent(courseId)}/llm-key/test`,
            successMessage: 'Course API key is valid'
        });
    }, { busyLabel: 'Testing...' });

    wireSectionButton('save-superchat-llm-key', async () => {
        if (!selectedSuperchatId) throw new Error('Select a bucket first');
        await saveLlmKey({
            inputId: 'superchat-llm-key-input',
            statusPrefix: 'superchat',
            url: `/api/superchats/${encodeURIComponent(selectedSuperchatId)}/llm-key`,
            successMessage: 'Bucket API key saved'
        });
        await loadSuperchatList(selectedSuperchatId);
        refreshCourseSuperchatChecklist();
    }, { busyLabel: 'Saving...' });

    wireSectionButton('test-superchat-llm-key', async () => {
        if (!selectedSuperchatId) throw new Error('Select a bucket first');
        await testSavedLlmKey({
            statusPrefix: 'superchat',
            url: `/api/superchats/${encodeURIComponent(selectedSuperchatId)}/llm-key/test`,
            successMessage: 'Bucket API key is valid'
        });
        await loadSuperchatList(selectedSuperchatId);
        refreshCourseSuperchatChecklist();
    }, { busyLabel: 'Testing...' });

    wireSectionButton('save-notes-llm-key', async () => {
        await saveLlmKey({
            inputId: 'notes-llm-key-input',
            statusPrefix: 'notes',
            url: '/api/settings/notes-llm-key',
            successMessage: 'Notes API key saved'
        });
    }, { busyLabel: 'Saving...' });

    wireSectionButton('test-notes-llm-key', async () => {
        await testSavedLlmKey({
            statusPrefix: 'notes',
            url: '/api/settings/notes-llm-key/test',
            successMessage: 'Notes API key is valid'
        });
    }, { busyLabel: 'Testing...' });

    wireSectionButton('save-instructor-superchat-llm-key', async () => {
        await saveLlmKey({
            inputId: 'instructor-superchat-llm-key-input',
            statusPrefix: 'instructor-superchat',
            url: '/api/settings/instructor-superchat-llm-key',
            successMessage: 'Instructor Super Course chat API key saved'
        });
    }, { busyLabel: 'Saving...' });

    wireSectionButton('test-instructor-superchat-llm-key', async () => {
        await testSavedLlmKey({
            statusPrefix: 'instructor-superchat',
            url: '/api/settings/instructor-superchat-llm-key/test',
            successMessage: 'Instructor Super Course chat API key is valid'
        });
    }, { busyLabel: 'Testing...' });

    // Course basics
    wireSectionButton('save-course-basics', async () => {
        const courseId = await getCurrentCourseId();
        const yearLevelSelect = document.getElementById('course-year-level-select');
        if (!courseId || !yearLevelSelect) {
            throw new Error('Select a course first');
        }
        const rawLevel = yearLevelSelect.value;
        const yearLevel = rawLevel === '' ? null : Number(rawLevel);
        const instructorId = getCurrentInstructorId();
        const response = await fetch(`/api/courses/${courseId}?instructorId=${encodeURIComponent(instructorId)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ instructorId, yearLevel })
        });
        const result = await response.json();
        if (!response.ok || !result.success) {
            throw new Error(result.message || 'Failed to save course level');
        }
        showNotification('Course basics saved', 'success');
    }, { busyLabel: 'Saving...' });

    // Student chat combines settings owned by several backend documents:
    // Top-K in ai-settings, retrieval behavior in prompts, source downloads in
    // quiz settings, and usefulness prompts in chat-survey settings.
    wireSectionButton('save-student-chat', async () => {
        await saveAiSettingsToServer();
        await savePromptsConfigToServer();
        await saveQuizConfigToServer();
        await saveChatSurveySettingsToServer();
        showNotification('Student chat settings saved', 'success');
    }, { busyLabel: 'Saving...' });

    wireSectionButton('reset-student-chat', async () => {
        const topKInput = document.getElementById('student-chat-topk-input');
        const additiveToggle = document.getElementById('additive-retrieval-toggle');
        const additionalSecondaryToggle = document.getElementById('additional-material-secondary-toggle');
        const sourceAttributionToggle = document.getElementById('source-attribution-download-toggle');
        if (topKInput) topKInput.value = 3;
        if (additiveToggle) additiveToggle.checked = true;
        if (additionalSecondaryToggle) additionalSecondaryToggle.checked = false;
        if (sourceAttributionToggle) sourceAttributionToggle.checked = false;
        applyChatSurveySettings(DEFAULT_CHAT_SURVEY_SETTINGS, DEFAULT_CHAT_SURVEY_SETTINGS);
        await saveAiSettingsToServer();
        await savePromptsConfigToServer();
        await saveQuizConfigToServer();
        await saveChatSurveySettingsToServer();
        showNotification('Student chat settings reset to defaults', 'success');
    }, {
        confirmMessage: 'Reset student chat settings (Top-K, additive retrieval, additional material search, source downloads, and survey settings) to defaults?',
        busyLabel: 'Resetting...'
    });

    // Course prompts
    wireSectionButton('save-prompts', async () => {
        await savePromptsConfigToServer();
        showNotification('Prompts saved', 'success');
    }, { busyLabel: 'Saving...' });

    wireSectionButton('reset-prompts', async () => {
        // Fetch the platform defaults (GET without courseId), fill the fields,
        // then save. Only prompt text resets - additive retrieval and
        // idle timeout belong to other sections and keep their current values.
        const response = await fetch('/api/settings/prompts');
        const result = await response.json();
        if (!result.success || !result.prompts) {
            throw new Error('Failed to load default prompts');
        }
        applyPromptValues(result.prompts);
        await savePromptsConfigToServer();
        showNotification('Prompts reset to defaults', 'success');
    }, {
        confirmMessage: 'Reset all course prompt text to the default values?',
        busyLabel: 'Resetting...'
    });

    // Quiz practice
    wireSectionButton('save-quiz-settings', async () => {
        await saveQuizConfigToServer();
        showNotification('Quiz settings saved', 'success');
    }, { busyLabel: 'Saving...' });

    wireSectionButton('reset-quiz-settings', async () => {
        const quizEnabledToggle = document.getElementById('quiz-enabled-toggle');
        const materialAccessToggle = document.getElementById('quiz-material-access-toggle');
        if (quizEnabledToggle) quizEnabledToggle.checked = false;
        if (materialAccessToggle) materialAccessToggle.checked = true;
        document.querySelectorAll('.testable-unit-checkbox').forEach(cb => { cb.checked = true; });
        await saveQuizConfigToServer();
        showNotification('Quiz settings reset to defaults', 'success');
    }, {
        confirmMessage: 'Reset quiz practice settings to defaults? Quiz practice will be disabled and all published units marked testable.',
        busyLabel: 'Resetting...'
    });

    // Privacy & sessions
    wireSectionButton('save-privacy-settings', async () => {
        await saveAnonymizeStudentsToServer();
        await savePromptsConfigToServer();
        showNotification('Privacy settings saved', 'success');
    }, { busyLabel: 'Saving...' });

    wireSectionButton('reset-privacy-settings', async () => {
        const anonymizeToggle = document.getElementById('anonymize-students-toggle');
        const idleTimeoutInput = document.getElementById('idle-timeout-input');
        const sessionTimeoutInput = document.getElementById('session-timeout-input');
        if (anonymizeToggle) anonymizeToggle.checked = false;
        if (idleTimeoutInput) idleTimeoutInput.value = 4;
        if (sessionTimeoutInput) sessionTimeoutInput.value = 30;
        await saveAnonymizeStudentsToServer();
        await savePromptsConfigToServer();
        showNotification('Privacy settings reset to defaults', 'success');
    }, {
        confirmMessage: 'Reset privacy and session settings to defaults (anonymization off, 4 minute idle timeout, 30 minute chat session timeout)?',
        busyLabel: 'Resetting...'
    });

    // Super course: per-course bucket membership
    wireSectionButton('save-course-superchats', async () => {
        await saveAiSettingsToServer();
        newlyCreatedSuperchatIds.clear();
        refreshCourseSuperchatChecklist();
        showNotification('Bucket membership saved', 'success');
    }, { busyLabel: 'Saving...' });

    wireSectionButton('reset-course-superchats', async () => {
        document.querySelectorAll('.course-superchat-checkbox').forEach(cb => { cb.checked = false; });
        await saveAiSettingsToServer();
        newlyCreatedSuperchatIds.clear();
        refreshCourseSuperchatChecklist();
        showNotification('Course removed from all Super Course buckets', 'success');
    }, {
        confirmMessage: 'Remove this course from every Super Course bucket?',
        busyLabel: 'Removing...'
    });

    // Super course: shared bucket settings
    wireSectionButton('save-superchat-bucket', async () => {
        await saveSuperchatBucketToServer();
        // Refresh the select label and checklist (name/course count may have changed).
        await loadSuperchatList(selectedSuperchatId);
        refreshCourseSuperchatChecklist();
        showNotification('Bucket settings saved', 'success');
    }, { busyLabel: 'Saving...' });

    wireSectionButton('reset-superchat-bucket', async () => {
        if (!selectedSuperchatId) {
            throw new Error('Select a bucket first');
        }
        const response = await fetch('/api/superchats/defaults', { credentials: 'include' });
        const result = await response.json();
        if (!response.ok || !result.success || !result.settings) {
            throw new Error(result.message || 'Failed to load default bucket settings');
        }
        // Restore the chat-settings defaults but keep the bucket's identity
        // (name, year level, student visibility) untouched, then persist.
        fillSuperchatChatSettingsFields(result.settings);
        await saveSuperchatBucketToServer();
        showNotification('Bucket chat settings reset to defaults', 'success');
    }, {
        confirmMessage: 'Reset this bucket\'s chat settings (Top-K, notes, prompts, modifiers) to defaults? Its name, year level, and student visibility are kept.',
        busyLabel: 'Resetting...'
    });

    // Admin: platform & models
    wireSectionButton('save-llm-settings', async () => {
        await savePlatformModelSettings('openai');
    }, { busyLabel: 'Saving...' });

    wireSectionButton('save-sandbox-llm-settings', async () => {
        await savePlatformModelSettings('ubc-llm-sandbox');
    }, { busyLabel: 'Saving...' });

    wireSectionButton('save-proxy-llm-settings', async () => {
        await savePlatformModelSettings('ubc-llm-proxy');
    }, { busyLabel: 'Saving...' });

    wireSectionButton('rollback-llm-embedding', async () => {
        await rollbackPlatformEmbeddingModel('openai');
    }, { busyLabel: 'Cancelling...' });

    wireSectionButton('rollback-sandbox-llm-embedding', async () => {
        await rollbackPlatformEmbeddingModel('ubc-llm-sandbox');
    }, { busyLabel: 'Cancelling...' });

    wireSectionButton('rollback-proxy-llm-embedding', async () => {
        await rollbackPlatformEmbeddingModel('ubc-llm-proxy');
    }, { busyLabel: 'Cancelling...' });

    // Admin: login restrictions
    wireSectionButton('save-access-settings', async () => {
        const allowLocalLogin = document.getElementById('allow-local-login-toggle')?.checked;
        const response = await fetch('/api/settings/global', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ allowLocalLogin })
        });
        const result = await response.json();
        if (!response.ok || !result.success) {
            throw new Error(result.error || 'Failed to save login settings');
        }
        showNotification('Login settings saved', 'success');
    }, { busyLabel: 'Saving...' });

    // Admin: academic API integration gate
    wireSectionButton('save-academic-api-settings', async () => {
        const academicApiEnabled = document.getElementById('academic-api-enabled-toggle')?.checked;
        const response = await fetch('/api/settings/global', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ academicApiEnabled })
        });
        const result = await response.json();
        if (!response.ok || !result.success) {
            throw new Error(result.error || 'Failed to save academic API settings');
        }
        showNotification('Academic API settings saved', 'success');
    }, { busyLabel: 'Saving...' });

    // Admin: question generation prompts
    wireSectionButton('save-question-prompts', async () => {
        const courseId = await getCurrentCourseId();
        const systemPrompt = document.getElementById('question-system-prompt')?.value;
        const trueFalse = document.getElementById('question-true-false-prompt')?.value;
        const multipleChoice = document.getElementById('question-multiple-choice-prompt')?.value;
        const shortAnswer = document.getElementById('question-short-answer-prompt')?.value;

        if (!systemPrompt || !trueFalse || !multipleChoice || !shortAnswer) {
            throw new Error('All four question prompts are required');
        }

        const response = await fetch('/api/settings/question-prompts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ systemPrompt, trueFalse, multipleChoice, shortAnswer, courseId })
        });
        const result = await response.json();
        if (!response.ok || !result.success) {
            throw new Error(result.message || 'Failed to save question prompts');
        }
        if (result.prompts) applyQuestionPromptValues(result.prompts);
        showNotification('Question prompts saved', 'success');
    }, { busyLabel: 'Saving...' });

    wireSectionButton('reset-question-prompts', async () => {
        const courseId = await getCurrentCourseId();
        const response = await fetch('/api/settings/question-prompts/reset', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ courseId })
        });
        const result = await response.json();
        if (!response.ok || !result.success || !result.prompts) {
            throw new Error(result.message || 'Failed to reset question prompts');
        }
        applyQuestionPromptValues(result.prompts);
        showNotification('Question prompts reset to defaults', 'success');
    }, {
        confirmMessage: 'Are you sure you want to reset all question generation prompts to default values? This only affects the current course.',
        busyLabel: 'Resetting...'
    });

    // Admin: mental health detection prompt
    wireSectionButton('save-mh-prompt', async () => {
        const courseId = await getCurrentCourseId();
        const prompt = document.getElementById('mental-health-detection-prompt')?.value;
        if (!prompt) {
            throw new Error('Detection prompt cannot be empty');
        }
        const response = await fetch('/api/settings/mental-health-prompt', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt, courseId })
        });
        const result = await response.json();
        if (!response.ok || !result.success) {
            throw new Error(result.message || 'Failed to save detection prompt');
        }
        showNotification('Detection prompt saved', 'success');
    }, { busyLabel: 'Saving...' });

    wireSectionButton('reset-mh-prompt', async () => {
        const courseId = await getCurrentCourseId();
        const response = await fetch('/api/settings/mental-health-prompt/reset', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ courseId })
        });
        const result = await response.json();
        if (!response.ok || !result.success) {
            throw new Error(result.message || 'Failed to reset detection prompt');
        }
        const textarea = document.getElementById('mental-health-detection-prompt');
        if (textarea) textarea.value = result.prompt || '';
        showNotification('Detection prompt reset to default', 'success');
    }, {
        confirmMessage: 'Reset the mental health detection prompt to the default?',
        busyLabel: 'Resetting...'
    });

    /* =============================================
       Course lifecycle + transfer (action buttons)
       ============================================= */

    function updateMasterTransferToggle(toggleId, selector) {
        const toggle = document.getElementById(toggleId);
        if (!toggle) return;

        const checkboxes = Array.from(document.querySelectorAll(selector));
        if (checkboxes.length === 0) {
            toggle.checked = false;
            toggle.indeterminate = false;
            return;
        }

        const checkedCount = checkboxes.filter(checkbox => checkbox.checked).length;
        toggle.checked = checkedCount === checkboxes.length;
        toggle.indeterminate = checkedCount > 0 && checkedCount < checkboxes.length;
    }

    function syncTransferMasterToggles() {
        updateMasterTransferToggle('transfer-all-docs', '.transfer-docs-checkbox');
        updateMasterTransferToggle('transfer-all-objectives', '.transfer-objectives-checkbox');
        updateMasterTransferToggle('transfer-all-questions', '.transfer-questions-checkbox');
    }

    function setTransferModalVisibility(isVisible) {
        if (!transferCourseModal) return;
        transferCourseModal.classList.toggle('show', isVisible);
        transferCourseModal.setAttribute('aria-hidden', isVisible ? 'false' : 'true');
        document.body.style.overflow = isVisible ? 'hidden' : '';
    }

    function resetTransferModalState() {
        isTransferInProgress = false;
        pendingTransferPayload = null;

        if (transferModalTitle) {
            transferModalTitle.textContent = 'Review Course Copy';
        }

        if (transferModalDescription) {
            transferModalDescription.textContent = 'This will create a new course copy and may take a few minutes while materials and existing chunks are copied over.';
        }

        if (transferModalSummary) {
            transferModalSummary.innerHTML = '';
        }

        if (transferModalConfirmation) {
            transferModalConfirmation.hidden = false;
        }

        if (transferModalLoading) {
            transferModalLoading.hidden = true;
        }

        if (transferModalLoadingText) {
            transferModalLoadingText.textContent = 'We’re copying materials, stored chunks, and saved course data into the new course.';
        }

        if (transferModalCancelBtn) {
            transferModalCancelBtn.disabled = false;
            transferModalCancelBtn.hidden = false;
        }

        if (transferModalConfirmBtn) {
            transferModalConfirmBtn.disabled = false;
            transferModalConfirmBtn.textContent = 'Start Course Copy';
            transferModalConfirmBtn.hidden = false;
        }
    }

    function closeTransferModal({ force = false } = {}) {
        if (isTransferInProgress && !force) return;
        window.a11yModal?.close(transferCourseModal);
        resetTransferModalState();
        setTransferModalVisibility(false);
    }

    function getTransferSelectionCounts(units = []) {
        return {
            totalUnits: units.length,
            docsCount: units.filter(unit => unit.transferDocuments).length,
            objectivesCount: units.filter(unit => unit.transferLearningObjectives).length,
            questionsCount: units.filter(unit => unit.transferAssessmentQuestions).length
        };
    }

    function selectedTransferProvider() {
        if (window.LlmPlatform) {
            return window.LlmPlatform.selectedProvider('transfer');
        }
        const checked = document.querySelector('input[name="transfer-llm-provider"]:checked');
        return checked ? checked.value : 'openai';
    }

    function refreshTransferProviderUi() {
        const provider = selectedTransferProvider();
        const meta = window.LlmPlatform
            ? window.LlmPlatform.providerMeta(provider)
            : {
                label: provider === 'ubc-llm-proxy'
                    ? 'UBC LLM Proxy'
                    : provider === 'ubc-llm-sandbox' ? 'UBC On-Premise LLM' : 'OpenAI Chat GPT',
                helpText: provider === 'ubc-llm-proxy'
                    ? 'Enter the UBC LLM Proxy key issued for this course.'
                    : provider === 'ubc-llm-sandbox'
                        ? 'Contact the LTIC team to request a UBC LLM Sandbox API key.'
                        : 'Feel free to use your own OpenAI API key, or contact the support team for assistance.',
                keyPlaceholder: provider === 'ubc-llm-proxy'
                    ? 'UBC LLM Proxy API key'
                    : provider === 'ubc-llm-sandbox' ? 'UBC LLM Sandbox API key' : 'sk-...'
            };

        const keyLabel = document.querySelector('label[for="transfer-course-api-key"]');
        if (keyLabel) keyLabel.textContent = `${meta.label} API key for new course`;
        if (transferCourseApiKeyInput) transferCourseApiKeyInput.placeholder = meta.keyPlaceholder;

        const help = document.getElementById('transfer-llm-platform-help');
        if (help) {
            help.textContent = meta.helpText;
            if (provider === 'openai') {
                help.innerHTML = meta.helpText.replace(
                    'the support team',
                    `<a href="mailto:${LLM_KEY_CONTACT_EMAIL}">the support team</a>`
                );
            }
        }

        return { provider, label: meta.label };
    }

    function openTransferModal(payload) {
        if (!transferCourseModal) return;

        resetTransferModalState();
        pendingTransferPayload = payload;

        const counts = getTransferSelectionCounts(payload.units || []);
        const summaryItems = [
            `New course name: ${payload.newCourseName}`,
            `AI platform: ${payload.llmProviderLabel}.`,
            `A new API key for ${payload.llmProviderLabel} will be validated before the copy is created.`,
            `${counts.docsCount} of ${counts.totalUnits} unit${counts.totalUnits === 1 ? '' : 's'} will copy docs and existing chunks.`,
            `${counts.objectivesCount} of ${counts.totalUnits} unit${counts.totalUnits === 1 ? '' : 's'} will copy learning objectives.`,
            `${counts.questionsCount} of ${counts.totalUnits} unit${counts.totalUnits === 1 ? '' : 's'} will copy assessment questions.`,
            'Approved course topics will be copied exactly as-is.',
            'All copied units will start unpublished in the new course.',
            payload.transferSettings ? 'Course settings will be copied.' : 'Course settings will not be copied.',
            payload.transferTAs ? 'TAs and their permissions will be copied.' : 'TAs will not be copied.',
            payload.deactivateSourceCourse ? 'The source course will be deactivated after the transfer finishes.' : 'The source course will stay active after the transfer.'
        ];

        if (transferModalDescription) {
            transferModalDescription.textContent = 'This can take a few minutes because selected materials and their stored chunks are copied into the new course.';
        }

        if (transferModalSummary) {
            transferModalSummary.innerHTML = '';
            summaryItems.forEach(item => {
                const listItem = document.createElement('li');
                listItem.textContent = item;
                transferModalSummary.appendChild(listItem);
            });
        }

        setTransferModalVisibility(true);
        window.a11yModal?.open(transferCourseModal, {
            dialogEl: transferCourseModal.querySelector('.transfer-modal'),
            onRequestClose: () => closeTransferModal(),
        });
    }

    function setTransferModalLoading(payload) {
        isTransferInProgress = true;

        // A course copy must finish atomically. Re-open through the shared
        // contract so Escape/backdrop attempts stay in the dialog and expose
        // an announced explanation rather than silently doing nothing.
        window.a11yModal?.open(transferCourseModal, {
            dialogEl: transferCourseModal.querySelector('.transfer-modal'),
            escapable: false,
            dismissalBlockedMessage: 'Course copy is in progress. Please keep this dialog open until it finishes.',
        });

        if (transferModalTitle) {
            transferModalTitle.textContent = 'Creating Course Copy...';
        }

        if (transferModalConfirmation) {
            transferModalConfirmation.hidden = true;
        }

        if (transferModalLoading) {
            transferModalLoading.hidden = false;
        }

        if (transferModalLoadingText) {
            transferModalLoadingText.textContent = `Creating "${payload.newCourseName}" now. Please keep this tab open while materials and stored chunks are copied.`;
        }

        if (transferModalCancelBtn) {
            transferModalCancelBtn.disabled = true;
            transferModalCancelBtn.hidden = true;
        }

        if (transferModalConfirmBtn) {
            transferModalConfirmBtn.disabled = true;
            transferModalConfirmBtn.textContent = 'Creating...';
        }
    }

    function renderTransferUnitGrid(lectures = []) {
        if (!transferUnitGrid) return;

        if (!Array.isArray(lectures) || lectures.length === 0) {
            transferUnitGrid.innerHTML = '<div class="transfer-unit-grid-empty">No units found for this course yet.</div>';
            syncTransferMasterToggles();
            return;
        }

        const header = `
            <div class="transfer-unit-grid-head">Unit</div>
            <div class="transfer-unit-grid-head">Docs + Chunks</div>
            <div class="transfer-unit-grid-head">Learning objectives</div>
            <div class="transfer-unit-grid-head">Questions</div>
        `;

        const rows = lectures.map(lecture => `
            <div class="transfer-unit-row" data-unit-name="${lecture.name}">
                <div class="transfer-unit-name">${lecture.displayName || lecture.name}</div>
                <label class="transfer-unit-checkbox">
                    <input type="checkbox" class="transfer-docs-checkbox" data-unit-name="${lecture.name}" checked>
                </label>
                <label class="transfer-unit-checkbox">
                    <input type="checkbox" class="transfer-objectives-checkbox" data-unit-name="${lecture.name}" checked>
                </label>
                <label class="transfer-unit-checkbox">
                    <input type="checkbox" class="transfer-questions-checkbox" data-unit-name="${lecture.name}" checked>
                </label>
            </div>
        `).join('');

        transferUnitGrid.innerHTML = `${header}${rows}`;
        syncTransferMasterToggles();
    }

    function renderCourseStatus() {
        const badge = document.getElementById('course-status-badge');
        const note = document.getElementById('course-status-note');
        if (!badge || !note || !toggleCourseActiveBtn || !lifecycleCourseData) return;

        const isInactive = lifecycleCourseData.status === 'inactive';
        badge.textContent = isInactive ? 'Inactive' : 'Active';
        badge.classList.toggle('inactive', isInactive);
        badge.classList.toggle('active', !isInactive);
        note.textContent = isInactive
            ? 'Students are currently blocked from this course. Instructors and TAs can still manage it.'
            : 'Students, instructors, and TAs can currently use this course.';
        toggleCourseActiveBtn.textContent = isInactive ? 'Reactivate Course' : 'Deactivate Course';
        toggleCourseActiveBtn.classList.toggle('danger-button', !isInactive);
        toggleCourseActiveBtn.classList.toggle('secondary-button', isInactive);
    }

    async function initializeCourseLifecycle() {
        const currentUser = typeof getCurrentUser === 'function' ? getCurrentUser() : null;
        const lifecycleTile = document.getElementById('lifecycle-tile');
        const lifecycleRailItem = document.getElementById('lifecycle-rail-item');
        if (!courseLifecycleSection) return;

        if (!currentUser || currentUser.role !== 'instructor') {
            courseLifecycleSection.style.display = 'none';
            if (lifecycleTile) lifecycleTile.hidden = true;
            if (lifecycleRailItem) lifecycleRailItem.hidden = true;
            renderSettingsView();
            return;
        }

        courseLifecycleSection.style.display = '';
        if (lifecycleTile) lifecycleTile.hidden = false;
        if (lifecycleRailItem) lifecycleRailItem.hidden = false;
        renderSettingsView();

        try {
            const courseId = await getCurrentCourseId();
            if (!courseId) {
                lifecycleCourseData = null;
                if (transferUnitGrid) {
                    transferUnitGrid.innerHTML = '<div class="transfer-unit-grid-empty">Select a course first to use transfer and deactivate tools.</div>';
                }
                if (toggleCourseActiveBtn) toggleCourseActiveBtn.disabled = true;
                if (transferCourseBtn) transferCourseBtn.disabled = true;
                return;
            }

            const response = await fetch(`/api/courses/${courseId}`);
            const result = await response.json();
            if (!response.ok || !result.success || !result.data) {
                throw new Error(result.message || 'Failed to load course lifecycle data');
            }

            lifecycleCourseData = result.data;
            renderCourseStatus();
            renderTransferUnitGrid(lifecycleCourseData.lectures || []);

            const transferProvider = lifecycleCourseData.llmProvider || 'openai';
            if (window.LlmPlatform) {
                window.LlmPlatform.setProvider('transfer', transferProvider);
            } else {
                const providerRadio = document.getElementById(`transfer-llm-provider-${transferProvider}`);
                if (providerRadio) providerRadio.checked = true;
            }
            refreshTransferProviderUi();

            if (transferCourseNameInput && !transferCourseNameInput.value.trim()) {
                transferCourseNameInput.value = `${lifecycleCourseData.name} Copy`;
            }

            if (toggleCourseActiveBtn) toggleCourseActiveBtn.disabled = false;
            if (transferCourseBtn) transferCourseBtn.disabled = false;
        } catch (error) {
            console.error('Error initializing course lifecycle section:', error);
            if (transferUnitGrid) {
                transferUnitGrid.innerHTML = '<div class="transfer-unit-grid-empty">Unable to load course transfer options right now.</div>';
            }
            if (toggleCourseActiveBtn) toggleCourseActiveBtn.disabled = true;
            if (transferCourseBtn) transferCourseBtn.disabled = true;
        }
    }

    if (transferAllDocsToggle) {
        transferAllDocsToggle.addEventListener('change', (event) => {
            document.querySelectorAll('.transfer-docs-checkbox').forEach(checkbox => {
                checkbox.checked = event.target.checked;
            });
            syncTransferMasterToggles();
        });
    }

    if (transferAllObjectivesToggle) {
        transferAllObjectivesToggle.addEventListener('change', (event) => {
            document.querySelectorAll('.transfer-objectives-checkbox').forEach(checkbox => {
                checkbox.checked = event.target.checked;
            });
            syncTransferMasterToggles();
        });
    }

    if (transferAllQuestionsToggle) {
        transferAllQuestionsToggle.addEventListener('change', (event) => {
            document.querySelectorAll('.transfer-questions-checkbox').forEach(checkbox => {
                checkbox.checked = event.target.checked;
            });
            syncTransferMasterToggles();
        });
    }

    if (transferUnitGrid) {
        transferUnitGrid.addEventListener('change', (event) => {
            if (!event.target.matches('input[type="checkbox"]')) return;
            syncTransferMasterToggles();
        });
    }

    document.querySelectorAll('input[name="transfer-llm-provider"]').forEach(radio => {
        radio.addEventListener('change', refreshTransferProviderUi);
    });
    refreshTransferProviderUi();

    if (transferCourseModal) {
        transferCourseModal.addEventListener('click', (event) => {
            if (event.target === transferCourseModal) {
                closeTransferModal();
            }
        });
    }

    if (transferModalCancelBtn) {
        transferModalCancelBtn.addEventListener('click', () => {
            closeTransferModal();
        });
    }

    if (transferModalConfirmBtn) {
        transferModalConfirmBtn.addEventListener('click', async () => {
            if (!pendingTransferPayload || isTransferInProgress) return;

            isTransferInProgress = true;
            setTransferModalLoading(pendingTransferPayload);

            transferCourseBtn.disabled = true;
            const previousLabel = transferCourseBtn.textContent;
            transferCourseBtn.textContent = 'Creating Copy...';

            try {
                const courseId = await getCurrentCourseId();
                const response = await fetch(`/api/courses/${courseId}/transfer`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        newCourseName: pendingTransferPayload.newCourseName,
                        llmProvider: pendingTransferPayload.llmProvider,
                        transferSettings: pendingTransferPayload.transferSettings,
                        transferTAs: pendingTransferPayload.transferTAs,
                        deactivateSourceCourse: pendingTransferPayload.deactivateSourceCourse,
                        apiKey: pendingTransferPayload.apiKey,
                        units: pendingTransferPayload.units
                    })
                });

                const result = await response.json();
                if (!response.ok || !result.success) {
                    throw new Error(result.message || 'Failed to transfer course');
                }

                const warnings = Array.isArray(result.data?.warnings) ? result.data.warnings : [];
                const preparationStarted = result.data?.preparation?.started === true;
                const providerLabel = result.data?.preparation?.providerLabel || 'AI';
                const copySummary = warnings.length > 0
                    ? `Course copy created with ${warnings.length} warning${warnings.length === 1 ? '' : 's'}.`
                    : 'Course copy created successfully.';
                const summary = preparationStarted
                    ? `${copySummary} ${providerLabel} material is being prepared in the background.`
                    : copySummary;

                sessionStorage.setItem('settingsFlashMessage', JSON.stringify({
                    message: `${summary} Switched to ${result.data.courseName}.`,
                    type: warnings.length > 0 || preparationStarted ? 'info' : 'success'
                }));

                localStorage.setItem('selectedCourseId', result.data.courseId);
                if (typeof setCurrentCourseId === 'function') {
                    await setCurrentCourseId(result.data.courseId);
                }

                closeTransferModal({ force: true });

                if (warnings.length > 0) {
                    alert(`${summary}\n\n${warnings.slice(0, 8).join('\n')}`);
                }

                window.location.href = `/instructor/settings?courseId=${encodeURIComponent(result.data.courseId)}`;
            } catch (error) {
                console.error('Error transferring course:', error);
                closeTransferModal({ force: true });
                showNotification(error.message || 'Failed to transfer course', 'error');
            } finally {
                transferCourseBtn.disabled = false;
                transferCourseBtn.textContent = previousLabel;
            }
        });
    }

    if (toggleCourseActiveBtn) {
        toggleCourseActiveBtn.addEventListener('click', async () => {
            if (!lifecycleCourseData) return;

            const isInactive = lifecycleCourseData.status === 'inactive';
            const nextStatus = isInactive ? 'active' : 'inactive';
            const confirmMessage = isInactive
                ? 'Reactivate this course so students can use it again?'
                : 'Deactivate this course? Students will be blocked until you reactivate it, but instructors and TAs will still be able to manage it.';

            if (!confirm(confirmMessage)) {
                return;
            }

            toggleCourseActiveBtn.disabled = true;
            const previousLabel = toggleCourseActiveBtn.textContent;
            toggleCourseActiveBtn.textContent = isInactive ? 'Reactivating...' : 'Deactivating...';

            try {
                const courseId = await getCurrentCourseId();
                const instructorId = getCurrentInstructorId();
                const response = await fetch(`/api/courses/${courseId}?instructorId=${encodeURIComponent(instructorId)}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        instructorId,
                        status: nextStatus
                    })
                });

                const result = await response.json();
                if (!response.ok || !result.success) {
                    throw new Error(result.message || 'Failed to update course status');
                }

                lifecycleCourseData.status = nextStatus;
                renderCourseStatus();
                showNotification(
                    nextStatus === 'inactive'
                        ? 'Course deactivated. Students are now blocked, but instructors and TAs still have access.'
                        : 'Course reactivated successfully.',
                    'success'
                );
            } catch (error) {
                console.error('Error updating course status:', error);
                showNotification(error.message || 'Failed to update course status', 'error');
            } finally {
                toggleCourseActiveBtn.disabled = false;
                if (toggleCourseActiveBtn.textContent === 'Reactivating...' || toggleCourseActiveBtn.textContent === 'Deactivating...') {
                    toggleCourseActiveBtn.textContent = previousLabel;
                }
                renderCourseStatus();
            }
        });
    }

    if (transferCourseBtn) {
        transferCourseBtn.addEventListener('click', async () => {
            if (!lifecycleCourseData) {
                showNotification('Course data is still loading. Please try again.', 'warning');
                return;
            }

            const newCourseName = transferCourseNameInput?.value?.trim() || '';
            if (!newCourseName) {
                showNotification('Please enter a name for the new course.', 'error');
                transferCourseNameInput?.focus();
                return;
            }

            const apiKey = transferCourseApiKeyInput?.value?.trim() || '';
            if (!apiKey) {
                const provider = refreshTransferProviderUi();
                showNotification(`Please enter the ${provider.label} API key for the new course.`, 'error');
                transferCourseApiKeyInput?.focus();
                return;
            }

            const transferProvider = refreshTransferProviderUi();

            const unitRows = Array.from(document.querySelectorAll('.transfer-unit-row'));
            const units = unitRows.map(row => {
                const unitName = row.getAttribute('data-unit-name');
                return {
                    unitName,
                    transferDocuments: row.querySelector('.transfer-docs-checkbox')?.checked !== false,
                    transferLearningObjectives: row.querySelector('.transfer-objectives-checkbox')?.checked !== false,
                    transferAssessmentQuestions: row.querySelector('.transfer-questions-checkbox')?.checked !== false
                };
            });

            const deactivateSourceCourse = document.getElementById('deactivate-source-after-transfer-toggle')?.checked === true;
            openTransferModal({
                newCourseName,
                transferSettings: document.getElementById('transfer-settings-toggle')?.checked === true,
                transferTAs: document.getElementById('transfer-tas-toggle')?.checked === true,
                deactivateSourceCourse,
                apiKey,
                llmProvider: transferProvider.provider,
                llmProviderLabel: transferProvider.label,
                units
            });
        });
    }

    /* =============================================
       Database management + system admin actions
       ============================================= */

    // Handle delete collection button click
    if (deleteCollectionBtn) {
        deleteCollectionBtn.addEventListener('click', async () => {
            // Show confirmation dialog
            const confirmed = confirm(
                'WARNING: This will permanently delete ALL BiocBot data!\n\n' +
                'This includes:\n' +
                '• Vector embeddings (Qdrant)\n' +
                '• Document metadata (MongoDB)\n' +
                '• Course information\n' +
                '• Questions and assessments\n' +
                '• Onboarding data\n\n' +
                'This action cannot be undone and will completely reset the system.\n\n' +
                'Are you absolutely sure you want to continue?'
            );

            if (!confirmed) {
                return;
            }

            try {
                // Disable button to prevent multiple clicks
                deleteCollectionBtn.disabled = true;
                deleteCollectionBtn.textContent = 'Deleting...';

                // Call API to delete all collections
                const response = await fetch('/api/qdrant/delete-all-collections', {
                    method: 'DELETE',
                    headers: {
                        'Content-Type': 'application/json'
                    }
                });

                const result = await response.json();

                if (result.success) {
                    showNotification(
                        `All data deleted successfully! Qdrant: ${result.data.qdrantDeletedCount}, MongoDB: ${result.data.mongoDeletedCount} documents removed.`,
                        'success'
                    );
                } else {
                    showNotification(
                        `Failed to delete data: ${result.message || 'Unknown error'}`,
                        'error'
                    );
                }

            } catch (error) {
                console.error('Error deleting data:', error);
                showNotification(
                    'Failed to delete data: Network or server error',
                    'error'
                );
            } finally {
                // Re-enable button
                deleteCollectionBtn.disabled = false;
                deleteCollectionBtn.textContent = 'Delete All Data';
            }
        });
    }

    if (grantSystemAdminBtn) {
        grantSystemAdminBtn.addEventListener('click', async () => {
            const email = systemAdminEmailInput ? systemAdminEmailInput.value.trim() : '';
            if (!email) {
                showNotification('Enter an email address first.', 'error');
                return;
            }

            grantSystemAdminBtn.disabled = true;
            grantSystemAdminBtn.textContent = 'Granting...';

            try {
                const response = await fetch('/api/settings/system-admins', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'include',
                    body: JSON.stringify({ email })
                });

                const result = await response.json();

                if (!result.success) {
                    showNotification(result.error || 'Failed to grant system admin access.', 'error');
                    return;
                }

                if (systemAdminEmailInput) {
                    systemAdminEmailInput.value = '';
                }

                await loadSystemAdmins();
                showNotification(`System admin access granted to ${email}.`, 'success');
            } catch (error) {
                console.error('Error granting system admin access:', error);
                showNotification('Failed to grant system admin access.', 'error');
            } finally {
                grantSystemAdminBtn.disabled = false;
                grantSystemAdminBtn.textContent = 'Grant Admin Access';
            }
        });
    }

    if (systemAdminList) {
        systemAdminList.addEventListener('click', async event => {
            const revokeButton = event.target.closest('.system-admin-revoke-btn');
            if (!revokeButton) {
                return;
            }

            const email = revokeButton.dataset.email;
            if (!email) {
                return;
            }

            if (!confirm(`Revoke system admin access for ${email}?`)) {
                return;
            }

            revokeButton.disabled = true;
            revokeButton.textContent = 'Revoking...';

            try {
                const response = await fetch('/api/settings/system-admins/revoke', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'include',
                    body: JSON.stringify({ email })
                });

                const result = await response.json();

                if (!result.success) {
                    showNotification(result.error || 'Failed to revoke system admin access.', 'error');
                    await loadSystemAdmins();
                    return;
                }

                await loadSystemAdmins();
                showNotification(`System admin access revoked for ${email}.`, 'success');
            } catch (error) {
                console.error('Error revoking system admin access:', error);
                showNotification('Failed to revoke system admin access.', 'error');
                await loadSystemAdmins();
            }
        });
    }

    /**
     * Check if the current user has system admin access.
     * Toggles the admin-only sections, hub tiles, and rail links.
     * Returns true if user has permission.
     */
    async function checkDeleteAllPermission() {
        const adminSectionIds = [
            'database-management-section',
            'login-restriction-section',
            'academic-api-section',
            'question-generation-section',
            'mental-health-detection-section',
            'system-admin-section',
            'llm-model-section',
            'sandbox-llm-model-section',
            'proxy-llm-model-section',
            'notes-llm-key-section',
            'instructor-superchat-llm-key-section'
        ];

        function setAdminVisibility(isAdmin) {
            adminSectionIds.forEach(id => {
                const section = document.getElementById(id);
                if (section) section.style.display = isAdmin ? '' : 'none';
            });
            const adminTileGroup = document.getElementById('admin-tile-group');
            const adminRailGroup = document.getElementById('admin-rail-group');
            if (adminTileGroup) adminTileGroup.hidden = !isAdmin;
            if (adminRailGroup) adminRailGroup.hidden = !isAdmin;
            if (isAdmin) setupScopedModelButtons();
            renderSettingsView();
        }

        try {
            const response = await fetch('/api/settings/can-delete-all', {
                credentials: 'include'
            });

            const result = await response.json();
            const isAdmin = !!(result.success && result.canDeleteAll);
            setAdminVisibility(isAdmin);
            return isAdmin;
        } catch (error) {
            console.error('Error checking delete all permission:', error);
            // On error, hide the sections for security
            setAdminVisibility(false);
            return false;
        }
    }
});
