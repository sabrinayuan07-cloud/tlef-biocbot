const fs = require('fs');
const path = require('path');
const vm = require('vm');

function createSelect(document) {
    return {
        value: '',
        disabled: false,
        options: [],
        replaceChildren() {
            this.options = [];
            this.value = '';
        },
        appendChild(option) {
            this.options.push(option);
            if (option.selected || (!this.value && !option.disabled)) this.value = option.value;
        },
        addEventListener: jest.fn(),
        ownerDocument: document
    };
}

function loadStudentHub(initialGradeResult, availableCoursesResult) {
    const elements = {};
    const document = {
        addEventListener: jest.fn(),
        createElement: jest.fn(() => ({
            value: '',
            textContent: '',
            disabled: false,
            selected: false
        })),
        getElementById: jest.fn((id) => elements[id] || null)
    };

    elements['lms-grade-provider'] = createSelect(document);
    elements['lms-grade-course'] = createSelect(document);
    elements['import-lms-grades'] = { disabled: false };
    elements['match-lms-students'] = { disabled: false };
    elements['link-lms-grade-course'] = { disabled: false };
    elements['connect-lms-grade-provider'] = { disabled: false, hidden: true, textContent: 'Connect LMS' };
    elements['lms-grades-bar'] = { hidden: false };
    elements['lms-grades-status'] = { textContent: '' };
    elements['lms-grades-source-note'] = { textContent: '' };
    elements['students-container'] = { innerHTML: '' };
    elements['lms-unmatched-panel'] = { hidden: true };
    elements['lms-unmatched-summary'] = { textContent: '' };
    elements['lms-unmatched-body'] = { innerHTML: '' };

    const responses = [initialGradeResult, availableCoursesResult].filter(Boolean);
    // A payload may carry `httpStatus` to stand in for an error response.
    const authenticatedFetch = jest.fn(async () => {
        const { httpStatus = 200, ...payload } = responses.shift() || {};
        return {
            ok: httpStatus < 400,
            status: httpStatus,
            text: async () => JSON.stringify(payload)
        };
    });
    const assign = jest.fn();
    const context = vm.createContext({
        authenticatedFetch,
        clearTimeout,
        console,
        document,
        fetch: jest.fn(),
        localStorage: { getItem: jest.fn(), setItem: jest.fn() },
        setTimeout,
        showNotification: jest.fn(),
        URLSearchParams,
        window: {
            location: { assign, pathname: '/instructor/student-hub', search: '' }
        }
    });

    const source = fs.readFileSync(
        path.join(__dirname, '../../../public/instructor/scripts/student-hub.js'),
        'utf8'
    );
    vm.runInContext(source, context);
    return { context, elements, authenticatedFetch, assign };
}

describe('Student Hub LMS grade loading', () => {
    test('does not start Canvas authentication when Canvas is not linked', async () => {
        const harness = loadStudentHub({
            success: true,
            data: {
                provider: 'canvas',
                source: null,
                sources: [{ provider: 'canvas', configured: true, linked: false }],
                students: [],
                gradeItems: []
            }
        });

        await harness.context.loadLmsGrades('BIOC-302');

        expect(harness.authenticatedFetch).toHaveBeenCalledTimes(1);
        expect(harness.authenticatedFetch).toHaveBeenCalledWith('/api/lms/grades/courses/BIOC-302');
        expect(harness.assign).not.toHaveBeenCalled();
        expect(harness.elements['lms-grade-course'].disabled).toBe(true);
        expect(harness.elements['lms-grade-course'].options[0].textContent)
            .toBe('Connect Canvas to choose a course');
        expect(harness.elements['connect-lms-grade-provider']).toMatchObject({
            disabled: false,
            hidden: false,
            textContent: 'Connect Canvas'
        });
    });

    test('still loads Canvas course choices for an already linked course', async () => {
        const source = {
            provider: 'canvas',
            configured: true,
            linked: true,
            courseId: '42',
            name: 'Biochemistry 302',
            code: 'BIOC 302'
        };
        const harness = loadStudentHub(
            {
                success: true,
                data: {
                    provider: 'canvas',
                    source,
                    sources: [source],
                    students: [],
                    gradeItems: []
                }
            },
            {
                success: true,
                data: { current: source, courses: [{ id: '42', name: source.name, code: source.code }] }
            }
        );

        await harness.context.loadLmsGrades('BIOC-302');

        expect(harness.authenticatedFetch).toHaveBeenCalledTimes(2);
        expect(harness.authenticatedFetch.mock.calls[1][0])
            .toBe('/api/lms/grades/courses/BIOC-302/available-courses?provider=canvas');
        expect(harness.elements['lms-grade-course'].value).toBe('42');
    });
});

