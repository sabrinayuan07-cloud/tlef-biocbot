/**
 * Student chat: message rendering, source attribution, flagging, chat-limit
 * modal, and revoked-access UI.
 */

/**
 * Initialize Chat Limit Modal functionality
 */
function initializeChatLimitModal() {
    // Event delegation for the "See why?" link
    document.addEventListener('click', (e) => {
        if (e.target && e.target.classList.contains('chat-limit-link')) {
            e.preventDefault();
            showChatLimitModal();
        }
    });

    // Event delegation for closing the modal
    document.addEventListener('click', (e) => {
        if (e.target) {
             // Close button
            if (e.target.id === 'close-info-modal-btn' || e.target.closest('#close-info-modal-btn')) {
                hideChatLimitModal();
            }
            // Overlay click (background)
            if (e.target.id === 'chat-limit-modal-overlay') {
                hideChatLimitModal();
            }
        }
    });
}

/**
 * Show the chat limit info modal
 * Creates it if it doesn't exist
 */
function showChatLimitModal() {
    let overlay = document.getElementById('chat-limit-modal-overlay');
    
    if (!overlay) {
        // Create modal structure
        overlay = document.createElement('div');
        overlay.id = 'chat-limit-modal-overlay';
        overlay.className = 'info-modal-overlay';
        
        overlay.innerHTML = `
            <div class="info-modal" role="dialog" aria-modal="true" aria-labelledby="limit-modal-title">
                <div class="info-modal-header">
                    <h2 id="limit-modal-title">Why the message limit?</h2>
                </div>
                
                <div class="info-modal-body" tabindex="0" role="region" aria-label="Why the message limit">
                    <div class="info-section">
                        <p>We recommend starting a new session after about 15 messages for a few key reasons:</p>
                        
                        <h3>1. Response Quality</h3>
                        <p>As conversations get longer, the AI has to process much more information for every answer. This can sometimes cause it to "lose focus" or provide less accurate responses to your specific questions.</p>
                        
                        <h3>2. Staying on Topic</h3>
                        <p>Starting a fresh session helps keep the conversation focused on your current learning objectives. It's often cleaner to separate different topics into different sessions.</p>
                        
                        <h3>3. Best Practices</h3>
                        <ul>
                            <li><strong>New Topic = New Session:</strong> If you're switching to a completely different concept, start a new chat.</li>
                            <li><strong>Summarize First:</strong> Before leaving a long chat, ask BiocBot to "summarize what we discussed" so you can copy the key points to your notes!</li>
                            <li><strong>Check Your Understanding:</strong> Use the "Protégé Mode" to explain concepts back to BiocBot to solidify your learning.</li>
                        </ul>
                    </div>
                </div>
                
                <div class="info-modal-footer">
                    <button type="button" class="info-modal-btn" id="close-info-modal-btn">
                        Got it
                    </button>
                </div>
            </div>
        `;
        
        document.body.appendChild(overlay);
    }
    
    // Show modal
    overlay.classList.add('show');
    document.body.style.overflow = 'hidden'; // Prevent background scrolling
}

/**
 * Hide the chat limit info modal
 */
function hideChatLimitModal() {
    const overlay = document.getElementById('chat-limit-modal-overlay');
    if (overlay) {
        overlay.classList.remove('show');
        document.body.style.overflow = ''; // Restore scrolling
    }
}

function renderRevokedAccessUI() {
    try {
        // Only hide the chat body, keep the header (where course selector may live)
        const chatContainer = document.querySelector('.chat-container');
        if (chatContainer) {
            chatContainer.style.display = 'none';
        }

        // Insert warning below header
        const header = document.querySelector('.chat-header');
        if (header && header.parentElement) {
            const notice = document.createElement('div');
            notice.style.padding = '24px';
            notice.innerHTML = `
                <div style="background:#fff3cd;border:1px solid #ffeeba;color:#856404;padding:16px;border-radius:8px;">
                    <h2 style="margin-top:0;margin-bottom:8px;">Access disabled</h2>
                    <p>Your access in this course is revoked.</p>
                    <p>Please select another course from the course selector at the top if available.</p>
                </div>
            `;
            header.parentElement.insertBefore(notice, header.nextSibling);
            // Also render a standalone course selector since chat body is hidden
            renderStandaloneCourseSelectorBelowHeader(header.parentElement);
        }
        // Disable sidebar actions that start sessions
        const newSessionBtn = document.getElementById('new-session-btn');
        if (newSessionBtn) newSessionBtn.disabled = true;
    } catch (_) {}
}

