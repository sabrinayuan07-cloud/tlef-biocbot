/**
 * Accessible names of the repeated controls on the instructor Course Upload
 * page (public/instructor/scripts/instructor-names.js): visible label first,
 * then hidden context in parentheses from most to least specific, with a
 * "- 1 of 2" position when a unit, file or objective shares its name.
 */
const Names = require('../../../public/instructor/scripts/instructor-names.js');

const units = [
    { id: 'Unit 1', title: 'Cell Structure' },
    { id: 'Unit 2', title: 'Cell Structure' },
    { id: 'Unit 3', title: '3. Metabolism' },
];
const name = Names.getControlName;

describe('formatContext', () => {
    test('wraps each part in parentheses, most specific first', () => {
        expect(Names.formatContext('Card 2', '1. Cell Structure')).toBe(' (Card 2) (1. Cell Structure)');
    });

    test('leaves out a missing part instead of writing "()"', () => {
        expect(Names.formatContext('', null, undefined, '  ')).toBe('');
        expect(Names.formatContext(undefined, 'Week 1')).toBe(' (Week 1)');
    });
});

describe('unit references', () => {
    test('a unit whose title repeats is referred to with its position', () => {
        expect(Names.getUnitReference(units, 'Unit 1')).toBe('Cell Structure - 1 of 2');
        expect(Names.getUnitReference(units, 'Unit 2')).toBe('Cell Structure - 2 of 2');
        expect(Names.getUnitReference(units, 'Unit 3')).toBe('3. Metabolism');
    });

    test('the heading shows the position as a suffix only when the title repeats', () => {
        expect(Names.getUnitHeadingSuffix(units, 'Unit 2')).toBe(' (2 of 2)');
        expect(Names.getUnitHeadingSuffix(units, 'Unit 3')).toBe('');
    });

    test('a missing unit gives an empty reference, and the name drops the unit part', () => {
        expect(Names.getUnitReference(units, 'Unit 9')).toBe('');
        expect(name('Delete Unit', '', Names.getUnitReference(units, 'Unit 9'))).toBe('Delete Unit');
    });

    test('renaming a unit so the titles differ drops both suffixes', () => {
        const renamed = [{ id: 'Unit 1', title: 'Cell Structure' }, { id: 'Unit 2', title: 'Enzymes' }];
        expect(Names.getUnitReference(renamed, 'Unit 1')).toBe('Cell Structure');
        expect(Names.getUnitHeadingSuffix(renamed, 'Unit 2')).toBe('');
    });
});

describe('unit controls', () => {
    const ref = Names.getUnitReference(units, 'Unit 2');

    test.each([
        ['Rename Unit', 'Rename Unit (Cell Structure - 2 of 2)'],
        ['Move Up', 'Move Up (Cell Structure - 2 of 2)'],
        ['Move Down', 'Move Down (Cell Structure - 2 of 2)'],
        ['Delete Unit', 'Delete Unit (Cell Structure - 2 of 2)'],
        ['Learning Objectives', 'Learning Objectives (Cell Structure - 2 of 2)'],
        ['Add Lecture Notes', 'Add Lecture Notes (Cell Structure - 2 of 2)'],
    ])('%s', (label, expected) => {
        expect(name(label, '', ref)).toBe(expected);
    });

    test('the publish switch is named for what turning it on does', () => {
        expect(name(Names.getPublishSwitchLabel(), '', '3. Metabolism')).toBe('Publish (3. Metabolism)');
    });

    test('rename editor buttons quote the title they rename', () => {
        const quoted = Names.getUnitQuotedReference(units, 'Unit 1');
        expect(quoted).toBe('"Cell Structure" - 1 of 2');
        expect(Names.getRenameEditorButtonName('Save', quoted)).toBe('Save (Rename Unit - "Cell Structure" - 1 of 2)');
        expect(Names.getRenameEditorButtonName('Cancel', Names.getUnitQuotedReference(units, 'Unit 3')))
            .toBe('Cancel (Rename Unit - "3. Metabolism")');
        expect(Names.getRenameEditorButtonName('Save', '')).toBe('Save');
    });
});