describe('Student Hub Canvas connection handling', () => {
    const linkedSource = {
        provider: 'canvas',
        configured: true,
        linked: true,
        courseId: '42',
        name: 'Biochemistry 302',
        code: 'BIOC 302'
    };
    const gradeView = {
        success: true,
        data: { provider: 'canvas', source: linkedSource, sources: [linkedSource], students: [], gradeItems: [] }
    };

    test('offers Connect instead of leaving the page when a co-instructor has not connected Canvas', async () => {
        const harness = loadStudentHub(gradeView, { httpStatus: 401, success: false, connected: false });

        await harness.context.loadLmsGrades('BIOC-302');

        expect(harness.assign).not.toHaveBeenCalled();
        expect(harness.elements['connect-lms-grade-provider']).toMatchObject({ hidden: false, textContent: 'Connect Canvas' });
        expect(harness.elements['lms-grades-source-note'].textContent).toContain('Connect Canvas to see or change');
    });

    test('shows a Canvas refusal instead of looping through Canvas login', async () => {
        const harness = loadStudentHub(gradeView, {
            httpStatus: 403,
            success: false,
            code: 'CANVAS_ACCESS_DENIED',
            message: 'Canvas refused this request.'
        });

        await harness.context.loadLmsGrades('BIOC-302');

        expect(harness.assign).not.toHaveBeenCalled();
        expect(harness.elements['lms-grades-source-note'].textContent).toContain('Canvas refused this request.');
    });

    test('goes to Canvas to connect when the instructor clicks Connect', async () => {
        const harness = loadStudentHub({ httpStatus: 401, success: false, connected: false });
        harness.elements['lms-grade-provider'].value = 'canvas';
        // A top-level `let` in the page script, so it is set inside the context.
        vm.runInContext("currentGradeCourseId = 'BIOC-302'", harness.context);

        await harness.context.connectLmsGradeProvider();

        expect(harness.assign).toHaveBeenCalledWith(
            '/api/lms/canvas/auth/login?returnTo=%2Finstructor%2Fstudent-hub'
        );
    });
});

describe('Student Hub LMS responses', () => {
    test('explains a proxy timeout instead of blaming the deployment', async () => {
        const harness = loadStudentHub();
        const response = { status: 504, text: async () => '<html>Gateway Time-out</html>' };

        await expect(harness.context.readLmsJson(response)).rejects.toThrow('may still be finishing');
    });
});

describe('Student Hub roster sync results', () => {
    const match = {
        provider: 'canvas',
        syncToken: 'sync-1',
        prune: { allowed: true },
        coverage: { total: 40, integrationId: 40 },
        unmatchedLmsStudents: [],
        unmatchedBiocBotStudents: [
            { localUserId: 'user-left', displayName: 'Alan Left', email: 'alan@student.ubc.ca' },
            { localUserId: 'user-code', displayName: 'Grace Code', email: '' }
        ],
        dropCandidates: [
            { localUserId: 'user-left', displayName: 'Alan Left', email: 'alan@student.ubc.ca' }
        ]
    };

    test('offers to disable only the students who left the Canvas course', () => {
        const harness = loadStudentHub();

        harness.context.renderUnmatchedPanel(match);

        const html = harness.elements['lms-unmatched-body'].innerHTML;
        expect(harness.elements['lms-unmatched-panel'].hidden).toBe(false);
        expect(html).toContain('Left the Canvas course (1)');
        expect(html).toContain('Disable access for 1 student');
        expect(html).toContain('In BiocBot, not on the synced Canvas roster (1)');
        const [leftSection, notOnRosterSection] = html.split('not on the synced Canvas roster');
        expect(leftSection).toContain('Alan Left');
        expect(leftSection).not.toContain('Grace Code');
        expect(notOnRosterSection).toContain('Grace Code');
    });

    test('lists students whose access is already off separately instead of as unexplained', () => {
        const harness = loadStudentHub();

        harness.context.renderUnmatchedPanel({
            ...match,
            dropCandidates: [],
            unmatchedBiocBotStudents: [
                { localUserId: 'user-left', displayName: 'Alan Left', email: '', accessDisabled: true },
                { localUserId: 'user-code', displayName: 'Grace Code', email: '' }
            ]
        });

        const html = harness.elements['lms-unmatched-body'].innerHTML;
        const [notOnRosterSection, disabledSection] = html.split('Access already disabled (1)');
        expect(disabledSection).toContain('Alan Left');
        expect(notOnRosterSection).toContain('not on the synced Canvas roster (1)');
        expect(notOnRosterSection).not.toContain('Alan Left');
    });

    test('escapes runs of markup characters in names', () => {
        const harness = loadStudentHub();

        harness.context.renderUnmatchedPanel({
            ...match,
            unmatchedBiocBotStudents: [{ localUserId: 'x', displayName: '<<img src=x onerror=alert(1)//', email: 'a"><b>@ubc.ca' }],
            dropCandidates: []
        });

        const html = harness.elements['lms-unmatched-body'].innerHTML;
        expect(html).not.toContain('<img');
        expect(html).not.toContain('"><b>');
        expect(html).toContain('&lt;&lt;img src=x onerror=alert(1)//');
    });

    test('shows no drop button when nobody left the Canvas course', () => {
        const harness = loadStudentHub();

        harness.context.renderUnmatchedPanel({ ...match, dropCandidates: [] });

        const html = harness.elements['lms-unmatched-body'].innerHTML;
        expect(html).not.toContain('Disable access');
        expect(html).toContain('In BiocBot, not on the synced Canvas roster (2)');
    });
});