/**
 * Handle explanation request for a message
 * @param {string} text - The message text to explain
 * @param {string|null} topic - The detected topic associated with this message
 */
async function handleExplainAction(text, topic = null, sourceMessageId = null) {
    if (!text) return;
    
    // Check if we already have an ongoing request
    const existingTyping = document.getElementById('typing-indicator');
    if (existingTyping) return;

    // Clean up the text (remove any existing HTML tags if passed as innerHTML)
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = text;
    const cleanText = tempDiv.innerText;
    let resolvedSourceMessageId = sourceMessageId || null;
    if (!resolvedSourceMessageId && typeof getCurrentChatData === 'function') {
        const chatData = getCurrentChatData();
        const messages = chatData && Array.isArray(chatData.messages) ? chatData.messages : [];
        const matchingSource = messages.slice().reverse().find(message =>
            message && message.type === 'bot' && message.messageId && message.content === text
        );
        resolvedSourceMessageId = matchingSource ? matchingSource.messageId : null;
    }

    // prompt construction moved to backend
    
    // Show typing indicator
    showTypingIndicator();
    
    try {
        // Send the clean text to the LLM - backend will wrap it with the Explain Mode prompt
        // Pass the topic if available so backend can increment struggle count
        const explanationOptions = topic ? { topic: topic } : true;
        const response = await sendMessageToLLM(cleanText, false, null, explanationOptions);
        
        // Remove typing indicator
        removeTypingIndicator();
        
        // Add bot response
        addMessage(
            response.message,
            'bot',
            true,
            false,
            response.sourceAttribution,
            false,
            null,
            null,
            response.messageId,
            null,
            {
                triggeredBy: 'explain_button',
                actionStatus: 'success',
                sourceMessageId: resolvedSourceMessageId,
                animate: true
            }
        );
        if (typeof maybeShowChatSurvey === 'function') {
            maybeShowChatSurvey();
        }
        
    } catch (error) {
        removeTypingIndicator();
        console.error('Explain error:', error);
        addMessage('Sorry, I encountered an error. Please try again.', 'bot', false, true, null);
    }
}

function buildSourceDownloadUrl(documentId, courseId) {
    const encodedDocId = encodeURIComponent(documentId);
    const encodedCourseId = encodeURIComponent(courseId);
    return `/api/chat/source-documents/${encodedDocId}/download?courseId=${encodedCourseId}`;
}

function renderSourceAttribution(sourceDiv, sourceAttribution) {
    const fallbackText = sourceAttribution && sourceAttribution.description
        ? sourceAttribution.description
        : 'TBD';
    const hasDownloadableSources = sourceAttribution
        && sourceAttribution.downloadsEnabled === true
        && Array.isArray(sourceAttribution.documents)
        && sourceAttribution.documents.some(doc => doc && doc.documentId);

    if (!hasDownloadableSources) {
        sourceDiv.textContent = `Source: ${fallbackText}`;
        return;
    }

    const courseId = localStorage.getItem('selectedCourseId');
    if (!courseId) {
        sourceDiv.textContent = `Source: ${fallbackText}`;
        return;
    }

    sourceDiv.textContent = '';
    sourceDiv.appendChild(document.createTextNode('Source: '));

    const docs = sourceAttribution.documents.filter(doc => doc && doc.documentId);
    docs.forEach((doc, index) => {
        if (index > 0) {
            sourceDiv.appendChild(document.createTextNode(', '));
        }

        const labelBase = doc.fileName || 'Source Document';
        const typeSuffix = doc.documentType && doc.documentType !== labelBase
            ? ` — ${doc.documentType}`
            : '';
        const labelWithType = `${labelBase}${typeSuffix}`;
        const label = doc.lectureName ? `${labelWithType} (${doc.lectureName})` : labelWithType;
        const link = document.createElement('a');
        link.href = buildSourceDownloadUrl(doc.documentId, courseId);
        link.textContent = label;
        link.title = 'Download source document';
        sourceDiv.appendChild(link);
    });
}