describe('course materials', () => {
    const files = [
        { id: '0', title: 'lecture.pdf' },
        { id: '1', title: 'lecture.pdf' },
        { id: '2', title: 'tutorial.txt' },
    ];

    test('a repeated file carries its position in the name and as a visible suffix', () => {
        expect(name('View', Names.getMaterialLead(files, '1'), 'Cell Structure - 1 of 2'))
            .toBe('View lecture.pdf (2 of 2) (Cell Structure - 1 of 2)');
        expect(Names.getMaterialTitleSuffix(files, '0')).toBe(' (1 of 2)');
    });

    test('a unique file is named by its title alone', () => {
        expect(name('Delete', Names.getMaterialLead(files, '2'), '1. Cell Structure')).toBe('Delete tutorial.txt (1. Cell Structure)');
        expect(Names.getMaterialTitleSuffix(files, '2')).toBe('');
    });

    test('an unknown file leaves the label and unit', () => {
        expect(name('Download', Names.getMaterialLead(files, '7'), '1. Cell Structure')).toBe('Download (1. Cell Structure)');
    });

    test('placeholder Upload says which required material it uploads', () => {
        expect(name('Upload', Names.getPlaceholderUploadLead('lecture-notes'), '2. Enzymes')).toBe('Upload lecture notes (2. Enzymes)');
        expect(name('Upload', Names.getPlaceholderUploadLead('practice-quiz'), '2. Enzymes'))
            .toBe('Upload practice questions or tutorial (2. Enzymes)');
    });
});

describe('learning objectives', () => {
    const objectives = [
        { id: '0', title: 'Explain osmosis' },
        { id: '1', title: 'Explain osmosis' },
        { id: '2', title: 'Name the organelles' },
    ];

    test('the remove control quotes the objective, with its position when it repeats', () => {
        expect(name('Remove Objective', Names.getObjectiveLead(objectives, '1'), 'Cell Structure - 1 of 2'))
            .toBe('Remove Objective ("Explain osmosis" - 2 of 2) (Cell Structure - 1 of 2)');
        expect(name('Remove Objective', Names.getObjectiveLead(objectives, '2'), '1. Cell Structure'))
            .toBe('Remove Objective ("Name the organelles") (1. Cell Structure)');
    });
});

describe('flashcards and questions', () => {
    test.each([
        ['Generate Draft', Names.getSectionLead('flashcards'), 'Generate Draft (Student Flashcards) (1. Cell Structure)'],
        ['Add Card', Names.getSectionLead('flashcards'), 'Add Card (Student Flashcards) (1. Cell Structure)'],
        ['Save Draft', Names.getSectionLead('flashcards'), 'Save Draft (Student Flashcards) (1. Cell Structure)'],
        ['Publish to Students', Names.getSectionLead('flashcards'), 'Publish to Students (Student Flashcards) (1. Cell Structure)'],
        ['Unpublish', Names.getSectionLead('flashcards'), 'Unpublish (Student Flashcards) (1. Cell Structure)'],
        ['Remove', Names.getCardLead(2), 'Remove (Card 2) (1. Cell Structure)'],
        ['Front', Names.getCardLead(2), 'Front (Card 2) (1. Cell Structure)'],
        ['Back', Names.getCardLead(2), 'Back (Card 2) (1. Cell Structure)'],
        ['Add Question', Names.getSectionLead('questions'), 'Add Question (Assessment Questions) (1. Cell Structure)'],
        ['Edit Learning Objective', Names.getQuestionLead(1), 'Edit Learning Objective (Question 1) (1. Cell Structure)'],
        ['Delete', Names.getQuestionLead(1), 'Delete (Question 1) (1. Cell Structure)'],
    ])('%s%s', (label, lead, expected) => {
        expect(name(label, lead, '1. Cell Structure')).toBe(expected);
    });

    test('every name starts with its visible label', () => {
        for (const label of ['Add Card', 'Remove', 'Front', 'Add Question']) {
            expect(name(label, Names.getCardLead(1), 'Unit 1').startsWith(label)).toBe(true);
        }
    });
});
