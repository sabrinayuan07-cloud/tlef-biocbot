#!/usr/bin/env node

const path = require('path');
const { execFileSync } = require('child_process');
const { MongoClient } = require('mongodb');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getLmsTokenCollectionName } = require('../src/config/chatEncryption');
const { initializeChatEncryption } = require('../src/services/chatEncryption');

const BIOCBOT_COURSE_ID = 'BIOC-302---GENERAL-B-1782773368847';
const CANVAS_ACCOUNT_ID = '1';
const CANVAS_SIS_COURSE_ID = 'BIOC-302-LOCAL-GRADES';
const MOODLE_CONTAINER = 'ubc-moodle-web-1';

const students = [
    { key: 'avery.gupta38', email: 'avery.gupta38@student.ubc.ca', name: 'Avery Gupta', scores: [88, 92, 84] },
    { key: 'bio_student', email: 'bio_student@student.ubc.ca', name: 'Bruno Student', scores: [73, 81, 78] },
    { key: 'cameron.patel43', email: 'cameron.patel43@student.ubc.ca', name: 'Cameron Patel', scores: [95, 89, 93] },
    { key: 'casey.ali36', email: 'casey.ali36@student.ubc.ca', name: 'Casey Ali', scores: [82, 76, 87] },
    { key: 'devon.wong44', email: 'devon.wong44@student.ubc.ca', name: 'Devon Wong', scores: [68, 74, 71] }
];

const assignments = [
    { name: 'Protein Structure Quiz', pointsPossible: 100 },
    { name: 'Enzyme Kinetics Assignment', pointsPossible: 100 },
    { name: 'Metabolism Midterm', pointsPossible: 100 }
];

function requireLocalUrl(value, name) {
    const url = new URL(value);
    if (!['localhost', '127.0.0.1', '::1'].includes(url.hostname)) {
        throw new Error(`${name} must point to a local development server`);
    }
    return url.origin;
}

async function canvasRequest(baseUrl, token, method, pathname, body) {
    const response = await fetch(`${baseUrl}${pathname}`, {
        method,
        headers: {
            Authorization: `Bearer ${token}`,
            ...(body ? { 'Content-Type': 'application/json' } : {})
        },
        body: body ? JSON.stringify(body) : undefined
    });
    if (!response.ok) {
        const detail = await response.text();
        throw new Error(`Canvas ${method} ${pathname} failed (${response.status}): ${detail.slice(0, 300)}`);
    }
    return response.status === 204 ? null : response.json();
}

