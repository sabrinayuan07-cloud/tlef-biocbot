const express = require('express');
const multer = require('multer');
const request = require('supertest');
const {
    MAX_OBJECTS,
    scanRequestValue,
    findListOrObjectId,
    requirePlainRequestValues,
} = require('../../../src/middleware/plainRequestValues');

const findOperatorKey = (value) => scanRequestValue(value).operatorKey;

// The server's order and limits: body parsers, then the check, then the routes.
function checkedApp() {
    const app = express();
    app.use(express.json({ limit: '50mb' }));
    app.use(express.urlencoded({ extended: true, limit: '50mb' }));
    app.use(requirePlainRequestValues);
    const upload = multer({ storage: multer.memoryStorage() });
    app.post('/upload', upload.single('file'), requirePlainRequestValues, (req, res) => res.json({ reached: true, body: req.body }));
    app.all('/{*rest}', (req, res) => res.json({ reached: true, body: req.body, query: req.query }));
    return app;
}

beforeAll(() => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterAll(() => jest.restoreAllMocks());

describe('findOperatorKey', () => {
    test('finds a "$" field name at any depth, in objects and lists', () => {
        expect(findOperatorKey({ courseId: { $in: ['a', 'b'] } })).toBe('$in');
        expect(findOperatorKey({ chatData: { messages: [{ meta: { $where: 'x' } }] } })).toBe('$where');
        expect(findOperatorKey([{ ok: 1 }, { $gt: '' }])).toBe('$gt');
    });

    test('lets plain values through, including "$" inside a value or later in a name', () => {
        expect(findOperatorKey(undefined)).toBeNull();
        expect(findOperatorKey(null)).toBeNull();
        expect(findOperatorKey('$in')).toBeNull();
        expect(findOperatorKey({ message: '$5 or $10?', price$: 3, list: ['$x'], nested: { a: [1, { b: null }] } })).toBeNull();
    });

    test('walks very deep nesting without overflowing the stack', () => {
        let deep = { $ne: null };
        for (let i = 0; i < 100000; i += 1) deep = { a: deep };
        expect(findOperatorKey(deep)).toBe('$ne');
    });
});

describe('scanRequestValue size limit', () => {
    test('walks up to MAX_OBJECTS objects and lists, and stops after that', () => {
        expect(scanRequestValue(Array.from({ length: MAX_OBJECTS - 1 }, () => ({})))).toEqual({ operatorKey: null, tooLarge: false });
        expect(scanRequestValue(Array.from({ length: MAX_OBJECTS }, () => ({})))).toEqual({ operatorKey: null, tooLarge: true });
    });

    test('a huge body costs about as much as the limit, however large it is', () => {
        const huge = Array.from({ length: 3000000 }, () => ({}));
        const started = process.hrtime.bigint();
        expect(scanRequestValue(huge).tooLarge).toBe(true);
        expect(Number(process.hrtime.bigint() - started) / 1e6).toBeLessThan(1000);
    });

    test('lists of plain values do not count towards the limit', () => {
        expect(scanRequestValue({ values: new Array(5000000).fill(0) })).toEqual({ operatorKey: null, tooLarge: false });
    });

    test('a cycle ends at the limit instead of looping', () => {
        const value = { a: {} };
        value.a.back = value;
        expect(scanRequestValue(value).tooLarge).toBe(true);
    });
});

describe('findListOrObjectId', () => {
    test('finds a top-level ID field holding an object or a list', () => {
        expect(findListOrObjectId({ courseId: ['C1'] })).toBe('courseId');
        expect(findListOrObjectId({ title: 'x', studentId: { a: 1 } })).toBe('studentId');
        expect(findListOrObjectId({ lectureName: ['Unit 1'] })).toBe('lectureName');
        expect(findListOrObjectId({ unitName: {} })).toBe('unitName');
    });

    test('lets single values, other fields and nested IDs through', () => {
        expect(findListOrObjectId({ courseId: 'C1', instructorId: null, questionId: 7, isValid: ['x'] })).toBeNull();
        expect(findListOrObjectId({ sourceCourseIds: ['C1', 'C2'], documentIds: ['d1'] })).toBeNull();
        expect(findListOrObjectId({ questions: [{ courseId: ['C1'] }] })).toBeNull();
        expect(findListOrObjectId(['courseId'])).toBeNull();
        expect(findListOrObjectId(undefined)).toBeNull();
    });
});

describe('requirePlainRequestValues', () => {
    const app = checkedApp();

    test('lets ordinary JSON, form and query requests through', async () => {
        await request(app).post('/api/questions').send({ courseId: 'C1', lectureName: 'Unit 1', questions: [{ options: { A: '$5' } }] }).expect(200);
        await request(app).post('/api/x').type('form').send({ courseId: 'C1' }).expect(200);
        await request(app).get('/api/x?courseId=C1&note=%24in').expect(200);
        await request(app).get('/api/x').expect(200);
    });

    test('refuses a "$" field name in a JSON body', async () => {
        const res = await request(app).post('/api/documents/text').send({ courseId: { $in: ['C2', 'C1'] } }).expect(400);
        expect(res.body).toMatchObject({ success: false, code: 'INVALID_FIELD_NAME' });
        expect(res.body.reached).toBeUndefined();
    });

    test('refuses a "$" field name in a form body and in a query string', async () => {
        await request(app).post('/api/x').type('form').send('courseId[$gte]=').expect(400);
        await request(app).get('/api/x?$where=1').expect(400);
    });

    test('refuses an ID field holding a list or an object, from a body or a query string', async () => {
        const res = await request(app).post('/api/questions').send({ courseId: ['C1'], lectureName: 'Unit 1' }).expect(400);
        expect(res.body).toMatchObject({ success: false, code: 'INVALID_FIELD_VALUE' });
        expect(res.body.message).toMatch(/^courseId /);
        await request(app).post('/api/x').send({ studentId: { name: 'x' } }).expect(400);
        await request(app).get('/api/x?courseId=C1&courseId=C2').expect(400);
    });

    test('refuses a body with more objects than the limit, with 413', async () => {
        const body = `[${'{},'.repeat(MAX_OBJECTS)}{}]`;
        const res = await request(app).post('/api/auth/login').set('Content-Type', 'application/json').send(body).expect(413);
        expect(res.body).toMatchObject({ success: false, code: 'REQUEST_TOO_LARGE' });
    });

    test('checks a multipart body once the route has parsed it', async () => {
        const send = (field, value) => request(app).post('/upload')
            .field(field, value)
            .attach('file', Buffer.from('notes'), { filename: 'notes.txt', contentType: 'text/plain' });
        await send('courseId', 'C1').expect(200);
        await send('courseId[$in][0]', 'C1').expect(400);
        await send('courseId[0]', 'C1').expect(400);
    });
});
