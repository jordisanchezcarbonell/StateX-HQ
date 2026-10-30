import { z } from "zod";
import type { Employee } from "./employee.js";
import type { Colleagues } from "./office-tools.js";
import { coordinationPhaseLimits, type FreeAgentBudget, type FreeCoordination } from "./free-agent.js";
import type { Board } from "./board.js";
import { getSettings } from "./runtime.js";
import { autoCompleteStructuredTask } from "./free-agent-review.js";

const coordinatorSchemas = {
  delegate_task: z.object({ title: z.string().trim().min(1).max(160).optional(), objective: z.string().trim().min(1).max(4000).optional(), acceptance_criteria: z.array(z.string().trim().min(1).max(400)).min(1).max(8).optional(), task_id: z.number().int().positive().optional(), correction: z.string().trim().min(1).max(2000).optional() }).strict(),
  get_task_status: z.object({ task_id: z.number().int().positive() }).strict(),
  complete_task: z.object({ task_id: z.number().int().positive(), summary: z.string().trim().min(1).max(2000), verified_files: z.array(z.string().trim().min(1).max(1024)).min(1).max(10) }).strict(),
};
const workerSchema = z.object({ summary: z.string().trim().min(1).max(2000), files: z.array(z.string().trim().min(1).max(1024)).min(1).max(10) }).strict();
const schema = (s: z.ZodType) => z.toJSONSchema(s) as Record<string, unknown>;
type CoordinationToolName = "delegate_task" | "get_task_status" | "submit_task_result" | "complete_task";
const functionTool = (name: CoordinationToolName, description: string, parameters: Record<string, unknown>): FreeCoordination["tools"][number] => ({ type: "function", function: { name, description, parameters } });

function packedBudget(b: FreeAgentBudget) { return { used: b.used, tokens: b.tokens, toolCalls: b.toolCalls, limit: b.limit, tokenLimit: b.tokenLimit, toolLimit: b.toolLimit, phaseUsage: b.phaseUsage, phaseLimits: b.phaseLimits, recoveryLimit: b.recoveryLimit, recoveryUsed: b.recoveryUsed }; }
function sharedRequestLimit(): number {
  const configured = Number(process.env.STATEX_FREE_COORD_MAX_REQUESTS ?? 12);
  return Number.isInteger(configured) && configured >= 7 && configured <= 12 ? configured : 10;
}