async function seedCanvas(db, course, localUsers) {
    const canvasUrl = requireLocalUrl(process.env.CANVAS_DOMAIN, 'CANVAS_DOMAIN');
    const tokenDoc = await db.collection(getLmsTokenCollectionName('canvas'))
        .findOne({ userKey: course.instructorId });
    const token = tokenDoc?.tokens?.accessToken;
    if (!token) throw new Error('Connect the BIOC 302 instructor to local Canvas before seeding');

    const existingCourses = await canvasRequest(
        canvasUrl,
        token,
        'GET',
        `/api/v1/accounts/${CANVAS_ACCOUNT_ID}/courses?per_page=100&search_term=${encodeURIComponent('BIOC 302')}`
    );
    let canvasCourse = existingCourses.find((candidate) =>
        candidate.sis_course_id === CANVAS_SIS_COURSE_ID || candidate.course_code === 'BIOC302-LOCAL'
    );
    if (!canvasCourse) {
        canvasCourse = await canvasRequest(canvasUrl, token, 'POST', `/api/v1/accounts/${CANVAS_ACCOUNT_ID}/courses`, {
            course: {
                name: 'BIOC 302 - General Biochemistry',
                course_code: 'BIOC302-LOCAL',
                sis_course_id: CANVAS_SIS_COURSE_ID,
                is_public: false,
                license: 'private'
            },
            offer: true
        });
    }
    if (canvasCourse.workflow_state !== 'available') {
        canvasCourse = await canvasRequest(canvasUrl, token, 'PUT', `/api/v1/courses/${canvasCourse.id}`, {
            course: { event: 'offer' }
        });
    }

    // Account-level course creation does not enroll the connected Canvas user.
    // Add that account as a teacher so this fixture appears in "All Courses".
    const canvasProfile = await canvasRequest(canvasUrl, token, 'GET', '/api/v1/users/self/profile');
    await canvasRequest(canvasUrl, token, 'POST', `/api/v1/courses/${canvasCourse.id}/enrollments`, {
        enrollment: {
            user_id: canvasProfile.id,
            type: 'TeacherEnrollment',
            enrollment_state: 'active',
            notify: false
        }
    });

    const canvasUsers = new Map();
    for (const student of students) {
        const candidates = await canvasRequest(
            canvasUrl,
            token,
            'GET',
            `/api/v1/accounts/${CANVAS_ACCOUNT_ID}/users?per_page=100&search_term=${encodeURIComponent(student.email)}`
        );
        let user = candidates.find((candidate) =>
            candidate.login_id === student.email || candidate.email === student.email
        );
        if (!user) {
            user = await canvasRequest(canvasUrl, token, 'POST', `/api/v1/accounts/${CANVAS_ACCOUNT_ID}/users`, {
                user: { name: student.name, skip_registration: true },
                pseudonym: {
                    unique_id: student.email,
                    password: 'password',
                    sis_user_id: `biocbot-${student.key}`,
                    send_confirmation: false
                },
                communication_channel: {
                    type: 'email',
                    address: student.email,
                    skip_confirmation: true
                }
            });
        }
        canvasUsers.set(student.key, user);
        await canvasRequest(canvasUrl, token, 'POST', `/api/v1/courses/${canvasCourse.id}/enrollments`, {
            enrollment: {
                user_id: user.id,
                type: 'StudentEnrollment',
                enrollment_state: 'active',
                notify: false
            }
        });
    }

    const existingAssignments = await canvasRequest(
        canvasUrl,
        token,
        'GET',
        `/api/v1/courses/${canvasCourse.id}/assignments?per_page=100`
    );
    const canvasAssignments = [];
    for (const assignment of assignments) {
        let record = existingAssignments.find((candidate) => candidate.name === assignment.name);
        if (!record) {
            record = await canvasRequest(canvasUrl, token, 'POST', `/api/v1/courses/${canvasCourse.id}/assignments`, {
                assignment: {
                    name: assignment.name,
                    points_possible: assignment.pointsPossible,
                    grading_type: 'points',
                    published: true
                }
            });
        }
        canvasAssignments.push(record);
    }

    for (const student of students) {
        const user = canvasUsers.get(student.key);
        for (let index = 0; index < canvasAssignments.length; index += 1) {
            await canvasRequest(
                canvasUrl,
                token,
                'PUT',
                `/api/v1/courses/${canvasCourse.id}/assignments/${canvasAssignments[index].id}/submissions/${user.id}`,
                { submission: { posted_grade: String(student.scores[index]) } }
            );
        }
    }

    await storeSourceAndMappings({
        db,
        course,
        provider: 'canvas',
        externalCourse: {
            id: String(canvasCourse.id),
            name: canvasCourse.name,
            code: canvasCourse.course_code
        },
        localUsers,
        externalUsers: Object.fromEntries([...canvasUsers].map(([key, user]) => [key, String(user.id)]))
    });
    return { courseId: String(canvasCourse.id), users: canvasUsers.size, assignments: canvasAssignments.length };
}

function seedMoodleFixture({ rotateToken = false } = {}) {
    requireLocalUrl(process.env.MOODLE_DOMAIN, 'MOODLE_DOMAIN');
    const localScript = path.join(__dirname, 'local-lms', 'seed-moodle-grades.php');
    const containerScript = '/tmp/biocbot-seed-moodle-grades.php';
    execFileSync('docker', ['cp', localScript, `${MOODLE_CONTAINER}:${containerScript}`], { stdio: 'ignore' });
    const args = ['exec', MOODLE_CONTAINER, 'php', containerScript];
    if (rotateToken) args.push('--rotate-token');
    const output = execFileSync('docker', args, {
        encoding: 'utf8',
        maxBuffer: 1024 * 1024
    });
    const jsonLine = output.trim().split(/\r?\n/).reverse()
        .find((line) => line.trim().startsWith('{'));
    if (!jsonLine) throw new Error('Moodle fixture did not return a JSON result');
    return JSON.parse(jsonLine);
}

