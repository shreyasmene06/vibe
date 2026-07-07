# ViBe — Contribution Context

Educational platform: continuous assessment, adaptive review, AI question generation, AI proctoring. IIT Ropar (dled@iitrpr.ac.in). MIT license.

## Monorepo (pnpm workspaces)

`pnpm-workspace.yaml` packages: `frontend`, `backend`, `backend/functions`, `docs`, `cli`, `mcp`, `e2e`.

- **backend** — Express + `routing-controllers` + `routing-controllers-openapi`. DI via `inversify` + `typedi`. `class-validator` / `class-transformer` DTOs. MongoDB (driver, not Mongoose). `firebase-admin` auth. `@casl/ability` authz. Sentry, winston. Vitest tests. `pnpm@10.4.1`, ESM (`"type":"module"`), Node >=14 declared (CI uses 23.11.0).
- **frontend** — React + Vite + `@tanstack/react-router` + `@tanstack/react-query`. shadcn/ui + Radix + Tailwind + MUI. `zustand` state. `zod`. API typed via OpenAPI: `openapi-fetch` / `openapi-react-query`. TensorFlow.js + MediaPipe + face-api (in-browser proctoring). Yoopta/Slate editor.
- **docs** — Docusaurus (root of repo is the docs site too). Contributing docs live in `docs/docs/contributing/`.
- **e2e** — Playwright (`pnpm test-e2e`).
- **cli** — `pnpm vibe` (`pnpx ts-node cli/src/cli.ts`).

## Backend module pattern

`backend/src/modules/<name>/` each has: `controllers/`, `services/`, `classes/` (`transformers/`, `validators/`), `abilities/` (CASL), `tests/`, `utils/`, plus `index.ts`, `container.ts` (DI bindings), `types.ts`. Modules: announcements, anomalies, auditTrails, auth, courseRegistration, courses, ejectionPolicy, emotions, genAI, hpSystem, notifications, projects, quizzes, reports, setting, studentQuestions, users. Shared in `backend/src/shared/`.

**Scaffold new code — do NOT hand-create:** `cd backend && pnpm generate` (plop `module-asset`). Generates `XxxController.ts` / `XxxService.ts` / `XxxRepository.ts` and wires DI in `container.ts`/`index.ts`/`types.ts`. Templates in `backend/plop-templates/`.

## Workflow (canonical: docs/docs/contributing/)

1. Fork → clone → branch. Branch naming: `feat/...`, `fix/...`, `chore/...`, `refactor/...` (kebab-case).
2. Lint/format before commit: `pnpm lint`, `pnpm fix` (gts = Google TS Style). Husky pre-commit runs `lint-staged` → `pnpm --filter backend lint` on backend `.{js,jsx,ts,tsx}`.
3. Tests: backend `pnpm --filter backend test` (Vitest); CI `test:ci`. Add/update tests for new/changed features.
4. Open PR to `main`. CI on PR: backend linter (paths `backend/**`), Jest/Vitest (Firebase auth emulator + Mongo Atlas), docs-check.

## Commit + PR convention (Conventional Commits)

Format: `<type>(<optional-scope>): <subject>`

- types: `feat`, `fix`, `doc`, `style`, `refactor`, `test`, `chore`, `perf`.
- scope = module/dir (`auth`, `courses`, `item`, `quizzes`, `timeslots`...). Optional.
- subject: imperative present tense, not capitalized, no trailing dot.
- PR body: motivation + prev behavior + how it improves. Footer: `Closes #123`. Breaking changes listed w/ migration notes. Deps: `- [ ] depends on: #XXXX`.
- PR template (`.github/PULL_REQUEST_TEMPLATE.md`) wants `Closes #ISSUE`.

## Local dev stack persistence (run.sh)

`run.sh` starts MongoDB + Firebase Auth emulator + backend + frontend, all concurrently. **Both data stores are persistent** so accounts and course content survive Ctrl+C, sleep, and reboots:

- Mongo dbpath: `~/.local/share/vibe/mongo/dbpath` (replica set `rs0` on :27017). Override with `VIBE_DATA_DIR`.
- Firebase Auth export: `~/.local/share/vibe/auth-export`. `--import` on startup; `run.sh`'s shutdown trap runs `firebase emulators:export` before killing the emulator so the next `./run.sh` re-imports the same state.

**Default seed accounts** (auto-created on first run by `scripts/seed-yaksha.sh`, idempotent on subsequent runs):

| email                | password    | global `roles` |
|----------------------|-------------|----------------|
| `admin@yaksha.com`   | `admin123`  | `admin`        |
| `teacher@yaksha.com` | `teacher123`| `user`         |
| `user@yaksha.com`    | `student123`| `user`         |

