/**
 * Quiz Practice Page Script
 * Handles loading questions, submitting answers, and tracking progress
 */

document.addEventListener('DOMContentLoaded', async () => {
    await waitForAuth();

    const courseId = getCurrentCourseId();
    if (!courseId) {
        showDisabled('No course selected. Please go to the Chat page and select a course first.');
        return;
    }

    // State
    let allQuestions = [];
    let filteredQuestions = [];
    let currentIndex = 0;
    let allowMaterials = false;
    let sessionCorrect = 0;
    let sessionTotal = 0;
    let answered = false;

    // Quiz help chat state
    let quizChatHistory = [];
    let quizChatActive = false;
    let currentQuestionContext = null;
    const QUIZ_CHAT_MAX_MESSAGES = 10;

    // DOM refs
    const loadingEl = document.getElementById('quiz-loading');
    const emptyEl = document.getElementById('quiz-empty');
    const disabledEl = document.getElementById('quiz-disabled');
    const questionCard = document.getElementById('question-card');
    const completeCard = document.getElementById('quiz-complete');
    const progressEl = document.getElementById('quiz-progress');
    const progressText = document.getElementById('progress-text');
    const progressFill = document.getElementById('progress-fill');
    const progressBar = progressFill?.closest('.progress-bar');

    const unitFilter = document.getElementById('unit-filter');
    const typeFilter = document.getElementById('type-filter');
    const shuffleBtn = document.getElementById('shuffle-btn');
    const submitBtn = document.getElementById('submit-btn');
    const nextBtn = document.getElementById('next-btn');
    const restartBtn = document.getElementById('restart-btn');

    // Quiz help chat DOM refs
    const quizChatContainer = document.getElementById('quiz-chat-container');
    const quizChatMessages = document.getElementById('quiz-chat-messages');
    const quizChatForm = document.getElementById('quiz-chat-form');
    const quizChatInput = document.getElementById('quiz-chat-input');
    const quizChatTyping = document.getElementById('quiz-chat-typing');
    const quizChatCloseBtn = document.getElementById('quiz-chat-close');

    // Load quiz data
    try {
        const [questionsRes, historyRes] = await Promise.all([
            fetch(`/api/quiz/questions?courseId=${courseId}`),
            fetch(`/api/quiz/history?courseId=${courseId}`)
        ]);

        const questionsData = await questionsRes.json();
        const historyData = await historyRes.json();

        if (!questionsRes.ok || !questionsData.success) {
            if (questionsRes.status === 403) {
                showDisabled(questionsData.message || 'Quiz practice is not enabled for this course.');
                return;
            }
            throw new Error(questionsData.message || 'Failed to load questions');
        }

        allQuestions = questionsData.questions || [];
        allowMaterials = questionsData.allowLectureMaterialAccess;

        // Populate unit filter
        const units = questionsData.units || [];
        for (const unit of units) {
            const option = document.createElement('option');
            option.value = unit.name;
            option.textContent = unit.displayName || unit.name;
            unitFilter.appendChild(option);
        }

        // Load stats
        if (historyData.success && historyData.stats) {
            updateGlobalStats(historyData.stats);
        }

        loadingEl.style.display = 'none';

        if (allQuestions.length === 0) {
            emptyEl.style.display = '';
            return;
        }

        applyFilters();
    } catch (error) {
        console.error('Error loading quiz data:', error);
        loadingEl.style.display = 'none';
        showDisabled('Error loading quiz data. Please try again later.');
    }

    // Filter & shuffle
    unitFilter.addEventListener('change', applyFilters);
    typeFilter.addEventListener('change', applyFilters);
    shuffleBtn.addEventListener('click', () => {
        shuffleArray(filteredQuestions);
        currentIndex = 0;
        sessionCorrect = 0;
        sessionTotal = 0;
        displayQuestion();
    });

    submitBtn.addEventListener('click', submitAnswer);
    nextBtn.addEventListener('click', nextQuestion);
    restartBtn.addEventListener('click', () => {
        shuffleArray(filteredQuestions);
        currentIndex = 0;
        sessionCorrect = 0;
        sessionTotal = 0;
        completeCard.style.display = 'none';
        displayQuestion();
    });

    // Quiz help chat event listeners
    if (quizChatForm) {
        quizChatForm.addEventListener('submit', (e) => {
            e.preventDefault();
            const message = quizChatInput.value.trim();
            if (message) {
                sendQuizChatMessage(message);
            }
        });
    }

    if (quizChatCloseBtn) {
        quizChatCloseBtn.addEventListener('click', () => {
            closeQuizChat();
        });
    }

    function applyFilters() {
        const unit = unitFilter.value;
        const type = typeFilter.value;

        filteredQuestions = allQuestions.filter(q => {
            if (unit !== 'all' && q.lectureName !== unit) return false;
            if (type !== 'all' && q.questionType !== type) return false;
            return true;
        });

        shuffleArray(filteredQuestions);
        currentIndex = 0;
        sessionCorrect = 0;
        sessionTotal = 0;

        if (filteredQuestions.length === 0) {
            questionCard.style.display = 'none';
            completeCard.style.display = 'none';
            progressEl.style.display = 'none';
            emptyEl.style.display = '';
        } else {
            emptyEl.style.display = 'none';
            displayQuestion();
        }
    }

    function displayQuestion() {
        if (currentIndex >= filteredQuestions.length) {
            showCompletion();
            return;
        }

        const q = filteredQuestions[currentIndex];
        answered = false;

        // Show card, hide others
        questionCard.style.display = '';
        completeCard.style.display = 'none';
        progressEl.style.display = '';

        // Progress
        progressText.textContent = `Question ${currentIndex + 1} of ${filteredQuestions.length}`;
        progressFill.style.width = `${((currentIndex) / filteredQuestions.length) * 100}%`;
        progressBar?.setAttribute('aria-valuenow', String(currentIndex));
        progressBar?.setAttribute('aria-valuemin', '0');
        progressBar?.setAttribute('aria-valuemax', String(filteredQuestions.length));

        // Meta
        document.getElementById('question-unit').textContent = q.lectureName;

        const typeBadge = document.getElementById('question-type-badge');
        const typeLabels = { 'multiple-choice': 'Multiple Choice', 'true-false': 'True/False', 'short-answer': 'Short Answer' };
        typeBadge.textContent = typeLabels[q.questionType] || q.questionType;


        // Question text
        renderRichQuestionText(document.getElementById('question-text'), q.question);

        // Hide all answer areas
        document.getElementById('mc-options').style.display = 'none';
        document.getElementById('tf-options').style.display = 'none';
        document.getElementById('sa-container').style.display = 'none';

        // Show appropriate answer area
        if (q.questionType === 'multiple-choice') {
            const mcContainer = document.getElementById('mc-options');
            mcContainer.innerHTML = '';
            mcContainer.style.display = '';

            const sortedKeys = Object.keys(q.options).sort();
            for (const key of sortedKeys) {
                const label = document.createElement('label');
                label.className = 'option-label';

                const radio = document.createElement('input');
                radio.type = 'radio';
                radio.name = 'mc-answer';
                radio.value = key;

                const text = document.createElement('span');
                text.className = 'option-text';
                renderRichQuestionText(text, `${key}. ${q.options[key]}`);

                label.appendChild(radio);
                label.appendChild(text);
                mcContainer.appendChild(label);
            }
        } else if (q.questionType === 'true-false') {
            document.getElementById('tf-options').style.display = '';
            const radios = document.querySelectorAll('input[name="tf-answer"]');
            radios.forEach(r => { r.checked = false; });
            document.querySelectorAll('#tf-options .option-label').forEach(l => {
                l.className = 'option-label';
            });
        } else if (q.questionType === 'short-answer') {
            document.getElementById('sa-container').style.display = '';
            const saInput = document.getElementById('sa-input');
            saInput.value = '';
            saInput.disabled = false;
        }

        // Reset buttons & feedback
        submitBtn.style.display = '';
        submitBtn.disabled = false;
        submitBtn.textContent = 'Submit Answer';
        nextBtn.style.display = 'none';
        document.getElementById('feedback-container').style.display = 'none';
        document.getElementById('materials-container').style.display = 'none';
        if (quizChatContainer) quizChatContainer.style.display = 'none';
    }

    async function submitAnswer() {
        if (answered) return;

        const q = filteredQuestions[currentIndex];
        let studentAnswer = '';

        if (q.questionType === 'multiple-choice') {
            const selected = document.querySelector('input[name="mc-answer"]:checked');
            if (!selected) {
                showNotification('Please select an answer.');
                return;
            }
            studentAnswer = selected.value;
        } else if (q.questionType === 'true-false') {
            const selected = document.querySelector('input[name="tf-answer"]:checked');
            if (!selected) {
                showNotification('Please select True or False.');
                return;
            }
            studentAnswer = selected.value;
        } else if (q.questionType === 'short-answer') {
            studentAnswer = document.getElementById('sa-input').value.trim();
            if (!studentAnswer) {
                showNotification('Please type your answer.');
                return;
            }
        }

        answered = true;
        submitBtn.disabled = true;
        submitBtn.textContent = 'Checking...';

        let correct = false;
        let feedback = '';

        let serverCorrectAnswer = null;

        try {
            // All question types are checked server-side
            const displayName = (typeof currentUser !== 'undefined' && currentUser)
                ? (currentUser.displayName || currentUser.username || 'Student')
                : 'Student';

            const res = await fetch('/api/quiz/check-answer', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    courseId,
                    questionId: q.questionId,
                    lectureName: q.lectureName,
                    studentAnswer,
                    studentName: displayName
                })
            });

            const data = await res.json();
            if (data.success && data.data) {
                correct = data.data.correct;
                feedback = data.data.feedback || (correct ? 'Correct!' : 'Incorrect.');
                serverCorrectAnswer = data.data.correctAnswer ?? null;
            } else {
                feedback = 'Unable to evaluate answer. Please try again.';
            }

            if (q.questionType === 'multiple-choice' || q.questionType === 'true-false') {
                highlightOptions(q, studentAnswer, serverCorrectAnswer);
            } else {
                document.getElementById('sa-input').disabled = true;
            }
        } catch (error) {
            console.error('Error checking answer:', error);
            feedback = 'Error checking answer. Please try again.';
        }

        // Show feedback
        showFeedback(correct, feedback);

        // Update session stats
        sessionTotal++;
        if (correct) sessionCorrect++;

        // Record attempt
        try {
            await fetch('/api/quiz/attempt', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    courseId,
                    questionId: q.questionId,
                    lectureName: q.lectureName,
                    questionType: q.questionType,
                    studentAnswer,
                    correct,
                    feedback
                })
            });
        } catch (e) {
            console.error('Error recording attempt:', e);
        }

        // Refresh global stats
        try {
            const histRes = await fetch(`/api/quiz/history?courseId=${courseId}`);
            const histData = await histRes.json();
            if (histData.success && histData.stats) {
                updateGlobalStats(histData.stats);
            }
        } catch (e) {
            console.error('Error refreshing stats:', e);
        }

        // Show materials if wrong and allowed
        if (!correct && allowMaterials) {
            loadMaterials(q.lectureName);
        }

        // Open quiz help chat on wrong answer
        if (!correct) {
            openQuizChat(q, studentAnswer, feedback, serverCorrectAnswer);
        }

        // Show next button
        submitBtn.style.display = 'none';
        nextBtn.style.display = '';
    }

    function nextQuestion() {
        closeQuizChat();
        currentIndex++;
        displayQuestion();
    }

    function highlightOptions(q, studentAnswer, correctAnswer) {
        const containerSelector = q.questionType === 'multiple-choice' ? '#mc-options' : '#tf-options';
        const labels = document.querySelectorAll(`${containerSelector} .option-label`);
        const normalizedStudentAnswer = String(studentAnswer).toLowerCase();
        const normalizedCorrectAnswer = correctAnswer === null || correctAnswer === undefined
            ? null
            : String(correctAnswer).toLowerCase();

        labels.forEach(label => {
            const radio = label.querySelector('input[type="radio"]');
            label.classList.add('disabled');
            const normalizedValue = String(radio.value).toLowerCase();

            if (normalizedCorrectAnswer !== null && normalizedValue === normalizedCorrectAnswer) {
                label.classList.add(normalizedValue === normalizedStudentAnswer ? 'correct' : 'was-correct');
            } else if (normalizedValue === normalizedStudentAnswer) {
                label.classList.add('incorrect');
            }
        });
    }

    /**
     * Show generated question text, typesetting any formulas and drawing any
     * molecules it contains.
     *
     * Falls back to plain text if rich-text.js did not load, so a missing
     * script costs the typesetting rather than the question.
     *
     * @param {Element} element Element to fill
     * @param {string} text Text as written by the generator
     * @returns {void}
     */
    function renderRichQuestionText(element, text) {
        if (!element) return;
        if (typeof RichText === 'undefined') {
            element.textContent = String(text || '');
            return;
        }
        RichText.render(element, text);
    }

    function showFeedback(correct, text) {
        const container = document.getElementById('feedback-container');
        const icon = document.getElementById('feedback-icon');
        const textEl = document.getElementById('feedback-text');

        container.className = 'feedback-container ' + (correct ? 'correct' : 'incorrect');
        icon.textContent = correct ? '\u2705' : '\u274C';
        renderRichQuestionText(textEl, text);
        container.style.display = '';
    }

    async function loadMaterials(lectureName) {
        try {
            const res = await fetch(`/api/quiz/materials?courseId=${courseId}&lectureName=${encodeURIComponent(lectureName)}`);
            const data = await res.json();

            if (!data.success || !data.materials || data.materials.length === 0) return;

            const container = document.getElementById('materials-container');
            const list = document.getElementById('materials-list');
            list.innerHTML = '';

            for (const mat of data.materials) {
                const item = document.createElement('div');
                item.className = 'material-item';
                item.onclick = () => downloadMaterial(mat.documentId, mat.originalName);

                const icon = document.createElement('span');
                icon.className = 'material-icon';
                icon.textContent = getFileIcon(mat.mimeType);

                const name = document.createElement('span');
                name.className = 'material-name';
                name.textContent = mat.originalName;

                const size = document.createElement('span');
                size.className = 'material-size';
                size.textContent = formatFileSize(mat.size);

                item.appendChild(icon);
                item.appendChild(name);
                item.appendChild(size);
                list.appendChild(item);
            }

            container.style.display = '';
        } catch (e) {
            console.error('Error loading materials:', e);
        }
    }

    async function downloadMaterial(documentId, filename) {
        try {
            const res = await fetch(`/api/quiz/materials/${documentId}/download?courseId=${courseId}`);
            if (!res.ok) {
                showNotification('Unable to download this document.');
                return;
            }

            const blob = await res.blob();
            const url = URL.createObjectURL(blob);
            const disposition = res.headers.get('Content-Disposition') || '';
            const nameFromHeader = extractFilenameFromDisposition(disposition);

            const a = document.createElement('a');
            a.href = url;
            a.download = nameFromHeader || filename || 'document';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        } catch (e) {
            console.error('Error downloading material:', e);
            showNotification('Error downloading material.');
        }
    }

    function extractFilenameFromDisposition(contentDisposition) {
        if (!contentDisposition) return null;
        const utf8Match = contentDisposition.match(/filename\*=UTF-8''([^;]+)/i);
        if (utf8Match && utf8Match[1]) {
            try {
                return decodeURIComponent(utf8Match[1]);
            } catch (_) {
                return utf8Match[1];
            }
        }

        const asciiMatch = contentDisposition.match(/filename="([^"]+)"/i);
        if (asciiMatch && asciiMatch[1]) {
            return asciiMatch[1];
        }

        return null;
    }

    // ==============================
    // Quiz Help Chat Functions
    // ==============================

    /**
     * Open the quiz help chat panel for a wrong answer
     */
    function openQuizChat(question, studentAnswer, saFeedback, serverCorrectAnswer) {
        // Build the correct answer string based on question type
        let correctAnswerStr = '';
        if (question.questionType === 'multiple-choice' && serverCorrectAnswer) {
            correctAnswerStr = `${serverCorrectAnswer}. ${question.options[serverCorrectAnswer] || ''}`;
        } else if (question.questionType === 'true-false' && serverCorrectAnswer) {
            correctAnswerStr = String(serverCorrectAnswer);
        } else if (question.questionType === 'short-answer') {
            // Short-answer correctAnswer is not on the client; server will look it up
            correctAnswerStr = '[evaluated by AI on server]';
        }

        // Build student answer display string
        let studentAnswerStr = studentAnswer;
        if (question.questionType === 'multiple-choice' && question.options && question.options[studentAnswer]) {
            studentAnswerStr = `${studentAnswer}. ${question.options[studentAnswer]}`;
        }

        currentQuestionContext = {
            questionText: question.question,
            questionType: question.questionType,
            correctAnswer: correctAnswerStr,
            studentAnswer: studentAnswerStr,
            lectureName: question.lectureName
        };

        quizChatHistory = [];
        quizChatMessages.innerHTML = '';
        quizChatActive = true;

        // Add initial bot message
        addQuizChatMessage(
            'I noticed you got this one wrong. No worries - let me help you understand the concept! What part are you finding confusing?',
            'bot'
        );

        quizChatContainer.style.display = '';

        // Scroll the chat panel into view
        setTimeout(() => {
            quizChatContainer.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            quizChatInput.focus();
        }, 100);
    }

    /**
     * Close and reset the quiz help chat
     */
    function closeQuizChat() {
        quizChatActive = false;
        quizChatHistory = [];
        currentQuestionContext = null;
        if (quizChatMessages) quizChatMessages.innerHTML = '';
        if (quizChatContainer) quizChatContainer.style.display = 'none';
        if (quizChatTyping) quizChatTyping.style.display = 'none';
        if (quizChatInput) {
            quizChatInput.disabled = false;
            quizChatInput.value = '';
        }
        const sendBtn = document.getElementById('quiz-chat-send');
        if (sendBtn) sendBtn.disabled = false;
    }

    /**
     * Add a message to the quiz chat display
     */
    function addQuizChatMessage(text, role) {
        const msgDiv = document.createElement('div');
        msgDiv.className = `quiz-chat-msg ${role}`;
        msgDiv.textContent = text;
        quizChatMessages.appendChild(msgDiv);
        if (role === 'bot' && typeof window.applyLLMTagClassesToElement === 'function') {
            window.applyLLMTagClassesToElement(msgDiv);
        }
        quizChatMessages.scrollTop = quizChatMessages.scrollHeight;
    }

    /**
     * Send a message in the quiz help chat
     */
    async function sendQuizChatMessage(message) {
        if (!message.trim() || !quizChatActive || !currentQuestionContext) return;

        // Check message limit
        const userMsgCount = quizChatHistory.filter(m => m.role === 'user').length;
        if (userMsgCount >= QUIZ_CHAT_MAX_MESSAGES) {
            addQuizChatMessage(
                'You have reached the message limit for this question. Click "Next Question" to continue, or review the materials above.',
                'system'
            );
            quizChatInput.disabled = true;
            document.getElementById('quiz-chat-send').disabled = true;
            return;
        }

        // Add user message to UI and history
        addQuizChatMessage(message, 'user');
        quizChatHistory.push({ role: 'user', content: message });

        // Disable input while waiting
        quizChatInput.disabled = true;
        quizChatInput.value = '';
        document.getElementById('quiz-chat-send').disabled = true;
        quizChatTyping.style.display = '';

        try {
            const response = await fetch('/api/quiz/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    message,
                    courseId,
                    lectureName: currentQuestionContext.lectureName,
                    questionText: currentQuestionContext.questionText,
                    questionType: currentQuestionContext.questionType,
                    correctAnswer: currentQuestionContext.correctAnswer,
                    studentAnswer: currentQuestionContext.studentAnswer,
                    conversationHistory: quizChatHistory
                })
            });

            const data = await response.json();
            quizChatTyping.style.display = 'none';

            if (data.success) {
                if (typeof window.applyLLMBodyTag === 'function') {
                    await window.applyLLMBodyTag();
                }
                const botMessage = data.message;
                addQuizChatMessage(botMessage, data.source === 'system' ? 'system' : 'bot');
                quizChatHistory.push({ role: 'assistant', content: botMessage });
            } else {
                addQuizChatMessage('Sorry, I had trouble processing that. Please try again.', 'system');
            }
        } catch (error) {
            console.error('Quiz chat error:', error);
            quizChatTyping.style.display = 'none';
            addQuizChatMessage('Connection error. Please try again.', 'system');
        }

        // Re-enable input
        quizChatInput.disabled = false;
        document.getElementById('quiz-chat-send').disabled = false;
        quizChatInput.focus();
    }

    function showCompletion() {
        questionCard.style.display = 'none';
        progressEl.style.display = 'none';
        completeCard.style.display = '';

        document.getElementById('completion-correct').textContent = sessionCorrect;
        document.getElementById('completion-total').textContent = sessionTotal;

        progressFill.style.width = '100%';
        progressBar?.setAttribute('aria-valuenow', String(sessionTotal));
        progressBar?.setAttribute('aria-valuemin', '0');
        progressBar?.setAttribute('aria-valuemax', String(sessionTotal));
    }

    function updateGlobalStats(stats) {
        document.getElementById('stat-total').textContent = stats.totalAttempts;
        document.getElementById('stat-correct').textContent = stats.correctCount;
        document.getElementById('stat-accuracy').textContent = stats.accuracy + '%';
    }

    function showDisabled(message) {
        const loadingEl = document.getElementById('quiz-loading');
        const disabledEl = document.getElementById('quiz-disabled');
        loadingEl.style.display = 'none';
        disabledEl.querySelector('p').textContent = message;
        disabledEl.style.display = '';
    }

    // Utility functions
    function shuffleArray(arr) {
        for (let i = arr.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [arr[i], arr[j]] = [arr[j], arr[i]];
        }
        return arr;
    }

    function getFileIcon(mimeType) {
        if (!mimeType) return '\uD83D\uDCC4';
        if (mimeType.includes('pdf')) return '\uD83D\uDCC4';
        if (mimeType.includes('word') || mimeType.includes('document')) return '\uD83D\uDCC3';
        if (mimeType.includes('presentation') || mimeType.includes('powerpoint')) return '\uD83D\uDCCA';
        if (mimeType.includes('image')) return '\uD83D\uDDBC';
        return '\uD83D\uDCC4';
    }

    function formatFileSize(bytes) {
        if (!bytes) return '';
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    }
});

/**
 * Wait for auth to be ready
 */
async function waitForAuth() {
    return new Promise((resolve) => {
        if (typeof currentUser !== 'undefined' && currentUser) {
            resolve();
            return;
        }
        document.addEventListener('auth:ready', () => resolve(), { once: true });
        // Fallback timeout
        setTimeout(resolve, 3000);
    });
}
