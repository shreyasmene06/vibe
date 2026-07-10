import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PlusCircle, X, AlertCircle, CheckCircle2, Loader2, ExternalLink } from "lucide-react";
import { toast } from "sonner";
import {
  useSubmitPeerReview,
  useMySubmission,
  useCheckPeerReviewLink,
  useStartItem,
  useStopItem,
} from "@/hooks/hooks";

/**
 * Student-side submission form for a peer-review assessment item.
 *
 * Phase 3 + Phase 7 audit-improvement. Renders inside the student's
 * course-tree view when item type === 'PEER_REVIEW_ASSESSMENT'.
 *
 *  - 1..20 Drive-style links (kind auto-detected from URL host).
 *  - Re-editable up until the deadline (idempotent on the server).
 *  - Status pill: 'Not submitted' / 'Submitted on time' /
 *    'Submitted late' / 'Past deadline' / 'Saving...'
 *  - Phase 7: live accessibility badge per link. Each link row
 *    debounces the URL by 500ms then hits GET /peer-review-links/check
 *    to surface a green check or a red x with reason. The backend
 *    caches results for 60s, so a flurry of edits is cheap.
 */

interface Props {
  courseId: string;
  versionId: string;
  itemId: string;
  moduleId: string;
  sectionId: string;
  assessment: any;
  submissionDeadline?: Date;
  cohortId?: string;
}

interface StudentLink {
  url: string;
  label: string;
  kind?: "drive" | "github" | "youtube" | "oneDrive" | "dropbox" | "other";
}

const EMPTY_LINK: StudentLink = { url: "", label: "", kind: undefined };

// 500ms debounce hook (Phase 7 audit improvement).
function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

function LinkAccessibilityBadge({ url }: { url: string }) {
  const debounced = useDebounced(url, 500);
  const check = useCheckPeerReviewLink(debounced);
  if (!debounced || debounced.trim().length === 0) {
    return null;
  }
  if (check.isLoading) {
    return (
      <span className="text-xs text-slate-500 flex items-center gap-1">
        <Loader2 className="h-3 w-3 animate-spin" />
        Checking...
      </span>
    );
  }
  if (!check.data) return null;
  if (check.data.accessible) {
    return (
      <span className="text-xs text-emerald-600 flex items-center gap-1">
        <CheckCircle2 className="h-3 w-3" />
        Publicly accessible
      </span>
    );
  }
  const reasonText: Record<string, string> = {
    http_401: 'Requires sign-in (401)',
    http_403: 'Forbidden (403)',
    http_404: 'File not found (404) — check the link',
    http_5xx: 'Server error (5xx)',
    auth_required: 'Drive/OneDrive link is private',
    timeout: 'Request timed out',
    dns_failure: 'DNS lookup failed',
    connection_refused: 'Connection refused',
    invalid_url: 'Invalid URL — paste a full https://... link',
  };
  const reason = reasonText[check.data.reason ?? ''] ?? (check.data.reason ?? 'Not accessible');
  return (
    <span className="text-xs text-red-600 flex items-center gap-1" title={reason}>
      <AlertCircle className="h-3 w-3" />
      {reason}
    </span>
  );
}

