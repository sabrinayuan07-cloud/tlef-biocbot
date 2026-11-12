/**
 * Student chat page boot script.
 *
 * The implementation lives in feature modules loaded before this file:
 *   student-state.js — shared page state (must load first)
 *   student-chat-core.js, student-practice.js, student-session.js,
 *   student-restore.js, student-course.js, student-calibration.js
 * All are classic scripts sharing the global scope. This file keeps the
 * top-level event listeners (the main DOMContentLoaded boot sequence and the
 * document click handler) in their original registration order.
 */

function initializeKeyboardControlActivation() {
    // The course picker is rendered after the page boots, so use delegation
    // rather than attaching listeners to only the controls present at load.
    document.addEventListener('keydown', event => {
        const control = event.target;
        if (!(control instanceof HTMLElement)) return;

        if (event.key === 'Escape') {
            const menu = control.closest('.flag-menu.show');
            if (menu) {
                event.preventDefault();
                menu.classList.remove('show');
                const flagButton = menu.previousElementSibling;
                if (flagButton instanceof HTMLButtonElement) {
                    flagButton.setAttribute('aria-expanded', 'false');
                    flagButton.focus();
                }
                return;
            }
        }

        if (control.matches('#course-select, #revoked-course-select, #unit-select')) {
            if (event.key !== 'Enter' && event.key !== ' ') return;

            // showPicker is the native, keyboard-friendly picker API. When it
            // is unavailable, leave the event alone so the browser's own
            // Space-key select behavior remains available.
            try {
                if (typeof control.showPicker === 'function') {
                    control.showPicker();
                    event.preventDefault();
                    return;
                }
            } catch (error) {
                // Use the browser's native select behavior below.
            }
            return;
        }

        if (control.id === 'mode-toggle-checkbox' && event.key === 'Enter') {
            // Checkboxes normally toggle with Space. Supporting Enter makes
            // this switch consistent with the selectors above.
            event.preventDefault();
            control.click();
        }
    });
}

