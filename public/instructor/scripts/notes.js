document.addEventListener('DOMContentLoaded', async () => {
    await waitForAuthReady();

    const user = typeof getCurrentUser === 'function' ? getCurrentUser() : null;
    if (user && user.role !== 'instructor' && user.role !== 'ta') {
        window.location.href = '/login';
        return;
    }

    const API = '/api/superchat-notes';
    const MAX_CHARS = 5000;

    // Elements
    const cards = document.querySelectorAll('.hub-card');
    const panels = document.querySelectorAll('.notes-panel');
    const newNoteBtn = document.getElementById('new-note-btn');
    const listContainer = document.getElementById('notes-list-container');
    const loading = document.getElementById('notes-loading');
    const notesCount = document.getElementById('notes-count');

    const editorHeading = document.getElementById('editor-heading');
    const titleInput = document.getElementById('note-title');
    const bodyInput = document.getElementById('note-body');
    const charCounter = document.getElementById('char-counter');
    const tagsWrap = document.getElementById('editor-tags');
    const tagInput = document.getElementById('tag-input');
    const saveBtn = document.getElementById('save-note');
    const cancelBtn = document.getElementById('cancel-note');

    const dupeWarning = document.getElementById('dupe-warning');
    const dupeDetail = document.getElementById('dupe-detail');
    const dupePreview = document.getElementById('dupe-preview');
    const dupeDismiss = document.getElementById('dupe-dismiss');

    let editingNoteId = null;     // null = creating, otherwise editing
    let currentTags = [];
    let dupeCheckTimer = null;

    function notify(message, type) {
        if (typeof showNotification === 'function') showNotification(message, type);
    }

    // ---------- Panel switching ----------
    function showPanel(targetId) {
        panels.forEach(p => p.classList.toggle('active', p.id === targetId));
        cards.forEach(c => c.classList.toggle('active', c.dataset.target === targetId));
    }
    cards.forEach(card => card.addEventListener('click', () => {
        if (card.dataset.target === 'panel-new') {
            openEditor();
        } else {
            showPanel(card.dataset.target);
        }
    }));
    newNoteBtn.addEventListener('click', openEditor);

    // ---------- Editor ----------
    function openEditor(note) {
        editingNoteId = note && note.noteId ? note.noteId : null;
        editorHeading.textContent = editingNoteId ? 'Edit note' : 'Write a new note';
        titleInput.value = note ? (note.title || '') : '';
        bodyInput.value = note ? (note.content || '') : '';
        currentTags = note && Array.isArray(note.tags) ? [...note.tags] : [];
        renderTags();
        updateCharCounter();
        hideDupeWarning();
        showPanel('panel-new');
        bodyInput.focus();
    }

    function closeEditor() {
        editingNoteId = null;
        titleInput.value = '';
        bodyInput.value = '';
        currentTags = [];
        renderTags();
        hideDupeWarning();
        showPanel('panel-browse');
    }
    cancelBtn.addEventListener('click', closeEditor);

    function updateCharCounter() {
        const len = bodyInput.value.length;
        charCounter.textContent = `${len} / ${MAX_CHARS}`;
        charCounter.classList.toggle('warn', len > MAX_CHARS - 500);
    }

    bodyInput.addEventListener('input', () => {
        updateCharCounter();
        scheduleDupeCheck();
    });

    // ---------- Tags ----------
    function renderTags() {
        // Remove existing chips (keep the input)
        tagsWrap.querySelectorAll('.tag-chip').forEach(chip => chip.remove());
        currentTags.forEach(tag => {
            const chip = document.createElement('span');
            chip.className = 'tag-chip';
            chip.textContent = tag;
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.textContent = '×';
            remove.setAttribute('aria-label', `Remove tag ${tag}`);
            remove.addEventListener('click', () => {
                currentTags = currentTags.filter(t => t !== tag);
                renderTags();
            });
            chip.appendChild(remove);
            tagsWrap.insertBefore(chip, tagInput);
        });
    }

    tagInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ',') {
            event.preventDefault();
            const value = tagInput.value.trim().replace(/,$/, '').trim();
            if (value && !currentTags.includes(value) && currentTags.length < 20) {
                currentTags.push(value);
                renderTags();
            }
            tagInput.value = '';
        }
    });

    // ---------- Duplicate check (debounced) ----------
    function scheduleDupeCheck() {
        if (dupeCheckTimer) clearTimeout(dupeCheckTimer);
        const content = bodyInput.value.trim();
        if (content.length < 40) {
            hideDupeWarning();
            return;
        }
        dupeCheckTimer = setTimeout(() => runDupeCheck(content), 700);
    }

    async function runDupeCheck(content) {
        try {
            const res = await fetch(`${API}/check-similar`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ content, excludeNoteId: editingNoteId })
            });
            const result = await res.json();
            if (result.success && result.similar) {
                showDupeWarning(result.similar);
            } else {
                hideDupeWarning();
            }
        } catch (error) {
            // advisory only
            hideDupeWarning();
        }
    }

    function showDupeWarning(similar) {
        const date = formatDate(similar.createdAt);
        dupeDetail.textContent = `${similar.authorName || 'Another instructor'} wrote something close${date ? ` on ${date}` : ''}:`;
        dupePreview.innerHTML = `<strong></strong><br/><span></span>`;
        dupePreview.querySelector('strong').textContent = similar.title || 'Untitled note';
        dupePreview.querySelector('span').textContent = similar.excerpt || '';
        dupeWarning.classList.add('show');
    }
    function hideDupeWarning() {
        dupeWarning.classList.remove('show');
    }
    dupeDismiss.addEventListener('click', hideDupeWarning);

    // ---------- Save ----------
    saveBtn.addEventListener('click', async () => {
        const content = bodyInput.value.trim();
        if (!content) {
            notify('Note content is required', 'error');
            bodyInput.focus();
            return;
        }

        saveBtn.disabled = true;
        saveBtn.textContent = 'Saving...';

        const payload = {
            title: titleInput.value.trim(),
            content,
            tags: currentTags
        };

        try {
            const url = editingNoteId ? `${API}/${encodeURIComponent(editingNoteId)}` : API;
            const method = editingNoteId ? 'PUT' : 'POST';
            const res = await fetch(url, {
                method,
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify(payload)
            });
            const result = await res.json();
            if (!res.ok || !result.success) {
                throw new Error(result.message || 'Failed to save note');
            }
            notify(editingNoteId ? 'Note updated' : 'Note saved — the bot can use it right away', 'success');
            closeEditor();
            await loadNotes();
        } catch (error) {
            console.error('Error saving note:', error);
            notify(error.message || 'Failed to save note', 'error');
        } finally {
            saveBtn.disabled = false;
            saveBtn.textContent = 'Save note';
        }
    });

    // ---------- Delete ----------
    async function deleteNote(noteId) {
        if (!confirm('Delete this note? It will stop being used by the bot immediately.')) return;
        try {
            const res = await fetch(`${API}/${encodeURIComponent(noteId)}`, {
                method: 'DELETE',
                credentials: 'include'
            });
            const result = await res.json();
            if (!res.ok || !result.success) {
                throw new Error(result.message || 'Failed to delete note');
            }
            notify('Note deleted', 'success');
            await loadNotes();
        } catch (error) {
            console.error('Error deleting note:', error);
            notify(error.message || 'Failed to delete note', 'error');
        }
    }

    // ---------- Load + render ----------
    async function loadNotes() {
        if (loading) loading.style.display = '';
        try {
            const res = await fetch(API, { credentials: 'include' });
            const result = await res.json();
            if (!res.ok || !result.success) {
                throw new Error(result.message || 'Failed to load notes');
            }
            renderNotes(result.data.notes || []);
        } catch (error) {
            console.error('Error loading notes:', error);
            listContainer.innerHTML = '<div class="notes-loading">Unable to load notes.</div>';
        } finally {
            if (loading) loading.style.display = 'none';
        }
    }

    function renderNotes(notes) {
        notesCount.textContent = `${notes.length} ${notes.length === 1 ? 'note' : 'notes'}`;
        listContainer.innerHTML = '';

        if (notes.length === 0) {
            listContainer.appendChild(buildEmptyState());
            return;
        }

        const mine = notes.filter(n => n.isOwn);
        const others = notes.filter(n => !n.isOwn);

        if (mine.length) {
            listContainer.appendChild(sectionHeading(`My notes (${mine.length})`));
            mine.forEach(note => listContainer.appendChild(buildNoteCard(note, true)));
        }
        if (others.length) {
            listContainer.appendChild(sectionHeading(`Notes by other instructors (${others.length})`));
            others.forEach(note => listContainer.appendChild(buildNoteCard(note, false)));
        }
    }

    function sectionHeading(text) {
        const h = document.createElement('div');
        h.className = 'notes-section-heading';
        h.textContent = text;
        return h;
    }

    function buildEmptyState() {
        const wrap = document.createElement('div');
        wrap.className = 'notes-empty';
        wrap.innerHTML = `
            <div class="empty-icon">${Icons.inbox}</div>
            <h3>No notes yet</h3>
            <p>Super Chat Notes are a shared notebook the bot reads. Add corrections, explanations,
               or things students keep asking about &mdash; and the bot will use them in Super Chat answers.</p>
        `;
        const btn = document.createElement('button');
        btn.className = 'btn-primary';
        btn.textContent = 'Write your first note';
        btn.addEventListener('click', () => openEditor());
        wrap.appendChild(btn);
        return wrap;
    }

    function buildNoteCard(note, isOwn) {
        const card = document.createElement('div');
        card.className = `note-card${isOwn ? ' mine' : ''}`;

        const header = document.createElement('div');
        header.className = 'note-card-header';
        const title = document.createElement('h3');
        title.textContent = note.title || 'Untitled note';
        const meta = document.createElement('div');
        meta.className = 'note-meta';
        meta.textContent = `${note.authorName || 'Instructor'} · ${formatDate(note.createdAt)}`;
        header.appendChild(title);
        header.appendChild(meta);

        const excerpt = document.createElement('p');
        excerpt.className = 'note-excerpt';
        excerpt.textContent = truncate(note.content || '', 280);

        const footer = document.createElement('div');
        footer.className = 'note-card-footer';

        const tags = document.createElement('div');
        tags.className = 'note-tags';
        (note.tags || []).forEach(tag => {
            const chip = document.createElement('span');
            chip.className = 'tag-chip';
            chip.textContent = tag;
            tags.appendChild(chip);
        });

        const actions = document.createElement('div');
        actions.className = 'note-actions';
        const usage = document.createElement('span');
        usage.className = 'note-usage';
        const count = note.usageCount || 0;
        usage.textContent = `Used in ${count} ${count === 1 ? 'answer' : 'answers'}`;
        actions.appendChild(usage);

        if (isOwn) {
            const editBtn = document.createElement('button');
            editBtn.className = 'btn-secondary';
            editBtn.textContent = 'Edit';
            editBtn.addEventListener('click', () => openEditor(note));
            const delBtn = document.createElement('button');
            delBtn.className = 'btn-danger';
            delBtn.textContent = 'Delete';
            delBtn.addEventListener('click', () => deleteNote(note.noteId));
            actions.appendChild(editBtn);
            actions.appendChild(delBtn);
        }

        footer.appendChild(tags);
        footer.appendChild(actions);

        card.appendChild(header);
        card.appendChild(excerpt);
        card.appendChild(footer);
        return card;
    }

    // ---------- Helpers ----------
    function truncate(text, max) {
        const clean = String(text || '').replace(/\s+/g, ' ').trim();
        return clean.length > max ? `${clean.slice(0, max).trim()}...` : clean;
    }
    function formatDate(value) {
        if (!value) return '';
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return '';
        return date.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
    }

    // Initial load
    loadNotes();
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