function getCurrentFeedbackConversationId() {
    try {
        const chatData = typeof getCurrentChatData === 'function' ? getCurrentChatData() : null;
        if (chatData && typeof getCurrentSessionId === 'function') {
            return getCurrentSessionId(chatData);
        }

        const studentId = typeof getCurrentStudentId === 'function' ? getCurrentStudentId() : null;
        const courseId = localStorage.getItem('selectedCourseId');
        const unitName = localStorage.getItem('selectedUnitName') || (typeof getCurrentUnitName === 'function' ? getCurrentUnitName() : 'this unit');
        if (!studentId || !courseId || !unitName) return null;
        return localStorage.getItem(`biocbot_session_${studentId}_${courseId}_${unitName}`);
    } catch (error) {
        console.warn('Could not resolve feedback conversation id:', error);
        return null;
    }
}

function getMessageTextForFeedback(messageElement) {
    const contentElement = messageElement.querySelector('.message-content');
    if (!contentElement) return '';
    const paragraph = contentElement.querySelector('p') || contentElement.querySelector(':scope > div');
    return paragraph ? (paragraph.textContent || paragraph.innerText || '') : '';
}

function setFeedbackButtonsState(container, rating) {
    const normalizedRating = rating || '';
    const status = container.querySelector('.message-feedback-status');
    container.querySelectorAll('.message-feedback-btn').forEach(button => {
        const isActive = normalizedRating && button.dataset.rating === normalizedRating;
        button.classList.toggle('active', !!isActive);
        button.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    });
    if (status) {
        status.textContent = '';
    }
}

function updateSavedMessageFeedback(messageId, rating) {
    try {
        if (!messageId || typeof getCurrentChatData !== 'function') return;
        const chatData = getCurrentChatData();
        if (!chatData || !Array.isArray(chatData.messages)) return;

        const message = chatData.messages.find(item => item && item.messageId === messageId);
        if (!message) return;

        message.feedbackRating = rating || null;
        chatData.lastActivityTimestamp = new Date().toISOString();

        const studentId = typeof getCurrentStudentId === 'function' ? getCurrentStudentId() : chatData.metadata?.studentId;
        if (studentId) {
            localStorage.setItem(`biocbot_current_chat_${studentId}`, JSON.stringify(chatData));
        }
    } catch (error) {
        console.warn('Could not update saved message feedback state:', error);
    }
}

async function handleMessageFeedback(button, rating) {
    const messageElement = button.closest('.message');
    const container = button.closest('.message-feedback-container');
    if (!messageElement || !container) return;

    const messageId = messageElement.dataset.messageId;
    const courseId = localStorage.getItem('selectedCourseId');
    const conversationId = getCurrentFeedbackConversationId();
    const nextRating = messageElement.dataset.feedbackRating === rating ? null : rating;
    const status = container.querySelector('.message-feedback-status');

    if (!messageId || !courseId || !conversationId) {
        if (status) status.textContent = 'Feedback unavailable';
        return;
    }

    container.querySelectorAll('.message-feedback-btn').forEach(btn => { btn.disabled = true; });
    if (status) status.textContent = 'Saving...';

    try {
        const response = await fetch('/api/chat/feedback', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({
                courseId,
                unitName: localStorage.getItem('selectedUnitName') || (typeof getCurrentUnitName === 'function' ? getCurrentUnitName() : null),
                conversationId,
                messageId,
                rating: nextRating,
                botMode: localStorage.getItem('studentMode') || 'tutor',
                messageContent: getMessageTextForFeedback(messageElement),
                sourceAttribution: messageElement._sourceAttribution || null
            })
        });

        const result = await response.json();
        if (!response.ok || !result.success) {
            throw new Error(result.message || `Feedback request failed: ${response.status}`);
        }

        const savedFeedback = result.data && result.data.feedback ? result.data.feedback : null;
        const savedRating = savedFeedback && savedFeedback.isActive ? savedFeedback.rating : null;
        messageElement.dataset.feedbackRating = savedRating || '';
        setFeedbackButtonsState(container, savedRating);
        updateSavedMessageFeedback(messageId, savedRating);
    } catch (error) {
        console.error('Error saving message feedback:', error);
        if (status) status.textContent = 'Could not save';
    } finally {
        container.querySelectorAll('.message-feedback-btn').forEach(btn => { btn.disabled = false; });
    }
}