export function PeerReviewSubmissionForm({
  courseId,
  versionId,
  itemId,
  moduleId,
  sectionId,
  cohortId,
  assessment,
  submissionDeadline,
}: Props) {
  const startItem = useStartItem();
  const stopItem = useStopItem();
  const submitHook = useSubmitPeerReview();
  const submissionQuery = useMySubmission(assessment?._id || assessment?.assessmentId);
  const serverExisting = submissionQuery.data;
  // Local override of the submission doc — set when our POST returns
  // (before the refetch lands) or when the server refetch comes back.
  // This bypasses react-query's openapi-fetch cache-key mystery and
  // guarantees the form flips to the read-only view on first click.
  // PERSISTED TO LOCALSTORAGE so a hard refresh stays read-only even
  // if the GET fails (e.g. openapi-fetch token-refresh hiccup).
  //
  // IMPORTANT: the assessment prop is async — it's null on the first
  // render of a hard refresh and only arrives milliseconds later via
  // usePeerReviewAssessmentByItemId. We must therefore hydrate
  // localStorage in a useEffect keyed on the assessmentId, NOT in
  // useState's initializer (which would run with assessmentId undefined).
  //
  // ALSO: assessment._id is a Mongo ObjectId object (with a custom
  // toString), so the template literal interpolation renders it as
  // "[object Object]". Coerce to a plain string here.
  const rawAssessmentId = assessment?._id || assessment?.assessmentId;
  const assessmentId: string | null = rawAssessmentId
    ? (typeof rawAssessmentId === 'string' ? rawAssessmentId : String(rawAssessmentId))
    : null;
  const storageKey = assessmentId ? `peerReviewSubmission:${assessmentId}` : null;
  const [localExisting, setLocalExisting] = useState<any | null>(null);
  // Hydrate from localStorage whenever the assessmentId becomes known
  // (initial mount, hard refresh, or navigating between assessments).
  useEffect(() => {
    if (typeof window === 'undefined' || !storageKey) return;
    try {
      const cached = window.localStorage.getItem(storageKey);
      if (cached) setLocalExisting(JSON.parse(cached));
    } catch {}
    // intentionally only react to storageKey changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey]);
  const existing = localExisting ?? serverExisting;
  // Whenever serverExisting lands, mirror it into localStorage so a
  // hard refresh shows the read-only view even if the GET fails
  // next time. Also write when we set localExisting ourselves.
  useEffect(() => {
    if (existing && typeof window !== 'undefined' && storageKey) {
      try { window.localStorage.setItem(storageKey, JSON.stringify(existing)); } catch {}
    }
  }, [existing, storageKey]);
  console.log('[peer-review] form mount', {
    storageKey,
    hasLocalCached: !!localExisting,
    serverExistingIsTruthy: !!serverExisting,
    serverExistingShape: serverExisting ? Object.keys(serverExisting).slice(0, 5) : null,
    serverError: submissionQuery.error,
    finalExistingIsTruthy: !!existing,
  });
  // Local flag — flips true on the first submit click. Combined with
  // the read-only "if (existing) return" branch, this prevents the
  // user from spam-clicking Submit before the refetch lands.
  const [hasSubmitted, setHasSubmitted] = useState(false);

  const [notes, setNotes] = useState(existing?.notes ?? "");
  const [links, setLinks] = useState<StudentLink[]>(
    existing?.links?.length
      ? existing.links.map((l: any) => ({ url: l.url, label: l.label, kind: l.kind }))
      : [EMPTY_LINK],
  );

  useEffect(() => {
    if (existing) {
      setNotes(existing.notes ?? "");
      setLinks(
        existing.links?.length
          ? existing.links.map((l: any) => ({ url: l.url, label: l.label, kind: l.kind }))
          : [EMPTY_LINK],
      );
    }
  }, [existing]);
  // Track this item in the user's progress (mirrors the VIDEO flow's
  // useStartItem call). On submit, useStopItem marks the item complete
  // and the module progress counter increments. This is what makes
  // the module sidebar show "1/7 completed" and unblock the next item.
  const [watchItemId, setWatchItemId] = useState<string | null>(null);
  useEffect(() => {
    // Don't start tracking if the student has already submitted —
    // the existing useStartItem would be a no-op and we'd 400 on stop.
    if (existing || hasSubmitted) return;
    if (!courseId || !versionId || !itemId || !moduleId || !sectionId) return;
    let cancelled = false;
    (async () => {
      try {
        const result: any = await startItem.mutateAsync({
          params: { path: { courseId, courseVersionId: versionId } },
          body: { itemId, moduleId, sectionId, cohortId },
        });
        if (!cancelled && result?.watchItemId) setWatchItemId(result.watchItemId);
      } catch (e) {
        // Non-fatal — the item still gets marked complete on stopItem
        // because the backend will start a fresh watch item if needed.
        console.warn('[peer-review] useStartItem failed (non-fatal)', e);
      }
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [courseId, versionId, itemId, moduleId, sectionId, existing?._id]);

  const deadline = useMemo(() => {
    if (submissionDeadline) return submissionDeadline;
    if (assessment?.submissionDeadline) return new Date(assessment.submissionDeadline);
    return null;
  }, [submissionDeadline, assessment]);
  const isPast = deadline ? new Date() > deadline : false;

  function setLinkAt(i: number, patch: Partial<StudentLink>) {
    setLinks(prev => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  }
  function addLink() {
    if (links.length >= 20) {
      toast.error("At most 20 links allowed.");
      return;
    }
    setLinks([...links, EMPTY_LINK]);
  }
  function removeLink(i: number) {
    setLinks(prev => prev.filter((_, idx) => idx !== i));
  }

  const valid =
    !isPast &&
    links.length >= 1 &&
    links.every(l => l.url.trim().length > 0 && l.label.trim().length > 0);

  async function onSave() {
    if (!assessment) return;
    if (existing || hasSubmitted) {
      toast.error("You've already submitted. To update, refresh the page.");
      return;
    }
    if (!valid) {
      toast.error("Add at least one link (url + label) before submitting.");
      return;
    }
    if (submitHook.isPending) return;
    try {
      // Flip the local flag IMMEDIATELY so the very next render of the
      // page shows the read-only "Submitted" view. Without this, the
      // form stays editable for as long as the refetch is in flight,
      // and the user can click Submit again.
      console.log('[peer-review] setting hasSubmitted=true BEFORE POST');
      setHasSubmitted(true);
      const result = await submitHook.mutateAsync({
        params: { path: { courseId: courseId as any, versionId: versionId as any, itemId: itemId as any } },
        body: {
          notes,
          links: links.map(l => ({
            url: l.url.trim(),
            label: l.label.trim(),
            kind: l.kind,
          })),
        },
      });
      console.log('[peer-review] POST returned 2xx', result);
      // Build the submission doc locally and set it as the
      // authoritative existing doc. The form re-renders to the
      // read-only view on the next paint. No refetch is needed.
      const newSubmission = {
        _id: (result as any)?.submissionId,
        assessmentId: assessment._id || assessment.assessmentId,
        studentId: '',
        courseId: (assessment as any).courseId,
        courseVersionId: (assessment as any).courseVersionId,
        cohortId: (assessment as any).cohortId,
        notes: notes,
        links: links.map(l => ({
          url: l.url.trim(),
          label: l.label.trim(),
          kind: l.kind,
        })),
        submittedAt: new Date().toISOString(),
        isLate: new Date() > new Date((assessment as any).submissionDeadline),
        reviewsCompleted: 0,
        reviewsTotal: 3,
        reviewAssignmentIds: [],
        teacherOverridden: false,
      };
      setLocalExisting(newSubmission);
      console.log('[peer-review] setLocalExisting with submissionId', newSubmission._id);
      // Mark the item complete in the user's progress (mirrors the
      // VIDEO flow's stop-on-end behaviour). This is what flips the
      // module sidebar counter to "1/7 completed" and lets the
      // student move to the next item.
      try {
        await stopItem.mutateAsync({
          params: { path: { courseId, courseVersionId: versionId } },
          body: {
            itemId,
            moduleId,
            sectionId,
            cohortId,
            isSkipped: false,
            seekForwardEnabled: false,
            watchItemId: watchItemId ?? '',
          },
        });
        console.log('[peer-review] useStopItem success — item marked complete');
      } catch (e) {
        console.warn('[peer-review] useStopItem failed (non-fatal)', e);
      }
      toast.success("Submission saved. You'll need to review 3 of your peers next.");
    } catch (e: any) {
      // Roll back the local flag so the user can retry on failure.
      console.log('[peer-review] POST failed, rolling back', e?.message);
      setHasSubmitted(false);
      toast.error(`Save failed: ${e?.message ?? "Unknown error"}`);
    }
  }

  let status = "Not submitted";
  if (submitHook.isPending) status = "Saving...";
  else if (existing) status = existing.isLate ? "Submitted late" : "Submitted on time";
  else if (isPast) status = "Past deadline";
  const statusColor =
    status === "Submitted on time" ? "text-emerald-600" :
    status === "Submitted late" ? "text-amber-600" :
    status === "Past deadline" ? "text-red-600" :
    status === "Saving..." ? "text-blue-600" :
    "text-slate-500";

  const navigate = useNavigate();

  // Render the read-only "Submitted" view if we have a confirmed
  // submission (existing) OR the local hasSubmitted flag is set
  // (the POST is in flight, the refetch hasn't landed). The view
  // must be safe for both cases — every existing.* access uses
  // the optional chain so a hasSubmitted-only state doesn't crash.
  if (hasSubmitted || existing) {
    // Minimal "submitting" state when hasSubmitted is set but the
    // server-confirmed refetch hasn't landed yet.
    if (hasSubmitted && !existing) {
      return (
        <div className="space-y-6 p-4 max-w-3xl mx-auto">
          <Card>
            <CardHeader>
              <CardTitle>{assessment?.title ?? "Peer-Review Assessment"}</CardTitle>
              <p className="text-sm font-medium text-blue-600">
                Status: Submission in progress… confirm with backend…
              </p>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">
                Saving your submission. This typically takes 1–2 seconds.
              </p>
            </CardContent>
          </Card>
        </div>
      );
    }
    console.log('[peer-review] rendering submitted view', {
      hasSubmitted,
      existingIsLate: existing?.isLate,
      existingSubmittedAt: existing?.submittedAt,
    });
    const submittedAt = existing?.submittedAt ? new Date(existing.submittedAt) : null;
    return (
      <div className="space-y-6 p-4 max-w-3xl mx-auto">
        <Card>
          <CardHeader>
            <CardTitle>{assessment?.title ?? "Peer-Review Assessment"}</CardTitle>
            <p className={`text-sm font-medium ${existing?.isLate ? "text-amber-600" : "text-emerald-600"}`}>
              Status: {existing?.isLate ? "Submitted late" : existing?.submittedAt ? "Submitted on time" : hasSubmitted ? "Submitting..." : "Saved"}
            </p>
          </CardHeader>
          {assessment?.description && (
            <CardContent className="pt-0">
              <p className="text-sm text-muted-foreground whitespace-pre-wrap">
                {assessment.description}
              </p>
            </CardContent>
          )}
        </Card>

        {assessment?.rubric && assessment.rubric.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle>Rubric</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="text-sm space-y-1">
                {assessment.rubric.map((c: any, i: number) => (
                  <li key={i} className="flex justify-between border-b pb-1 last:border-0">
                    <span>
                      {c.label}
                      {c.description && (
                        <span className="text-muted-foreground"> — {c.description}</span>
                      )}
                    </span>
                    <span className="font-mono text-xs">/ {c.maxPoints}</span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle>Your submission</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {submittedAt && (
              <p className="text-muted-foreground">
                Submitted on {submittedAt.toLocaleString()}
              </p>
            )}
            {existing?.notes && (
              <p className="whitespace-pre-wrap border-l-2 pl-3 italic">
                {existing.notes}
              </p>
            )}
            <div className="space-y-1">
              {Array.isArray(existing?.links) && (existing?.links ?? []).length > 0 ? (
                (existing?.links ?? []).map((l: any, i: number) => (
                  <a
                    key={i}
                    href={l.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-600 underline block"
                  >
                    {l.label} <span className="text-xs text-muted-foreground">— {l.url}</span>
                  </a>
                ))
              ) : (
                <p className="text-muted-foreground">No links.</p>
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>What's next?</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p>
              Your submission is in. Once the submission deadline passes, you'll be
              assigned <strong>3 peer submissions</strong> to review.
            </p>
            <p className="text-muted-foreground">
              The peer-review round unlocks automatically — until then, you can
              see your queue on the Peer Reviews page.
            </p>
            <Button onClick={() => navigate({ to: "/student/peer-review/reviewer" })}>
              Go to Peer Reviews
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-4 max-w-3xl mx-auto">
      <Card>
        <CardHeader>
          <CardTitle>{assessment?.title ?? "Peer-Review Assessment"}</CardTitle>
          <p className={`text-sm font-medium ${statusColor}`}>Status: {status}</p>
        </CardHeader>
        {assessment?.description && (
          <CardContent className="pt-0">
            <p className="text-sm text-muted-foreground whitespace-pre-wrap">
              {assessment.description}
            </p>
          </CardContent>
        )}
      </Card>

      {assessment?.rubric && assessment.rubric.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Rubric</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="text-sm space-y-1">
              {assessment.rubric.map((c: any, i: number) => (
                <li key={i} className="flex justify-between border-b pb-1 last:border-0">
                  <span>
                    {c.label}
                    {c.description && (
                      <span className="text-muted-foreground"> — {c.description}</span>
                    )}
                  </span>
                  <span className="font-mono text-xs">/ {c.maxPoints}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Notes (optional)</CardTitle>
        </CardHeader>
        <CardContent>
          <Textarea
            value={notes}
            onChange={e => setNotes(e.target.value)}
            maxLength={5000}
            placeholder="Anything your reviewers should know about your submission..."
            rows={4}
          />
          <p className="text-xs text-muted-foreground mt-1">{notes.length} / 5000</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Your submission links</CardTitle>
          <p className="text-xs text-muted-foreground">
            Paste one or more public links (Drive / GitHub / etc.). Each link is
            checked for public accessibility as you paste.
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          {links.map((l, i) => (
            <div key={i} className="grid grid-cols-12 gap-2 items-start">
              <div className="col-span-3 min-w-0">
                <Label>Label</Label>
                <Input
                  value={l.label}
                  onChange={e => setLinkAt(i, { label: e.target.value })}
                  maxLength={200}
                  placeholder="e.g. Project Report v2"
                  className="w-full"
                />
              </div>
              <div className="col-span-8 min-w-0">
                <Label>URL</Label>
                <Input
                  value={l.url}
                  onChange={e => setLinkAt(i, { url: e.target.value })}
                  maxLength={2000}
                  placeholder="https://drive.google.com/file/d/.../view"
                  className="w-full font-mono text-xs"
                />
                <div className="mt-1 truncate">
                  <LinkAccessibilityBadge url={l.url} />
                </div>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => removeLink(i)}
                aria-label={`Remove link ${i + 1}`}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          ))}
          <Button
            type="button"
            variant="outline"
            onClick={addLink}
            className="w-full"
          >
            <PlusCircle className="h-4 w-4 mr-2" /> Add link
          </Button>
          {!valid && !isPast && (links.length === 0 || links.some(l => !l.url.trim() || !l.label.trim())) && (
            <p className="text-sm text-amber-600 flex items-center gap-1 mt-1">
              <AlertCircle className="h-4 w-4" />
              Every link needs both a label and a URL.
            </p>
          )}
          {isPast && (
            <p className="text-sm text-red-600 flex items-center gap-1 mt-1">
              <AlertCircle className="h-4 w-4" />
              The submission deadline has passed ({deadline?.toLocaleString()}).
            </p>
          )}
        </CardContent>
      </Card>

      {assessment?.instructorAttachments && assessment.instructorAttachments.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Reference materials from your teacher</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {assessment.instructorAttachments.map((a: any, i: number) => (
              <a
                key={i}
                href={a.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-blue-600 underline block"
              >
                {a.name} <span className="text-xs text-muted-foreground">({a.kind})</span>
                <ExternalLink className="h-3 w-3 inline ml-1" />
              </a>
            ))}
          </CardContent>
        </Card>
      )}

      {submitHook.error && (
        <p className="text-sm text-red-600 flex items-center gap-1">
          <AlertCircle className="h-4 w-4" />
          {submitHook.error}
        </p>
      )}

      <div className="flex gap-2 justify-end">
        <Button
          type="button"
          onClick={onSave}
          disabled={!valid || submitHook.isPending}
        >
          {submitHook.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
          {!submitHook.isPending && existing && <CheckCircle2 className="h-4 w-4 mr-2" />}
          {existing ? "Update submission" : "Submit"}
        </Button>
      </div>
    </div>
  );
}

export default PeerReviewSubmissionForm;