`teacher@yaksha.com` has global role `user`; to act as a teacher it needs a per-course `Enrollment.role = 'INSTRUCTOR'` (assign via the UI once a course/version exists — there is no global "teacher" role in `IUser.roles`, only `'admin' | 'user'`).

## Naming (gts-enforced)

- File w/ single class → match class name PascalCase (`UserService.ts`). Single fn → camelCase (`getUser.ts`). Multi → PascalCase contextual.
- vars/fns camelCase. classes PascalCase. interfaces `I` prefix (`IUser`). enums PascalCase, values UPPER_SNAKE_CASE. generics single uppercase / descriptive.
- No module-name prefixes in file/type names.

## Video + Proctoring architecture (core domain)

**Video = a YouTube clip, not hosted media.** A course `VIDEO` item stores only `{ URL, startTime, endTime, points }` (`IVideoDetails`, `models.ts`). URL validated as public YouTube/Vimeo link (`ItemValidators.ts`). startTime/endTime are `HH:MM:SS` strings = the clipped window the student must watch.

**Player** — `frontend/src/components/video.tsx` (~2200 lines). Loads YouTube IFrame API, builds `window.YT.Player` with locked-down `playerVars` (`controls:0 disablekb:1 fs:0 modestbranding rel:0`). `getYouTubeId()` regex-extracts the 11-char id. Moderation/UX bolted on top of the raw player:
- Watch enforcement: polls `getCurrentTime` every ~500ms/rate; clamps to `[startTime,endTime]`; blocks forward seek past `maxTimeRef` unless `seekForwardEnabled`; tracks rewinds/fastForwards (`WatchTimeTrackData`).
- Progress lifecycle: `useStartItem` → periodic `useUpsertWatchTime` (15s) → `useStopItem` (on end/endTime) → `onNext()`. Stop can fail ("watch ≥30s") → skip overlay.
- Transparent overlays kill native YT click/context/dblclick. Keyboard lock blocks YT shortcuts. Tab-switch auto-pauses.
- Proctoring inputs are **props**: `readyToDetect`, `pauseVid`, `rewindVid`, `doGesture`, `anomalies[]`. Anomaly overlay (warning SVG / thumbs-up) renders over the player keyed on those. Autoplay waits for `readyToDetect` + 10s grace.

**Detection engine** — `frontend/src/components/floating-video.tsx` (the moderation brain) + `components/ai/*`:
- `useCameraProcessor` grabs webcam (`MediaRegistry` shared stream), runs TFJS face-detection in a Web Worker (`FaceDetectorWorker.ts`) → `faces[]`.
- Per-detector child components, each gated by teacher settings: `BlurDetector`, `SpeechDetector`, `GestureDetector`, `FaceDetectors` (count + recognition via face-api + focus). Detectors: `blurDetection faceCountDetection voiceDetection faceRecognition handGestureDetection rightClickDisabled focus` (some hardcoded-off in code).
- Scoring loop (every 100ms after 10s grace): builds `activeAnomalies[]`, adds penalty points (speaking +1, noFace +1, multipleFaces +2, blur +1, faceRecognition mismatch +2). `contiguousAnomalyPoints >= 20` → `setRewindVid+setPauseVid`. Multiple-faces / face-mismatch → immediate pause (+rewind). Clears when clean.
- Reports evidence to backend: screenshot (`useReportAnomalyImage`) / audio (`useReportAnomalyAudio`), throttled 1/s.
- `runProctoringChecks` (`proctoringGuard.ts` → `detectVirtualCamera`) every 5s → virtual-cam / stream-quality → `cameraIntegrity` anomaly.
- Missing face embedding → `FaceRegistrationModal`.

**Backend** — `modules/anomalies/`: `AnomalyController` (multipart upload) → `AnomalyService.recordAnomaly` (tx) → `CloudStorageService` uploads evidence to GCS, `AnomalyRepository` (Mongo) stores `{type,courseId,versionId,itemId,userId,fileName,cohortId,createdAt}`. `AnomalyType` enum is canonical. Teacher reads via `getCourseAnomalies` (paginated, search, cohort filter) → `AnomaliesList.tsx`. Stats via `getAnomalyStats`. Per-course detector toggles live in `modules/setting`; enforcement escalation (e.g. course pause on face mismatch) via `modules/ejectionPolicy`.

**Mental model:** raw YouTube clip (cheap, no hosting) → custom React shell that locks controls + enforces watch window/progress → independent webcam ML pipeline emits `anomalies[]`/pause/rewind signals into the player → flagged frames/audio persisted to GCS+Mongo for teacher review and policy-driven ejection.

## Frontend API types

Backend OpenAPI → frontend types: `cd frontend && pnpm copy` (regen openapi.json from backend) then `pnpm gen-schema` (→ `src/lib/api/schema.ts`). Run after backend endpoint changes.
