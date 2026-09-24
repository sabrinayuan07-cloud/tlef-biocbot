# BiocBot - AI-Powered Study Assistant

BiocBot is an AI-powered study assistant platform that enables students to interact with course material in a chat-based format. Instructors can upload documents (PDFs, DOCX, or TXT), which are automatically parsed, chunked, and embedded into a vector database (Qdrant) for semantic search. When a student asks a question, the system retrieves relevant chunks and generates a response grounded in course content.

## 🚀 Features

- **Document Management**: Upload and organize course materials per lecture/unit
- **Vector Search**: Semantic search across documents using Qdrant
- **AI Chat Interface**: RAG-powered student chat with tutor and protege modes
- **Per-Course Retrieval Mode**: Instructor-controlled additive vs single-unit retrieval for chat
- **Quiz Practice System**: Self-paced AI-graded quizzes with attempt history
- **Assessment Questions**: Create and manage multiple-choice, true/false, and short-answer questions
- **Flagging System**: Students flag issues with questions; instructors review and respond
- **Student Struggle Tracking**: Activity logging to monitor and surface struggling students
- **Course Structure**: Organize content by units/lectures with publish controls
- **User Management**: Separate interfaces for instructors, TAs, and students
- **TA Management**: Instructors promote students to TAs with scoped permissions
- **Onboarding Wizard**: Guided AI-assisted course setup for instructors
- **SAML / UBC CWL Auth**: Shibboleth integration alongside local username/password auth
- **User Agreement**: Modal-gated terms acceptance before platform access
- **Session Idle Timeout**: Automatic logout after inactivity
- **Student Chat Encryption**: Optional field-level encryption for persisted chat payloads, with resumable migration tooling

## 🏗️ Architecture

BiocBot follows a split architecture with a public frontend and a private backend, adhering to clear separation of concerns for maintainability and security.

### Tech Stack

- **Frontend**: HTML + Vanilla JS (no frameworks), styled via separate CSS files
- **Backend**: Node.js (Express 5), built with modular architecture
- **Database**: MongoDB (documents, user sessions, analytics, quiz attempts)
- **Vector Database**: Qdrant for semantic search and similarity retrieval
- **Embeddings**: UBC GenAI Toolkit with OpenAI (text-embedding-3-small)
- **Authentication**: Passport.js — local strategy + SAML / UBC Shibboleth

## 🛠️ Setup & Installation

### Prerequisites

- Node.js v18.x or higher
- MongoDB instance
- Qdrant vector database (Docker recommended)
- OpenAI API key

### 1. Clone and Install

```bash
git clone <repository-url>
cd tlef-biocbot
npm install
```

### 2. Environment Configuration

Create a `.env` file in the root directory with the following variables:

```bash
# MongoDB Connection
MONGO_URI=mongodb://localhost:27017/biocbot

# Server Port
TLEF_BIOCBOT_PORT=8080

# Qdrant Configuration
QDRANT_URL=http://localhost:6333
QDRANT_API_KEY=super-secret-dev-key

# Embeddings Provider Configuration
EMBEDDING_PROVIDER=ubc-genai-toolkit-llm

# LLM Provider Settings
LLM_PROVIDER=openai
LLM_API_KEY=your-openai-api-key
OPENAI_MODEL=gpt-5.6-luna
LLM_EMBEDDING_MODEL=text-embedding-3-small

# Optional Canvas integration (all four values are required to enable it)
CANVAS_DOMAIN=canvas.example.edu
CANVAS_CLIENT_ID=your-canvas-developer-key-id
CANVAS_CLIENT_SECRET=your-canvas-developer-key-secret
CANVAS_REDIRECT_URI=http://localhost:8080/api/lms/canvas/auth/callback
CANVAS_TOKEN_COLLECTION_NAME=lms_canvas_tokens

# Optional Moodle integration
MOODLE_DOMAIN=https://moodle.example.edu
MOODLE_TOKEN_COLLECTION_NAME=lms_moodle_tokens
```

To test the 2026 UBC LLM Sandbox deployment instead, use:

```bash
LLM_PROVIDER=ubc-llm-sandbox
LLM_API_KEY=your-ubc-sandbox-api-key
LLM_ENDPOINT=https://ai-stg.apps.ctlt.ubc.ca/v1
LLM_DEFAULT_MODEL=qwen3.6-35b-a3b
LLM_EMBEDDING_MODEL=qwen3-embedding-0.6b
QDRANT_VECTOR_SIZE=1024
```

The Qwen embedding model uses a separate model-qualified Qdrant collection so
existing vectors are preserved. Re-index course documents and Super Chat notes
before evaluating retrieval quality with the new embedding model.

The Canvas callback URI must exactly match the redirect URI registered on the Canvas Developer
Key. The integration is disabled when no `CANVAS_*` application credentials are set and refuses
to start partially configured. OAuth tokens are stored per authenticated BiocBot user in MongoDB;
never commit Canvas credentials or package-registry tokens. See [`agents_canvas.md`](https://github.com/ubc/ubc-genai-toolkit-lms-integration/blob/main/agents_canvas.md)
for provider setup, required LMS permissions, security boundaries, and implementation details.

Moodle uses an instructor-provided web-service token instead of OAuth. Instructors can connect or
disconnect it from the Course Upload page. Canvas and Moodle course-file links are stored
independently, so both providers can remain linked to the same BiocBot course.

For the bundled local Canvas and Moodle environments, seed the BIOC 302 demo courses, five student
enrollments, grades, and Moodle note resources with:

```bash
npm run seed:local-lms-grades
```

The fixture scripts are idempotent and intentionally kept in the repository so a new local LMS or
database can be rebuilt. Use `node scripts/seed-local-lms-grades.js --yes --moodle-only` when the
local Canvas instructor has not been connected, or `--canvas-only` to skip Moodle. The script
refuses non-local LMS URLs.

### 3. Start Services

#### Start Qdrant (Docker)
```bash
docker run -p 6333:6333 qdrant/qdrant
```

#### Start BiocBot
```bash
npm run dev
```

For the staged student-chat encryption rollout, see
[`documentation/student-chat-encryption-rollout.md`](documentation/student-chat-encryption-rollout.md).

## Health checks

Configure the load balancer to request `GET /api/health` without authentication
and accept **HTTP 200 only**. `/api/health/ready` is an equivalent readiness route.
Both return only `{"status":"healthy"}` (200) or `{"status":"unhealthy"}` (503).
Use `/api/health/live` for process liveness; it returns `{"status":"ok"}` (200)
without checking dependencies. `/health` and `/healthz` are not aliases.

Readiness requires completed startup (including migrations and enabled chat
encryption), initialized authentication and the scoped LLM registry, and reachable
MongoDB and Qdrant. It checks Qdrant without creating or requiring a particular
collection. An auth initialization check does not verify the external SSO service.
These routes bypass body parsing, sessions and authentication, and expose no
service names, configuration, credentials or upstream errors.

LLM credentials and models saved inside the app are not tested by these probes.
No model listings, chat completions or external LMS/Academic API requests run.
A healthy result means the application can accept traffic; it does not guarantee
every course's AI provider can generate answers. Monitor provider/inference
availability separately; do not use liveness as a substitute for readiness.

Dependency probes run in parallel with a two-second timeout, share concurrent
requests and cache successes and failures for five seconds per process. Allow
more than two seconds for the load-balancer timeout (for example, three seconds)
and account for that cache interval when setting failure/recovery thresholds.
All responses use `Cache-Control: no-store` to prevent intermediary caching.
Readiness transitions log fixed failing check names on the server, without
upstream error text. The HTTP listener opens only after startup succeeds.

## 📚 Usage

### For Instructors

1. **Access**: Navigate to `/instructor`
2. **Onboarding**: Complete the guided course setup wizard (AI-assisted topic extraction)
3. **Upload Documents**: Add course materials to units/lectures
   - When Canvas or Moodle is configured, a small **Canvas** / **Moodle** button appears above the
     unit list. It opens a four-step wizard — connect, choose the course, choose the file, choose
     the destination unit — and the import itself reports each stage (download, store, extract,
     save, index) as it happens. Only providers this deployment has credentials for are shown.
   - Canvas connects through OAuth; Moodle takes a web-service token pasted from
     *Preferences → Security keys*. Both connections are reused after the first time, so the wizard
     opens on the course step from then on.
   - Logging out of the Canvas website does not revoke OAuth access. Use **Disconnect** in the
     wizard's first step to revoke the stored Canvas authorization or delete the Moodle token.
4. **Create Questions**: Build multiple-choice, true/false, and short-answer assessments
5. **Publish Units**: Make content available to students
6. **Quiz Settings**: Enable quiz practice, select testable units, and control material access for failed answers
7. **Retrieval Mode**: On the course Home page, toggle "Use additive retrieval" to allow chat to include earlier published units in addition to the selected unit. When off, chat uses only the selected unit.
8. **Manage TAs**: Promote students to TAs via the TA Hub; assign course and flag permissions
9. **Review Flags**: View and respond to student-flagged question issues
10. **Monitor Students**: Use the Student Hub to review engagement and struggle activity
11. **LMS Grades** (optional): In the Student Hub, run **Match students** to tie the linked LMS
    roster to BiocBot accounts, then **Import grades** to pull a read-only snapshot. Grades appear
    on each student's card, with the field that produced the match; anyone who could not be matched
    is listed above the cards. Matching uses the Canvas integration_id (the CWL PUID) first, then
    email; an email match is refused when the two sides carry different PUIDs. Student number,
    username and display name are never used. See [`agents_canvas.md`](https://github.com/ubc/ubc-genai-toolkit-lms-integration/blob/main/agents_canvas.md) for the full rules.

### For Students

1. **Access**: Navigate to `/student`
2. **Agreement**: Accept the user agreement on first login
3. **Course Selection**: Choose your course
4. **Chat Interface**: Select a unit, then ask questions about course material
5. **Quiz Practice**: Practice assessment questions with immediate AI feedback and attempt history
6. **Flag Questions**: Report unclear or incorrect questions for instructor review
7. **Chat History**: Review past conversations

### For TAs

1. **Access**: Navigate to `/ta`
2. **Onboarding**: Complete TA onboarding
3. **Settings**: Configure TA-specific options
4. **Flagged Questions**: Review and respond to flagged questions (if permitted)

## 🔍 Qdrant Integration

BiocBot uses Qdrant for vector-based semantic search:

- **Automatic Document Processing**: Documents are automatically chunked, embedded, and stored on upload
- **Semantic Search**: Find relevant content using natural language queries
- **Course-Aware Search**: Filter results by course and lecture
- **Real-time Indexing**: New documents are immediately searchable

### API Endpoints

- `GET /api/qdrant/status` — Check Qdrant service status
- `POST /api/qdrant/process-document` — Process and store a document
- `POST /api/qdrant/search` — Semantic search across documents
- `DELETE /api/qdrant/document/:id` — Delete document chunks
- `GET /api/qdrant/collection-stats` — Get collection statistics

Visit `/qdrant-test` to test the Qdrant functionality interactively.

## 🔧 Development

### Project Structure

```
tlef-biocbot/
├── public/                     # Frontend assets
│   ├── common/
│   │   └── scripts/            # Shared scripts (auth, login, idle-timer, etc.)
│   ├── instructor/             # Instructor interface
│   │   ├── scripts/            # home, settings, onboarding, ta-hub, student-hub, ...
│   │   └── *.html
│   ├── student/                # Student interface
│   │   ├── scripts/            # dashboard, quiz, history, flagged, ...
│   │   └── *.html
│   ├── ta/                     # TA interface
│   │   ├── scripts/
│   │   └── *.html
│   └── qdrant-test.html        # Qdrant testing page
├── src/                        # Backend source
│   ├── config/                 # Passport, app config
│   ├── middleware/             # Auth middleware (requireAuth, requireRole, etc.)
│   ├── models/                 # MongoDB models
│   ├── routes/                 # API route handlers
│   ├── services/               # Business logic (LLM, Qdrant, auth, tracker)
│   └── server.js               # Main server entry point
```

### Key Models

| Model | Collection | Purpose |
|---|---|---|
| `Course` | `courses` | Course metadata, lecture structure, quiz settings |
| `User` | `users` | Accounts, roles, preferences, struggle state |
| `Document` | `documents` | Uploaded files and parsed content |
| `Question` | embedded in Course | MC, TF, and short-answer questions per lecture |
| `QuizAttempt` | `quizAttempts` | Per-student quiz attempt records |
| `FlaggedQuestion` | `flaggedQuestions` | Student-reported question issues |
| `StruggleActivity` | `struggleActivity` | Student struggle state transitions |
| `UserAgreement` | `useragreements` | Terms acceptance records |

### Key Services

- **LLMService** (`src/services/llm.js`): AI chat responses and short-answer evaluation via UBC GenAI Toolkit
- **QdrantService** (`src/services/qdrantService.js`): Vector DB indexing and semantic search
- **AuthService** (`src/services/authService.js`): User registration, login, preferences
- **TrackerService** (`src/services/tracker.js`): Student engagement and struggle tracking
- **prompts** (`src/services/prompts.js`): System prompt management (base, tutor, protege, quizHelp modes)

### Auth Middleware

- `requireAuth` — Must be logged in
- `requireStudent` / `requireInstructor` / `requireInstructorOrTA` — Role-based access
- `requireStudentEnrolled` — Must be enrolled in the requested course
- `requireTAPermission(permission)` — TA-scoped permission checks

## 🧪 Testing

### Running tests locally

```bash
npm test                  # all Playwright tests, headless
npm run test:headed       # run with a visible browser
npm run test:ui           # Playwright UI mode
npm run test:report       # open the last HTML report
```

The Playwright config (`playwright.config.js`) launches its own server with `BIOCBOT_TEST_LLM_STUB=1`, so the LLM and embeddings calls are intercepted by deterministic stubs (`src/services/llmStub.js`, `src/services/embeddingsStub.js`). You do **not** need an OpenAI key to run tests — but you still need MongoDB and Qdrant reachable at the URLs in your `.env`.

## 🤖 Continuous Integration

A GitHub Actions workflow at [`.github/workflows/playwright.yml`](.github/workflows/playwright.yml) runs the full Playwright suite on every push to `main` and on every pull request targeting `main`.

### What the workflow does

1. Boots `mongo:7` and `qdrant/qdrant:latest` as service containers inside the runner.
2. Installs Node 20 and project dependencies.
3. Installs the Chromium browser via `npx playwright install --with-deps chromium`.
4. Runs `npm test` with `BIOCBOT_TEST_LLM_STUB=1` so no external LLM calls are made.
5. Uploads the Playwright HTML report, Monocart report, coverage reports, and (on failure) traces/videos/screenshots as workflow artifacts.

### Enabling the workflow on GitHub

The workflow is plain YAML — pushing the file to GitHub is enough to register it. No extra configuration is required for the default case because:

- MongoDB and Qdrant run as ephemeral service containers (no external DB needed).
- The LLM stub means **no API keys / secrets** need to be configured.
- All required env vars are inlined in the `env:` block of the workflow.

Steps to enable:

1. Push this branch (which includes `.github/workflows/playwright.yml`) to GitHub.
2. Open the repository's **Actions** tab on github.com. If Actions are disabled at the org level, an admin must enable them under **Settings → Actions → General → Allow all actions**.
3. The workflow will run automatically on the next push or pull request. You can also trigger a run manually from the Actions tab if you add a `workflow_dispatch:` trigger.

### Viewing test results

- Go to **Actions → Playwright Tests → (latest run)**.
- Scroll to the **Artifacts** section at the bottom to download:
  - `playwright-report` — standard Playwright HTML report
  - `monocart-report` — Monocart report with coverage
  - `coverage-reports` — raw v8/lcov coverage
  - `test-results` — traces, videos, screenshots (only uploaded on failure)
- Unzip and open `index.html` from any of the reports locally.

### Customizing

- **Different Node version**: change `node-version: 20` in the workflow.
- **Switch from `npm install` to `npm ci`**: commit `package-lock.json` (currently in `.gitignore`), then change the install step and re-enable `cache: npm` on the `setup-node` action.
- **Add a manual trigger**: add `workflow_dispatch:` under the top-level `on:` block.
- **Run on more branches**: extend the `branches:` lists under `push:` and `pull_request:`.

## 📄 License

ISC License