document.addEventListener('DOMContentLoaded', async () => {
    initializeKeyboardControlActivation();

    // History navigation carries the selected chat in sessionStorage. Stage it
    // before the first awaited startup request so course/session initialization
    // cannot create a fresh assessment over the requested continuation.
    if (typeof stageHistoryChatDataForLoad === 'function') {
        stageHistoryChatDataForLoad();
    }

    try {
        const courseId = localStorage.getItem('selectedCourseId');
        if (courseId) {
            const resp = await fetch(`/api/courses/${courseId}/student-enrollment`, { credentials: 'include' });
            if (resp.ok) {
                const data = await resp.json();
                // Only show revoked UI if explicitly banned
                if (data && data.success && data.data && data.data.status === 'banned') {
                    renderRevokedAccessUI();
                    return; // stop further chat init
                }
            }
        }
    } catch (e) { console.warn('Enrollment check failed, proceeding:', e); }
    const chatForm = document.getElementById('chat-form');
    const chatInput = document.getElementById('chat-input');
    const chatMessages = document.getElementById('chat-messages');
    let currentController = null; // Controller for aborting in-flight requests
    let lastActiveStruggleTopic = null; // Track active struggle topic for the session

    window.addEventListener('chat-session:rotating', () => {
        if (currentController) {
            currentController.abort();
            currentController = null;
        }
        removeTypingIndicator();
    });

    // Guard: Only allow students on this page; redirect others immediately
    const handleRoleGuard = (user) => {
        if (!user) return; // auth.js will handle redirect if unauthenticated
        if (user.role === 'student') return;
        if (user.role === 'instructor') {
            window.location.href = '/instructor';
            return;
        }
        if (user.role === 'ta') {
            window.location.href = '/ta';
            return;
        }
        window.location.href = '/login';
    };

    // Perform role check as early as possible
    try {
        const existingUser = typeof getCurrentUser === 'function' ? getCurrentUser() : null;
        if (existingUser) {
            handleRoleGuard(existingUser);
        } else {
            document.addEventListener('auth:ready', (e) => handleRoleGuard(e.detail));
        }
    } catch (e) {
        // If anything goes wrong, rely on server-side protection
        console.warn('Student role guard failed softly:', e);
    }

    // Initialize chat


    // Wait for authentication to be ready before initializing auto-save
    const initializeAutoSaveWhenReady = async () => {

        await refreshChatSessionTimeoutForSelectedCourse(true);
        await initializeAutoSave();
        scheduleChatSessionExpiration();
        if (typeof window.updateChatSummaryButtonState === 'function') {
            window.updateChatSummaryButtonState();
        }

        // Check for auto-continue after authentication is ready
        // Add a small delay to ensure auto-save data is fully loaded
        setTimeout(() => {
            // Only check for auto-continue if we're NOT loading from history
            const isLoadingFromHistory = sessionStorage.getItem('loadChatData');
            const isAlreadyLoadingFromHistory = window.loadingFromHistory;

            if (!isLoadingFromHistory && !isAlreadyLoadingFromHistory) {

                const wasAutoContinued = checkForAutoContinue();

        if (wasAutoContinued) {

            // Set a flag to prevent assessment questions from loading
            window.autoContinued = true;

            // Load the current session data into the interface
            // Add a small delay to ensure DOM is fully ready
            setTimeout(() => {
                try {

                    loadCurrentSessionIntoInterface();
                } catch (error) {
                    console.error('🔄 [AUTO-CONTINUE] Error loading session into interface:', error);
                }
            }, 200);
        }
            } else {
                // console logs removed
            }
        }, 100);
    };

    // Check if auth is already ready
    if (getCurrentUser()) {

        await initializeAutoSaveWhenReady();
    } else {
        // Wait for auth:ready event
        document.addEventListener('auth:ready', initializeAutoSaveWhenReady);
    }

    // Add beforeunload event to ensure auto-save data is preserved and synced
    window.addEventListener('beforeunload', async () => {

        const chatData = getCurrentChatData();
        if (chatData && chatData.messages.length > 0) {
            await syncAutoSaveWithServer(chatData);
        }
    });

    // Load current course information and update UI
    loadCurrentCourseInfo();

    // Check if we're loading from history first
    const isLoadingFromHistory = sessionStorage.getItem('loadChatData');

    if (isLoadingFromHistory) {
        // console log removed
    }

    // Initialize mode toggle functionality
    initializeModeToggle();

    // Ensure mode toggle is properly set after a short delay (fallback for timing issues)
    setTimeout(() => {
        const currentMode = localStorage.getItem('studentMode') || 'tutor';

        updateModeToggleUI(currentMode);
    }, 200);

    // Set up periodic timestamp updates
    setInterval(updateTimestamps, 20000); // Update every 20 seconds

    // Initialize chat history storage
    initializeChatHistoryStorage();

    // Check for chat data to load from history (after DOM is ready)
    setTimeout(() => {
        checkForChatDataToLoad();
    }, 100);
    
    // Initialize Idle Timer
    initializeIdleTimer();

    // Initialize user agreement modal
    initializeUserAgreement();

    // Initialize new session button
    initializeNewSessionButton();

    // Expire stale chats when a student returns to a sleeping/background tab.
    initializeSessionReturnMonitor();

    // Initialize "View General Rules" link
    const viewRulesLink = document.getElementById('view-rules-link');
    if (viewRulesLink) {
        viewRulesLink.addEventListener('click', (e) => {
            e.preventDefault();
            if (window.agreementModal) {
                window.agreementModal.show(true); // true = read-only mode
            }
        });
    }

    /**
     * Format timestamp for display
     * @param {Date} timestamp - The timestamp to format
     * @returns {string} Formatted timestamp string
     */
    function formatTimestamp(timestamp) {
        const now = new Date();
        const diffMs = now - timestamp;
        const diffSeconds = Math.floor(diffMs / 1000);
        const diffMinutes = Math.floor(diffSeconds / 60);
        const diffHours = Math.floor(diffMinutes / 60);
        const diffDays = Math.floor(diffHours / 24);

        // Format based on how long ago
        if (diffSeconds < 60) {
            return 'Just now';
        } else if (diffMinutes < 60) {
            return `${diffMinutes} minute${diffMinutes !== 1 ? 's' : ''} ago`;
        } else if (diffHours < 24) {
            return `${diffHours} hour${diffHours !== 1 ? 's' : ''} ago`;
        } else if (diffDays < 7) {
            return `${diffDays} day${diffDays !== 1 ? 's' : ''} ago`;
        } else {
            // For older messages, show actual date
            return timestamp.toLocaleDateString('en-US', {
                month: 'short',
                day: 'numeric',
                hour: 'numeric',
                minute: '2-digit',
                hour12: true
            });
        }
    }

    /**
     * Update all timestamps to show relative time
     */
    function updateTimestamps() {
        const timestamps = document.querySelectorAll('.timestamp');
        timestamps.forEach(timestamp => {
            const messageDiv = timestamp.closest('.message');
            if (messageDiv && messageDiv.dataset.timestamp) {
                const messageTime = new Date(parseInt(messageDiv.dataset.timestamp));
                timestamp.textContent = formatTimestamp(messageTime);
            }
        });
    }

    /**
     * Update UI based on Struggle State
     * @param {Object} state - The struggle state object
     */
    function updateStruggleUI(state) {
        if (!state || !state.topics) return;

        const activeTopics = state.topics.filter(t => t.isActive);
        const modeToggleContainer = document.querySelector('.mode-toggle-container');
        let indicator = document.getElementById('directive-mode-indicator');

        if (activeTopics.length > 0) {
            if (!indicator) {
                indicator = document.createElement('div');
                indicator.id = 'directive-mode-indicator';
                indicator.className = 'directive-mode-badge';
                indicator.innerHTML = `
                    <span class="icon">⚠️</span>
                    <span>Directive Mode Active</span>
                `;
                indicator.title = `Directive Mode is active for: ${activeTopics.map(t => t.topic).join(', ')}`;
                
                // Add click handler to go to dashboard
                indicator.style.cursor = 'pointer';
                indicator.addEventListener('click', () => {
                    // Keep the marker a "View as Student" preview tab carries.
                    window.location.href = window.BiocBotPreview?.url('/student/dashboard.html')
                        || '/student/dashboard.html';
                });

                // Insert before mode toggle
                if (modeToggleContainer) {
                    modeToggleContainer.parentNode.insertBefore(indicator, modeToggleContainer);
                }
            }
        } else {
            if (indicator) {
                indicator.remove();
            }
        }
    }

    /**
     * Send message to LLM service
     * @param {string} message - The message to send
     * @param {boolean} checkSummaryAttempt - Whether to check for summary attempt
     * @param {AbortSignal} signal - Optional abort signal
     * @returns {Promise<Object>} Response from LLM service
     */
    async function sendMessageToLLM(message, checkSummaryAttempt = false, signal = null, isExplanationRequest = false, options = {}) {
        try {
            // Get current student mode for context
            const currentMode = localStorage.getItem('studentMode') || 'tutor';

            // Get course ID from localStorage (should be set after course selection)
            const courseId = localStorage.getItem('selectedCourseId');
            if (!courseId) {
                throw new Error('No course selected. Please select a course first.');
            }

            const unitName = localStorage.getItem('selectedUnitName') || getCurrentUnitName();

            // Check if we're continuing a chat and need to include conversation context.
            // Summary-seeded sessions intentionally send their first message without
            // prior context because the summary itself is the full context.
            const skipConversationContext = !!(options.skipConversationContext || window.skipConversationContextForNextMessage);
            if (window.skipConversationContextForNextMessage) {
                window.skipConversationContextForNextMessage = false;
            }
            const conversationContext = skipConversationContext ? null : getConversationContext();
            let conversationId = null;
            try {
                const chatData = typeof getCurrentChatData === 'function' ? getCurrentChatData() : null;
                if (chatData && typeof getCurrentSessionId === 'function') {
                    conversationId = getCurrentSessionId(chatData);
                }
            } catch (error) {
                console.warn('Could not resolve conversation id for chat request:', error);
            }

            // conversationContext retrieved or new conversation started


            const requestBody = {
                message: message,
                conversationId: conversationId,
                mode: currentMode,
                courseId: courseId,
                unitName: unitName,
                conversationContext: conversationContext,
                checkSummaryAttempt: checkSummaryAttempt,
                isExplanationRequest: isExplanationRequest,
                topic: isExplanationRequest && typeof isExplanationRequest === 'object' ? isExplanationRequest.topic : null
            };




            const fetchOptions = {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(requestBody)
            };

            if (signal) {
                fetchOptions.signal = signal;
            }

            const response = await fetch('/api/chat', fetchOptions);



            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.message || `HTTP error! status: ${response.status}`);
            }

            const data = await response.json();

            if (!data.success) {
                throw new Error(data.message || 'Failed to get response from LLM');
            }

            if (typeof window.applyLLMBodyTag === 'function') {
                await window.applyLLMBodyTag();
            }

            // Don't clear the continuing chat flags - we need them for the entire conversation
            // The flags will be cleared when starting a new chat session or explicitly clearing chat
            // This ensures the conversation context is maintained throughout the chat session

            return data;

        } catch (error) {
            console.error('Error sending message to LLM:', error);
            throw error;
        }
    }

    let isSummaryInProgress = false;
    const defaultSummaryTriggerMessageCount = 25;
    const summaryButtonDefaultText = 'Summarize & Start New Chat';
    const summaryConfirmationMessage = 'This will summarize the current chat, end this session, and start a new chat in the same unit and mode. The summary will be sent as your first message, and assessment questions will not carry over. Continue?';

    function isSummarizableChatMessage(message) {
        if (!message || typeof message !== 'object') return false;
        if (message.isSummarySeed === true) return false;
        if (message.messageType !== 'regular-chat') return false;
        if (message.type !== 'user' && message.type !== 'bot') return false;
        if (!message.content || typeof message.content !== 'string' || !message.content.trim()) return false;
        if (message.sourceAttribution && String(message.sourceAttribution.source || '').toLowerCase() === 'system') {
            return false;
        }
        return true;
    }

    function getSummarizableChatMessages() {
        try {
            const chatData = typeof getCurrentChatData === 'function' ? getCurrentChatData() : null;
            const messages = chatData && Array.isArray(chatData.messages) ? chatData.messages : [];
            return messages.filter(isSummarizableChatMessage);
        } catch (error) {
            console.warn('Could not read chat messages for summary:', error);
            return [];
        }
    }

    function setSummaryButtonLoading(isLoading) {
        const summaryButton = document.getElementById('chat-summary-btn');
        if (!summaryButton) return;

        isSummaryInProgress = isLoading;
        summaryButton.classList.toggle('is-loading', isLoading);
        summaryButton.disabled = true;
        summaryButton.textContent = isLoading ? 'Starting new chat...' : summaryButtonDefaultText;
    }

    async function updateChatSummaryButtonState() {
        const summaryButton = document.getElementById('chat-summary-btn');
        const summaryActions = document.getElementById('chat-summary-actions');
        if (!summaryButton || isSummaryInProgress) return;

        const messages = getSummarizableChatMessages();
        let triggerMessageCount = defaultSummaryTriggerMessageCount;
        if (typeof window.loadChatSurveySettingsForCourse === 'function') {
            const payload = await window.loadChatSurveySettingsForCourse();
            const configuredTrigger = Number(payload?.settings?.summaryTriggerMessageCount);
            if (Number.isInteger(configuredTrigger)) {
                triggerMessageCount = configuredTrigger;
            }
        }

        const thresholdReached = messages.length >= triggerMessageCount;
        if (summaryActions) summaryActions.hidden = !thresholdReached;
        if (!thresholdReached) {
            summaryButton.disabled = true;
            summaryButton.textContent = summaryButtonDefaultText;
            summaryButton.title = `Available after ${triggerMessageCount} student and BiocBot messages`;
            return;
        }

        const hasStudentMessage = messages.some(message => message.type === 'user');
        const hasBotMessage = messages.some(message => message.type === 'bot');
        const responseInProgress = !!currentController || !!document.getElementById('typing-indicator');
        const canSummarize = hasStudentMessage && hasBotMessage && !window.noPublishedUnits && !responseInProgress;

        summaryButton.disabled = !canSummarize;
        summaryButton.textContent = summaryButtonDefaultText;
        summaryButton.title = canSummarize
            ? 'Summarize this chat, end this session, and start a new same-unit chat'
            : 'Wait for BiocBot to finish responding before summarizing this chat';
    }

    window.updateChatSummaryButtonState = updateChatSummaryButtonState;

    function resetAssessmentStateForSummarySession() {
        currentCalibrationQuestions = [];
        window.currentCalibrationQuestions = currentCalibrationQuestions;
        currentQuestionIndex = 0;
        currentPassThreshold = 0;
        window.currentPassThreshold = currentPassThreshold;
        studentAnswers = [];
        window.studentAnswers = studentAnswers;
        window.studentEvaluations = [];
        window.currentAssessmentScore = null;
    }

    function createFreshSummarySession(courseId, unitName) {
        const studentId = getCurrentStudentId();
        if (!studentId || !courseId || !unitName) return null;

        const sessionKey = `biocbot_session_${studentId}_${courseId}_${unitName}`;
        const sessionId = `autosave_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        localStorage.setItem(sessionKey, sessionId);
        return sessionId;
    }

    async function requestChatSummary(messages, courseId, unitName, mode) {
        const response = await fetch('/api/chat/summary', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                courseId,
                unitName,
                mode,
                messages
            })
        });

        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.success) {
            throw new Error(data.message || `Summary request failed with status ${response.status}`);
        }

        const summary = String(data.summary || data.message || '').trim();
        if (!summary) {
            throw new Error('Summary response was empty');
        }

        return summary;
    }

    async function handleChatSummaryContinue() {
        if (isSummaryInProgress) return;
        if (currentController || document.getElementById('typing-indicator')) {
            updateChatSummaryButtonState();
            return;
        }

        const courseId = localStorage.getItem('selectedCourseId');
        const unitName = localStorage.getItem('selectedUnitName') || getCurrentUnitName();
        const mode = localStorage.getItem('studentMode') || 'tutor';
        const messages = getSummarizableChatMessages();
        const hasStudentMessage = messages.some(message => message.type === 'user');
        const hasBotMessage = messages.some(message => message.type === 'bot');

        if (!courseId || !unitName || !hasStudentMessage || !hasBotMessage) {
            updateChatSummaryButtonState();
            return;
        }

        if (!window.confirm(summaryConfirmationMessage)) {
            updateChatSummaryButtonState();
            return;
        }

        setSummaryButtonLoading(true);

        try {
            const summary = await requestChatSummary(messages, courseId, unitName, mode);
            const courseName = localStorage.getItem('selectedCourseName');

            // The summary belongs to a fresh session, so record the successful
            // button action on the old session before its local state is cleared.
            const previousChatData = getCurrentChatData();
            if (previousChatData) {
                recordChatActionEvent(previousChatData, 'summarize_button');
                syncAutoSaveWithServer(previousChatData);
            }

            clearCurrentChatData();
            resetAssessmentStateForSummarySession();
            sessionStorage.removeItem('isContinuingChat');
            sessionStorage.removeItem('loadedChatData');
            sessionStorage.removeItem('loadChatData');

            localStorage.setItem('selectedCourseId', courseId);
            localStorage.setItem('selectedUnitName', unitName);
            localStorage.setItem('studentMode', mode);
            if (courseName) {
                localStorage.setItem('selectedCourseName', courseName);
            }

            createFreshSummarySession(courseId, unitName);
            window.autoContinued = false;
            window.loadingFromHistory = false;
            window.noPublishedUnits = false;

            const chatMessagesElement = document.getElementById('chat-messages');
            if (chatMessagesElement) {
                chatMessagesElement.innerHTML = '';
            }

            enableChatInput();
            const modeToggleContainer = document.querySelector('.mode-toggle-container');
            if (modeToggleContainer) {
                modeToggleContainer.style.display = 'flex';
            }
            updateModeToggleUI(mode);

            setSummaryButtonLoading(false);
            updateChatSummaryButtonState();

            window.skipConversationContextForNextMessage = true;
            window.summarySeedForNextUserMessage = true;
            chatInput.value = summary;
            chatForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        } catch (error) {
            console.error('Error summarizing chat:', error);
            setSummaryButtonLoading(false);
            updateChatSummaryButtonState();
            addMessage('Sorry, I could not summarize this chat. Please try again.', 'bot', false, true, null);
        }
    }

    function initializeChatSummaryButton() {
        const summaryButton = document.getElementById('chat-summary-btn');
        if (!summaryButton) return;

        summaryButton.addEventListener('click', handleChatSummaryContinue);
        document.addEventListener('auth:ready', () => setTimeout(updateChatSummaryButtonState, 0));
        updateChatSummaryButtonState();
        setTimeout(updateChatSummaryButtonState, 500);
        setTimeout(updateChatSummaryButtonState, 1500);
        setTimeout(updateChatSummaryButtonState, 3000);
    }

    // Initialize chat summary continuation button after its state is defined.
    initializeChatSummaryButton();

    // Maximum number of regular-chat messages (user + bot combined) before session is capped
    const MAX_MESSAGES = 40;

    /**
     * Check if the 15-message warning has already been shown
     * @returns {boolean} True if warning was already shown
     */
    function hasWarningBeenShown() {
        try {
            const chatData = getCurrentChatData();
            if (!chatData || !chatData.messages || chatData.messages.length === 0) {
                return false;
            }

            // Check if any bot message contains the warning text
            const warningText = 'Please be aware that after 15 messages, the quality of the responses might be degraded.';
            return chatData.messages.some(msg =>
                msg.type === 'bot' &&
                msg.content &&
                msg.content.includes(warningText.substring(0, 50)) // Check first 50 chars to avoid exact match issues
            );
        } catch (error) {
            console.error('Error checking if warning was shown:', error);
            return false;
        }
    }

    /**
     * Check if the 25-message warning has already been shown
     * @returns {boolean} True if warning was already shown
     */
    function hasWarning25BeenShown() {
        try {
            const chatData = getCurrentChatData();
            if (!chatData || !chatData.messages || chatData.messages.length === 0) {
                return false;
            }
            const warningText = 'You\'ve reached 25 messages. We recommend starting a new session';
            return chatData.messages.some(msg =>
                msg.type === 'bot' &&
                msg.content &&
                msg.content.includes(warningText.substring(0, 50))
            );
        } catch (error) {
            console.error('Error checking if 25-message warning was shown:', error);
            return false;
        }
    }

    /**
     * Check if the 35-message warning has already been shown
     * @returns {boolean} True if warning was already shown
     */
    function hasWarning35BeenShown() {
        try {
            const chatData = getCurrentChatData();
            if (!chatData || !chatData.messages || chatData.messages.length === 0) {
                return false;
            }
            const warningText = 'In 5 messages, this session will automatically close';
            return chatData.messages.some(msg =>
                msg.type === 'bot' &&
                msg.content &&
                msg.content.includes(warningText.substring(0, 50))
            );
        } catch (error) {
            console.error('Error checking if 35-message warning was shown:', error);
            return false;
        }
    }

    /**
     * Check if the session has been capped (40 messages reached)
     * @returns {boolean} True if session is capped
     */
    function isSessionCapped() {
        const count = countMessagesFromFirstStudent();
        return count >= MAX_MESSAGES;
    }

    /**
     * Disable chat input because the session has reached the message cap
     */
    function disableChatInputForCap() {
        const chatInput = document.getElementById('chat-input');
        if (chatInput) {
            chatInput.disabled = true;
            chatInput.placeholder = 'This session has reached the 40-message limit. Please start a new session.';
            chatInput.classList.add('disabled-input');
            chatInput.style.cursor = 'not-allowed';
        }
        const sendButton = document.getElementById('send-button');
        if (sendButton) {
            sendButton.disabled = true;
            sendButton.classList.add('disabled-button');
            sendButton.style.cursor = 'not-allowed';
            sendButton.style.opacity = '0.5';
        }
    }

    /**
     * Check if the Protege Effect prompt has already been shown
     * @returns {boolean} True if prompt was already shown
     */
    function hasProtegePromptShown() {
        try {
            const chatData = getCurrentChatData();
            if (!chatData || !chatData.messages || chatData.messages.length === 0) {
                return false;
            }

            // Check if any bot message contains the prompt text
            const promptText = 'Do you want to try and explain our chat above to me?';
            return chatData.messages.some(msg =>
                msg.type === 'bot' &&
                msg.content &&
                msg.content.includes(promptText)
            );
        } catch (error) {
            console.error('Error checking if protege prompt was shown:', error);
            return false;
        }
    }

    /**
     * Count messages starting from the first student message
     * Only counts regular-chat messages (user and bot)
     * @returns {number} Count of messages from first student message
     */
    function countMessagesFromFirstStudent() {
        try {
            const chatData = getCurrentChatData();
            if (!chatData || !chatData.messages || chatData.messages.length === 0) {

                return 0;
            }



            // Find the index of the first user message
            const firstUserMessageIndex = chatData.messages.findIndex(msg =>
                msg.type === 'user' && msg.messageType === 'regular-chat'
            );

            // If no user message found, return 0
            if (firstUserMessageIndex === -1) {

                return 0;
            }



            // Count all regular-chat messages (user and bot) from the first user message onwards
            const messagesFromFirstStudent = chatData.messages.slice(firstUserMessageIndex).filter(msg =>
                (msg.type === 'user' || msg.type === 'bot') && msg.messageType === 'regular-chat'
            );



            return messagesFromFirstStudent.length;
        } catch (error) {
            console.error('Error counting messages from first student:', error);
            return 0;
        }
    }

    /**
     * Get conversation context for continuing a chat
     * @returns {Object|null} Conversation context or null if not continuing a chat
     */
    function getConversationContext() {


        // Check if we're continuing a chat (this flag is set when loading chat data)
        const isContinuingChat = sessionStorage.getItem('isContinuingChat') === 'true';


        // Always get the latest chat data from localStorage to ensure we have the most recent messages
        // The sessionStorage might be stale if messages were added after loading
        const currentChatData = getCurrentChatData();
        let loadedChatData = null;

        if (currentChatData && currentChatData.messages && currentChatData.messages.length > 0) {

            // Always use the latest data from localStorage
            loadedChatData = JSON.stringify(currentChatData);
            // Update sessionStorage with the latest data
            sessionStorage.setItem('isContinuingChat', 'true');
            sessionStorage.setItem('loadedChatData', loadedChatData);
        } else {
            // Fallback: try sessionStorage if localStorage is empty
            loadedChatData = sessionStorage.getItem('loadedChatData');
            if (!loadedChatData) {
                // No chat data found
            }
        }

        if (!loadedChatData) {

            return null;
        }



        try {
            const chatData = JSON.parse(loadedChatData);

            // Verify session ID matches - only use context if we're in the same session
            const currentChatData = getCurrentChatData();
            let currentSessionId = null;
            if (currentChatData && currentChatData.sessionInfo && currentChatData.sessionInfo.sessionId) {
                currentSessionId = currentChatData.sessionInfo.sessionId;
            }

            const loadedSessionId = chatData.sessionInfo && chatData.sessionInfo.sessionId
                ? chatData.sessionInfo.sessionId
                : null;



            // If we have a current session ID, verify it matches the loaded session ID
            if (currentSessionId && loadedSessionId && currentSessionId !== loadedSessionId) {
                // This is a new session - clearing old context and returning null
                // Clear the old context flags since they're from a different session
                sessionStorage.removeItem('isContinuingChat');
                sessionStorage.removeItem('loadedChatData');
                return null;
            }

            // If current session has no ID but loaded does, it means we're starting fresh
            // Don't use old session context - new sessions should not reference old conversations
            if (!currentSessionId && loadedSessionId) {
                sessionStorage.removeItem('isContinuingChat');
                sessionStorage.removeItem('loadedChatData');
                return null;
            }



            const currentMode = localStorage.getItem('studentMode') || 'tutor';
            const unitName = localStorage.getItem('selectedUnitName') || 'this unit';

            // Build structured conversation context
            const conversationMessages = [];

            // 1) System prompt (handled by the API)

            // 2) Hardcoded assistant response with learning objectives and test questions
            let assistantResponse = `I'm BiocBot in ${currentMode === 'protege' ? 'Protégé' : 'Tutor'} Mode. We're discussing ${unitName} this week.`;

            if (chatData.practiceTests && chatData.practiceTests.questions.length > 0) {
                assistantResponse += ` How did you get on with the test questions?`;
            } else {
                assistantResponse += ` How can I help you today?`;
            }

            conversationMessages.push({
                role: 'assistant',
                content: assistantResponse
            });

            // 3) Hardcoded student response with test answers (if practice test exists)
            if (chatData.practiceTests && chatData.practiceTests.questions.length > 0 &&
                chatData.studentAnswers && chatData.studentAnswers.answers.length > 0) {

                let studentResponse = `Here's my responses to those:\n\n`;
                chatData.studentAnswers.answers.forEach((answer, index) => {
                    const question = chatData.practiceTests.questions[index];
                    if (question) {
                        studentResponse += `${index + 1}. ${question.question}\n`;
                        studentResponse += `   My Answer: ${answer.answer}\n`;
                        studentResponse += `   Correct: ${question.correctAnswer}\n`;
                        const result = chatData.assessmentScore?.results?.[index]
                            ?? chatData.practiceTests.score?.results?.[index];
                        studentResponse += `   Result: ${(result?.isCorrect ?? question.isCorrect ?? answer.isCorrect) ? 'Correct' : 'Incorrect'}\n\n`;
                    }
                });

                conversationMessages.push({
                    role: 'user',
                    content: studentResponse
                });

                // 4) Hardcoded assistant response acknowledging the test
                // Calculate overall performance
                const restoredScore = chatData.assessmentScore ?? chatData.practiceTests.score
                    ?? AssessmentScoring.evaluateAssessment(
                        chatData.practiceTests.questions,
                        chatData.studentAnswers.answers.map(answer => answer.answer),
                        chatData.practiceTests.passThreshold
                    );
                conversationMessages.push({
                    role: 'assistant',
                    content: `Thank you for that. Based on your responses, I can see you ${restoredScore.passed ? 'demonstrated good understanding' : 'need some additional support'}. So how can I help you today?`
                });
            }

            // 5) Add the actual conversation history from the previous chat
            if (chatData.messages && chatData.messages.length > 0) {
                // Filter out system messages and only include actual conversation
                const regularChatMessages = chatData.messages.filter(msg =>
                    msg.messageType === 'regular-chat' &&
                    (msg.type === 'user' || msg.type === 'bot')
                );



                // Add the conversation history
                regularChatMessages.forEach((msg, index) => {
                    conversationMessages.push({
                        role: msg.type === 'user' ? 'user' : 'assistant',
                        content: msg.content
                    });
                    // Log first few messages for debugging

                });

                // Log last few messages with full content for debugging
                if (regularChatMessages.length > 3) {
                    const lastFew = regularChatMessages.slice(-3);
                    lastFew.forEach((msg, idx) => {
                        const actualIdx = regularChatMessages.length - 3 + idx;
                        console.log(`🔄 [CONTEXT] Message ${actualIdx + 1}:`, msg.type, '-', msg.content.substring(0, 100) + (msg.content.length > 100 ? '...' : ''));
                        // Log full content for hero-related messages to debug
                        if (msg.content.toLowerCase().includes('hero') || msg.content.toLowerCase().includes('batman')) {
                            console.log(`🔄 [CONTEXT] FULL CONTENT for message ${actualIdx + 1}:`, msg.content);
                        }
                    });
                }

                // Also search through all messages for hero-related content to verify it's included
                const heroMessages = regularChatMessages.filter(msg =>
                    msg.content.toLowerCase().includes('hero') ||
                    msg.content.toLowerCase().includes('batman') ||
                    msg.content.toLowerCase().includes('favorite')
                );

            }



            return {
                conversationMessages: conversationMessages,
                mode: currentMode,
                hasPracticeTest: !!(chatData.practiceTests && chatData.practiceTests.questions.length > 0)
            };

        } catch (error) {
            console.error('Error building conversation context:', error);
            return null;
        }
    }

    // Handle chat form submission
    if (chatForm) {
        chatForm.addEventListener('submit', async (e) => {
            e.preventDefault();

            // Cancel any previous in-flight request
            if (currentController) {
                currentController.abort();
                currentController = null;
            }

            // Create new controller for this request
            currentController = new AbortController();
            const signal = currentController.signal;

            // Prevent chat if no published units are available
            if (window.noPublishedUnits) {

                return;
            }

            const message = chatInput.value.trim();
            if (!message) return;

            // A visible/focused page may not emit focus or visibility events.
            // Enforce the full session rotation before accepting the next message.
            if (await checkForExpiredSessionOnReturn()) {
                return;
            }

            // Check message count BEFORE adding the user message
            const messageCountBefore = countMessagesFromFirstStudent();

            // Block input if session is already capped
            if (messageCountBefore >= MAX_MESSAGES) {
                disableChatInputForCap();
                return;
            }

            // Determine which warnings to show
            const warningAlreadyShown = hasWarningBeenShown();
            const shouldShowWarning15 = !warningAlreadyShown && (messageCountBefore === 13 || messageCountBefore === 14);

            const warning25AlreadyShown = hasWarning25BeenShown();
            const shouldShowWarning25 = !warning25AlreadyShown && (messageCountBefore === 23 || messageCountBefore === 24);

            const warning35AlreadyShown = hasWarning35BeenShown();
            const shouldShowWarning35 = !warning35AlreadyShown && (messageCountBefore === 33 || messageCountBefore === 34);

            // Check if this is the 15th message to trigger summary check on backend
            const shouldCheckSummaryAttempt = !warningAlreadyShown && messageCountBefore === 14;

            // Add user message to chat
            addMessage(message, 'user');

            // Clear input
            chatInput.value = '';

            const systemSource = {
                source: 'System',
                description: 'System notification',
                unitName: null,
                documentType: null
            };

            // Show 15-message warning if needed
            if (shouldShowWarning15) {
                addMessage('Please be aware that after 15 messages, the quality of the responses might be degraded. <a href="#" class="chat-limit-link">See why?</a>', 'bot', true, false, systemSource, true);
            }

            // Show 25-message warning if needed
            if (shouldShowWarning25) {
                addMessage('You\'ve reached 25 messages. We recommend starting a new session for better response quality. <a href="#" class="chat-limit-link">See why?</a>', 'bot', true, false, systemSource, true);
            }

            // Show 35-message warning if needed
            if (shouldShowWarning35) {
                addMessage('In 5 messages, this session will automatically close. Please wrap up your current discussion or start a new session. <a href="#" class="chat-limit-link">See why?</a>', 'bot', true, false, systemSource, true);
            }

            // Check if the bot response would hit or exceed the cap
            // messageCountBefore + 1 (user msg) + warnings + 1 (bot response)
            const currentCountAfterUser = countMessagesFromFirstStudent();
            const willHitCap = (currentCountAfterUser + 1) >= MAX_MESSAGES; // +1 for the upcoming bot response

            // Show typing indicator
            showTypingIndicator();

            // Send message to real LLM service
            try {
                // If we need to check for summary attempt, pass that flag to the backend
                if (shouldCheckSummaryAttempt) {

                }
                
                const response = await sendMessageToLLM(message, shouldCheckSummaryAttempt, signal);

                // Request completed successfully
                currentController = null;

                // Remove typing indicator
                removeTypingIndicator();

                // Add real bot response
                // Add real bot response




                // Check if we should append the Protege prompt
                const currentMode = localStorage.getItem('studentMode') || 'tutor';
                const isTutorMode = currentMode === 'tutor';
                const promptAlreadyShown = hasProtegePromptShown();
                
                // We initially check messageCountBefore (e.g. 12).
                // User adds message -> Total messages = 13 (assuming 1-based index or however countMessagesFromFirstStudent works).
                // If countMessagesFromFirstStudent returns the count of HISTORY, and we just added a user message:
                // If history was 12. New count is 13.
                // The bot response will be the 14th message.
                // So we want to trigger when `messageCountBefore` is 12 (or 13 to be safe).
                const shouldShowProtegePrompt = !promptAlreadyShown && isTutorMode && (messageCountBefore === 12 || messageCountBefore === 13);
                
                if (shouldShowProtegePrompt) {
                     response.message += '\n\n----------------\nDo you want to try and explain our chat above to me?';
                }

                if (response.struggleDebug) {
                    console.log('🕵️ [FRONTEND_DEBUG_V2] Backend Debug Info:', response.struggleDebug);
                }

                // Update Struggle UI if available
                if (response.struggleState) {
                    console.log('🕵️ [FRONTEND_DEBUG] Struggle State received:', response.struggleState);
                    updateStruggleUI(response.struggleState);
                    
                    // Check for active struggle topic to pass to addMessage
                    let activeTopic = null;
                    if (response.struggleState.topics && Array.isArray(response.struggleState.topics)) {
                        activeTopic = response.struggleState.topics.find(t => t.isActive);
                    } else if (response.struggleState.topic && response.struggleState.isActive) {
                        activeTopic = response.struggleState;
                    }

                    if (activeTopic) {
                        lastActiveStruggleTopic = activeTopic.topic;
                    } else {
                        // If we received a state where isActive is explicitly false, clear the topic
                        if (response.struggleState.isActive === false) {
                            lastActiveStruggleTopic = null;
                        } else if (response.struggleState.topics) {
                            // If we have a topics array and none are active, clear it
                            const anyActive = response.struggleState.topics.some(t => t.isActive);
                            if (!anyActive) lastActiveStruggleTopic = null;
                        }
                    }
                } else {
                    console.log('🕵️ [FRONTEND_DEBUG] No struggle state in response');
                }

                // Extract detected topic (even if not active yet) for "Explain" button
                // Priority: active topic -> latest detected topic in state -> simple topic string if passed (unlikely)
                let detectedTopic = null;
                if (response.struggleState) {
                    // 1. Try to find the topic that was just analyzed/updated
                    if (response.struggleDebug && response.struggleDebug.identifiedTopic) {
                        detectedTopic = response.struggleDebug.identifiedTopic;
                    } 
                    // 2. Fallback to extracting from topics array if active
                    else if (response.struggleState.topics && response.struggleState.topics.length > 0) {
                        // We might want the most recently updated one, but for now let's use the active one if any
                        const active = response.struggleState.topics.find(t => t.isActive);
                        if (active) detectedTopic = active.topic;
                    }
                    // 3. Simple topic property if it exists at top level (depends on backend structure)
                    else if (response.struggleState.topic) {
                        detectedTopic = response.struggleState.topic;
                    }
                }

                // If this bot response will hit the cap, append the session-closed notice
                if (willHitCap) {
                    response.message += '\n\n----------------\nThis chat session has been exhausted. Please start a new session to continue.';
                }

                // Only show "I understand X now" button when directive mode is active for this response
                const showStruggleReset = response.struggleDebug?.directiveModeActive ? lastActiveStruggleTopic : null;
                addMessage(response.message, 'bot', true, false, response.sourceAttribution, false, showStruggleReset, detectedTopic, response.messageId, null, { animate: true });
                if (typeof maybeShowChatSurvey === 'function') {
                    maybeShowChatSurvey();
                }

                // Disable chat input if session is now capped
                if (willHitCap) {
                    disableChatInputForCap();
                }

            } catch (error) {
                // Remove typing indicator
                removeTypingIndicator();

                if (error.name === 'AbortError') {
                    // Request was aborted by user starting a new message
                    addMessage('You have stopped this response', 'bot', false, true, null);
                    // Don't log error or show generic error message
                    return;
                }

                // Show error message
                console.error('Chat error:', error);

                addMessage('Sorry, I encountered an error processing your message. Please try again.', 'bot', false, true, null);
            }
        });
    }

    // Note: addMessage function is defined globally below with auto-save functionality

    // Function to show typing indicator
    function showTypingIndicator() {
        const typingDiv = document.createElement('div');
        typingDiv.classList.add('message', 'bot-message', 'typing-indicator');
        typingDiv.id = 'typing-indicator';

        const avatarDiv = document.createElement('div');
        avatarDiv.classList.add('message-avatar');
        avatarDiv.textContent = 'B';

        const dotsDiv = document.createElement('div');
        dotsDiv.classList.add('dots');

        for (let i = 0; i < 3; i++) {
            const dot = document.createElement('div');
            dot.classList.add('dot');
            dotsDiv.appendChild(dot);
        }

        typingDiv.appendChild(avatarDiv);
        typingDiv.appendChild(dotsDiv);

        chatMessages.appendChild(typingDiv);
        applyCurrentLLMTagClasses(typingDiv);

        // Lock the chat controls while we wait — prevents the student from
        // submitting another message before the prior LLM round-trip returns.
        const chatInput = document.getElementById('chat-input');
        if (chatInput) chatInput.disabled = true;
        const sendButton = document.getElementById('send-button');
        if (sendButton) sendButton.disabled = true;

        // Scroll to bottom
        chatMessages.scrollTop = chatMessages.scrollHeight;
    }

    // Function to remove typing indicator
    function removeTypingIndicator() {
        const typingIndicator = document.getElementById('typing-indicator');
        if (typingIndicator) {
            typingIndicator.remove();
        }
        // Restore the chat controls only when no other "permanent" disable
        // (cap reached, no published units) is in effect. Those paths add a
        // disabled-input/disabled-button class which we check for here.
        const chatInput = document.getElementById('chat-input');
        if (chatInput && !chatInput.classList.contains('disabled-input')) {
            chatInput.disabled = false;
        }
        const sendButton = document.getElementById('send-button');
        if (sendButton && !sendButton.classList.contains('disabled-button')) {
            sendButton.disabled = false;
        }
    }

    // Initialize Chat Limit Modal
    initializeChatLimitModal();

    // Expose functions to global scope for helper actions
    window.sendMessageToLLM = sendMessageToLLM;
    window.showTypingIndicator = showTypingIndicator;
    window.removeTypingIndicator = removeTypingIndicator;
});

// Close flag menus when clicking outside
document.addEventListener('click', function(event) {
    if (!event.target.closest('.message-flag-container')) {
        const openMenus = document.querySelectorAll('.flag-menu.show');
        openMenus.forEach(menu => {
            menu.classList.remove('show');
            const flagButton = menu.previousElementSibling;
            if (flagButton instanceof HTMLButtonElement) {
                flagButton.setAttribute('aria-expanded', 'false');
            }
        });
    }
});