async function seedMoodle(db, course, localUsers, options = {}) {
    const fixture = seedMoodleFixture(options);
    await db.collection(getLmsTokenCollectionName('moodle')).updateOne(
        { userKey: course.instructorId },
        { $set: { tokens: { token: fixture.token, moodleUserId: fixture.adminUserId } } },
        { upsert: true }
    );
    await storeSourceAndMappings({
        db,
        course,
        provider: 'moodle',
        externalCourse: {
            id: fixture.courseId,
            name: fixture.courseName,
            code: fixture.courseCode
        },
        localUsers,
        externalUsers: fixture.userIds
    });
    return { courseId: fixture.courseId, users: Object.keys(fixture.userIds).length, assignments: Object.keys(fixture.gradeItemIds).length };
}

async function storeSourceAndMappings({ db, course, provider, externalCourse, localUsers, externalUsers }) {
    const now = new Date();
    const source = {
        courseId: externalCourse.id,
        name: externalCourse.name,
        code: externalCourse.code,
        linkedAt: now,
        linkedBy: course.instructorId
    };
    await db.collection('courses').updateOne(
        { courseId: course.courseId },
        {
            $set: {
                [`lmsGradeSources.${provider}`]: source,
                [`lmsFileSources.${provider}`]: { provider, ...source },
                updatedAt: now
            }
        }
    );

    for (const student of students) {
        const localUser = localUsers.get(student.email);
        const externalUserId = externalUsers[student.key];
        if (!localUser || !externalUserId) {
            throw new Error(`Could not map ${student.email} for ${provider}`);
        }
        await db.collection('lms_identity_mappings').updateOne(
            {
                courseId: course.courseId,
                provider,
                externalCourseId: externalCourse.id,
                externalUserId: String(externalUserId)
            },
            {
                $set: {
                    localUserId: String(localUser.userId),
                    externalLabel: student.name,
                    mappedAt: now,
                    mappedBy: course.instructorId
                }
            },
            { upsert: true }
        );
    }
}

async function main() {
    if (!process.argv.includes('--yes')) {
        throw new Error('This writes local Canvas, Moodle, and MongoDB fixtures. Re-run with --yes.');
    }
    if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required');
    const client = new MongoClient(process.env.MONGO_URI);
    await client.connect();
    try {
        // The LMS tokens this reads and writes are encrypted when the app's
        // encryption is on, so go through the same wrapper the server uses.
        const db = await initializeChatEncryption(client.db());
        const course = await db.collection('courses').findOne({ courseId: BIOCBOT_COURSE_ID });
        if (!course) throw new Error('Local BIOC 302 course was not found');
        const userRecords = await db.collection('users').find({ email: { $in: students.map((student) => student.email) } })
            .project({ _id: 0, userId: 1, email: 1 })
            .toArray();
        const localUsers = new Map(userRecords.map((user) => [user.email, user]));
        if (localUsers.size !== students.length) {
            throw new Error(`Expected ${students.length} local students, found ${localUsers.size}`);
        }

        const canvasResult = process.argv.includes('--moodle-only')
            ? null
            : await seedCanvas(db, course, localUsers);
        const moodleResult = process.argv.includes('--canvas-only')
            ? null
            : await seedMoodle(db, course, localUsers, {
                rotateToken: process.argv.includes('--rotate-moodle-token')
            });
        console.log(JSON.stringify({
            success: true,
            biocbotCourseId: course.courseId,
            canvas: canvasResult,
            moodle: moodleResult
        }, null, 2));
    } finally {
        await client.close();
    }
}

main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
});