function createMessageFeedbackControls(initialRating = null) {
    const container = document.createElement('div');
    container.classList.add('message-feedback-container');
    container.setAttribute('aria-label', 'Rate this response');

    const upButton = document.createElement('button');
    upButton.type = 'button';
    upButton.classList.add('message-feedback-btn');
    upButton.dataset.rating = 'up';
    // Use a monochrome SVG (inherits button color) instead of the coloured 👍 emoji,
    // so the control stays neutral until the student actually presses it.
    upButton.innerHTML = '<svg class="feedback-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M1 21h4V9H1v12zm22-11c0-1.1-.9-2-2-2h-6.31l.95-4.57.03-.32c0-.41-.17-.79-.44-1.06L14.17 1 7.59 7.59C7.22 7.95 7 8.45 7 9v10c0 1.1.9 2 2 2h9c.83 0 1.54-.5 1.84-1.22l3.02-7.05c.09-.23.14-.47.14-.73v-2z"/></svg>';
    upButton.title = 'This response was helpful';
    upButton.setAttribute('aria-label', 'Mark response as helpful');
    upButton.onclick = () => handleMessageFeedback(upButton, 'up');

    const status = document.createElement('span');
    status.classList.add('message-feedback-status');
    status.setAttribute('aria-live', 'polite');

    container.appendChild(upButton);
    container.appendChild(status);
    setFeedbackButtonsState(container, initialRating);

    return container;
}

/**
 * Global function to add a message to the chat
 * @param {string} content - The message content
 * @param {string} sender - 'user' or 'bot'
 * @param {boolean} withSource - Whether to show source citation
 * @param {boolean} skipAutoSave - Whether to skip auto-save for this message
 * @param {Object} sourceAttribution - Source attribution information
 * @param {boolean} isHtml - Whether content is HTML
 * @param {string} activeStruggleTopic - The currently active struggle topic (for Reset button)
 * @param {string} detectedTopic - The topic detected in this message (for Explain button)
 * @param {string|null} messageId - Server-generated assistant message id
 * @param {string|null} feedbackRating - Existing thumbs feedback rating
 */
function applyCurrentLLMTagClasses(element) {
    if (typeof window.applyLLMTagClassesToElement === 'function') {
        window.applyLLMTagClassesToElement(element);
    }
}