/** Minimal structured bridge for the first supported delegation path: Alex → Mia only. */
export function freeAgentCoordination(self: Employee, colleagues: Colleagues, taskId?: number): FreeCoordination | undefined {
  const board = colleagues.board();
  const worker = taskId === undefined ? undefined : board.tasks.find((x) => x.id === taskId);
  const canCoordinate = self.cfg.id === "alex" && /personal assistant/i.test(self.cfg.role);
  const canSubmit = worker?.coordination?.coordinator === "alex" && worker.coordination.worker === self.cfg.id && worker.owner === self.cfg.id;
  if (!canCoordinate && !canSubmit) return undefined;

  const tools: FreeCoordination["tools"] = canCoordinate
    ? [
        functionTool("delegate_task", "Create one real Board task for Mia, or request one limited correction on an existing task by including task_id and correction. Start or resume only the authorized Mia task.", schema(coordinatorSchemas.delegate_task)),
        functionTool("get_task_status", "Read the structured status and result of an Alex-to-Mia task.", schema(coordinatorSchemas.get_task_status)),
        functionTool("complete_task", "Complete a reviewed task only after independently reading every reported file.", schema(coordinatorSchemas.complete_task)),
      ]
    : [functionTool("submit_task_result", "Submit a structured result for your assigned task. Report only files you have read after the final edit.", schema(workerSchema))];

  return {
    tools,
    async execute(name, raw, context) {
      if (name === "delegate_task" && canCoordinate) {
        const parsed = coordinatorSchemas.delegate_task.safeParse(raw);
        if (!parsed.success) return "Error: invalid_tool_arguments";
        if (parsed.data.task_id !== undefined) {
          if (!parsed.data.correction) return "Error: correction_required";
          const task = board.tasks.find((x) => x.id === parsed.data.task_id && x.coordination?.coordinator === self.cfg.id && x.owner === "mia");
          if (!task?.coordination || task.coordination.status !== "review") return "Error: task_not_ready_for_correction";
          if (task.coordination.history.filter(x => x.status === "assigned").length >= 2) return "Error: correction_limit_reached";
          board.setCoordination(task.id, { status: "assigned", by: self.cfg.id, detail: "one correction requested" });
          board.updateTask(task.id, { status: "todo", detail: `${task.detail}\n\nCorrection requested by Alex:\n${parsed.data.correction}`, note: `Correction requested: ${parsed.data.correction}` }, self.cfg.id);
          const launched = colleagues.launch(task, self);
          if (launched === "started") board.setCoordination(task.id, { status: "running", by: self.cfg.id });
          return `One correction was sent to Mia on existing task #${task.id} (${launched}); no new task was created.`;
        }
        const create = z.object({ title: coordinatorSchemas.delegate_task.shape.title.unwrap(), objective: coordinatorSchemas.delegate_task.shape.objective.unwrap(), acceptance_criteria: coordinatorSchemas.delegate_task.shape.acceptance_criteria.unwrap() }).safeParse(parsed.data);
        if (!create.success) return "Error: task_objective_and_criteria_required";
        const { title, objective, acceptance_criteria } = create.data;
        const active = board.tasks.find((x) => x.coordination?.coordinator === "alex" && !["completed", "failed", "blocked", "cancelled"].includes(x.coordination.status));
        if (active) {
          if (active.title.trim().toLowerCase() === title.toLowerCase() && active.detail.includes(objective)) return `Existing delegated task #${active.id} is ${active.coordination!.status}; no duplicate was created.`;
          return "Error: active_delegation_exists";
        }
        const mia = colleagues.list().find((e) => e.cfg.id === "mia");
        if (!mia || mia.engine !== "free-agent" || !getSettings().taskSessions) return "Error: mia_free_runtime_unavailable";
        const detail = `Objective:\n${objective}\n\nAcceptance criteria:\n${acceptance_criteria.map((x, i) => `${i + 1}. ${x}`).join("\n")}\n\nSubmit a structured result with submit_task_result. Do not mark the task complete yourself.`;
        if (context.budget.used > 1) return "Error: planning_budget_exhausted";
        // This bounded task budget is shared by Alex and Mia; it cannot exceed 12 requests or the existing token/tool ceilings.
        context.budget.limit = Math.max(context.budget.limit, sharedRequestLimit());
        context.budget.phaseUsage = { planning: 1, execution: 0, delivery: 0, review: 0, recovery: 0 };
        context.budget.phaseLimits = coordinationPhaseLimits(context.budget.limit);
        const task = board.addTask(mia.cfg.id, title, detail, self.cfg.id, true);
        board.beginCoordination(task.id, { coordinator: self.cfg.id, worker: mia.cfg.id, criteria: acceptance_criteria, budget: packedBudget(context.budget) });
        colleagues.setCoordinationBudget(task.id, context.budget);
        const launched = colleagues.launch(task, self);
        if (launched === "started") board.setCoordination(task.id, { status: "running", by: self.cfg.id });
        return `Delegated to Mia as Board task #${task.id} (${launched}). The task is real and persisted; wait for its submitted result before reporting completion.`;
      }
      if (name === "get_task_status" && canCoordinate) {
        const parsed = coordinatorSchemas.get_task_status.safeParse(raw);
        if (!parsed.success) return "Error: invalid_tool_arguments";
        const task = board.tasks.find((x) => x.id === parsed.data.task_id && x.coordination?.coordinator === self.cfg.id);
        if (!task?.coordination) return "Error: delegated_task_not_found";
        return JSON.stringify({ task_id: task.id, title: task.title, status: task.coordination.status, worker: task.coordination.worker, criteria: task.coordination.criteria, result: task.coordination.result ?? null, error: task.coordination.error ?? null });
      }
      if (name === "submit_task_result" && canSubmit && taskId !== undefined) {
        const parsed = workerSchema.safeParse(raw);
        if (!parsed.success) return "Error: invalid_tool_arguments";
        if (worker!.coordination!.status !== "running") return "Error: task_not_running";
        if (parsed.data.files.some((file) => !context.workspace.verifyReadFile(file))) return "Error: result_file_not_verified";
        const result = { summary: parsed.data.summary, files: [...new Set(parsed.data.files)], submittedAt: Date.now() };
        board.setCoordination(taskId, { status: "review", result, by: self.cfg.id, detail: "structured result submitted" });
        board.updateTask(taskId, { status: "review", note: result.summary }, self.cfg.id);
        const finalization = await autoCompleteStructuredTask(board, taskId, async file => {
          const contents = await context.workspace.execute("Read", { file_path: file }, context.signal, async () => false, true);
          return contents.startsWith("Error:") ? undefined : contents;
        }, self.pendingAsks.length > 0);
        colleagues.persistCoordinationBudget(context.budget);
        return finalization === "completed"
          ? `Task #${taskId} completed automatically: Mia submitted a structured result and every objective acceptance criterion passed local verification.`
          : finalization === "manual_review_required"
            ? `Result submitted for review on task #${taskId}. Objective checks were recorded; at least one criterion requires manual or semantic review.`
            : `Result submitted for review on task #${taskId}. Deterministic completion was withheld (${finalization}); review the persisted result and verification.`;
      }
      if (name === "complete_task" && canCoordinate) {
        const parsed = coordinatorSchemas.complete_task.safeParse(raw);
        if (!parsed.success) return "Error: invalid_tool_arguments";
        const task = board.tasks.find((x) => x.id === parsed.data.task_id && x.coordination?.coordinator === self.cfg.id);
        const coordination = task?.coordination;
        if (!task || !coordination || coordination.status !== "review" || !coordination.result) return "Error: task_not_ready_for_completion";
        const files = [...new Set(parsed.data.verified_files)];
        if (files.length !== coordination.result.files.length || coordination.result.files.some((f) => !files.includes(f) || !context.workspace.verifyReadFile(f))) return "Error: independent_file_verification_required";
        if (!board.completeCoordinationTask(task.id, self.cfg.id, parsed.data.summary, parsed.data.summary)) return "Error: task_not_ready_for_completion";
        colleagues.persistCoordinationBudget(context.budget);
        return `Task #${task.id} completed after Mia submitted a result and Alex independently read the reported file(s).`;
      }
      return "Error: tool_forbidden";
    },
  };
}

