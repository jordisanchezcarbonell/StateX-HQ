/** Narrow, read-only verifier for simple file acceptance criteria; unknown criteria require a human. */
import type { Board } from "./board.js";
export interface LocalCriterionCheck { criterion: string; status: "passed" | "manual_review" | "failed"; file?: string }
export interface LocalVerification { checkedAt: number; status: "passed" | "needs_manual_review" | "failed"; files: string[]; checks: LocalCriterionCheck[] }

export function referencedWorkspaceFiles(criteria: readonly string[]): string[] {
  const found = new Set<string>();
  for (const criterion of criteria) {
    for (const match of criterion.matchAll(/(?:^|[^\w.-])([A-Za-z0-9_-][A-Za-z0-9_./-]*\.[A-Za-z0-9_-]+)(?=$|[^\w.-])/g)) {
      const file = match[1];
      if (!file.startsWith("/") && !file.split("/").some(part => part === ".." || part === ".")) found.add(file);
    }
  }
  return [...found].sort();
}

export async function verifyLocalAcceptance(criteria: readonly string[], read: (relativePath: string) => Promise<string | undefined>, now = Date.now(), candidateFiles: readonly string[] = []): Promise<LocalVerification> {
  const files = [...new Set([...referencedWorkspaceFiles(criteria), ...candidateFiles.filter(file => !file.startsWith("/") && !file.split("/").some(part => part === ".." || part === "."))])].sort();
  const content = new Map<string, string | undefined>();
  for (const file of files) {
    try { content.set(file, await read(file)); }
    catch { content.set(file, undefined); }
  }
  const exactContents = new Map<string, string>();
  for (const criterion of criteria) {
    const exact = criterion.match(/\bcontent is exactly\s+"([^"\r\n]*)"\s*\.?\s*$/i) ?? criterion.match(/\bcontent is exactly\s+“([^”\r\n]*)”\s*\.?\s*$/i);
    const file = files.find(f => criterion.includes(f)) ?? (files.length === 1 ? files[0] : undefined);
    if (exact && file) exactContents.set(file, exact[1]);
  }
  const checks = criteria.map((criterion): LocalCriterionCheck => {
    const file = files.find(f => criterion.includes(f)) ?? (files.length === 1 ? files[0] : undefined);
    const value = file ? content.get(file) : undefined;
    if (/\b(?:exists|exist|est[aá])\b/i.test(criterion) && /\bfile\b/i.test(criterion)) {
      return { criterion, status: value === undefined ? "failed" : "passed", ...(file ? { file } : {}) };
    }
    const exactFirstLine = criterion.match(/first line is exactly\s+["“](.*?)["”]/i);
    if (exactFirstLine) {
      const firstLine = value?.split(/\r?\n/, 1)[0];
      return { criterion, status: value !== undefined && firstLine === exactFirstLine[1] ? "passed" : "failed", ...(file ? { file } : {}) };
    }
    const exactContent = criterion.match(/\bcontent is exactly\s+"([^"\r\n]*)"\s*\.?\s*$/i) ?? criterion.match(/\bcontent is exactly\s+“([^”\r\n]*)”\s*\.?\s*$/i);
    if (exactContent) {
      const actual = value === undefined ? undefined : Buffer.from(value, "utf8");
      const expected = Buffer.from(exactContent[1], "utf8");
      return { criterion, status: actual !== undefined && actual.equals(expected) ? "passed" : "failed", ...(file ? { file } : {}) };
    }
    if (/\bfirst line matches the title\b/i.test(criterion)) {
      const expectedTitle = file ? exactContents.get(file) : undefined;
      if (expectedTitle === undefined || value === undefined) return { criterion, status: "manual_review", ...(file ? { file } : {}) };
      const firstLine = (bytes: Buffer) => {
        const end = bytes.indexOf(0x0a);
        const line = bytes.subarray(0, end < 0 ? bytes.length : end);
        return line.length && line.at(-1) === 0x0d ? line.subarray(0, line.length - 1) : line;
      };
      const expectedLine = firstLine(Buffer.from(expectedTitle, "utf8"));
      const actualLine = firstLine(Buffer.from(value, "utf8"));
      return { criterion, status: actualLine.equals(expectedLine) ? "passed" : "failed", ...(file ? { file } : {}) };
    }
    return { criterion, status: "manual_review", ...(file ? { file } : {}) };
  });
  const status = checks.some(x => x.status === "failed") ? "failed" : checks.some(x => x.status === "manual_review") ? "needs_manual_review" : "passed";
  return { checkedAt: now, status, files, checks };
}