function addMessage(content, sender, withSource = false, skipAutoSave = false, sourceAttribution = null, isHtml = false, activeStruggleTopic = null, detectedTopic = null, messageId = null, feedbackRating = null, messageOptions = null) {


    const chatMessages = document.getElementById('chat-messages');
    if (!chatMessages) {
        console.error('Chat messages container not found');
        return;
    }

    const messageDiv = document.createElement('div');
    messageDiv.classList.add('message', sender + '-message');
    const restoredMessageClass = {
        'assessment-start': 'assessment-start',
        'unit-selection': 'unit-selection-welcome'
    }[messageOptions && messageOptions.messageType];
    if (restoredMessageClass) {
        messageDiv.classList.add(restoredMessageClass);
    }
    const consumeSummarySeedFlag = sender === 'user' && window.summarySeedForNextUserMessage === true;
    const isSummarySeed = consumeSummarySeedFlag || !!(messageOptions && messageOptions.isSummarySeed === true);
    const triggeredBy = (messageOptions && messageOptions.triggeredBy)
        || (isSummarySeed ? 'summarize_button' : null);
    const actionStatus = (messageOptions && messageOptions.actionStatus)
        || (triggeredBy ? 'success' : null);
    const sourceMessageId = messageOptions && messageOptions.sourceMessageId
        ? messageOptions.sourceMessageId
        : null;
    if (isSummarySeed) {
        messageDiv.dataset.summarySeed = 'true';
    }
    if (triggeredBy) {
        messageDiv.dataset.triggeredBy = triggeredBy;
    }
    if (actionStatus) {
        messageDiv.dataset.actionStatus = actionStatus;
    }
    if (sourceMessageId) {
        messageDiv.dataset.sourceMessageId = sourceMessageId;
    }
    if (messageId) {
        messageDiv.dataset.messageId = messageId;
    }
    if (feedbackRating) {
        messageDiv.dataset.feedbackRating = feedbackRating;
    }
    if (sourceAttribution) {
        messageDiv._sourceAttribution = sourceAttribution;
    }

    const avatarDiv = document.createElement('div');
    avatarDiv.classList.add('message-avatar');
    avatarDiv.textContent = sender === 'user' ? 'S' : 'B';

    const contentDiv = document.createElement('div');
    contentDiv.classList.add('message-content');

    // Use a <div> for HTML content (block elements can't nest inside <p>), otherwise <p>
    const paragraph = document.createElement(isHtml ? 'div' : 'p');
    if (isHtml) {
        paragraph.innerHTML = content;
    } else {
        // Use innerText to respect newlines from the source
        paragraph.innerText = content;
        // Ensure formatting is preserved
        paragraph.style.whiteSpace = 'pre-wrap';
    }

    contentDiv.appendChild(paragraph);

    // Create message footer for bottom elements
    const footerDiv = document.createElement('div');
    footerDiv.classList.add('message-footer');

    // Special handling: Never show source for the welcome message or the "Welcome to BiocBot!" unit selection message
    if (content && typeof content === 'string') {
        if ((content.includes("Hello! I'm BiocBot") && content.includes("AI study assistant")) ||
            (content.includes("Welcome to BiocBot!") && content.includes("I can see you have access to published units"))) {
            withSource = false;
        }
    }

    // Check for assessment start message to apply styling
    if (content && typeof content === 'string' && content.includes('Starting Assessment for')) {
        messageDiv.classList.add('assessment-start');
        // Force withSource to false for assessment start messages
        withSource = false;
    }

    // Add source citation if needed
    if (withSource && sender === 'bot') {
        const sourceDiv = document.createElement('div');
        sourceDiv.classList.add('message-source');

        renderSourceAttribution(sourceDiv, sourceAttribution);

        footerDiv.appendChild(sourceDiv);
    }

    // Create right side container for timestamp and flag button
    const rightContainer = document.createElement('div');
    rightContainer.classList.add('message-footer-right');

    const timestamp = document.createElement('span');
    timestamp.classList.add('timestamp');

    // Use the message's original timestamp when one is supplied (e.g. restoring a
    // saved/continued session) so old messages keep their real time instead of
    // being re-stamped with the moment the conversation was reopened.
    const providedTimestamp = messageOptions && messageOptions.timestamp
        ? new Date(messageOptions.timestamp)
        : null;
    const messageTime = (providedTimestamp && !isNaN(providedTimestamp.getTime()))
        ? providedTimestamp
        : new Date();
    timestamp.textContent = formatTimestamp(messageTime);

    // Store timestamp in message div for future updates
    messageDiv.dataset.timestamp = messageTime.getTime();

    // Add title attribute for exact time on hover
    timestamp.title = messageTime.toLocaleString('en-US', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        second: '2-digit',
        hour12: true
    });

    rightContainer.appendChild(timestamp);

    // Add flag button for bot messages
    if (sender === 'bot') {
        const flagContainer = document.createElement('div');
        flagContainer.classList.add('message-flag-container');

        // Add Explain Button
        // Only if message has content, is not the typing indicator, and is not a practice question
        const isPracticeQuestion = content && (content.includes('practice-question-container') || content.includes('struggle-gate-question'));
        if (content && !content.includes('<div class="dots">') && !isPracticeQuestion) {
            const explainButton = document.createElement('button');
            explainButton.classList.add('message-action-btn');
            explainButton.innerHTML = 'Explain';
            explainButton.title = 'Explain this message for a novice';
            if (detectedTopic) {
                explainButton.title += ` (Topic: ${detectedTopic})`;
            }
            explainButton.style.marginRight = '8px'; // Add some spacing
            explainButton.onclick = () => handleExplainAction(
                content,
                detectedTopic,
                messageDiv.dataset.messageId || messageId || null
            );
            rightContainer.appendChild(explainButton);

            // Add "Ask me a question" button when a topic is detected
            if (detectedTopic) {
                const practiceBtn = document.createElement('button');
                practiceBtn.classList.add('message-action-btn', 'practice-question-btn');
                practiceBtn.innerHTML = 'Ask me a question';
                practiceBtn.title = `Practice a question on ${detectedTopic}`;
                practiceBtn.style.marginRight = '8px';
                practiceBtn.onclick = () => handlePracticeQuestion(detectedTopic);
                rightContainer.appendChild(practiceBtn);
            }
        }

        if (messageId && content && !content.includes('<div class="dots">') && !isPracticeQuestion) {
            rightContainer.appendChild(createMessageFeedbackControls(feedbackRating));
        }

        const flagButton = document.createElement('button');
        flagButton.type = 'button';
        flagButton.classList.add('flag-button');
        flagButton.innerHTML = '⚑';
        flagButton.title = 'Flag this message';
        flagButton.setAttribute('aria-label', 'Flag this message');
        flagButton.setAttribute('aria-expanded', 'false');
        flagButton.onclick = () => toggleFlagMenu(flagButton);

        // Create flag menu
        const flagMenu = document.createElement('div');
        flagMenu.classList.add('flag-menu');
        flagMenu.innerHTML = `
            <button type="button" class="flag-option" onclick="flagMessage(this, 'incorrect')">Incorrect</button>
            <button type="button" class="flag-option" onclick="flagMessage(this, 'inappropriate')">Inappropriate</button>
            <button type="button" class="flag-option" onclick="flagMessage(this, 'unclear')">Unclear</button>
            <button type="button" class="flag-option" onclick="flagMessage(this, 'confusing')">Confusing</button>
            <button type="button" class="flag-option" onclick="flagMessage(this, 'typo')">Typo/Error</button>
            <button type="button" class="flag-option" onclick="flagMessage(this, 'offensive')">Offensive</button>
            <button type="button" class="flag-option" onclick="flagMessage(this, 'irrelevant')">Irrelevant</button>
        `;

        flagContainer.appendChild(flagButton);
        flagContainer.appendChild(flagMenu);
        rightContainer.appendChild(flagContainer);

        // Add "I'm done struggling" button if active topic exists
        // This triggers a practice question — if answered correctly, resets the struggle state
        if (activeStruggleTopic) {
            const resetBtn = document.createElement('button');
            resetBtn.className = 'message-action-btn struggle-reset-btn';
            resetBtn.style.marginLeft = '8px';
            resetBtn.style.color = '#dc3545';
            resetBtn.style.borderColor = '#dc3545';

            const displayTopic = activeStruggleTopic.charAt(0).toUpperCase() + activeStruggleTopic.slice(1);
            resetBtn.textContent = `I understand ${displayTopic} now`;

            resetBtn.title = `Answer a question to turn off Directive Mode for ${activeStruggleTopic}`;
            resetBtn.onclick = () => handleStruggleResetQuestion(activeStruggleTopic);
            rightContainer.appendChild(resetBtn);
        }
    }

    footerDiv.appendChild(rightContainer);
    contentDiv.appendChild(footerDiv);

    messageDiv.appendChild(avatarDiv);
    messageDiv.appendChild(contentDiv);

    chatMessages.appendChild(messageDiv);
    if (sender === 'bot') {
        applyCurrentLLMTagClasses(messageDiv);
    }

    // Scroll to bottom
    chatMessages.scrollTop = chatMessages.scrollHeight;

    // Reveal a freshly-arrived bot answer word-by-word instead of all at once.
    // Only for plain-text live responses (messageOptions.animate), never for
    // isHtml system/link messages or history restores, which don't set it.
    if (sender === 'bot' && !isHtml && messageOptions && messageOptions.animate && typeof window.typeOutText === 'function') {
        window.typeOutText(paragraph, content, {
            onStep: () => { chatMessages.scrollTop = chatMessages.scrollHeight; }
        });
    }

    // Auto-save the message
    // Only auto-save if not explicitly skipped
    if (!skipAutoSave) {
        const savedMessage = autoSaveMessage(content, sender, withSource, sourceAttribution, isHtml, activeStruggleTopic, messageId, feedbackRating, {
            isSummarySeed,
            triggeredBy,
            actionStatus,
            sourceMessageId,
            timestamp: messageTime.toISOString()
        });
        if (savedMessage) {
            messageDiv.dataset.elapsedTime = String(savedMessage.elapsedTime);
            messageDiv.dataset.elapsedTimeDerived = String(savedMessage.elapsedTimeDerived === true);
        }
    } else if (messageOptions && messageOptions.elapsedTime !== null
        && messageOptions.elapsedTime !== undefined
        && Number.isFinite(Number(messageOptions.elapsedTime))) {
        messageDiv.dataset.elapsedTime = String(Math.max(0, Math.round(Number(messageOptions.elapsedTime))));
        messageDiv.dataset.elapsedTimeDerived = String(messageOptions.elapsedTimeDerived === true);
    }

    if (consumeSummarySeedFlag) {
        window.summarySeedForNextUserMessage = false;
    }

    if (typeof window.updateChatSummaryButtonState === 'function') {
        window.updateChatSummaryButtonState();
    }
}