/** Restart recovery is deliberately manual: interrupted assignments become blocked and are never replayed. */
export function recoverDelegatedTasks(board: Board): void {
  for (const task of [...board.tasks]) {
    const state = task.coordination;
    if (state?.status === "blocked" && task.status === "blocked" && !state.error && task.notes.some(note => note.by === "system" && /free-agent: (?:free_providers_(?:exhausted|cooling_down_or_unverified)|request_limit_before_tools)/.test(note.text))) {
      const previousFailure = [...task.notes].reverse().find(note => note.by === "system" && /free-agent: (?:free_providers_(?:exhausted|cooling_down_or_unverified)|request_limit_before_tools)/.test(note.text))?.text ?? "";
      if (previousFailure.includes("request_limit_before_tools")) {
        board.setCoordination(task.id, {
          error: "request_limit_before_tools", by: "system",
          lastAttempt: { agent: task.owner, requestId: "not-persisted", requestsConsumed: state.budget?.used ?? 0, tokensConsumed: state.budget?.tokens ?? 0, reason: "request_limit_before_tools", proposedTools: [], at: Date.now() },
          detail: "Migrated exhausted task. Unpersisted tool calls were discarded; user approval is required before bounded recovery.",
        });
        continue;
      }
      // Older releases persisted the task error but not its retryAt or the failed inference reservation.
      board.setCoordination(task.id, {
        error: "free_quota_exhausted", retryAt: Date.now(), by: "system",
        ...(state.budget ? { budget: { ...state.budget, used: Math.min(12, state.budget.used + 1) } } : {}),
        detail: "Migrated quota-blocked task; provider availability must be checked before manual resume.",
      });
      continue;
    }
    if (!state || !["pending", "assigned", "running", "review"].includes(state.status)) continue;
    board.setCoordination(task.id, { status: "blocked", error: "server_restarted; manual_review_required", by: "system" });
    if (["todo", "doing", "review"].includes(task.status)) board.updateTask(task.id, { status: "blocked", note: "Server restarted; confirm existing file state before restarting." }, "system");
  }
}

