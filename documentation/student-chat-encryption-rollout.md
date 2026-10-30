# Student chat encryption rollout

BiocBot uses `@ubc/genai-toolkit-encryption` to encrypt chat transcripts, other
student- or instructor-written text, and stored LMS tokens in MongoDB. Application code continues
to read and write normal JavaScript objects; MongoDB stores an authenticated
AES-256-GCM envelope in place of each configured field.

## Protected collections

One policy, one key, one namespace covers all of them:

| Collection | Encrypted fields | Written by |
| --- | --- | --- |
| `chat_sessions` | `chatData`, `title` | student course chat |
| `student_super_course_chat_sessions` | `chatData`, `title` | student Super Course chat |
| `instructor_chat_sessions` | `chatData`, `title` | instructor Super Course chat |
| `mentalHealthFlags` | `message`, `conversationContext`, `llmReason` | wellbeing check on student messages |
| `flaggedQuestions` | `questionContent`, `flagDescription`, `instructorResponse` | flag button and instructor replies |
| `messageFeedback` | `messageContentPreview` | thumbs up/down on a bot reply |
| `chatSurveyResponses` | `comment` | end-of-chat survey |
| `quizAttempts` | `studentAnswer`, `feedback` | quiz answers and their AI feedback |
| `lms_canvas_tokens` | `tokens` | instructor connecting Canvas (OAuth access and refresh tokens) |
| `lms_moodle_tokens` | `tokens` | instructor connecting Moodle (web-service token) |

Chat titles are encrypted because the app builds them from the first 50
characters of the student's first question.

The LMS tokens are credentials: a Moodle web-service token, or a Canvas refresh
token together with the Canvas client secret, acts as that instructor in the
LMS. The LMS toolkit's token store only looks them up by `userKey`, so they need
no blind index. A deployment that renames these collections with
`CANVAS_TOKEN_COLLECTION_NAME` or `MOODLE_TOKEN_COLLECTION_NAME` keeps them
protected under the new name; use that name wherever this guide says
`lms_canvas_tokens` or `lms_moodle_tokens`.

The map lives in `ENCRYPTED_FIELDS` in `src/config/chatEncryption.js` and is
the single source the config, the synthetic canary, and the tests all read. Add
a field there and it is protected everywhere at once — but only after checking
that nothing filters, sorts, regex-searches, groups, or indexes on it. The
toolkit rejects all of those on an encrypted field, and it rejects `$group`
anywhere on a protected collection; that is why the flag, mental-health, and
quiz statistics count in code instead of with an aggregation.

Nothing else is encrypted. `users`, `courses` (including `studentEnrollment`),
`student_pseudonyms`, `lms_identity_mappings`, `lms_grade_snapshots`,
`documents`, Qdrant payloads, and `struggleActivity` are out of scope for this
rollout. AI provider API keys are encrypted separately, with
`BIOCBOT_KEY_ENCRYPTION_SECRET`, not by this policy.

The rollout deliberately leaves ids (`courseId`, `studentId`, `instructorId`,
`superchatId`, `sessionId`, `flagId`), names (`studentName`, `instructorName`),
`unitName`, statuses, `flagReason`, `concernLevel`, `correct`, `messageCount`,
`duration`, `savedAt`, timestamps, and deletion flags in plaintext. They remain
available for existing filters, sorts, retention jobs, pseudonymization, and
dashboards — including the `distinct('studentId', …)` query behind Super Course
pseudonyms. Expanding the schema to names or identifiers requires a separate
query/index review, because those are looked up by value and would need blind
indexes.

Each envelope's additional authenticated data binds it to its own namespace,
collection, field, and key id, so a ciphertext cannot be moved between these
collections or fields even though they share a key.

## Security boundary

A person with MongoDB access but without the application key cannot decrypt the
configured fields. Someone who compromises both the running application
and its key can decrypt it because BiocBot must possess the key to show chat
history. The wrapper does not protect plaintext in logs, exports, browser
storage, Qdrant, application memory, or third-party calls.

The assessment-summary repair script now uses the protected database wrapper,
but its pre-change JSON backup is still an intentional plaintext export. The
file is created with owner-only permissions and must be handled under the
applicable data-retention and transfer policy.

Only writes through the protected wrapper are encrypted. Anything that writes a
configured collection on the raw `Db` stores plaintext, and the canary cannot
see that because it writes through the wrapper itself. This is why the server
builds the wrapper before the LMS integration and hands it to the token stores,
and why `scripts/seed-local-lms-grades.js` opens the database the same way.

The chat encryption key must be independent from
`BIOCBOT_KEY_ENCRYPTION_SECRET`, MongoDB credentials, and any future blind-index
key. Keep it outside source control and separate from database backups.

## Local canary

Run the synthetic real-MongoDB canary first:

```bash
npm run encryption:canary
```

It creates a uniquely named temporary database, writes one synthetic document
through the wrapper **into every collection in `ENCRYPTED_FIELDS`**, with a
marker string in every configured field. It verifies that each configured field
is stored as an envelope, that the marker appears nowhere at rest, and that a
protected read returns the original values. It reports only non-sensitive
structural metadata and drops the temporary database. A field added to the
policy but not actually protected fails the canary instead of passing it
silently.