/**
 * Format timestamp for display (global version)
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
 * Toggle the flag menu visibility
 * @param {HTMLElement} button - The flag button element
 */
function toggleFlagMenu(button) {
    // Close all other open menus first
    const allMenus = document.querySelectorAll('.flag-menu.show');
    allMenus.forEach(menu => {
        if (menu !== button.nextElementSibling) {
            menu.classList.remove('show');
            const otherFlagButton = menu.previousElementSibling;
            if (otherFlagButton instanceof HTMLButtonElement) {
                otherFlagButton.setAttribute('aria-expanded', 'false');
            }
        }
    });

    // Toggle the clicked menu
    const menu = button.nextElementSibling;
    if (menu && menu.classList.contains('flag-menu')) {
        const isOpening = !menu.classList.contains('show');
        menu.classList.toggle('show', isOpening);
        button.setAttribute('aria-expanded', String(isOpening));
        if (isOpening) {
            menu.querySelector('.flag-option')?.focus();
        }
    }
}

/**
 * Handle flag message action
 * @param {HTMLElement} button - The flag option button
 * @param {string} flagType - The type of flag (now flagReason)
 */
function flagMessage(button, flagType) {
    const menu = button.closest('.flag-menu');
    const messageContent = menu.closest('.message-content');
    const textEl = messageContent.querySelector('p') || messageContent.querySelector('div');
    const messageText = textEl ? textEl.textContent : messageContent.textContent;

    // Close the menu
    menu.classList.remove('show');

    // Send flag to server
    submitFlag(messageText, flagType);

    // Replace the message content with thank you message
    replaceMessageWithThankYou(messageContent, flagType);
}