/** One explicit, auditable +2 request recovery; consumed request/token/tool counters are never reset. */
export function authorizeInferenceRecovery(board: Board, id: number, now: number, confirm: boolean): "not_eligible" | "confirmation_required" | "token_budget_exhausted" | "tool_budget_exhausted" | "request_budget_inconsistent" | "already_recovered" | "authorized" {
  const task = board.tasks.find(x => x.id === id), state = task?.coordination, budget = state?.budget;
  if (!task || !state || state.status !== "blocked" || state.error !== "request_limit_before_tools" || !budget) return "not_eligible";
  if (!confirm) return "confirmation_required";
  if (state.recovery) return "already_recovered";
  if (budget.tokens >= budget.tokenLimit) return "token_budget_exhausted";
  if (budget.toolCalls >= budget.toolLimit) return "tool_budget_exhausted";
  if (budget.used !== budget.limit || budget.limit > 12 || budget.limit + 2 > 14) return "request_budget_inconsistent";
  const recovery = { authorizedBy: "user" as const, authorizedAt: now, previousLimit: budget.limit, newLimit: budget.limit + 2, requestsAdded: 2, used: 0, reason: "explicit user recovery after request_limit_before_tools" };
  board.setCoordination(id, {
    status: "assigned", error: undefined, retryAt: undefined, by: "user", recovery,
    budget: { ...budget, limit: budget.limit + 2, recoveryLimit: 2, recoveryUsed: 0 },
    detail: "User explicitly authorized up to two additional requests; consumed usage is preserved.",
  });
  board.updateTask(id, { status: "todo", note: "Resuming the existing session with two user-authorized recovery requests. Previously executed writes are deduplicated from persisted tool history." }, "user");
  return "authorized";
}

/** User-triggered, bounded resume for quota-blocked tasks; the task session and history are retained. */
export function resumeQuotaBlockedTask(board: Board, id: number, now: number, hasAvailableProvider: boolean): "not_quota_blocked" | "cooldown" | "provider_unavailable" | "budget_unavailable" | "budget_exhausted" | "resumed" {
  const task = board.tasks.find(x => x.id === id);
  const state = task?.coordination;
  if (!task || !state || state.status !== "blocked" || state.error !== "free_quota_exhausted") return "not_quota_blocked";
  if (!state.retryAt || now < state.retryAt) return "cooldown";
  if (!hasAvailableProvider) return "provider_unavailable";
  if (!state.budget) return "budget_unavailable";
  const limit = sharedRequestLimit();
  if (state.budget.used >= limit || state.budget.tokens >= state.budget.tokenLimit || state.budget.toolCalls >= state.budget.toolLimit) return "budget_exhausted";
  // Explicit resume may grant only the already-supported bounded request allowance.
  // Counters, token ceiling, tool ceiling, session, and tool history are never reset.
  board.setCoordination(id, {
    status: "assigned", error: undefined, retryAt: undefined, by: "user",
    budget: { ...state.budget, limit: Math.max(state.budget.limit, limit) },
    detail: "Quota cooldown expired; explicitly resumed by user.",
  });
  board.updateTask(id, { status: "todo", note: "Resuming the existing delegated session after the free-provider cooldown." }, "user");
  return "resumed";
}

export async function cancelDelegatedTask(board: Board, id: number, stopWorker: () => Promise<unknown>): Promise<"cancelled" | "missing" | "terminal"> {
  const task = board.tasks.find((x) => x.id === id && x.coordination);
  if (!task?.coordination) return "missing";
  if (["completed", "failed", "blocked", "cancelled"].includes(task.coordination.status)) return "terminal";
  await stopWorker();
  board.setCoordination(id, { status: "cancelled", error: undefined, by: "user", detail: "cancelled by user" });
  board.updateTask(id, { status: "blocked", note: "Delegated task cancelled by the user." }, "user");
  return "cancelled";
}
