(function initializeStudentGuidedTour() {
    const steps = [
        {
            id: 'course',
            path: '/student',
            selector: '#course-select',
            title: 'Select your course',
            description: 'Start by choosing the course you want to study. The rest of BiocBot will stay locked until you make a selection.',
            actionLabel: 'Choose a course above'
        },
        {
            id: 'unit',
            path: '/student',
            selector: '#unit-select',
            title: 'Select a unit',
            description: 'Now choose the unit you are currently studying. Your first visit skips the assessment and opens Tutor mode directly.',
            actionLabel: 'Choose a unit above'
        },
        {
            id: 'mode',
            path: '/student',
            selector: '.mode-toggle',
            title: 'Start in Tutor mode',
            description: 'Tutor mode is your starting mode. BiocBot explains concepts and answers questions. You can switch to Protégé mode here whenever you want to teach the bot instead.',
            nextLabel: 'Show me Chat History'
        },
        {
            id: 'history',
            path: '/student/history',
            selector: '.history-header h2',
            title: 'Chat History',
            description: 'Your saved conversations live here. Open an old chat to review it, download it, or continue where you left off.',
            nextLabel: 'Next: Flagged Messages'
        },
        {
            id: 'flagged',
            path: '/student/flagged',
            selector: '#main',
            title: 'Flagged Messages',
            description: 'If a BiocBot answer looks wrong or concerning, flag it from Chat. This page shows your reports and any response from your instructor.',
            nextLabel: 'Next: Topic Dashboard'
        },
        {
            id: 'dashboard',
            path: '/student/dashboard.html',
            selector: '#main',
            title: 'Topic Dashboard',
            description: 'Use this page to see concepts you have been struggling with and track where extra review may help.',
            nextLabel: 'Next: Quiz'
        },
        {
            id: 'quiz',
            path: '/student/quiz',
            selector: '#main',
            title: 'Quiz Practice',
            description: 'Practice course questions here whenever you choose. This is separate from Chat, so it will not force you into a harder chat mode.',
            nextLabel: 'Next: Flashcards'
        },
        {
            id: 'flashcards',
            path: '/student/flashcards',
            selector: '#main',
            title: 'Flashcards',
            description: 'Review instructor-provided flashcard decks by unit. You can return here at any time from the student navigation.',
            nextLabel: 'Finish walkthrough'
        }
    ];

    let user = null;
    let stepIndex = 0;
    let target = null;
    let card = null;
    let shades = [];
    let layoutTimer = null;
    let renderToken = 0;
    let listenerController = null;

    function storageKey() {
        return `biocbot_student_guided_tour_${user.userId}`;
    }

    function normalizePath(path) {
        if (path === '/student/' || path === '/student/index.html') return '/student';
        return path.replace(/\/$/, '') || '/student';
    }

    function isCorrectPage(step) {
        return normalizePath(window.location.pathname) === step.path;
    }

    // The walkthrough moves between student pages by assigning location.href,
    // which drops the ?preview=1 marker an instructor's "View as Student" tab
    // navigates with. Unmarked, the next page is refused and the tab is sent
    // back to the instructor UI mid-tour.
    function stepUrl(path) {
        return window.BiocBotPreview?.url(path) || path;
    }

    function saveStep(index) {
        stepIndex = index;
        localStorage.setItem(storageKey(), String(index));
    }

    function clearTourElements() {
        listenerController?.abort();
        listenerController = null;
        if (layoutTimer) window.clearInterval(layoutTimer);
        layoutTimer = null;
        window.removeEventListener('resize', updateLayout);
        window.removeEventListener('scroll', updateLayout, true);
        target?.classList.remove('student-tour-target');
        target = null;
        card?.remove();
        card = null;
        shades.forEach(shade => shade.remove());
        shades = [];
    }

    function finishCleanup() {
        renderToken += 1;
        clearTourElements();
        document.body.classList.remove('student-tour-active');
    }

    function setRect(element, left, top, width, height) {
        Object.assign(element.style, {
            left: `${Math.max(0, left)}px`,
            top: `${Math.max(0, top)}px`,
            width: `${Math.max(0, width)}px`,
            height: `${Math.max(0, height)}px`
        });
    }

    function updateLayout() {
        if (!target || !card || shades.length !== 4) return;

        const padding = 10;
        const rect = target.getBoundingClientRect();
        const left = Math.max(0, rect.left - padding);
        const top = Math.max(0, rect.top - padding);
        const right = Math.min(window.innerWidth, rect.right + padding);
        const bottom = Math.min(window.innerHeight, rect.bottom + padding);

        setRect(shades[0], 0, 0, window.innerWidth, top);
        setRect(shades[1], 0, top, left, bottom - top);
        setRect(shades[2], right, top, window.innerWidth - right, bottom - top);
        setRect(shades[3], 0, bottom, window.innerWidth, window.innerHeight - bottom);

        if (window.innerWidth <= 700) return;

        const cardRect = card.getBoundingClientRect();
        const gap = 18;
        const preferredTop = bottom + gap;
        const aboveTop = top - cardRect.height - gap;
        const cardTop = preferredTop + cardRect.height <= window.innerHeight - 16
            ? preferredTop
            : Math.max(16, aboveTop);
        const cardLeft = Math.min(
            window.innerWidth - cardRect.width - 16,
            Math.max(16, left + ((right - left - cardRect.width) / 2))
        );

        card.style.top = `${cardTop}px`;
        card.style.left = `${cardLeft}px`;
    }

    function createShades() {
        shades = Array.from({ length: 4 }, () => {
            const shade = document.createElement('div');
            shade.className = 'student-tour-shade';
            shade.setAttribute('aria-hidden', 'true');
            shade.addEventListener('click', event => {
                event.preventDefault();
                event.stopPropagation();
            });
            document.body.appendChild(shade);
            return shade;
        });
    }

    function createCard(step) {
        const element = document.createElement('section');
        element.className = 'student-tour-card';
        element.setAttribute('role', 'dialog');
        element.setAttribute('aria-labelledby', 'student-tour-title');

        const hasRequiredAction = !!step.actionLabel;
        element.setAttribute('aria-modal', hasRequiredAction ? 'false' : 'true');
        element.innerHTML = `
            <p class="student-tour-progress">Guided walkthrough · ${stepIndex + 1} of ${steps.length}</p>
            <h2 id="student-tour-title">${step.title}</h2>
            <p class="student-tour-description">${step.description}</p>
            <div class="student-tour-actions">
                <button type="button" class="student-tour-next"${hasRequiredAction ? ' disabled' : ''}>
                    ${hasRequiredAction ? step.actionLabel : step.nextLabel}
                </button>
            </div>
        `;

        document.body.appendChild(element);
        return element;
    }

    function waitForTarget(selector, token) {
        return new Promise(resolve => {
            const find = () => {
                if (token !== renderToken) return resolve(null);
                const element = document.querySelector(selector);
                if (element && element.getClientRects().length > 0) {
                    observer.disconnect();
                    return resolve(element);
                }
                return null;
            };

            const observer = new MutationObserver(find);
            observer.observe(document.documentElement, {
                childList: true,
                subtree: true,
                attributes: true,
                attributeFilter: ['style', 'class']
            });
            find();
        });
    }

    async function renderStep() {
        const step = steps[stepIndex];
        if (!step) return;

        if (!isCorrectPage(step)) {
            window.location.href = stepUrl(step.path);
            return;
        }

        const token = ++renderToken;
        clearTourElements();
        document.body.classList.add('student-tour-active');

        const nextTarget = await waitForTarget(step.selector, token);
        if (!nextTarget || token !== renderToken) return;

        target = nextTarget;
        target.scrollIntoView({ block: 'center', behavior: 'smooth' });
        target.classList.add('student-tour-target');
        createShades();
        card = createCard(step);
        listenerController = new AbortController();

        document.addEventListener('keydown', event => {
            if (event.key === 'Escape') {
                event.preventDefault();
                return;
            }
            if (event.key !== 'Tab') return;

            event.preventDefault();
            if (step.actionLabel) {
                target.focus();
            } else {
                card.querySelector('.student-tour-next')?.focus();
            }
        }, { signal: listenerController.signal });

        if (step.id === 'course') {
            target.addEventListener('change', () => {
                if (!target.value) return;
                saveStep(1);
                renderStep();
            }, { signal: listenerController.signal });
            target.focus();
        } else if (step.id === 'unit') {
            target.addEventListener('change', () => {
                if (!target.value) return;
                const button = card?.querySelector('.student-tour-next');
                if (button) button.textContent = 'Preparing Tutor mode…';
            }, { signal: listenerController.signal });
            target.focus();
        } else {
            const nextButton = card.querySelector('.student-tour-next');
            nextButton.addEventListener('click', advance, { signal: listenerController.signal });
            nextButton.focus();
        }

        updateLayout();
        layoutTimer = window.setInterval(updateLayout, 250);
        window.addEventListener('resize', updateLayout);
        window.addEventListener('scroll', updateLayout, true);
    }

    async function completeWalkthrough() {
        const button = card?.querySelector('.student-tour-next');
        if (button) {
            button.disabled = true;
            button.textContent = 'Finishing…';
        }

        try {
            const response = await fetch('/api/auth/student-onboarding/complete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include'
            });
            const result = await response.json();
            if (!response.ok || !result.success) {
                throw new Error(result.error || 'Unable to finish the walkthrough');
            }

            user.studentOnboardingComplete = true;
            localStorage.removeItem(storageKey());
            localStorage.setItem('studentMode', 'tutor');
            finishCleanup();
            window.location.href = stepUrl('/student');
        } catch (error) {
            console.error('Error completing student walkthrough:', error);
            const description = card?.querySelector('.student-tour-description');
            if (description) description.textContent = 'We could not save your progress. Please try Finish again.';
            if (button) {
                button.disabled = false;
                button.textContent = 'Try again';
            }
        }
    }

    function advance() {
        if (stepIndex === steps.length - 1) {
            completeWalkthrough();
            return;
        }

        saveStep(stepIndex + 1);
        renderStep();
    }

    function advanceAfterUnitSelection() {
        if (steps[stepIndex]?.id !== 'unit') return;
        saveStep(stepIndex + 1);
        renderStep();
    }

    function isWaitingForUnitSelection() {
        return !!user && user.studentOnboardingComplete === false && steps[stepIndex]?.id === 'unit';
    }

    async function start(currentUser) {
        if (!currentUser || currentUser.role !== 'student' || currentUser.studentOnboardingComplete !== false) {
            return;
        }

        user = currentUser;
        const savedStep = Number.parseInt(localStorage.getItem(storageKey()), 10);
        stepIndex = Number.isInteger(savedStep) && savedStep >= 0 && savedStep < steps.length
            ? savedStep
            : 0;

        if (!isCorrectPage(steps[stepIndex])) {
            window.location.href = stepUrl(steps[stepIndex].path);
            return;
        }

        try {
            const response = await fetch('/api/user-agreement/status', { credentials: 'include' });
            const result = await response.json();
            if (response.ok && result.success && result.data?.hasAgreed) {
                renderStep();
                return;
            }
        } catch (error) {
            console.warn('Unable to check agreement before the guided walkthrough:', error);
        }

        // The existing agreement modal owns the legal-consent step. Begin the
        // product tour only after that modal has been completed.
        BiocbotEvents.subscribe('agreement.accepted', () => renderStep(), { once: true });
    }

    window.StudentGuidedTour = {
        advanceAfterUnitSelection,
        isWaitingForUnitSelection
    };

    document.addEventListener('DOMContentLoaded', () => {
        const currentUser = typeof getCurrentUser === 'function' ? getCurrentUser() : null;
        if (currentUser) {
            start(currentUser);
        } else {
            BiocbotEvents.subscribe('auth.ready', () => start(getCurrentUser()), { once: true });
        }
    });
})();