/**
 * Submit flag to server
 * @param {string} messageText - The flagged message text
 * @param {string} flagType - The type of flag (now flagReason)
 */
async function submitFlag(messageText, flagType) {
    try {
        // Get current course and student information
        const courseId = localStorage.getItem('selectedCourseId');
        if (!courseId) {
            throw new Error('No course selected. Please select a course first.');
        }
        const studentId = getCurrentStudentId();
        const studentName = getCurrentStudentName();
        const unitName = getCurrentUnitName();
        
        // Get current bot mode (protege or tutor)
        const botMode = localStorage.getItem('studentMode') || 'tutor';
        // fixed the resolved.

        // Create flag data for the new flagged questions API
        const flagData = {
            questionId: generateQuestionId(messageText), // Generate a unique ID for this "question"
            courseId: courseId,
            unitName: unitName,
            studentId: studentId,
            studentName: studentName,
            flagReason: flagType,
            flagDescription: `Student flagged bot response as ${flagType}`,
            botMode: botMode, // Include the bot mode (protege or tutor) when the flag was submitted
            questionContent: {
                question: messageText,
                questionType: 'bot-response',
                options: {},
                correctAnswer: 'N/A',
                explanation: 'This is a flagged bot response from the student chat interface'
            }
        };



        const response = await fetch('/api/flags', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(flagData)
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const result = await response.json();


        // Immediately refresh flag notifications to track the new flag
        // This ensures the flag is in lastKnownFlags so we can detect when it's approved
        if (result.success && typeof checkForFlagUpdates === 'function') {

            // Small delay to ensure the flag is saved on the server
            setTimeout(() => {
                checkForFlagUpdates();
            }, 1000);
        }

    } catch (error) {
        console.error('Error submitting flag:', error);
        // Still show confirmation to user even if server request fails
    }
}

/**
 * Replace the bot message with a thank you message
 * @param {HTMLElement} messageContent - The message content element
 * @param {string} flagType - The type of flag that was submitted (now flagReason)
 */
function replaceMessageWithThankYou(messageContent, flagType) {
    // Get the paragraph element (could be <p> or <div> for HTML messages)
    const paragraph = messageContent.querySelector('p') || messageContent.querySelector('div');

    // Map flag types to user-friendly descriptions
    const flagTypeDescriptions = {
        'incorrect': 'incorrect information',
        'inappropriate': 'inappropriate content',
        'unclear': 'unclear or confusing content',
        'confusing': 'confusing content',
        'typo': 'typo or error',
        'offensive': 'offensive content',
        'irrelevant': 'irrelevant content'
    };

    const description = flagTypeDescriptions[flagType] || flagType;

    // Replace the message text
    paragraph.textContent = `Thank you for reporting this response as ${description}. This has been logged and will be reviewed by your instructor.`;

    // Add a visual indicator that this message was flagged
    paragraph.style.color = '#666';
    paragraph.style.fontStyle = 'italic';

    // Remove the flag button and menu
    const flagContainer = messageContent.querySelector('.message-flag-container');
    if (flagContainer) {
        flagContainer.remove();
    }

    // Update the timestamp to show when it was flagged
    const timestamp = messageContent.querySelector('.timestamp');
    if (timestamp) {
        timestamp.textContent = 'Flagged just now';
        timestamp.style.color = '#888';
    }

    // Add a subtle background color to indicate the message was flagged
    messageContent.style.backgroundColor = '#f8f9fa';
    messageContent.style.border = '1px solid #e9ecef';
}

/**
 * Enable chat input and clear noPublishedUnits flag
 * Called when units are available or assessment is completed
 */
function enableChatInput() {
    // Clear the noPublishedUnits flag since units are now available
    window.noPublishedUnits = false;

    // Show chat input container
    const chatInputContainer = document.querySelector('.chat-input-container');
    if (chatInputContainer) {
        chatInputContainer.style.display = 'block';
    }

    // Re-enable the chat input field
    const chatInput = document.getElementById('chat-input');
    if (chatInput) {
        chatInput.disabled = false;
        chatInput.placeholder = 'Type your message here...';
        chatInput.classList.remove('disabled-input');
        chatInput.style.cursor = 'text';
    }

    // Re-enable the send button
    const sendButton = document.getElementById('send-button');
    if (sendButton) {
        sendButton.disabled = false;
        sendButton.classList.remove('disabled-button');
        sendButton.style.cursor = 'pointer';
        sendButton.style.opacity = '1';
    }

    // Show mode toggle
    const modeToggleContainer = document.querySelector('.mode-toggle-container');
    if (modeToggleContainer) {
        modeToggleContainer.style.display = 'block';
    }
}
