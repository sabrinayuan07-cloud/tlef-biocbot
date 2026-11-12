/**
 * Settings page search.
 *
 * Matches a free-text query against a small, hand-curated index of this
 * page's settings sections (title + description + related terms), then
 * jumps to and highlights the best match. No network/LLM calls - everything
 * here is static data and a lightweight local scoring function, so results
 * are instant, free, and deterministic (see issue #595 for why this
 * approach was chosen over embeddings-based search).
 */
document.addEventListener('DOMContentLoaded', () => {
    // One entry per `.settings-section` in settings.html. `sectionId` must
    // match that section's id so we can check visibility and scroll to it;
    // `panel` must match the `data-panel` used by the hub tiles/rail links.
    const SEARCH_INDEX = [
        {
            sectionId: 'course-level-section',
            panel: 'course-basics',
            title: 'Course level',
            description: 'Sets the academic year this course targets, used to tailor BiocBot\'s responses and to flag higher-level material when this course is part of a Super Course bucket.',
            tags: ['year level', 'academic year', 'grade level', 'undergraduate', 'graduate', 'student level', 'course number']
        },
        {
            sectionId: 'course-llm-key-section',
            panel: 'course-basics',
            title: 'Course API key',
            description: 'Choose which AI platform this course runs on and save that platform\'s API key. AI features are unavailable until a valid key is saved.',
            tags: ['api key', 'openai key', 'sk-', 'platform', 'activate ai', 'enable ai', 'llm key', 'chatgpt key', 'test key', 'save key']
        },
        {
            sectionId: 'student-chat-section',
            panel: 'student-chat',
            title: 'Retrieval & sources',
            description: 'Controls how regular student chat retrieves and cites course material (chunks retrieved, additive retrieval across units, additional-material search order, clickable source downloads) and the post-chat usefulness survey.',
            tags: [
                'top-k', 'topk', 'chunks', 'number of chunks retrieved', 'retrieval depth', 'context limit', 'rag',
                'additive retrieval', 'turn off additive retrieval', 'earlier units', 'previous units',
                'additional materials', 'secondary search', 'source attribution', 'citations', 'download sources',
                'survey', 'feedback survey', 'star rating', 'usefulness survey', 'summarize button',
                'message count trigger', 'written comments'
            ]
        },
        {
            sectionId: 'ai-persona-section',
            panel: 'prompts',
            title: 'Course prompts',
            description: 'The system prompts that define BiocBot\'s behavior for students in this course: base personality, Protege/Tutor/Explain modes, the directive strategy for struggling students, quiz-help chat, flashcard generation, and the chat-summary prompt.',
            tags: [
                'system prompt', 'persona', 'personality', 'protege mode', 'tutor mode', 'explain button',
                'directive mode', 'struggling student', 'quiz help chat', 'wrong answer explanation',
                'flashcard generation', 'flashcard prompt', 'token budget', 'chat summary prompt',
                'summarize and start new chat', 'ai behavior', 'prompt wording'
            ]
        },
        {
            sectionId: 'quiz-settings-section',
            panel: 'quiz',
            title: 'Quiz practice settings',
            description: 'Turns the self-paced quiz practice page on or off, selects which published units students can be tested on, and controls whether students can download lecture material after answering incorrectly.',
            tags: ['quiz practice', 'enable quiz', 'disable quiz', 'testable units', 'quiz difficulty', 'practice page', 'practice questions', 'lecture material access', 'review mistakes']
        },
        {
            sectionId: 'privacy-settings-section',
            panel: 'privacy',
            title: 'Privacy & session settings',
            description: 'Hides student names throughout your instructor view, and controls the idle-activity timer and chat-session inactivity timeout before a student\'s chat resets.',
            tags: ['anonymize students', 'hide names', 'privacy', 'idle timeout', 'session timeout', 'inactivity', 'forget conversation', 'remember old messages', 'start new chat automatically', 'are you still there']
        },
        {
            sectionId: 'course-superchats-section',
            panel: 'super-course',
            title: 'Buckets this course belongs to',
            description: 'Choose which Super Course buckets this course belongs to, or create a brand-new bucket. Students in a bucket can chat across every course in it.',
            tags: ['super course', 'bucket membership', 'join bucket', 'create bucket', 'shared chat across courses']
        },
        {
            sectionId: 'super-course-chat-section',
            panel: 'super-course',
            title: 'Bucket settings',
            description: 'Shared settings for a selected Super Course bucket: name, year level, API key, student visibility, plus advanced retrieval (Top-K, notes retrieval share/similarity) and prompt/level-modifier settings.',
            tags: [
                'super course bucket', 'bucket name', 'bucket api key', 'show students bucket',
                'instructor top-k', 'student top-k', 'notes retrieval', 'include inactive courses',
                'include notes', 'super course prompt', 'answer depth', 'answer level',
                'overview standard deep dive', 'introductory undergraduate graduate'
            ]
        },
        {
            sectionId: 'course-lifecycle-section',
            panel: 'lifecycle',
            title: 'Course lifecycle',
            description: 'Deactivate this course to block student and TA access (reversible), or transfer/copy this course into a brand-new course with recopied materials and optional TA/settings carry-over.',
            tags: ['deactivate course', 'reactivate course', 'archive course', 'transfer course', 'copy course', 'duplicate course', 'course copy']
        },
        {
            sectionId: 'llm-model-section',
            panel: 'admin-platform',
            title: 'Platform & models — OpenAI',
            description: 'Default front-end and back-end chat models, reasoning effort, and embedding model used for AI surfaces running on OpenAI Chat GPT.',
            tags: ['openai model', 'gpt model', 'front-end model', 'back-end model', 'reasoning effort', 'embedding model', 'model defaults']
        },
        {
            sectionId: 'sandbox-llm-model-section',
            panel: 'admin-platform',
            title: 'Platform & models — UBC On-Premise LLM',
            description: 'Default front-end and back-end chat models, reasoning effort, and embedding model used for AI surfaces running on the UBC On-Premise LLM (Sandbox).',
            tags: ['sandbox model', 'on-premise llm', 'qwen', 'front-end model', 'back-end model', 'reasoning effort', 'embedding model']
        },
        {
            sectionId: 'proxy-llm-model-section',
            panel: 'admin-platform',
            title: 'Platform & models — UBC LLM Proxy',
            description: 'Model selection for AI surfaces running on the UBC LLM Proxy, discovered from the saved proxy key, including reasoning effort and embedding model.',
            tags: ['proxy model', 'ubc llm proxy', 'front-end model', 'back-end model', 'reasoning effort', 'embedding model']
        },
        {
            sectionId: 'notes-llm-key-section',
            panel: 'admin-platform',
            title: 'Instructor notes API key',
            description: 'The API key used for uploading and retrieving Super Chat notes.',
            tags: ['notes api key', 'super chat notes key', 'notes platform key']
        },
        {
            sectionId: 'instructor-superchat-llm-key-section',
            panel: 'admin-platform',
            title: 'Instructor Super Course chat API key',
            description: 'The dedicated API key for instructor Super Course chat, independent of any student bucket key.',
            tags: ['instructor super course key', 'super course chat key', 'instructor chat api key']
        },
        {
            sectionId: 'login-restriction-section',
            panel: 'admin-access',
            title: 'Login restrictions',
            description: 'Controls whether local username/password login and registration are allowed, or whether users must sign in via CWL only.',
            tags: ['cwl only', 'local login', 'disable registration', 'sign in restrictions', 'password login']
        },
        {
            sectionId: 'academic-api-section',
            panel: 'admin-access',
            title: 'Academic API integration',
            description: 'Enables UBC academic API class-list sync so courses can be set up from real sections, students are enrolled automatically, and instructors of record join without a code.',
            tags: ['class list sync', 'academic api', 'auto enrollment', 'course code join', 'section sync']
        },
        {
            sectionId: 'system-admin-section',
            panel: 'admin-access',
            title: 'System admin access',
            description: 'Grants or revokes system admin access for other users by email, and lists current system admins.',
            tags: ['grant admin', 'revoke admin', 'system admin list', 'admin access']
        },
        {
            sectionId: 'question-generation-section',
            panel: 'admin-safety',
            title: 'Question generation settings',
            description: 'Prompts used by AI question generation across question types: the shared system prompt plus templates for true/false, multiple choice, and short answer questions.',
            tags: ['question generation', 'true false prompt', 'multiple choice prompt', 'short answer prompt', 'ai question prompt']
        },
        {
            sectionId: 'mental-health-detection-section',
            panel: 'admin-safety',
            title: 'Mental health detection settings',
            description: 'The AI prompt used to silently flag mental-health concerns in student conversations; flags appear on the Flagged Content page.',
            tags: ['mental health detection', 'concern level', 'flagged content detection', 'safety monitoring']
        },
        {
            sectionId: 'database-management-section',
            panel: 'admin-database',
            title: 'Database management',
            description: 'Development-only tools to permanently delete all BiocBot data, including vector embeddings and document metadata.',
            tags: ['delete all data', 'reset database', 'wipe data', 'development tools', 'qdrant', 'mongodb reset']
        }
    ];

    const PANEL_LABELS = {
        'course-basics': 'Course basics',
        'student-chat': 'Student chat',
        'prompts': 'AI prompts',
        'quiz': 'Quiz practice',
        'privacy': 'Privacy & sessions',
        'super-course': 'Super course',
        'lifecycle': 'Course lifecycle',
        'admin-platform': 'Platform & models',
        'admin-access': 'Admins & access',
        'admin-safety': 'Safety prompts',
        'admin-database': 'Database'
    };

    const STOP_WORDS = new Set([
        'the', 'a', 'an', 'is', 'are', 'to', 'for', 'how', 'can', 'do', 'does',
        'i', 'it', 'this', 'that', 'of', 'on', 'in', 'my', 'many', 'much', 'be'
    ]);

    function normalize(str) {
        return (str || '').toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').replace(/\s+/g, ' ').trim();
    }

    function tokenize(str) {
        return normalize(str).split(' ').filter(Boolean);
    }

    // Edit distance, capped at 2 since we only ever care whether it's <= 1.
    function levenshtein(a, b) {
        if (a === b) return 0;
        if (Math.abs(a.length - b.length) > 2) return 3;
        const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
        for (let j = 0; j <= b.length; j++) dp[0][j] = j;
        for (let i = 1; i <= a.length; i++) {
            for (let j = 1; j <= b.length; j++) {
                dp[i][j] = a[i - 1] === b[j - 1]
                    ? dp[i - 1][j - 1]
                    : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
            }
        }
        return dp[a.length][b.length];
    }

    function bestTokenScore(queryToken, entryTokens) {
        let best = 0;
        for (const t of entryTokens) {
            if (t === queryToken) return 4;
            if (t.length >= 4 && queryToken.length >= 4) {
                if (t.startsWith(queryToken) || queryToken.startsWith(t)) best = Math.max(best, 2.5);
                else if (levenshtein(t, queryToken) <= 1) best = Math.max(best, 2);
            }
            if (queryToken.length >= 3 && t.includes(queryToken)) best = Math.max(best, 1.5);
        }
        return best;
    }

    const index = SEARCH_INDEX.map(entry => ({
        ...entry,
        // Full text (incl. free-form description prose) is only used for
        // whole-phrase substring bonuses below. Word-by-word overlap is
        // scored against title + tags only - the description is written in
        // natural sentences and often contains incidental common words
        // ("turns ... on or off") that would otherwise cause unrelated
        // queries to match on a single stray word.
        haystack: normalize([entry.title, entry.description, ...entry.tags].join(' ')),
        tokens: Array.from(new Set(tokenize([entry.title, ...entry.tags].join(' '))))
    }));

    function scoreEntry(entry, rawQueryNorm, queryTokens) {
        const meaningful = queryTokens.filter(t => t.length >= 2 && !STOP_WORDS.has(t));
        if (meaningful.length === 0) return 0;

        let score = 0;
        if (rawQueryNorm.length >= 3 && entry.haystack.includes(rawQueryNorm)) score += 8;
        if (rawQueryNorm.length >= 3 && normalize(entry.title).includes(rawQueryNorm)) score += 6;

        let matched = 0;
        for (const qt of meaningful) {
            const tokenScore = bestTokenScore(qt, entry.tokens);
            if (tokenScore > 0) {
                matched++;
                score += tokenScore;
            }
        }

        const coverage = matched / meaningful.length;
        // Require decent coverage of the query's words unless a strong
        // phrase hit already carried the score, so a long query doesn't
        // surface a section that only shares one incidental word with it.
        if (coverage < 0.5 && score < 6) return 0;
        return score + coverage * 2;
    }

    function isSectionVisible(sectionEl) {
        // Permission/platform gating on this page always sets inline
        // style.display directly on the `.settings-section` element itself
        // (see checkDeleteAllPermission / initializeCourseLifecycle /
        // loadLLMSettings in settings.js). The panel's own `hidden`
        // attribute is just navigation state, not permission state, so we
        // deliberately don't consult computed style here.
        return !!sectionEl && sectionEl.style.display !== 'none';
    }

    function search(query) {
        const rawQueryNorm = normalize(query);
        if (!rawQueryNorm) return [];
        const queryTokens = tokenize(query);

        const scored = [];
        for (const entry of index) {
            const sectionEl = document.getElementById(entry.sectionId);
            if (!isSectionVisible(sectionEl)) continue;
            const score = scoreEntry(entry, rawQueryNorm, queryTokens);
            if (score > 0) scored.push({ entry, score });
        }
        scored.sort((a, b) => b.score - a.score);
        return scored.slice(0, 8).map(s => s.entry);
    }

    /* =============================================
       UI wiring
       ============================================= */

    const searchInput = document.getElementById('settings-search-input');
    const clearBtn = document.getElementById('settings-search-clear');
    const resultsList = document.getElementById('settings-search-results');
    if (!searchInput || !resultsList) return;

    const searchForm = searchInput.closest('form');
    if (searchForm) {
        searchForm.addEventListener('submit', (event) => event.preventDefault());
    }

    let currentResults = [];
    let activeIndex = -1;
    let pendingSectionJump = null;

    function closeResults() {
        resultsList.hidden = true;
        resultsList.innerHTML = '';
        searchInput.setAttribute('aria-expanded', 'false');
        searchInput.removeAttribute('aria-activedescendant');
        currentResults = [];
        activeIndex = -1;
    }

    function setActive(index) {
        const options = resultsList.querySelectorAll('[role="option"]');
        options.forEach(opt => opt.removeAttribute('aria-selected'));
        activeIndex = index;
        if (index >= 0 && options[index]) {
            options[index].setAttribute('aria-selected', 'true');
            searchInput.setAttribute('aria-activedescendant', options[index].id);
            options[index].scrollIntoView({ block: 'nearest' });
        } else {
            searchInput.removeAttribute('aria-activedescendant');
        }
    }

    function renderResults(results) {
        currentResults = results;
        resultsList.innerHTML = '';

        if (results.length === 0) {
            const empty = document.createElement('li');
            empty.className = 'settings-search-empty';
            empty.textContent = 'No matching settings found. Try different words.';
            resultsList.append(empty);
            resultsList.hidden = false;
            searchInput.setAttribute('aria-expanded', 'true');
            activeIndex = -1;
            return;
        }

        results.forEach((entry, i) => {
            const li = document.createElement('li');
            li.setAttribute('role', 'presentation');

            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'settings-search-result';
            button.id = `settings-search-result-${i}`;
            button.setAttribute('role', 'option');

            const title = document.createElement('span');
            title.className = 'settings-search-result-title';
            title.textContent = entry.title;

            const meta = document.createElement('span');
            meta.className = 'settings-search-result-meta';
            meta.textContent = PANEL_LABELS[entry.panel] || entry.panel;

            const desc = document.createElement('span');
            desc.className = 'settings-search-result-desc';
            desc.textContent = entry.description;

            button.append(title, meta, desc);
            button.addEventListener('click', () => jumpToResult(entry));
            // Hover hands the active/highlighted state over to whichever
            // result the mouse is on, instead of leaving it stuck on
            // whatever keyboard navigation (or the initial render) last set.
            button.addEventListener('mouseenter', () => setActive(i));
            li.append(button);
            resultsList.append(li);
        });

        resultsList.hidden = false;
        searchInput.setAttribute('aria-expanded', 'true');
        // Leave nothing highlighted until the user actually hovers or
        // arrow-keys onto a result, instead of auto-selecting the first one.
        activeIndex = -1;
        searchInput.removeAttribute('aria-activedescendant');
    }

    function performPendingJump() {
        if (!pendingSectionJump) return;
        const entry = pendingSectionJump;
        pendingSectionJump = null;
        requestAnimationFrame(() => {
            const el = document.getElementById(entry.sectionId);
            if (!el) return;
            el.scrollIntoView({ behavior: 'smooth', block: 'start' });
            el.classList.add('settings-section-highlight');
            setTimeout(() => el.classList.remove('settings-section-highlight'), 2000);
            if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
            el.focus({ preventScroll: true });
        });
    }

    window.addEventListener('hashchange', performPendingJump);

    function jumpToResult(entry) {
        pendingSectionJump = entry;
        const target = `#${entry.panel}`;
        closeResults();
        if (window.location.hash === target) {
            performPendingJump();
        } else {
            window.location.hash = entry.panel;
        }
    }

    searchInput.addEventListener('input', () => {
        clearBtn.hidden = searchInput.value.length === 0;
        const results = search(searchInput.value);
        renderResults(results);
    });

    searchInput.addEventListener('keydown', (event) => {
        if (resultsList.hidden) return;
        // Tab/Shift+Tab step through results the same way Arrow Down/Up do,
        // instead of leaving the widget (the browser's default Tab
        // behavior) while results are open.
        if (event.key === 'ArrowDown' || (event.key === 'Tab' && !event.shiftKey)) {
            event.preventDefault();
            if (currentResults.length === 0) return;
            setActive(activeIndex === -1 ? 0 : (activeIndex + 1) % currentResults.length);
        } else if (event.key === 'ArrowUp' || (event.key === 'Tab' && event.shiftKey)) {
            event.preventDefault();
            if (currentResults.length === 0) return;
            setActive(activeIndex === -1 ? currentResults.length - 1 : (activeIndex - 1 + currentResults.length) % currentResults.length);
        } else if (event.key === 'Enter') {
            event.preventDefault();
            if (activeIndex >= 0 && currentResults[activeIndex]) {
                jumpToResult(currentResults[activeIndex]);
            }
        } else if (event.key === 'Escape') {
            if (!resultsList.hidden) {
                closeResults();
            } else {
                searchInput.value = '';
                clearBtn.hidden = true;
            }
        }
    });

    searchInput.addEventListener('blur', () => {
        setTimeout(() => {
            if (!resultsList.contains(document.activeElement)) closeResults();
        }, 150);
    });

    clearBtn.addEventListener('click', () => {
        searchInput.value = '';
        clearBtn.hidden = true;
        closeResults();
        searchInput.focus();
    });
});
