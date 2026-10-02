document.addEventListener('DOMContentLoaded', async () => {
    await waitForAuthReady();

    const user = typeof getCurrentUser === 'function' ? getCurrentUser() : null;
    if (user && user.role !== 'instructor' && user.role !== 'ta') {
        window.location.href = '/login';
        return;
    }

    const form = document.getElementById('instructor-chat-form');
    const input = document.getElementById('instructor-chat-input');
    const messages = document.getElementById('chat-messages');
    const sendButton = document.getElementById('send-button');
    const newChatButton = document.getElementById('new-super-course-chat');
    const levelSelect = document.getElementById('answer-level');
    const scopeLabel = document.getElementById('super-course-scope');
    const poolPanel = document.getElementById('super-course-pool-panel');
    const poolList = document.getElementById('super-course-pool-list');
    const historyPanel = document.getElementById('super-course-history-panel');
    const historyList = document.getElementById('super-course-history-list');
    const toggleHistoryButton = document.getElementById('toggle-super-course-history');
    const refreshHistoryButton = document.getElementById('refresh-super-course-history');
    const conversationMessages = [];
    const instructorId = user?.userId || 'unknown-instructor';
    const instructorName = user?.displayName || user?.username || user?.email || 'Instructor';
    const currentChatKey = `biocbot_instructor_super_current_chat_${instructorId}`;
    const sessionKey = `biocbot_instructor_super_session_${instructorId}`;
    const historyStateKey = `biocbot_instructor_super_history_open_${instructorId}`;
    const SUPER_COURSE_FLAG_COURSE_ID = 'SUPER_COURSE';
    const GREETING_TEXT = 'Ask about material across the Super Course. I will use opted-in uploaded course material when relevant and can draw on general biochemistry when the uploaded context is thin.';

    if (!form || !input || !messages || !sendButton) {
        return;
    }

    // Persist the user's chosen answer depth across sessions.
    const levelStorageKey = `biocbot_instructor_super_level_${instructorId}`;
    if (levelSelect) {
        const savedLevel = localStorage.getItem(levelStorageKey);
        if (savedLevel && [...levelSelect.options].some(opt => opt.value === savedLevel)) {
            levelSelect.value = savedLevel;
        }
        levelSelect.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;

            try {
                if (typeof levelSelect.showPicker === 'function') {
                    levelSelect.showPicker();
                    event.preventDefault();
                }
            } catch {
                // Preserve the browser's native Space-key behavior.
            }
        });
        levelSelect.addEventListener('change', () => {
            localStorage.setItem(levelStorageKey, levelSelect.value);
        });
    }

    loadSourcePool();
    initializeHistoryDisclosure();
    loadHistoryList();
    initializeAutoSave();
    if (!restoreRecentSession()) {
        showGreeting({ save: true });
    }

    if (newChatButton) {
        newChatButton.addEventListener('click', () => {
            if (conversationMessages.length && !confirm('Start a new Super Course chat?')) {
                return;
            }
            startNewChat();
        });
    }

    if (refreshHistoryButton) {
        refreshHistoryButton.addEventListener('click', () => loadHistoryList());
    }

    if (toggleHistoryButton) {
        toggleHistoryButton.addEventListener('click', () => {
            setHistoryOpen(historyPanel?.classList.contains('collapsed'));
        });
    }

    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const text = input.value.trim();
        if (!text) return;

        input.value = '';
        addMessage(text, 'user');
        conversationMessages.push({ role: 'user', content: text });

        const typing = addMessage('Thinking...', 'bot', { isPending: true, skipAutoSave: true });
        setBusy(true);

        try {
            const response = await fetch('/api/instructor/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({
                    message: text,
                    conversationMessages,
                    level: levelSelect ? levelSelect.value : undefined
                })
            });

            const result = await response.json();
            if (!response.ok || !result.success) {
                throw new Error(result.message || 'Failed to send message');
            }

            typing.remove();
            addMessage(result.message || '', 'bot', {
                sourceAttribution: result.sourceAttribution,
                citations: result.citations
            });
            conversationMessages.push({ role: 'assistant', content: result.message || '' });
        } catch (error) {
            console.error('Instructor chat error:', error);
            typing.remove();
            addMessage(error.message || 'Sorry, I could not process that message. Please try again.', 'bot', {
                isError: true,
                skipAutoSave: true
            });
        } finally {
            setBusy(false);
            input.focus();
        }
    });

    document.addEventListener('click', (event) => {
        if (!event.target.closest('.message-flag-container')) {
            closeFlagMenus();
        }
    });

    function setBusy(isBusy) {
        sendButton.disabled = isBusy;
        input.disabled = isBusy;
        sendButton.textContent = isBusy ? 'Sending...' : 'Send';
    }

    function addMessage(content, sender, options = {}) {
        const message = document.createElement('div');
        message.className = `message ${sender}-message${options.isPending ? ' pending-message' : ''}${options.isError ? ' error-message' : ''}`;

        const avatar = document.createElement('div');
        avatar.className = 'message-avatar';
        avatar.textContent = sender === 'user' ? 'I' : 'B';

        const contentWrap = document.createElement('div');
        contentWrap.className = 'message-content';

        const text = document.createElement('p');
        text.innerText = content;
        text.style.whiteSpace = 'pre-wrap';
        contentWrap.appendChild(text);

        const footer = document.createElement('div');
        footer.className = 'message-footer';

        if (sender === 'bot' && options.sourceAttribution) {
            footer.appendChild(renderSourceAttribution(options.sourceAttribution));
        } else if (sender === 'bot' && Array.isArray(options.citations) && options.citations.length) {
            footer.appendChild(renderCitationSummary(options.citations));
        }

        const right = document.createElement('div');
        right.className = 'message-footer-right';

        if (sender === 'bot' && !options.isPending && !options.isError && !options.isGreeting) {
            right.appendChild(createFlagControl(content, options));
        }

        const timestamp = document.createElement('span');
        timestamp.className = 'timestamp';
        timestamp.textContent = 'Just now';
        right.appendChild(timestamp);
        footer.appendChild(right);
        contentWrap.appendChild(footer);

        message.appendChild(avatar);
        message.appendChild(contentWrap);
        messages.appendChild(message);
        messages.scrollTop = messages.scrollHeight;

        if (!options.skipAutoSave && !options.isPending && !options.isError) {
            autoSaveMessage(content, sender, {
                sourceAttribution: options.sourceAttribution || null,
                citations: Array.isArray(options.citations) ? options.citations : [],
                isError: options.isError === true,
                isGreeting: options.isGreeting === true
            });
        }

        return message;
    }

    function createFlagControl(messageText, options = {}) {
        const container = document.createElement('div');
        container.className = 'message-flag-container';

        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'flag-button';
        button.innerHTML = Icons.flag;
        button.title = 'Flag this message';
        button.addEventListener('click', (event) => {
            event.stopPropagation();
            toggleFlagMenu(button);
        });

        const menu = document.createElement('div');
        menu.className = 'flag-menu';
        [
            ['incorrect', 'Incorrect'],
            ['inappropriate', 'Inappropriate'],
            ['unclear', 'Unclear'],
            ['confusing', 'Confusing'],
            ['typo', 'Typo/Error'],
            ['offensive', 'Offensive'],
            ['irrelevant', 'Irrelevant']
        ].forEach(([reason, label]) => {
            const option = document.createElement('button');
            option.type = 'button';
            option.className = 'flag-option';
            option.textContent = label;
            option.addEventListener('click', async (event) => {
                event.stopPropagation();
                menu.classList.remove('show');
                await submitSuperCourseFlag(messageText, reason, options);
                replaceMessageWithThankYou(container.closest('.message-content'), reason);
            });
            menu.appendChild(option);
        });

        container.appendChild(button);
        container.appendChild(menu);
        return container;
    }

    function toggleFlagMenu(button) {
        const menu = button.nextElementSibling;
        closeFlagMenus(menu);
        if (menu && menu.classList.contains('flag-menu')) {
            menu.classList.toggle('show');
        }
    }

    function closeFlagMenus(exceptMenu = null) {
        document.querySelectorAll('.flag-menu.show').forEach(menu => {
            if (menu !== exceptMenu) {
                menu.classList.remove('show');
            }
        });
    }

    async function submitSuperCourseFlag(messageText, flagReason, options = {}) {
        const sourceCourses = getSourceCourses(options);
        const flagData = {
            questionId: generateFlagQuestionId(messageText),
            courseId: SUPER_COURSE_FLAG_COURSE_ID,
            unitName: 'Super Course',
            flagReason,
            flagDescription: `Instructor flagged Super Course response as ${flagReason}`,
            botMode: 'supercourse-instructor',
            isSuperCourseFlag: true,
            sourceCourseIds: sourceCourses.map(course => course.courseId),
            sourceCourseNames: sourceCourses.map(course => course.courseName),
            questionContent: {
                question: messageText,
                questionType: 'super-course-bot-response',
                options: {},
                correctAnswer: 'N/A',
                explanation: 'This is a flagged bot response from the instructor Super Course chat interface'
            }
        };

        try {
            const response = await fetch('/api/flags', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify(flagData)
            });
            const result = await response.json().catch(() => ({}));
            if (!response.ok || !result.success) {
                throw new Error(result.message || `HTTP error! status: ${response.status}`);
            }
        } catch (error) {
            console.error('Error submitting Super Course flag:', error);
        }
    }

    function getSourceCourses(options = {}) {
        const docs = Array.isArray(options.sourceAttribution?.documents) && options.sourceAttribution.documents.length
            ? options.sourceAttribution.documents
            : (Array.isArray(options.citations) ? options.citations : []);
        const seen = new Set();

        return docs.reduce((courses, doc) => {
            const courseId = doc && doc.courseId ? String(doc.courseId).trim() : '';
            if (!courseId || seen.has(courseId)) return courses;
            seen.add(courseId);
            courses.push({
                courseId,
                courseName: doc.courseName || courseId
            });
            return courses;
        }, []);
    }

    function generateFlagQuestionId(messageText) {
        const textHash = String(messageText || '')
            .split('')
            .reduce((hash, char) => ((hash << 5) - hash) + char.charCodeAt(0), 0);
        return `super_instructor_${Date.now()}_${Math.abs(textHash).toString(36)}`;
    }

    function replaceMessageWithThankYou(messageContent, flagReason) {
        const paragraph = messageContent && messageContent.querySelector('p');
        if (!paragraph) return;

        const descriptions = {
            incorrect: 'incorrect information',
            inappropriate: 'inappropriate content',
            unclear: 'unclear or confusing content',
            confusing: 'confusing content',
            typo: 'typo or error',
            offensive: 'offensive content',
            irrelevant: 'irrelevant content'
        };
        paragraph.textContent = `Thank you for reporting this response as ${descriptions[flagReason] || flagReason}. This has been logged for admin review.`;
        paragraph.style.color = '#666';
        paragraph.style.fontStyle = 'italic';
    }

    function initializeAutoSave() {
        const existing = getCurrentChatData();
        if (existing && Array.isArray(existing.messages)) {
            ensureSessionId(existing);
            localStorage.setItem(currentChatKey, JSON.stringify(existing));
            return;
        }

        localStorage.setItem(currentChatKey, JSON.stringify(createEmptyChatData()));
    }

    function createEmptyChatData() {
        const sessionId = getOrCreateSessionId();
        const now = new Date().toISOString();
        return {
            metadata: {
                exportDate: now,
                courseId: 'SUPER_COURSE',
                courseName: 'Super Course',
                instructorId,
                instructorName,
                unitName: 'Super Course',
                currentMode: 'instructor-super-course',
                totalMessages: 0,
                version: '1.0'
            },
            messages: [],
            sessionInfo: {
                sessionId,
                startTime: now,
                endTime: null,
                duration: '0s'
            },
            lastActivityTimestamp: now
        };
    }

    function autoSaveMessage(content, sender, options = {}) {
        try {
            const chatData = getCurrentChatData() || createEmptyChatData();
            ensureSessionId(chatData);

            chatData.messages.push({
                type: sender,
                content,
                timestamp: new Date().toISOString(),
                messageType: 'instructor-super-course-chat',
                sourceAttribution: options.sourceAttribution || null,
                citations: options.citations || [],
                isError: options.isError === true,
                isGreeting: options.isGreeting === true
            });

            chatData.metadata.totalMessages = chatData.messages.length;
            chatData.metadata.exportDate = new Date().toISOString();
            chatData.sessionInfo.endTime = new Date().toISOString();
            chatData.sessionInfo.duration = calculateSessionDuration(chatData);
            chatData.lastActivityTimestamp = new Date().toISOString();

            localStorage.setItem(currentChatKey, JSON.stringify(chatData));

            // Persist the greeting locally so it survives refreshes, but don't create a
            // server-side history entry for a chat that only contains the greeting (no
            // real exchange yet). Once a real message exists, the greeting syncs with it.
            const hasRealMessage = chatData.messages.some(message => !message.isGreeting);
            if (hasRealMessage) {
                syncAutoSaveWithServer(chatData);
            }
        } catch (error) {
            console.error('Error auto-saving instructor chat:', error);
        }
    }

    function restoreRecentSession() {
        const chatData = getCurrentChatData();
        if (!chatData || !Array.isArray(chatData.messages) || chatData.messages.length === 0) {
            return false;
        }

        const restorableMessages = chatData.messages.filter(message => !message.isError);
        if (restorableMessages.length === 0) {
            resetToFreshSession();
            return false;
        }

        if (!chatData.lastActivityTimestamp) {
            resetToFreshSession();
            return false;
        }

        const lastActivity = new Date(chatData.lastActivityTimestamp);
        const diffMinutes = Math.floor((Date.now() - lastActivity.getTime()) / (1000 * 60));
        if (Number.isNaN(diffMinutes) || diffMinutes > 30) {
            // Session is stale: clear it out so the next message starts a brand new
            // session instead of being appended to the expired one.
            resetToFreshSession();
            return false;
        }

        ensureSessionId(chatData);
        loadChatData(chatData);
        // Only announce "continued where you left off" if there's a real exchange to
        // continue — a greeting-only session shouldn't trigger that notification.
        if (restorableMessages.some(message => !message.isGreeting)) {
            showAutoContinueNotification();
        }
        return true;
    }

    // Clears any stored chat/session state and starts a fresh, empty autosave session
    // with a new session ID. The caller is responsible for re-rendering the greeting.
    function resetToFreshSession() {
        localStorage.removeItem(currentChatKey);
        localStorage.removeItem(sessionKey);
        conversationMessages.length = 0;
        initializeAutoSave();
    }

    // Renders the standard Super Course greeting as the first bot message. When `save`
    // is true, the greeting is persisted into the current chat data so it survives
    // refreshes and appears at the top of saved history sessions.
    function showGreeting({ save = false } = {}) {
        messages.innerHTML = '';
        addMessage(GREETING_TEXT, 'bot', { isGreeting: true, skipAutoSave: !save });
    }

    function loadChatData(chatData) {
        messages.innerHTML = '';
        conversationMessages.length = 0;

        const restorableMessages = chatData.messages.filter(messageData => !messageData.isError);
        if (!restorableMessages.length) {
            return;
        }

        restorableMessages.forEach(messageData => {
            addMessage(messageData.content, messageData.type, {
                sourceAttribution: messageData.sourceAttribution,
                citations: messageData.citations,
                isError: messageData.isError,
                isGreeting: messageData.isGreeting === true,
                skipAutoSave: true
            });

            // The greeting is display-only — never feed it back to the LLM as context.
            if (messageData.isGreeting) {
                return;
            }

            if (messageData.type === 'user') {
                conversationMessages.push({ role: 'user', content: messageData.content });
            } else if (messageData.type === 'bot' && !messageData.isError) {
                conversationMessages.push({ role: 'assistant', content: messageData.content });
            }
        });

        localStorage.setItem(currentChatKey, JSON.stringify(chatData));
    }

    function startNewChat() {
        localStorage.removeItem(currentChatKey);
        localStorage.removeItem(sessionKey);
        conversationMessages.length = 0;
        initializeAutoSave();
        showGreeting({ save: true });
        loadHistoryList({ silent: true });
        input.focus();
    }

    function getCurrentChatData() {
        try {
            const raw = localStorage.getItem(currentChatKey);
            return raw ? JSON.parse(raw) : null;
        } catch (error) {
            console.error('Error reading instructor chat data:', error);
            return null;
        }
    }

    function getOrCreateSessionId() {
        let sessionId = localStorage.getItem(sessionKey);
        if (!sessionId) {
            sessionId = `autosave_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
            localStorage.setItem(sessionKey, sessionId);
        }
        return sessionId;
    }

    function ensureSessionId(chatData) {
        if (!chatData.sessionInfo) {
            chatData.sessionInfo = {};
        }

        if (chatData.sessionInfo.sessionId) {
            localStorage.setItem(sessionKey, chatData.sessionInfo.sessionId);
            return chatData.sessionInfo.sessionId;
        }

        const sessionId = getOrCreateSessionId();
        chatData.sessionInfo.sessionId = sessionId;
        return sessionId;
    }

    function calculateSessionDuration(chatData) {
        if (!chatData || !Array.isArray(chatData.messages) || chatData.messages.length === 0) {
            return '0s';
        }

        const firstUserMessage = chatData.messages.find(msg => msg.type === 'user');
        if (!firstUserMessage?.timestamp) {
            return '0s';
        }

        const lastBotMessage = chatData.messages.slice().reverse().find(msg => msg.type === 'bot');
        const lastMessage = lastBotMessage || chatData.messages[chatData.messages.length - 1];
        if (!lastMessage?.timestamp) {
            return '0s';
        }

        const diffMs = new Date(lastMessage.timestamp) - new Date(firstUserMessage.timestamp);
        const safeDiffMs = Math.max(0, Number.isFinite(diffMs) ? diffMs : 0);
        const hours = Math.floor(safeDiffMs / (1000 * 60 * 60));
        const minutes = Math.floor((safeDiffMs % (1000 * 60 * 60)) / (1000 * 60));
        const seconds = Math.floor((safeDiffMs % (1000 * 60)) / 1000);

        if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
        if (minutes > 0) return `${minutes}m ${seconds}s`;
        return `${seconds}s`;
    }

    function syncAutoSaveWithServer(chatData) {
        const sessionId = ensureSessionId(chatData);
        const serverData = {
            sessionId,
            title: generateChatTitle(chatData),
            messageCount: chatData.metadata.totalMessages,
            duration: chatData.sessionInfo.duration,
            savedAt: chatData.metadata.exportDate,
            chatData
        };

        fetch('/api/instructor/chat/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify(serverData)
        }).then(response => {
            if (response.ok) {
                loadHistoryList({ silent: true });
            }
        }).catch(error => {
            console.warn('Instructor chat server sync failed:', error.message);
        });
    }

    function generateChatTitle(chatData) {
        const firstUserMessage = chatData.messages.find(msg => msg.type === 'user');
        if (firstUserMessage) {
            const question = firstUserMessage.content.slice(0, 50);
            return `Super Course - ${question}${question.length >= 50 ? '...' : ''}`;
        }
        return `Super Course Chat (${chatData.metadata.totalMessages} messages)`;
    }

    function showAutoContinueNotification() {
        if (typeof showNotification === 'function') {
            showNotification('Chat continued from where you left off', 'success');
        }
    }

    function initializeHistoryDisclosure() {
        const shouldOpen = localStorage.getItem(historyStateKey) === 'open';
        setHistoryOpen(shouldOpen);
    }

    function setHistoryOpen(isOpen) {
        if (!historyPanel) return;
        historyPanel.classList.toggle('collapsed', !isOpen);
        localStorage.setItem(historyStateKey, isOpen ? 'open' : 'closed');
        if (toggleHistoryButton) {
            toggleHistoryButton.setAttribute('aria-expanded', String(isOpen));
        }
    }

    async function loadHistoryList(options = {}) {
        if (!historyList) return;

        if (!options.silent) {
            historyList.textContent = 'Loading history...';
        }

        try {
            const response = await fetch('/api/instructor/chat/sessions', { credentials: 'include' });
            const result = await response.json();
            if (!response.ok || !result.success) {
                throw new Error(result.message || 'Failed to load chat history');
            }

            renderHistoryList(result.data?.sessions || []);
        } catch (error) {
            console.error('Instructor Super Chat history load error:', error);
            if (!options.silent) {
                historyList.textContent = 'Unable to load history.';
            }
        }
    }

    function renderHistoryList(sessions) {
        if (!historyList) return;
        historyList.innerHTML = '';

        if (!sessions.length) {
            const empty = document.createElement('div');
            empty.className = 'super-course-history-empty';
            empty.textContent = 'No saved Super Chat sessions yet.';
            historyList.appendChild(empty);
            return;
        }

        sessions.slice(0, 12).forEach(session => {
            historyList.appendChild(createHistoryItem(session));
        });
    }

    function createHistoryItem(session) {
        const item = document.createElement('article');
        item.className = 'super-course-history-item';
        item.dataset.sessionId = session.sessionId || '';

        const title = document.createElement('div');
        title.className = 'super-course-history-title';
        title.textContent = session.title || 'Super Course Chat';

        const preview = document.createElement('div');
        preview.className = 'super-course-history-preview';
        preview.textContent = generateHistoryPreview(session.chatData);

        const meta = document.createElement('div');
        meta.className = 'super-course-history-meta';
        meta.textContent = [
            formatHistoryDate(session.savedAt || session.updatedAt),
            `${session.messageCount || 0} messages`,
            session.duration || '0s'
        ].filter(Boolean).join(' | ');

        const actions = document.createElement('div');
        actions.className = 'super-course-history-actions';

        const continueButton = document.createElement('button');
        continueButton.type = 'button';
        continueButton.className = 'super-course-history-action primary';
        continueButton.textContent = 'Continue';
        continueButton.addEventListener('click', (event) => {
            event.stopPropagation();
            loadHistorySession(session.sessionId);
        });

        const deleteButton = document.createElement('button');
        deleteButton.type = 'button';
        deleteButton.className = 'super-course-history-action';
        deleteButton.textContent = 'Delete';
        deleteButton.addEventListener('click', (event) => {
            event.stopPropagation();
            deleteHistorySession(session.sessionId);
        });

        actions.appendChild(continueButton);
        actions.appendChild(deleteButton);
        item.appendChild(title);
        item.appendChild(preview);
        item.appendChild(meta);
        item.appendChild(actions);

        item.addEventListener('click', () => loadHistorySession(session.sessionId));
        return item;
    }

    async function loadHistorySession(sessionId) {
        if (!sessionId) return;

        try {
            const response = await fetch(`/api/instructor/chat/sessions/${encodeURIComponent(sessionId)}`, {
                credentials: 'include'
            });
            const result = await response.json();
            if (!response.ok || !result.success || !result.session?.chatData) {
                throw new Error(result.message || 'Failed to load chat session');
            }

            const chatData = result.session.chatData;
            ensureSessionId(chatData);
            loadChatData(chatData);
            markActiveHistorySession(sessionId);
            if (typeof showNotification === 'function') {
                showNotification('Super Chat session loaded', 'success');
            }
        } catch (error) {
            console.error('Error loading instructor Super Chat session:', error);
            if (typeof showNotification === 'function') {
                showNotification('Unable to load that Super Chat session', 'error');
            }
        }
    }

    async function deleteHistorySession(sessionId) {
        if (!sessionId || !confirm('Delete this Super Chat session?')) return;

        try {
            const response = await fetch(`/api/instructor/chat/sessions/${encodeURIComponent(sessionId)}`, {
                method: 'DELETE',
                credentials: 'include'
            });
            const result = await response.json().catch(() => ({}));
            if (!response.ok || !result.success) {
                throw new Error(result.message || 'Failed to delete chat session');
            }

            const current = getCurrentChatData();
            if (current?.sessionInfo?.sessionId === sessionId) {
                startNewChat();
            }
            loadHistoryList();
        } catch (error) {
            console.error('Error deleting instructor Super Chat session:', error);
            if (typeof showNotification === 'function') {
                showNotification('Unable to delete that Super Chat session', 'error');
            }
        }
    }

    function markActiveHistorySession(sessionId) {
        if (!historyList) return;
        historyList.querySelectorAll('.super-course-history-item').forEach(item => {
            item.classList.toggle('active', item.dataset.sessionId === sessionId);
        });
    }

    function generateHistoryPreview(chatData) {
        const messages = Array.isArray(chatData?.messages) ? chatData.messages : [];
        const firstUserMessage = messages.find(message => message.type === 'user' && message.content);
        if (firstUserMessage) {
            return firstUserMessage.content;
        }
        const firstMessage = messages.find(message => message.content);
        return firstMessage?.content || 'No message preview available.';
    }

    function formatHistoryDate(value) {
        if (!value) return '';
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return '';
        return date.toLocaleString([], {
            month: 'short',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit'
        });
    }

    function renderSourceAttribution(sourceAttribution) {
        const source = document.createElement('div');
        source.className = 'message-source super-course-source';

        const label = document.createElement('span');
        label.className = 'source-label';
        label.textContent = sourceAttribution.description || 'Super Course sources';
        source.appendChild(label);

        const documents = Array.isArray(sourceAttribution.documents)
            ? sourceAttribution.documents.slice(0, 5)
            : [];

        if (documents.length) {
            const list = document.createElement('div');
            list.className = 'super-course-citation-list';
            documents.forEach(doc => {
                const item = document.createElement('span');
                item.className = 'super-course-citation';
                item.textContent = [
                    doc.courseName || doc.courseId,
                    doc.unitName,
                    doc.fileName
                ].filter(Boolean).join(' / ');
                list.appendChild(item);
            });
            source.appendChild(list);
        } else if (Array.isArray(sourceAttribution.poolCourses) && sourceAttribution.poolCourses.length) {
            const poolNote = document.createElement('div');
            poolNote.className = 'super-course-pool-note';
            poolNote.textContent = `Configured sources: ${formatPoolCourseNames(sourceAttribution.poolCourses)}`;
            source.appendChild(poolNote);
        }

        return source;
    }

    function renderCitationSummary(citations) {
        return renderSourceAttribution({
            description: 'From uploaded Super Course material',
            documents: citations
        });
    }

    async function loadSourcePool() {
        if (!poolList) return;

        try {
            const response = await fetch('/api/instructor/chat/pool', { credentials: 'include' });
            const result = await response.json();

            if (!response.ok || !result.success) {
                throw new Error(result.message || 'Failed to load source pool');
            }

            const courses = Array.isArray(result.courses) ? result.courses : [];
            renderSourcePool(courses);
        } catch (error) {
            console.error('Source pool load error:', error);
            if (scopeLabel) scopeLabel.textContent = 'Source pool unavailable';
            poolList.textContent = 'Unable to load source pool.';
            if (poolPanel) poolPanel.classList.add('error');
        }
    }

    function renderSourcePool(courses) {
        if (scopeLabel) {
            scopeLabel.textContent = courses.length === 1
                ? formatPoolCourseName(courses[0])
                : `${courses.length} opted-in courses`;
        }

        if (!poolList) return;
        poolList.innerHTML = '';

        if (!courses.length) {
            poolList.textContent = 'No courses are currently included.';
            return;
        }

        const visibleCourses = courses.slice(0, 12);
        visibleCourses.forEach(course => {
            const chip = document.createElement('span');
            chip.className = 'super-course-pool-chip';
            chip.textContent = formatPoolCourseName(course);
            poolList.appendChild(chip);
        });

        if (courses.length > visibleCourses.length) {
            const more = document.createElement('span');
            more.className = 'super-course-pool-chip muted';
            more.textContent = `+${courses.length - visibleCourses.length} more`;
            poolList.appendChild(more);
        }
    }

    function formatPoolCourseName(course) {
        return course.courseName || course.courseId || 'Untitled course';
    }

    function formatPoolCourseNames(courses) {
        const names = courses.slice(0, 6).map(formatPoolCourseName).join(', ');
        return courses.length > 6 ? `${names}, and ${courses.length - 6} more` : names;
    }
});

function waitForAuthReady() {
    return new Promise(resolve => {
        if (typeof getCurrentUser === 'function' && getCurrentUser()) {
            resolve();
            return;
        }

        document.addEventListener('auth:ready', () => resolve(), { once: true });
        setTimeout(resolve, 5000);
    });
}
