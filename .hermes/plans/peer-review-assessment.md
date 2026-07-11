# Peer-Review Assessment — Implementation Plan

**Status:** Awaiting user review of Phase 0 (design). Do NOT start coding until the design doc is approved.

**Module:** `backend/src/modules/peerReview/` (new)
**Item-type:** `PEER_REVIEW_ASSESSMENT` (new value in `ItemType` enum)
**Stack:** matches the existing backend — Express + `routing-controllers` + inversify + Mongo + Firebase admin auth + audit trails + notifications + CASL abilities + vitest.

---

## Phase 0 — Design freeze

**Deliverable:** This file, plus the design notes captured in conversation history (reproduced inline below so the spec is self-contained).

### Decisions locked so far

| # | Question | Decision | Rationale |
|---|----------|----------|-----------|
| 1 | New item-type or extend PROJECT? | **New** `PEER_REVIEW_ASSESSMENT` | PROJECT has no submission flow; keeps existing semantics untouched, no schema migration. |
| 2 | Review symmetry | **Symmetric 3-in/3-out**, adaptive fallback to `min(3, N-1)` | User explicitly rejected asymmetric 3:1 as unbalanced. Adaptive guards small cohorts. Teacher can manually substitute. |
| 3 | Anonymity | **Double-blind for students**; teacher always sees submitter ↔ reviewer map (audit only) | Accountability via audit, not by exposing identities to students. |
| 4 | Anti-collusion | **Circular-shift with collision check** against prior assessments | Honest random; collision check prevents `X ↔ Y` repeats. |
| 5 | Scoring | **Trimmed mean** (drop high + low) **+ teacher per-review override** | Robust to one outlier; teacher override is the safeguard. |
| 6 | Late policy | **Penalty-only** (default 10%); teacher can flip to hard-exclude | Maximises learning for late submitters; teacher override exists anyway. |
| 7 | Small-cohort fallback | **Adaptive `min(3, N-1)`** with manual teacher substitution | Same as #2. |
| 8 | v1 scope | **No teacher dashboard**; just assign / review / score / notify | Shorter time-to-learn. Dashboard in v2. |
| 9 | When to run assignment | **Deadline-batch** (rec at `submissionDeadline`) | Predictable; one batch vs N small batches. |
| 10 | Rubric shape | **Free-form max-points per criterion**; sum = totalMaxPoints; default 100 | Flexible, matches the user's "100 marks / criteria set by teacher". |
| 11 | Submission format | **Files only** (PDF, images, code archives) | Matches user's "I gave a pdf" framing; smaller surface than rich text + files. |
| 12 | Storage | **New sibling `PeerReviewStorageService`** with own bucket (don't touch `CloudStorageService`) | Keeps modules independent; existing GCS service is scoped to anomalies/AI-server. |

### Items the user has been asked to confirm (still open)

- Confirm Phase 0 design as written (especially the row defaults in the table above).
- After approval of this plan, we execute it via the standard `[local-dev] short-name` commit messages with one PR per Phase.

---

## Phase 1 — Data model + scaffolding

**Goal:** Mongo collections exist, repositories wired through DI, vitest CRUD tests pass. No controllers, no routes, no UI.

**Steps (atomic commits):**

1. `chore(peer-review): scaffold module via plop module-asset`
   - `cd backend && pnpm generate` → pick `peerReview` module, all three: controller, service, repository.
   - Verifies `plop-templates/module-base/{index,container,types}.ts.hbs` get expanded correctly.
   - Verifies `package.json` gains `"#peerReview/*": "./build/modules/peerReview/*"` and `tsconfig.json` paths gain the entry.

2. `feat(peer-review): add IUser-assessments/submissions/assignments/reviews TS interfaces`
   - Files: `backend/src/shared/interfaces/models.ts` (append 4 interfaces — `IPeerReviewAssessment`, `IPeerReviewSubmission`, `IPeerReviewAssignment`, `IPeerReview`).
   - Also add `peerReviewsAssigned` and `peerReviewsCompleted` fields to existing `IEnrollment`.

3. `feat(peer-review): add PeerReviewRepository / SubmissionRepository / AssignmentRepository / ReviewRepository`
   - Files: `backend/src/modules/peerReview/repositories/providers/mongodb/{Assessment,Submission,Assignment,Review}Repository.ts`.
   - Each repository extends the same Mongo base class used by `ItemRepository`, with CRUD + the per-collection queries (e.g. `findByAssessmentAndReviewer`, `findPendingByCourse`).
   - Index recommendations: `{assessmentId, reviewerId}` on assignments (PENDING lookup), `{assessmentId}` on submissions, `{assignmentId}` on reviews (1-1), `{submissionId}` on reviews (1-N).

4. `feat(peer-review): wire DI bindings + audit-log emission helpers`
   - Update `backend/src/modules/peerReview/container.ts` to bind all four repositories and the service stubs.
   - Update `backend/src/modules/peerReview/index.ts` to export them.
   - Add a small `audit.ts` helper that wraps `setAuditTrail(...)` calls with category `AuditCategory.PEER_REVIEW`.

5. `test(peer-review): repository CRUD unit tests`
   - `backend/src/modules/peerReview/tests/{Assessment,Submission,Assignment,Review}Repository.test.ts`.
   - Use vitest. Follow pattern from `EnrollmentController.test.ts` — these are repository-level so probably pure unit with a mocked Mongo client (or real if there's an in-memory mongo).
   - Tests: insert/get/update/delete, plus one join query per repo (e.g. assignment repo: list pending assignments for a reviewer).

**Acceptance:**
- `pnpm --filter backend test -- peerReview` passes.
- `pnpm --filter backend lint` clean.
- No endpoints added. No UI changes.

---

## Phase 2 — Item type + teacher create flow

**Goal:** Teacher can add a `PEER_REVIEW_ASSESSMENT` item to a section; the item is persisted as an Item + PeerReviewAssessment doc.

1. `feat(courses): add ItemType.PEER_REVIEW_ASSESSMENT + PeerReviewAssessmentItem class`
   - Files: `backend/src/shared/interfaces/models.ts` (add enum value), `backend/src/modules/courses/classes/transformers/Item.ts` (add `PeerReviewAssessmentItem` class extending `Item` union, plus the `case ItemType.PEER_REVIEW_ASSESSMENT:` branch in `ItemBase`).
   - Mirror existing QUIZ/PROJECT/BLOG shape exactly — `name`, `description`, `isOptional`, `isDeleted`, `deletedAt`, `isHidden`, plus a typed `details: IPeerReviewAssessmentDetails`.

2. `feat(peer-review): PeerReviewAssessmentService + create/edit/get endpoints`
   - `backend/src/modules/peerReview/services/PeerReviewAssessmentService.ts` (validates rubric total points ≥ 1, deadlines ≥ now, cohort exists, course/version/module/section/item all chained valid).
   - `backend/src/modules/peerReview/controllers/PeerReviewAssessmentController.ts`:
     - `POST /peer-review-assessments` body = full assessment config — creates the item + the assessment doc atomically.
     - `PATCH /peer-review-assessments/:id` — editable up until first submission arrives.
     - `GET /peer-review-assessments/:id` — for the teacher's own manage view AND for the student-side "what do I need to submit" view.
   - Auth: `INSTRUCTOR` or `MANAGER` of the course (per CASL). Mirror `EnrollmentController.abilities/` pattern.

3. `feat(peer-review): validators + OpenAPI`
   - `backend/src/modules/peerReview/classes/validators/PeerReviewValidators.ts` (class-validator + JSONSchema decorators).
   - Re-generate OpenAPI spec via `pnpm generateOpenapiSpec` — verify the new routes appear in `/api/reference`.

4. `feat(frontend): teacher-side Peer Review Assessment form`
   - File under `frontend/src/components/manage-course/items/` (mirror existing PROJECT editor).
   - Sections: rubric builder (add/remove criteria + maxPoints), deadline pickers, config toggles (late policy, anti-collusion mode, late penalty %).
   - Wires the new OpenAPI operations via `openapi-react-query` mutations.
   - The "Add item" dropdown in the existing item editor should now include "Peer Review Assessment".

5. `test(peer-review): controller + validator test suite`
   - `backend/src/modules/peerReview/tests/PeerReviewAssessmentController.test.ts`.
   - Tests: valid create / invalid rubric (sum = 0) / deadline-in-past / edit-after-submission-blocked / unauthorized-as-student.

**Acceptance:**
- From the UI, teacher creates an assessment; it appears as an item in the course tree.
- `pnpm --filter backend test -- peerReview` passes.
- Frontend `pnpm lint` + `pnpm build` clean.

---

## Phase 3 — Student submission

**Goal:** Student can submit files for an assessment. Idempotent. Late flag computed.

1. `feat(peer-review): PeerReviewSubmissionService + endpoints`
   - `backend/src/modules/peerReview/services/PeerReviewSubmissionService.ts`.
   - `backend/src/modules/peerReview/controllers/PeerReviewSubmissionController.ts`:
     - `POST /peer-review-assessments/:assessmentId/submission` — multipart: `attachments[]` + (optional) `notes`. Idempotent on `(assessmentId, studentId)` upsert.
     - `GET /students/me/submissions?assessmentId=` — student fetches own submission status.
   - Auth: `STUDENT` of the cohort. Server enforces `cohortId` matches the student's cohort.
   - Persists to GCS via a new `PeerReviewStorageService` (`backend/src/modules/peerReview/services/PeerReviewStorageService.ts`) modelled on `CloudStorageService` — same client library, separate bucket (`vibe-peer-review-data`). New env: `GOOGLE_PEER_REVIEW_BUCKET`.

2. `chore(peer-review): add GOOGLE_PEER_REVIEW_BUCKET env var`
   - `backend/src/config/storage.ts` and `backend/.env.example`.
   - Update `backend/src/config/storage.ts` keys; no behavioural change unless env is set.

3. `feat(frontend): student submission form`
   - Component under `frontend/src/components/course/peer-review/`.
   - File picker, drag-drop, multi-file, progress per file (mirror existing GCS upload widget).
   - Submission state machine visible: not-submitted / submitted-on-time / submitted-late / past-deadline.

4. `test(peer-review): submission controller + idempotency + late-detection tests`
   - Tests: first submit creates row; second submit updates; submit-after-deadline sets `isLate=true`; non-cohort-student blocked; student-of-different-course-blocked.

**Acceptance:**
- Student submits a PDF to an assessment; row appears in Mongo with the GCS URL.
- Re-uploading the same submission updates in place.
- Submitting after the deadline flips `isLate`.

---

## Phase 4 — Assignment algorithm + reviewer flow

**Goal:** Cron fires at deadline, runs the algorithm, creates ReviewAssignments, notifies both sides. Reviewer can fetch assigned submission, submit review.

1. `feat(peer-review): assignment algorithm + service`
   - `backend/src/modules/peerReview/services/PeerReviewAssignmentService.ts`.
   - Algorithm per design doc: Fisher-Yates shuffle, circular-shift with collision check (read prior assessments from Mongo), retry up to 50 times, fall back to uniform random with no-collision-check on exhaustion.
   - Adaptive `target = min(3, N-1)`. Throws typed `InsufficientSubmissionsError` for N<2.
   - Idempotency guard: if assignments already exist for this assessment, return without re-creating.

2. `feat(peer-review): deadline-driven cron`
   - `backend/src/modules/peerReview/cron/AssignmentRunner.ts` — uses `node-cron`, runs every minute, picks assessments whose `submissionDeadline < now` AND `assignmentRunAt IS NULL`, runs the algorithm, sets `assignmentRunAt`.
   - Reassignment cron: `backend/src/modules/peerReview/cron/ReassignmentRunner.ts` — runs every 30 min near `reviewDeadline - 24h` and at the deadline; up to 2 reassignment rounds; mark OVERDUE → REASSIGNED.
   - Finalization cron: `backend/src/modules/peerReview/cron/FinalizationRunner.ts` — runs at `reviewDeadline + 1min`; computes finalScores; sends "score ready" notifications.
   - Register the three crons at `backend/src/bootstrap/jobs/peerReview.ts` and wire into the main entrypoint (verify where `allocateHp.ts` is imported from — likely `server.ts` or `bootstrap/index.ts`).
   - The crons live in-process; production should use a queue but that's out of scope for v1 (note it in `cron/README.md`).

3. `feat(peer-review): reviewer-side endpoints (double-blind enforced)`
   - `backend/src/modules/peerReview/controllers/PeerReviewAssignmentController.ts`:
     - `GET /students/me/peer-review-assignments` — list current user's assignments.
     - `GET /peer-review-assignments/:id/submission` — server checks `assignment.reviewerId == currentUserId`; returns submission TEXT + attachments but **never** submitter identity.
     - `POST /peer-review-assignments/:id/review` — body = `{scores:[{criterionId, score, comment}], overallComment}`; persists, marks assignment SUBMITTED, increments `enrollment.peerReviewsCompleted`.
     - `GET /students/me/peer-reviews-received?assessmentId=` — returns reviews received by current user; **strips reviewer identity**; once `reviewsCompleted == reviewsTotal`, also returns `finalScore`.

4. `feat(notifications): peer-review notification templates`
   - Add 5 templates to `backend/src/modules/notifications/services/NotificationService.ts` (assignments.out, reviews.dueSoon, reviews.dueVerySoon, reviews.reassigned, score.ready). User wants concise English templates — match the codebase's existing tone.
   - Wire `NotificationService` calls into the assignment + cron flows.

5. `feat(frontend): reviewer + reviewer-received UIs`
   - `frontend/src/components/course/peer-review/ReviewerDashboard.tsx` — list of "reviews to do".
   - `frontend/src/components/course/peer-review/ReviewForm.tsx` — per-criterion score + comment fields, submit.
   - `frontend/src/components/course/peer-review/MyScore.tsx` — show reviews received + final score when ready (anonymized reviewers).

6. `test(peer-review): algorithm correctness + reassignment + double-blind leak tests`
   - Algorithm tests on small synthetic cohorts: N=2, N=3, N=4, N=10, N=100. Properties to assert:
     - Every submitter is reviewed by exactly `target` reviewers.
     - Every reviewer reviews exactly `target` submitters.
     - No `X → Y` pair is repeated across two seeded prior assessments (collision check works).
     - For N=2: target=1, each reviews the other.
     - For N=1: throws `InsufficientSubmissionsError`.
     - With 50 collision checks failing, falls back to uniform random (asserted via a controlled RNG seed).
   - Reassignment: simulate a deadline, verify OVERDUE assignments are reassigned to replacement reviewers who have capacity.
   - **Critical leak test:** GET `/peer-review-assignments/:id/submission` — assert response body contains NO submitterId, NO submitterName, NO submitterEmail. GET `/students/me/peer-reviews-received` — assert response contains NO reviewerId, NO reviewerName, NO reviewerEmail.
   - GET `/peer-review-assessments/:id/submissions` (teacher endpoint) — assert response DOES contain submitterId and reviewerId (the teacher view).

**Acceptance:**
- Set a system clock + submit 5 fake students' submissions, wait 1 minute (or call the cron function directly via test).
- Verify 5×3 = 15 ReviewAssignments exist, each submitter has 3, each reviewer has 3, no submitter-reviewer pair equals (X,X).
- A student browser sees only the assigned submission's content, never the submitter's name.

---

## Phase 5 — Scoring + teacher oversight

**Goal:** Final scores computed correctly with the trimmed mean, teacher can override per review, score recomputes.

1. `feat(peer-review): scoring service + finalScore writer`
   - `backend/src/modules/peerReview/services/PeerReviewScoringService.ts`.
   - Per-criterion trimmed mean, sum to totalScore, breakdown stored.
   - Idempotent: recompute is safe to call repeatedly.
   - Tie to `finalization` cron from Phase 4.

2. `feat(peer-review): teacher override endpoints`
   - `backend/src/modules/peerReview/controllers/PeerReviewTeacherController.ts`:
     - `GET /peer-review-assessments/:id/submissions` — list all submissions with submitterId + reviewer mapping visible.
     - `GET /peer-review-assessments/:id/reviews` — all reviews with identities visible.
     - `PATCH /peer-reviews/:id/teacher-override` — `body: {scores?, overallComment?, reason}` — replaces scores in-place, sets override flags, recomputes finalScore for that submission, fires notification to the submitter (something like "your score was adjusted by the teacher for reason X").
   - Audit trail: every override action writes a `PEER_REVIEW_OVERRIDE` audit with before/after scores.

3. `test(peer-review): scoring + override tests`
   - Trimmed-mean correctness on synthetic 3-review data.
   - Override replaces original scores in finalScore breakdown, `teacherOverridden=true`.
   - Override reason required (validator).

**Acceptance:**
- Run through a 3-reviewer assessment; finalScore is the middle of 3 per criterion summed; teacher override flips one review's scores; finalScore recomputes correctly.

---

## Phase 6 — Polish + E2E

**Goal:** E2E test covers the full happy path end-to-end.

1. `test(e2e): peer-review happy-path`
   - `frontend/e2e/peer-review.spec.ts` (Playwright).
   - 3 fake students + 1 teacher. Teacher creates an assessment with deadline in 60s. Students submit. Time-skip via vitest clock or test-only endpoint. Cron fires (or test calls the algorithm directly). Each student sees 3 reviews to do, does them. After review deadline (test-only), final scores appear.
   - Teacher override flow exercised.

2. `chore: docs + CLAUDE.md update`
   - `docs/docs/contributing/conventions/` — add a section describing peer-review module patterns.
   - `CLAUDE.md` — add the module to the list, document the OpenAPI regeneration step.

---

## Out of scope (v2+)

- Plagiarism detection (text similarity across submissions in same cohort).
- Teacher score-distribution analytics dashboard (per P3/P4).
- Cross-cohort peer review (needs teacher opt-in).
- TA-as-reviewer slot (replace one peer with a TA).
- Resubmission up to deadline.
- Rich-text editor for submission (files-only in v1 per user choice).

---

## Risks + how we de-risk each

| Risk | Mitigation |
|---|---|
| Design decisions get changed mid-implementation | Each Phase PR is independently mergeable / rollback-able. Phase 1 has no behavioural change. |
| Cron timing in tests is flaky | Tests call the algorithm cron function directly with a forced clock. Phase 4 docs this pattern. |
| Double-blind leak in the API | Phase 4 includes an explicit leak test per affected endpoint — fail-the-build if a reviewerId/submitterId shows in a student-side payload. |
| Anti-collusion algorithm regresses | Phase 4 algorithm tests use a known RNG seed + property assertions (symmetry, no-self, no-repeat). |
| Teacher override becomes a backdoor for arbitrary grade changes | Override requires a `reason` (non-empty, ≥ 20 chars), audit-logged with before/after. |
| GCS bucket misconfiguration in dev | `.env.example` documented; new bucket lazily created on first upload; `getSignedUrl` returns 401 cleanly if misconfigured — surfaced with a clear error. |
| Existing PROJECT items accidentally see new validator | The new `PeerReviewAssessmentItem` class only handles `case ItemType.PEER_REVIEW_ASSESSMENT`; other types fall through unchanged. |
| The plop-generated module skeleton doesn't compile on this codebase version | Phase 1 step 1 first verifies `pnpm generate` succeeds on a dummy name before running the real scaffold. |

---

## Open questions for the user (re-asked)

1. Confirm the decisions locked in the Phase 0 table.
2. Approve this execution order, or reorder the phases.
3. Confirm v1 scope (Phases 1–5 ship; Phase 6 polish + e2e; no analytics dashboard).
4. v2 scope (out-of-scope list above) — anything you want pulled INTO v1?
5. Any specific cohort sizes to test against up-front (e.g. your class sizes).