1. Generate a dedicated key:

   ```bash
   node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
   ```

2. Put the value in the local secret environment as
   `BIOCBOT_CHAT_ENCRYPTION_KEY`. Set:

   ```text
   BIOCBOT_CHAT_ENCRYPTION_ENABLED=true
   BIOCBOT_CHAT_ENCRYPTION_READ_POLICY=mixed
   BIOCBOT_CHAT_ENCRYPTION_QUERY_POLICY=mixed
   ```

3. Start BiocBot and save a new student chat. Chat history and instructor views
   should look unchanged because reads are decrypted transparently.

4. Inspect MongoDB only for structure. `chatData` and `title` should each be an
   object containing `__ubc_enc`, `alg`, `kid`, `iv`, `tag`, and `ct`; neither
   may contain the original `messages` or title text. The same holds for the
   fields listed above in any flag, feedback, survey, or quiz record created
   while testing. Do not copy ciphertext, binary fields, or source documents
   into tickets or logs.

## Existing-data workflow

All commands load `.env` through `src/config/encryption.js`. `plan`, dry-run,
and verify are read-only for application data. Run them from the repository
root.

### Every command names its own collection

The npm scripts **no longer hardcode a collection**. Each invocation must state
its scope with `-- --collection <name>`.

This is deliberate. The toolkit declares `--collection` as a repeatable option,
so passing the flag twice *accumulates* rather than overriding:

```bash
# What the old hardcoded script did with an extra flag:
#   plan --collection chat_sessions --collection student_super_course_chat_sessions
#   -> scope resolves to BOTH collections
```

For `plan` that is merely surprising. For `migrate` it silently widens the blast
radius to a collection the operator never named. With the flag removed from the
scripts, a bare invocation now fails loudly instead:

```text
collection scope is required: pass --collection <name> one or more times,
or --all-configured to opt in to every configured collection
```

`--all-configured` is available for the read-only commands
(`encryption:plan:all`, `encryption:verify:all`) and refuses to combine with
`--collection`. Migrations are intentionally left one collection at a time.

### `student_super_course_chat_sessions`

```bash
# 1. Plan and dry-run (read-only)
npm run encryption:plan -- --collection student_super_course_chat_sessions
npm run encryption:migrate:dry-run -- --collection student_super_course_chat_sessions

# 2. Bounded canary, after a tested backup that does not contain the key
npm run encryption:migrate -- --collection student_super_course_chat_sessions --max-documents 25 --backup-confirmed --verify
npm run encryption:status
npm run encryption:verify -- --collection student_super_course_chat_sessions

# 3. Full migration, then verification
npm run encryption:migrate -- --collection student_super_course_chat_sessions --backup-confirmed --verify
npm run encryption:verify -- --collection student_super_course_chat_sessions
```

### `instructor_chat_sessions`

```bash
# 1. Plan and dry-run (read-only)
npm run encryption:plan -- --collection instructor_chat_sessions
npm run encryption:migrate:dry-run -- --collection instructor_chat_sessions

# 2. Bounded canary, after a tested backup that does not contain the key
npm run encryption:migrate -- --collection instructor_chat_sessions --max-documents 25 --backup-confirmed --verify
npm run encryption:status
npm run encryption:verify -- --collection instructor_chat_sessions

# 3. Full migration, then verification
npm run encryption:migrate -- --collection instructor_chat_sessions --backup-confirmed --verify
npm run encryption:verify -- --collection instructor_chat_sessions
```

### `chat_sessions`

Unchanged apart from naming the collection explicitly:

```bash
npm run encryption:plan -- --collection chat_sessions
npm run encryption:migrate:dry-run -- --collection chat_sessions
npm run encryption:migrate -- --collection chat_sessions --max-documents 25 --backup-confirmed --verify
npm run encryption:migrate -- --collection chat_sessions --backup-confirmed --verify
npm run encryption:verify -- --collection chat_sessions
```

### Chat titles in already-migrated chats

`title` joined the policy after `chatData`. A chat collection migrated before
that still has plaintext titles; running its commands above again encrypts only
the titles. The migration checks each configured field separately and skips
values already in their target state, so `chatData` is not re-encrypted.

Use toolkit `0.1.1` or later for these reruns. In `0.1.0`, a rerun resumed
after a finished checkpoint and could skip older documents while still
reporting `completed`. If chat migrations were rerun under `0.1.0`, run
`npm run encryption:plan:all` after upgrading; it counts any plaintext left in
configured fields without printing values.

### Free-text collections

`mentalHealthFlags`, `flaggedQuestions`, `messageFeedback`,
`chatSurveyResponses`, and `quizAttempts` follow the same sequence. Run it once
per collection, substituting its name:

