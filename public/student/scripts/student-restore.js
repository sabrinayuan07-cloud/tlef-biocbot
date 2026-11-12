/**
 * Student chat: restoring saved chats into the interface.
 */

/**
 * Copy persisted timing fields onto a custom-rendered message element. These
 * renderers bypass addMessage(), so the fields must be restored explicitly or
 * a later DOM-based export will derive/re-stamp them.
 * @param {HTMLElement} element - Restored message element
 * @param {Object} messageData - Persisted message data
 */
function applyRestoredTimingData(element, messageData) {
    const timestampMs = new Date(messageData && messageData.timestamp).getTime();
    if (Number.isFinite(timestampMs)) {
        element.dataset.timestamp = String(timestampMs);
    }

    const elapsedTime = Number(messageData && messageData.elapsedTime);
    if (messageData && messageData.elapsedTime !== null
        && messageData.elapsedTime !== undefined
        && Number.isFinite(elapsedTime)) {
        element.dataset.elapsedTime = String(Math.max(0, Math.round(elapsedTime)));
        element.dataset.elapsedTimeDerived = String(messageData.elapsedTimeDerived === true);
    }
}

/**
 * Render a restored mode result message
 * @param {Object} messageData - The message data object
 */
function renderRestoredModeResult(messageData) {
    const chatMessages = document.getElementById('chat-messages');
    if (!chatMessages) return;

    const modeMessage = document.createElement('div');
    modeMessage.classList.add('message', 'bot-message', 'mode-result', 'standard-mode-result');
    applyRestoredTimingData(modeMessage, messageData);

    const avatarDiv = document.createElement('div');
    avatarDiv.classList.add('message-avatar');
    avatarDiv.textContent = 'B';

    const contentDiv = document.createElement('div');
    contentDiv.classList.add('message-content', 'standard-mode-content');

    // Use saved HTML content if available, otherwise fall back to text
    if (messageData.htmlContent) {
        contentDiv.innerHTML = messageData.htmlContent;
    } else {
        // Fallback for older messages
        const text = document.createElement('p');
        text.textContent = messageData.content;
        contentDiv.appendChild(text);
    }

    // Add timestamp if not already present in HTML (it shouldn't be as we removed it on save)
    if (!contentDiv.querySelector('.timestamp')) {
        const timestamp = document.createElement('span');
        timestamp.classList.add('timestamp');
        timestamp.textContent = messageData.displayTimestamp || formatTimestamp(new Date(messageData.timestamp));
        timestamp.title = new Date(messageData.timestamp).toLocaleString();
        contentDiv.appendChild(timestamp);
    }

    modeMessage.appendChild(avatarDiv);
    modeMessage.appendChild(contentDiv);
    chatMessages.appendChild(modeMessage);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

/**
 * Render a restored mode toggle result message
 * @param {Object} messageData - The message data object
 */
function renderRestoredModeToggleResult(messageData) {
    const chatMessages = document.getElementById('chat-messages');
    if (!chatMessages) return;

    // Rendered as a centered system notice rather than a bot-message bubble,
    // matching the live showModeToggleResult() in student-calibration.js.
    const modeMessage = document.createElement('div');
    modeMessage.classList.add('message', 'bot-message', 'system-notice', 'mode-toggle-result');
    applyRestoredTimingData(modeMessage, messageData);

    const contentDiv = document.createElement('div');
    contentDiv.classList.add('message-content');

    // Use saved HTML content if available
    if (messageData.htmlContent) {
        contentDiv.innerHTML = messageData.htmlContent;
    } else {
        const text = document.createElement('p');
        text.textContent = messageData.content;
        contentDiv.appendChild(text);
    }

    // Add timestamp if needed
    if (!contentDiv.querySelector('.timestamp')) {
        const timestamp = document.createElement('span');
        timestamp.classList.add('timestamp');
        timestamp.textContent = messageData.displayTimestamp || formatTimestamp(new Date(messageData.timestamp));
        timestamp.title = new Date(messageData.timestamp).toLocaleString();
        contentDiv.appendChild(timestamp);
    }

    modeMessage.appendChild(contentDiv);
    chatMessages.appendChild(modeMessage);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

/**
 * Load chat data into the current chat interface
 * @param {Object} chatData - The chat data to load
 */
function loadChatData(chatData) {
    try {


        // Clear existing messages
        const chatMessages = document.getElementById('chat-messages');
        if (!chatMessages) {
            console.error('Chat messages container not found');
            return;
        }

        // Clear ALL existing messages
        chatMessages.innerHTML = '';

        // Don't clear auto-save data when loading from history - we want to preserve it


        // Add a loading message first
        const loadingMessage = document.createElement('div');
        loadingMessage.classList.add('message', 'bot-message');
        loadingMessage.innerHTML = `
            <div class="message-avatar">B</div>
            <div class="message-content">
                <p>Loading your previous chat...</p>
                <span class="timestamp">Just now</span>
            </div>
        `;
        chatMessages.appendChild(loadingMessage);

        // Scroll to bottom
        chatMessages.scrollTop = chatMessages.scrollHeight;

        // Use setTimeout to ensure the loading message is visible
        setTimeout(() => {
            // Clear the loading message
            chatMessages.innerHTML = '';

            const savedAnswerEntries = Array.isArray(chatData.studentAnswers?.answers)
                ? chatData.studentAnswers.answers
                : [];
            const savedAssessmentAnswers = savedAnswerEntries.map(answer => answer?.answer);
            const resumeQuestionIndex = savedAssessmentAnswers
                .filter(answer => answer !== undefined && answer !== null)
                .length;
            const resumeQuestion = chatData.practiceTests?.questions?.[resumeQuestionIndex];
            const pendingCalibrationMessages = new Set();
            let legacyPendingCalibrationMessage = null;
            let pendingShortAnswerDraft = null;

            if (resumeQuestion) {
                const expectedText = String(resumeQuestion.question || '').trim();
                chatData.messages.forEach(messageData => {
                    if (messageData.messageType !== 'practice-test-question' || !messageData.questionData) return;

                    const savedText = String(
                        messageData.questionData.questionText || messageData.content || ''
                    ).trim();
                    const savedIndex = Number(messageData.questionData.questionIndex);
                    const textMatches = expectedText && savedText.includes(expectedText);
                    const hasComparableText = expectedText && savedText;
                    const indexMatches = Number.isInteger(savedIndex) && savedIndex === resumeQuestionIndex;

                    // Text is the safer identifier for legacy saves because older
                    // exports recorded every visible card with the current global
                    // question index instead of the index encoded in its DOM id.
                    if (textMatches) {
                        pendingCalibrationMessages.add(messageData);
                        pendingShortAnswerDraft = messageData.questionData.studentAnswer;
                    } else if (!hasComparableText && indexMatches) {
                        legacyPendingCalibrationMessage = messageData;
                        pendingShortAnswerDraft = messageData.questionData.studentAnswer;
                    }
                });

                if (pendingCalibrationMessages.size === 0 && legacyPendingCalibrationMessage) {
                    pendingCalibrationMessages.add(legacyPendingCalibrationMessage);
                }
            }

            // Load each message from the chat data WITHOUT triggering auto-save
            chatData.messages.forEach((messageData, index) => {
                // The unanswered card is rendered interactively below. Restoring
                // its saved snapshot too would duplicate the current question.
                if (pendingCalibrationMessages.has(messageData)) return;

                const messageOptions = {
                    messageType: messageData.messageType || null,
                    isSummarySeed: messageData.isSummarySeed === true,
                    timestamp: messageData.timestamp,
                    triggeredBy: messageData.triggeredBy || null,
                    actionStatus: messageData.actionStatus || null,
                    sourceMessageId: messageData.sourceMessageId || null,
                    elapsedTime: messageData.elapsedTime,
                    elapsedTimeDerived: messageData.elapsedTimeDerived === true
                };

                if (messageData.type === 'user') {
                    addMessage(messageData.content, 'user', false, true, null, messageData.isHtml, null, null, null, null, messageOptions); // Skip auto-save
                } else if (messageData.type === 'bot') {
                    // Check if this is a special message type that needs special handling
                    if (messageData.messageType === 'assessment-start') {
                        // This is the assessment start message - add it as a regular bot message
                        addMessage(messageData.content, 'bot', messageData.hasFlagButton, true, messageData.sourceAttribution, true, null, null, messageData.messageId, messageData.feedbackRating, messageOptions); // Skip auto-save, force HTML for assessment start
                    } else if (messageData.messageType === 'practice-test-question') {
                        // This is a practice test question - restore its UI
                        renderRestoredPracticeQuestion(messageData); // Skip auto-save implicit
                    } else if (messageData.messageType === 'mode-result') {
                        // This is a mode result message - use dedicated restorer
                        renderRestoredModeResult(messageData); // Skip auto-save
                    } else if (messageData.messageType === 'mode-toggle-result') {
                        // This is a mode toggle result message - use dedicated restorer
                        renderRestoredModeToggleResult(messageData); // Skip auto-save
                    } else {
                        // Regular bot message
                        // Check if the struggle topic is still active
                        let activeTopic = messageData.activeStruggleTopic;
                        if (activeTopic && window.currentStruggleState) {
                             const isStillActive = window.currentStruggleState.topics && 
                                                 window.currentStruggleState.topics.some(t => t.topic === activeTopic && t.isActive);
                             if (!isStillActive) {
                                 activeTopic = null;
                             }
                        }
                        
                        addMessage(messageData.content, 'bot', messageData.hasFlagButton, true, messageData.sourceAttribution, messageData.isHtml, activeTopic, null, messageData.messageId, messageData.feedbackRating, messageOptions); // Skip auto-save, force HTML for result
                    }
                }
            });

            // Sanitize any un-answered practice questions from previous sessions
            // (server-side answer store won't have them after restart/reload)
            document.querySelectorAll('.practice-question-container:not(.practice-completed)').forEach(container => {
                const questionText = container.querySelector('.practice-question-text')?.textContent || '';
                container.outerHTML = `<div class="practice-question-container practice-completed">
                    <div class="practice-question-header">Practice Question</div>
                    <div class="practice-question-text">${questionText}</div>
                    <div class="practice-feedback practice-feedback-error" style="display:block;">This practice question has expired. Click "Ask me a question" to generate a new one.</div>
                </div>`;
            });

            // Restore practice test data if present
            if (chatData.practiceTests && chatData.practiceTests.questions.length > 0) {

                // Map back questionType to type for compatibility with showCalibrationQuestion
                currentCalibrationQuestions = chatData.practiceTests.questions.map(q => ({
                    ...q,
                    type: q.questionType || q.type // Ensure type property exists
                }));
                window.currentCalibrationQuestions = currentCalibrationQuestions; // Sync global
                currentPassThreshold = chatData.practiceTests.passThreshold;
                window.currentPassThreshold = currentPassThreshold; // Update global reference
                
                studentAnswers = savedAssessmentAnswers;
                window.studentAnswers = studentAnswers; // Sync global
                window.currentAssessmentScore = chatData.assessmentScore
                    ?? chatData.practiceTests.score
                    ?? AssessmentScoring.evaluateAssessment(
                        currentCalibrationQuestions,
                        studentAnswers,
                        currentPassThreshold
                    );

                // Calculate the correct current question index based on answers provided
                // This is more reliable than the saved index which might be stale
                currentQuestionIndex = resumeQuestionIndex;


                // Resume assessment if incomplete
                if (currentQuestionIndex < currentCalibrationQuestions.length) {

                    
                    // Disable chat input during assessment
                    const chatInputContainer = document.querySelector('.chat-input-container');
                    if (chatInputContainer) {
                        chatInputContainer.style.display = 'none';
                    }

                    // Show the next question
                    // Use a small delay to ensure DOM is ready
                    setTimeout(() => {
                        showCalibrationQuestion();
                        if (typeof pendingShortAnswerDraft === 'string') {
                            const answerInput = document.querySelector(
                                `#calibration-question-${currentQuestionIndex} .calibration-answer-input`
                            );
                            if (answerInput) answerInput.value = pendingShortAnswerDraft;
                        }
                    }, 500);
                }
            }

            // Restore mode if present, but only if no recent mode change has occurred
            const currentStoredMode = localStorage.getItem('studentMode') || 'tutor';
            const chatDataMode = chatData.metadata.currentMode;

            // Check if the user has manually changed the mode recently (within last 5 minutes)
            const lastModeChange = localStorage.getItem('lastModeChange');
            const now = Date.now();
            const fiveMinutesAgo = now - (5 * 60 * 1000);

            if (lastModeChange && parseInt(lastModeChange) > fiveMinutesAgo) {
                // User recently changed mode, keep their current choice

                updateModeToggleUI(currentStoredMode);
            } else if (chatDataMode) {
                // No recent mode change, restore from chat data

                localStorage.setItem('studentMode', chatDataMode);
                updateModeToggleUI(chatDataMode);

            } else {

                updateModeToggleUI(currentStoredMode);
            }

            // Restore unit selection if present
            if (chatData.metadata.unitName) {

                localStorage.setItem('selectedUnitName', chatData.metadata.unitName);

                // Update unit selection dropdown if it exists
                const unitSelect = document.getElementById('unit-select');
                if (unitSelect) {
                    unitSelect.value = chatData.metadata.unitName;
                }
            }

            // Restore course selection if present
            if (chatData.metadata.courseId) {

                const currentCourseId = localStorage.getItem('selectedCourseId');
                
                // Only update if different
                if (currentCourseId !== chatData.metadata.courseId) {

                    localStorage.setItem('selectedCourseId', chatData.metadata.courseId);
                    
                    if (chatData.metadata.courseName) {
                        localStorage.setItem('selectedCourseName', chatData.metadata.courseName);
                    }

                    // Update course display (loadCourseData handles UI updates)
                    loadCourseData(chatData.metadata.courseId, false);
                }
            } else {
                // Ensure chat input is visible if no course context to restore
                const chatInputContainer = document.querySelector('.chat-input-container');
                if (chatInputContainer) {
                    chatInputContainer.style.display = 'block';
                }
            }

            // Ensure chat input and mode toggle are visible (enable chat) IF we are not in an assessment
            // Check if assessment is in progress (defined in the block above)
            const isAssessmentInProgress = window.currentCalibrationQuestions && 
                                          window.currentCalibrationQuestions.length > 0 && 
                                          window.studentAnswers && 
                                          window.studentAnswers.length < window.currentCalibrationQuestions.length;
            
            // Check if this loaded session has hit the message cap
            const regularChatMsgCount = chatData.messages.filter(msg =>
                (msg.type === 'user' || msg.type === 'bot') && msg.messageType === 'regular-chat'
            ).length;
            const isSessionAtCap = regularChatMsgCount >= 40;

            if (!isAssessmentInProgress) {

                enableChatInput();

                // Force show input container regardless of enableChatInput logic
                const chatInputContainer = document.querySelector('.chat-input-container');
                if (chatInputContainer) {
                    chatInputContainer.style.display = 'block';
                    // Ensure input itself is enabled
                    const chatInput = document.getElementById('chat-input');
                    if (chatInput) {
                        chatInput.disabled = false;
                        chatInput.style.cursor = 'text';
                        chatInput.classList.remove('disabled-input');
                        chatInput.placeholder = 'Type your message here...';
                    }
                    const sendButton = document.getElementById('send-button');
                    if (sendButton) {
                        sendButton.disabled = false;
                        sendButton.style.cursor = 'pointer';
                        sendButton.classList.remove('disabled-button');
                        sendButton.style.opacity = '1';
                    }
                }

                // Also ensure mode toggle is visible if not in assessment
                const modeToggleContainer = document.querySelector('.mode-toggle-container');
                if (modeToggleContainer) {
                    modeToggleContainer.style.display = 'flex';
                }

                // If session is capped, disable chat input after enabling it
                if (isSessionAtCap) {
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
            } else {

                // Explicitly hide them just in case
                const chatInputContainer = document.querySelector('.chat-input-container');
                if (chatInputContainer) {
                    chatInputContainer.style.display = 'none';
                }
                const modeToggleContainer = document.querySelector('.mode-toggle-container');
                if (modeToggleContainer) {
                    modeToggleContainer.style.display = 'none';
                }
            }



            // Set flags for continuing chat
            sessionStorage.setItem('isContinuingChat', 'true');
            sessionStorage.setItem('loadedChatData', JSON.stringify(chatData));

            // Update the current session ID to match the loaded chat data
            if (chatData.sessionInfo && chatData.sessionInfo.sessionId) {
                const studentId = chatData.metadata.studentId;
                const courseId = chatData.metadata.courseId;
                const unitName = chatData.metadata.unitName;
                const sessionKey = `biocbot_session_${studentId}_${courseId}_${unitName}`;

                // Store the session ID from the loaded chat data
                localStorage.setItem(sessionKey, chatData.sessionInfo.sessionId);

            } else {
                // If no session ID in chat data, generate one and store it
                const studentId = chatData.metadata.studentId;
                const courseId = chatData.metadata.courseId;
                const unitName = chatData.metadata.unitName;
                const sessionKey = `biocbot_session_${studentId}_${courseId}_${unitName}`;

                // Generate a new session ID for this chat
                const newSessionId = `autosave_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
                localStorage.setItem(sessionKey, newSessionId);

                // Update the chat data with the new session ID
                if (!chatData.sessionInfo) {
                    chatData.sessionInfo = {};
                }
                chatData.sessionInfo.sessionId = newSessionId;


            }

            // Replace the current auto-save data with the loaded chat data
            const studentId = chatData.metadata.studentId;
            const autoSaveKey = `biocbot_current_chat_${studentId}`;
            localStorage.setItem(autoSaveKey, JSON.stringify(chatData));
            scheduleChatSessionExpiration(chatData);




        }, 500); // Small delay to show loading message

    } catch (error) {
        console.error('Error loading chat data:', error);
        addMessage('❌ Error loading chat history. Please try again.', 'bot', false, true, null);
    }
}

/**
 * Format date for display in history
 * @param {string} dateString - ISO date string
 * @returns {string} Formatted date
 */
function formatHistoryDate(dateString) {
    try {
        const date = new Date(dateString);
        const now = new Date();
        const diffMs = now - date;
        const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

        if (diffDays === 0) {
            return 'Today, ' + date.toLocaleTimeString('en-US', {
                hour: 'numeric',
                minute: '2-digit',
                hour12: true
            });
        } else if (diffDays === 1) {
            return 'Yesterday, ' + date.toLocaleTimeString('en-US', {
                hour: 'numeric',
                minute: '2-digit',
                hour12: true
            });
        } else if (diffDays < 7) {
            return date.toLocaleDateString('en-US', {
                weekday: 'short',
                hour: 'numeric',
                minute: '2-digit',
                hour12: true
            });
        } else {
            return date.toLocaleDateString('en-US', {
                month: 'short',
                day: 'numeric',
                year: 'numeric'
            });
        }
    } catch (error) {
        console.error('Error formatting date:', error);
        return 'Unknown date';
    }
}

/**
 * Check for chat data to load from history
 */
function stageHistoryChatDataForLoad() {
    const storedChatData = sessionStorage.getItem('loadChatData');
    if (!storedChatData) return null;

    try {
        const chatData = JSON.parse(storedChatData);
        window.loadingFromHistory = true;

        // Clicking Continue Chat is an explicit return to this session. Rebase
        // its activity window so an older history item is not restored and
        // immediately rotated by the background inactivity policy.
        chatData.lastActivityTimestamp = new Date().toISOString();

        // Stage the selected course/unit and chat before any asynchronous page
        // initialization can create a competing fresh assessment session.
        if (chatData?.metadata?.courseId) {
            localStorage.setItem('selectedCourseId', chatData.metadata.courseId);
        }
        if (chatData?.metadata?.courseName) {
            localStorage.setItem('selectedCourseName', chatData.metadata.courseName);
        }
        if (chatData?.metadata?.unitName) {
            localStorage.setItem('selectedUnitName', chatData.metadata.unitName);
        }

        const studentId = chatData?.metadata?.studentId || getCurrentStudentId();
        if (studentId) {
            localStorage.setItem(`biocbot_current_chat_${studentId}`, JSON.stringify(chatData));
        }

        return chatData;
    } catch (error) {
        console.error('Error staging chat data from history:', error);
        return null;
    }
}

async function checkForChatDataToLoad() {
    try {
        // Stage synchronously before the struggle-state request yields to other
        // startup work. student.js also calls this at the start of page boot.
        const chatData = stageHistoryChatDataForLoad();

        // Fetch current struggle state before rendering the restored messages.
        if (typeof fetchCurrentStruggleState === 'function') {
            window.currentStruggleState = await fetchCurrentStruggleState();
            if (typeof updateStruggleUI === 'function') {
                updateStruggleUI(window.currentStruggleState);
            }
        }

        if (chatData) {
            // Clear the stored data
            sessionStorage.removeItem('loadChatData');


            // Load the chat data

            loadChatData(chatData);
        }
    } catch (error) {
        console.error('Error checking for chat data to load:', error);
    }
}

/**
 * Test function to add sample chat data to history
 * This can be called from the browser console for testing
 */
function addSampleChatData() {
    const sampleChatData = {
        metadata: {
            exportDate: new Date().toISOString(),
            courseId: 'BIOC202-test',
            courseName: 'BIOC 202',
            studentId: 'test-student-123',
            studentName: 'Test Student',
            unitName: 'Unit 1',
            currentMode: 'tutor',
            totalMessages: 4,
            version: '1.0'
        },
        messages: [
            {
                index: 0,
                type: 'bot',
                timestamp: new Date(Date.now() - 3600000).toISOString(),
                displayTimestamp: '1 hour ago',
                content: 'Hello! I\'m BiocBot, your AI study assistant for BIOC 202. How can I help you today?',
                messageType: 'regular-chat',
                isCalibrationQuestion: false,
                isModeResult: false,
                isAssessmentStart: false,
                hasFlagButton: true
            },
            {
                index: 1,
                type: 'user',
                timestamp: new Date(Date.now() - 3500000).toISOString(),
                displayTimestamp: '1 hour ago',
                content: 'Can you explain protein folding and what determines the final 3D structure?',
                messageType: 'regular-chat',
                isCalibrationQuestion: false,
                isModeResult: false,
                isAssessmentStart: false
            },
            {
                index: 2,
                type: 'bot',
                timestamp: new Date(Date.now() - 3400000).toISOString(),
                displayTimestamp: '1 hour ago',
                content: 'Protein folding is determined by several factors:\n\n1. **Primary structure:** The sequence of amino acids forms the backbone.\n2. **Hydrogen bonding:** Creates secondary structures like alpha helices and beta sheets.\n3. **Hydrophobic interactions:** Non-polar amino acids cluster in the center, away from water.\n4. **Ionic interactions:** Charged amino acids form salt bridges.\n5. **Disulfide bridges:** Covalent bonds between cysteine residues stabilize the structure.\n\nThe final 3D structure represents the most energetically favorable conformation.',
                messageType: 'regular-chat',
                isCalibrationQuestion: false,
                isModeResult: false,
                isAssessmentStart: false,
                hasFlagButton: true
            },
            {
                index: 3,
                type: 'user',
                timestamp: new Date(Date.now() - 3300000).toISOString(),
                displayTimestamp: '1 hour ago',
                content: 'What happens if there\'s a mutation in the amino acid sequence?',
                messageType: 'regular-chat',
                isCalibrationQuestion: false,
                isModeResult: false,
                isAssessmentStart: false
            }
        ],
        practiceTests: {
            questions: [],
            totalQuestions: 0,
            passThreshold: 2,
            currentQuestionIndex: 0
        },
        studentAnswers: {
            answers: [],
            totalAnswers: 0,
            answersProvided: 0
        },
        sessionInfo: {
            startTime: new Date(Date.now() - 3600000).toISOString(),
            endTime: new Date().toISOString(),
            duration: '1h 0m 0s'
        }
    };

    saveChatToHistory(sampleChatData);

}

/**
 * Render a restored practice test question from reading history
 * @param {Object} messageData - The message data object
 */
function renderRestoredPracticeQuestion(messageData) {
    const questionData = messageData.questionData;
    if (!questionData) {
        // Fallback to text if data missing
        addMessage(messageData.content, 'bot', false, true, null, false, null, null, null, null, {
            timestamp: messageData.timestamp,
            elapsedTime: messageData.elapsedTime,
            elapsedTimeDerived: messageData.elapsedTimeDerived === true
        });
        return;
    }

    const chatMessages = document.getElementById('chat-messages');
    if (!chatMessages) return;

    const questionMessage = document.createElement('div');
    questionMessage.classList.add('message', 'bot-message', 'calibration-question');
    if (questionData.questionIndex !== undefined) {
        questionMessage.id = `calibration-question-${questionData.questionIndex}`;
    }

    // Avatar
    const avatarDiv = document.createElement('div');
    avatarDiv.classList.add('message-avatar');
    avatarDiv.textContent = 'B';

    // Content
    const contentDiv = document.createElement('div');
    contentDiv.classList.add('message-content');

    // Question Text
    const questionTextParams = document.createElement('p');
    questionTextParams.textContent = questionData.questionText;
    questionTextParams.style.marginBottom = '15px';
    questionTextParams.style.fontWeight = '500';
    contentDiv.appendChild(questionTextParams);

    // Options Container
    const optionsDiv = document.createElement('div');
    optionsDiv.classList.add('calibration-options');

    if (questionData.options && questionData.options.length > 0) {
        questionData.options.forEach((opt) => {
            const optionContainer = document.createElement('div');
            optionContainer.classList.add('calibration-option-container');

            const optionButton = document.createElement('button');
            optionButton.classList.add('calibration-option');
            optionButton.textContent = opt.text;
            
            // Apply frozen state
            optionButton.disabled = true;
            optionButton.style.cursor = 'default';

            if (opt.isSelected) {
                optionButton.classList.add('selected');
                optionButton.style.backgroundColor = 'var(--primary-color)';
                optionButton.style.color = 'white';
                optionButton.style.borderColor = 'var(--primary-color)';
            } else {
                optionButton.style.backgroundColor = '#f8f9fa';
                optionButton.style.color = '#999';
                optionButton.style.borderColor = '#ddd';
            }

            optionContainer.appendChild(optionButton);
            optionsDiv.appendChild(optionContainer);
        });
    }

    contentDiv.appendChild(optionsDiv);

    // Short Answer Display
    if (questionData.studentAnswer) {
        const answerDisplay = document.createElement('div');
        answerDisplay.style.marginTop = '10px';
        answerDisplay.style.padding = '10px';
        answerDisplay.style.backgroundColor = '#f8f9fa';
        answerDisplay.style.border = '1px solid #ddd';
        answerDisplay.style.borderRadius = '5px';
        answerDisplay.style.color = '#555';
        answerDisplay.innerHTML = `<strong>Your Answer:</strong> ${questionData.studentAnswer}`;
        contentDiv.appendChild(answerDisplay);
    }

    // Feedback Display
    if (questionData.feedback) {
        const feedbackDiv = document.createElement('div');
        feedbackDiv.className = 'calibration-feedback';
        feedbackDiv.style.marginTop = '10px';
        feedbackDiv.style.padding = '12px';
        feedbackDiv.style.borderRadius = '6px';
        feedbackDiv.style.fontSize = '0.9em';
        feedbackDiv.style.lineHeight = '1.4';
        // We know feedback HTML is safe as it comes from our own generator
        feedbackDiv.innerHTML = questionData.feedback;
        contentDiv.appendChild(feedbackDiv);
    }

    // Timestamp
    const footerDiv = document.createElement('div');
    footerDiv.classList.add('message-footer');
    const rightContainer = document.createElement('div');
    rightContainer.classList.add('message-footer-right');
    const timestamp = document.createElement('span');
    timestamp.classList.add('timestamp');
    timestamp.textContent = messageData.displayTimestamp || 'Just now';
    if (messageData.timestamp) {
        try {
            const date = new Date(messageData.timestamp);
            timestamp.title = date.toLocaleString();
        } catch(e) {}
    }
    
    rightContainer.appendChild(timestamp);
    footerDiv.appendChild(rightContainer);
    contentDiv.appendChild(footerDiv);

    questionMessage.appendChild(avatarDiv);
    questionMessage.appendChild(contentDiv);
    
    applyRestoredTimingData(questionMessage, messageData);

    chatMessages.appendChild(questionMessage);
}