/** Complete only a reviewed task with a persisted worker result and fully objective local checks. */
export async function autoCompleteStructuredTask(
  board: Board,
  taskId: number,
  read: (relativePath: string) => Promise<string | undefined>,
  hasPendingApproval: boolean,
  now = Date.now(),
): Promise<"completed" | "already_completed" | "not_ready" | "pending_approval" | "operation_review_required" | "manual_review_required" | "verification_failed" | "result_files_mismatch"> {
  const task = board.tasks.find(x => x.id === taskId), state = task?.coordination;
  if (state?.status === "completed" && state.result) return "already_completed";
  const restartReview = state?.status === "blocked" && state.error === "server_restarted; manual_review_required" && task?.status === "blocked";
  if (!task || !(task.status === "review" && state?.status === "review") && !restartReview || !state || !state.result || !state.result.summary.trim() || !Number.isSafeInteger(state.result.submittedAt) || !state.result.files.length) return "not_ready";
  if (hasPendingApproval) return "pending_approval";
  const files = [...new Set(state.result.files)];
  if (files.length !== state.result.files.length || files.some(file => !file || file.startsWith("/") || file.split("/").some(part => part === ".." || part === "."))) return "result_files_mismatch";
  const reported = new Set(files);
  const criteriaFiles = referencedWorkspaceFiles(state.criteria);
  if (criteriaFiles.length ? criteriaFiles.length !== reported.size || criteriaFiles.some(file => !reported.has(file)) : files.length !== 1) return "result_files_mismatch";
  for (const operation of state.operations ?? []) {
    if (operation.outcome === "failed" || operation.outcome === "denied") return "operation_review_required";
    if (["Write", "Edit"].includes(operation.tool)) {
      if (operation.outcome !== "executed" && operation.outcome !== "cached") return "operation_review_required";
      if (operation.agent !== state.worker || !operation.path || !reported.has(operation.path)) return "operation_review_required";
    }
  }
  const verification = await verifyLocalAcceptance(state.criteria, file => reported.has(file) ? read(file) : Promise.resolve(undefined), now, files);
  if (verification.status === "failed") {
    board.setCoordination(taskId, { verification, by: "system", detail: "structured result local verification failed" });
    return "verification_failed";
  }
  if (verification.files.length !== reported.size || verification.files.some(file => !reported.has(file))) return "result_files_mismatch";
  board.setCoordination(taskId, { verification, by: "system", detail: `structured result local verification: ${verification.status}` });
  if (verification.status !== "passed" || verification.checks.some(check => check.status !== "passed")) return "manual_review_required";
  if (restartReview) {
    board.setCoordination(taskId, { status: "review", error: undefined, by: "system", detail: "Resumed persisted review after local result verification; no agent execution was restarted." });
    board.updateTask(taskId, { status: "review", note: "Persisted result re-verified locally after server restart; no tools were replayed." }, "system");
  }
  const completed = board.completeCoordinationTask(taskId, "system", "Structured result and all objective acceptance checks verified locally.", `Automatically completed after local verification of ${files.join(", ")}.`, {
    authorizedBy: "system", mechanism: "structured_result_and_local_acceptance", completedAt: now, resultSubmittedAt: state.result.submittedAt, verifiedAt: verification.checkedAt,
  });
  return completed ? "completed" : "not_ready";
}

export function approveManualLocalReview(board: Board, taskId: number, verification: LocalVerification, confirmedManualCriteria: number[], confirm: boolean, now = Date.now()): "not_ready" | "confirmation_required" | "criteria_not_confirmed" | "stale_verification" | "approved" {
  const task = board.tasks.find(x => x.id === taskId), state = task?.coordination;
  if (!task || !state || !["blocked", "review"].includes(state.status) || !state.verification || verification.status === "failed") return "not_ready";
  if (!confirm) return "confirmation_required";
  if (JSON.stringify(state.verification) !== JSON.stringify(verification)) return "stale_verification";
  if (state.result) {
    const reported = [...new Set(state.result.files)].sort(), verified = [...new Set(verification.files)].sort();
    if (!state.result.summary.trim() || reported.length !== state.result.files.length || JSON.stringify(reported) !== JSON.stringify(verified)) return "stale_verification";
  }
  const needed = verification.checks.flatMap((check, i) => check.status === "manual_review" ? [i] : []);
  if (needed.some(i => !confirmedManualCriteria.includes(i))) return "criteria_not_confirmed";
  const resultNote = state.result ? " Structured worker result was present and its reported files matched the local verification." : " No structured worker result was received.";
  board.setCoordination(taskId, { status: "completed", by: "user", verification, manualReview: { approvedBy: "user", approvedAt: now, note: `User approved the locally verified artifact and any listed manual criteria.${resultNote}`, source: "local_verification" }, detail: "Completed after a fresh local workspace verification and explicit user review." });
  board.updateTask(taskId, { status: "done", note: `Completed after explicit user review of local verification.${resultNote}` }, "user");
  return "approved";
}