```bash
npm run encryption:plan -- --collection mentalHealthFlags
npm run encryption:migrate:dry-run -- --collection mentalHealthFlags
npm run encryption:migrate -- --collection mentalHealthFlags --max-documents 25 --backup-confirmed --verify
npm run encryption:migrate -- --collection mentalHealthFlags --backup-confirmed --verify
npm run encryption:verify -- --collection mentalHealthFlags
```

Run each collection's canary, review it, and only then remove `--max-documents`.
Migrate one collection at a time so a failure is scoped to one dataset.

### LMS token collections

`lms_canvas_tokens` and `lms_moodle_tokens` follow the same sequence. Tokens
stored before encryption was turned on keep working under mixed reads, so
instructors stay connected while the migration runs.

```bash
npm run encryption:plan -- --collection lms_canvas_tokens
npm run encryption:migrate:dry-run -- --collection lms_canvas_tokens
npm run encryption:migrate -- --collection lms_canvas_tokens --max-documents 25 --backup-confirmed --verify
npm run encryption:migrate -- --collection lms_canvas_tokens --backup-confirmed --verify
npm run encryption:verify -- --collection lms_canvas_tokens
```

Then the same commands with `--collection lms_moodle_tokens`. A database
backup taken before this migration still holds the tokens in plaintext, so
handle it as a credential store until it expires.

The toolkit migration is idempotent, resumable, lease-protected, and checks for
concurrent changes before updating a document. Its checkpoint collection is
`_ubc_encryption_migrations` and contains operational metadata, not chat data or
keys.

### Schema fingerprint changes

Every change to `ENCRYPTED_FIELDS` changes the configuration's schema
fingerprint — adding the two Super Course chat collections did, adding the
titles and free-text collections did again, and so did adding the LMS token
collections. Two consequences:

- The default migration id derives from the fingerprint, so it changes too. Any
  checkpoint from an earlier migration is not resumed by default, and
  `npm run encryption:status` reports it with
  `schemaMatchesCurrentConfig: false`. That row is historical; it is not an
  error. Passing an explicit `--migration-id` from before the change would raise
  a lease error — start a new id instead.
- **Existing ciphertext is unaffected.** The fingerprint is migration metadata
  only; it is not part of the additional authenticated data. Envelopes written
  under the previous single-collection policy still decrypt, which
  `tests/unit/services/chatEncryption.test.js` asserts directly.

## Moving from mixed to strict

Keep mixed reads while plaintext and encrypted documents coexist. The policies
are global, not per collection, so strict mode requires **every configured
collection** to be fully migrated and verified first. Only then should staging
change to:

```text
BIOCBOT_CHAT_ENCRYPTION_READ_POLICY=strict
BIOCBOT_CHAT_ENCRYPTION_QUERY_POLICY=encrypted
```

Both switches move together: the toolkit rejects a `strict` read policy
alongside a `mixed` query policy at configuration time.

Restart and exercise save, history, continue-chat, instructor download, student
analytics, deletion, title update, and pseudonym flows — for the course chat,
the student Super Course chat, and the instructor Super Course chat — then the
mental-health flag list and stats, flagged questions and their stats, message
feedback, the chat survey, and quiz attempts and stats, then connecting,
importing from, and disconnecting Canvas and Moodle. Strict reads fail closed
if any configured value is plaintext, malformed, tampered with, or encrypted
under an unavailable key.

### Adding a collection to an environment that is already strict

A collection newly added to `ENCRYPTED_FIELDS` still holds plaintext when the
release that adds it is deployed. Under strict reads every one of those rows
fails with `PLAINTEXT_VALUE_REJECTED`. For the LMS token collections that means
every instructor who connected Canvas or Moodle earlier gets an error on each
LMS request, not a "not connected" prompt. So, in a strict environment:

1. Set the environment back to `mixed` / `mixed`, then deploy the release.
2. Migrate and verify the new collections as described above.
3. Run `npm run encryption:plan:all` to confirm nothing plaintext is left, then
   switch back to `strict` / `encrypted`.

An environment that is still on mixed reads needs no change; deploy, then
migrate. The new collections use the existing `BIOCBOT_CHAT_ENCRYPTION_KEY`, so
no new secret is needed.

## Staging gate

Before staging deployment:

- Pin and install toolkit version `0.1.1` from UBC GitHub Packages.
- Inject the dedicated key through the staging secret manager; never commit it.
- Confirm the key and MongoDB backup are stored separately.
- Capture a tested pre-migration backup and a restore point.
- Run the test suite and a local encrypted-write/raw-storage canary.
- Deploy mixed-read/encrypted-write mode first.
- Confirm newly written records are encrypted at rest and readable in every UI,
  for every collection in the table above.
- Run plan, dry-run, a small migration canary, full migration, and verification
  — separately for each collection in the table above.
- Switch to strict/encrypted policies in a later deployment after verification.
- Monitor typed toolkit authentication and plaintext-rejection failures.

Turning the feature flag off does not decrypt records already migrated. Recovery
requires keeping the key and mixed decryption available, using the toolkit's
guarded `decrypt` workflow with explicit plaintext confirmation, or restoring a
pre-migration backup.
