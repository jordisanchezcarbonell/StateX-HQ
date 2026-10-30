// Fully offline vertical integration: Alex → persisted Board task → Mia approval/tool run → Alex verification.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { register } from 'node:module';
register('./fixtures/no-agent-sdk-loader.mjs', import.meta.url);
process.env.STATEX_FREE_ONLY = '1';
process.env.STATEX_FREE_ROUTER_BACKEND = 'python';
process.env.STATEX_FREE_COORD_MAX_REQUESTS = '12';
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'statex-coordination-'));
const workspace = path.join(scratch, 'workspace'); fs.mkdirSync(workspace);
fs.writeFileSync(path.join(workspace, 'README.md'), '# Isolated fixture\n');
const [{ Employee }, { Store }, { Board }, runtime, i18n, coord, tools, review] = await Promise.all([
  import('../dist/server/employee.js'), import('../dist/server/store.js'), import('../dist/server/board.js'),
  import('../dist/server/runtime.js'), import('../dist/server/i18n.js'), import('../dist/server/free-agent-coordination.js'), import('../dist/server/free-agent-tools.js'), import('../dist/server/free-agent-review.js'),
]);
runtime.initRuntime({ offices: [], taskSessions: true }, new i18n.Translator(i18n.loadLocale('en').data));
const dataDir = path.join(scratch, 'office-data'); fs.mkdirSync(dataDir);
const board = new Board(dataDir);
const store = new Store(dataDir);
const make = (id, role) => new Employee({ id, officeId: 'main', name: id === 'alex' ? 'Alex' : 'Mia', role, color: '#5de4d2', look: {}, systemPrompt: 'Work only in the supplied fixture.', cwd: workspace, model: 'free-agent:auto', permissionMode: 'default', manager: false }, store);
const alex = make('alex', 'Personal Assistant'), mia = make('mia', 'Software Developer');
const budgets = new Map();
const colleagues = {
  list: () => [alex, mia], board: () => board,
  launch: (task, from) => mia.startTask(task.id, from),
  discoveryBlock: () => undefined, autoMoveBlock: () => undefined, countDiscovery() {}, capBlock: () => undefined,
  gatewayUrl: () => 'http://127.0.0.1:4747/gw/test', mcpUrl: () => 'http://127.0.0.1:4747/mcp/test',
  getCoordinationBudget: id => budgets.get(id),
  getActiveCoordinationBudget: owner => { const task = board.tasks.find(t => t.coordination?.coordinator === owner && !['completed','failed','blocked','cancelled'].includes(t.coordination.status)); return task && budgets.get(task.id); },
  setCoordinationBudget: (id, value) => { budgets.set(id, value); board.setCoordination(id, { budget: { used:value.used,tokens:value.tokens,toolCalls:value.toolCalls,limit:value.limit,tokenLimit:value.tokenLimit,toolLimit:value.toolLimit,phaseUsage:value.phaseUsage,phaseLimits:value.phaseLimits,recoveryLimit:value.recoveryLimit,recoveryUsed:value.recoveryUsed }, by:'system' }); },
  persistCoordinationBudget: value => { for (const [id, b] of budgets) if (b === value) board.setCoordination(id, { budget: { used:b.used,tokens:b.tokens,toolCalls:b.toolCalls,limit:b.limit,tokenLimit:b.tokenLimit,toolLimit:b.toolLimit,phaseUsage:b.phaseUsage,phaseLimits:b.phaseLimits,recoveryLimit:b.recoveryLimit,recoveryUsed:b.recoveryUsed }, by:'system' }); },
};
alex.setColleagues(colleagues); mia.setColleagues(colleagues);
const originalFetch = globalThis.fetch;
const checks = [];
const requests = [];
const counts = { alex: 0, mia: 0 };
let approvalSeen = false;
let alexReviewWaiting = false, releaseAlexReview;
const call = (name, args, id) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const toolReply = (...calls) => ({ model: 'fixture/free', choices: [{ message: { role: 'assistant', content: null, tool_calls: calls }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 8, completion_tokens: 4, cost: 0 } });
const finalReply = text => ({ model: 'fixture/free', choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 4, cost: 0 } });
const waitFor = async (predicate, label) => { const until = Date.now() + 10000; while (Date.now() < until) { if (predicate()) return; await new Promise(r => setTimeout(r, 10)); } throw new Error(`timeout waiting for ${label}`); };
try {
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url); assert(u.startsWith('http://127.0.0.1:4141/'), `forbidden network request: ${u}`);
    if (u.endsWith('/health')) return Response.json({ status: 'ok', policy: 'free-only' });
    assert(u.endsWith('/v1/chat/completions')); const body = JSON.parse(init.body); requests.push(body);
    const names = body.tools.map(t => t.function.name);
    const isAlex = names.includes('delegate_task'); const who = isAlex ? 'alex' : 'mia'; const n = ++counts[who];
    if (isAlex) {
      if (n === 1) return Response.json(toolReply(call('delegate_task', { title: 'Create statex-test.md', objective: 'Create the requested test file in the isolated workspace.', acceptance_criteria: ['statex-test.md exists in the workspace', 'Its contents contain StateX HQ Multi-Agent Test OK'] }, 'alex-delegate')));
      const task = board.tasks.find(x => x.coordination);
      if (n === 2) { alexReviewWaiting = true; await new Promise(resolve => { releaseAlexReview = resolve; }); return Response.json(toolReply(call('Read', { file_path: 'statex-test.md' }, 'alex-read'))); }
      if (n === 3) return Response.json(toolReply(call('complete_task', { task_id: task.id, summary: 'Mia created the requested file and I verified its contents.', verified_files: ['statex-test.md'] }, 'alex-complete')));
      return Response.json(finalReply('Mia completed the file, and I verified its contents.'));
    }
    if (n === 1) return Response.json(toolReply(call('Read', { file_path: 'README.md' }, 'mia-read-workspace')));
    if (n === 2) return Response.json(toolReply(call('Write', { file_path: 'statex-test.md', content: '# StateX\nStateX HQ Multi-Agent Test OK\n' }, 'mia-write')));
    if (n === 3) return Response.json(toolReply(call('Read', { file_path: 'statex-test.md' }, 'mia-read-back')));
    if (n === 4) return Response.json(toolReply(call('submit_task_result', { summary: 'Created and read back statex-test.md; acceptance text is present.', files: ['statex-test.md'] }, 'mia-submit')));
    if (n === 5) return Response.json(finalReply('I completed the task without reporting a structured result.'));
    return Response.json(finalReply('I stopped without submitting a result.'));
  };
  mia.on('ask', request => {
    if (request.toolName !== 'Write') return;
    approvalSeen = true;
    assert.equal(counts.alex, 1, 'Alex must not infer while Mia is working');
    assert.equal(fs.existsSync(path.join(workspace, 'statex-test.md')), false, 'write must wait for approval');
    mia.reply(request.requestId, { allow: true });
  });
  alex.send('Create statex-test.md with the required marker. Delegate the work to Mia, review it, and report the result.');
  await waitFor(() => approvalSeen, 'Mia write approval');
  await waitFor(() => board.tasks.some(t => t.coordination?.status === 'review') && alexReviewWaiting, 'Mia result awaiting Alex review');
  const duplicate = coord.freeAgentCoordination(alex, colleagues);
  const duplicateResult = await duplicate.execute('delegate_task', { title: 'Create statex-test.md', objective: 'Create the requested test file in the isolated workspace.', acceptance_criteria: ['statex-test.md exists in the workspace', 'Its contents contain StateX HQ Multi-Agent Test OK'] }, { cwd: workspace, workspace: new tools.WorkspaceTools(workspace), signal: new AbortController().signal, budget: budgets.get(board.tasks.find(t => t.coordination).id) });
  assert.match(duplicateResult, /Existing delegated task/); assert.equal(board.tasks.filter(t => t.coordination).length, 1);
  releaseAlexReview();
  await waitFor(() => board.tasks.some(t => t.coordination?.status === 'completed'), 'coordinated task completion');
  const task = board.tasks.find(t => t.coordination);
  assert(approvalSeen, 'Mia must request user approval before Write');
  assert.equal(task.owner, 'mia'); assert.equal(task.createdBy, 'alex');
  assert.deepEqual(task.coordination.history.map(x => x.status), ['pending', 'assigned', 'running', 'review', 'completed']);
  assert.equal(task.coordination.result.files[0], 'statex-test.md');
  assert.match(fs.readFileSync(path.join(workspace, 'statex-test.md'), 'utf8'), /StateX HQ Multi-Agent Test OK/);
  assert.equal(counts.alex, 3); assert.equal(counts.mia, 4); assert.equal(requests.length, 7, 'Alex waits while Mia works; successful structured coordination tool calls end their turn without a redundant inference');
  const toolNames = requests.flatMap(r => r.tools.map(t => t.function.name));
  assert(toolNames.some(n => n === 'delegate_task')); assert(toolNames.some(n => n === 'submit_task_result'));
  assert(requests.filter(r => r.tools.some(t => t.function.name === 'submit_task_result')).every(r => r.model === 'auto'));
  assert.equal(task.coordination.budget.used, 7); assert(task.coordination.budget.tokens <= 24000);
  assert.equal((await new Board(dataDir).tasks.find(t => t.id === task.id)).coordination.status, 'completed', 'result survives Board reload');
  checks.push('offline Alex → Mia → Alex flow, actual runtime, approval, structured result, independent read, persisted completion and shared budget');
  assert.equal(coord.freeAgentCoordination(mia, colleagues), undefined, 'Mia cannot receive coordinator tools in her own chat');
  const noMia = { ...colleagues, list: () => [alex] };
  const noMiaTools = coord.freeAgentCoordination(alex, noMia);
  const beforeNoMia = board.tasks.length;
  const noMiaResult = await noMiaTools.execute('delegate_task', { title: 'No worker', objective: 'test missing employee', acceptance_criteria: ['report blocked'] }, { cwd: workspace, workspace: new tools.WorkspaceTools(workspace), signal: new AbortController().signal, budget: budgets.get(task.id) });
  assert.match(noMiaResult, /mia_free_runtime_unavailable/); assert.equal(board.tasks.length, beforeNoMia);
  checks.push('only Alex can delegate and an unavailable Mia fails closed without creating a task');

  const correctionDir = path.join(scratch, 'correction-data'); fs.mkdirSync(correctionDir);
  const correctionBoard = new Board(correctionDir); const correctionTask = correctionBoard.addTask('mia', 'Correction fixture', 'objective', 'alex', true);
  correctionBoard.beginCoordination(correctionTask.id, { coordinator: 'alex', worker: 'mia', criteria: ['verified file'] });
  correctionBoard.updateTask(correctionTask.id, { status: 'doing' }, 'mia');
  correctionBoard.setCoordination(correctionTask.id, { status: 'review', result: { summary: 'initial', files: ['statex-test.md'], submittedAt: Date.now() }, by: 'mia' });
  correctionBoard.updateTask(correctionTask.id, { status: 'review' }, 'mia');
  const correctionColleagues = { ...colleagues, board: () => correctionBoard, launch: () => 'queued' };
  const correctionTools = coord.freeAgentCoordination(alex, correctionColleagues);
  const correctionContext = { cwd: workspace, workspace: new tools.WorkspaceTools(workspace), signal: new AbortController().signal, budget: budgets.get(task.id) };
  assert.match(await correctionTools.execute('delegate_task', { task_id: correctionTask.id, correction: 'Add the missing acceptance detail.' }, correctionContext), /One correction/);
  assert.equal(correctionBoard.tasks.length, 1); assert.equal(correctionTask.coordination.history.filter(x => x.status === 'assigned').length, 2);
  correctionBoard.setCoordination(correctionTask.id, { status: 'review', by: 'mia' }); correctionBoard.updateTask(correctionTask.id, { status: 'review' }, 'mia');
  assert.match(await correctionTools.execute('delegate_task', { task_id: correctionTask.id, correction: 'Try again.' }, correctionContext), /correction_limit_reached/);
  checks.push('Alex can request exactly one correction on the same task; the next correction is rejected');

  checks.push('duplicate delegation is idempotent and cannot create a second task');

  const restartDir = path.join(scratch, 'restart-data'); fs.mkdirSync(restartDir);
  const beforeRestart = new Board(restartDir); const interrupted = beforeRestart.addTask('mia', 'Interrupted work', 'fixture', 'alex', true);
  beforeRestart.beginCoordination(interrupted.id, { coordinator: 'alex', worker: 'mia', criteria: ['verify'], budget: { used: 2, tokens: 20, toolCalls: 1, limit: 12, tokenLimit: 24000, toolLimit: 12 } });
  beforeRestart.updateTask(interrupted.id, { status: 'doing' }, 'system');
  const { recoverDelegatedTasks } = coord; recoverDelegatedTasks(new Board(restartDir));
  const recovered = new Board(restartDir).tasks[0]; assert.equal(recovered.coordination.status, 'blocked'); assert.equal(recovered.status, 'blocked');
  checks.push('restart blocks delegated work for manual review and never resumes writes');

  const quotaDir = path.join(scratch, 'quota-resume-data'); fs.mkdirSync(quotaDir);
  const quotaBoard = new Board(quotaDir), quotaTask = quotaBoard.addTask('mia', 'Quota paused work', 'Continue the existing file task.', 'alex', true);
  quotaBoard.beginCoordination(quotaTask.id, { coordinator: 'alex', worker: 'mia', criteria: ['verify existing file'], budget: { used: 9, tokens: 18000, toolCalls: 2, limit: 10, tokenLimit: 24000, toolLimit: 12 } });
  quotaBoard.markTask(quotaTask.id, { session: 'free-agent:retained-session' });
  const retryAt = Date.now() + 60000;
  quotaBoard.setCoordination(quotaTask.id, { status: 'blocked', error: 'free_quota_exhausted', retryAt, by: 'system' });
  quotaBoard.updateTask(quotaTask.id, { status: 'blocked', note: 'Free quota exhausted; waiting for the shared Groq token window.' }, 'system');
  const persistedQuotaBoard = new Board(quotaDir), persistedQuota = persistedQuotaBoard.tasks[0];
  assert.equal(coord.resumeQuotaBlockedTask(persistedQuotaBoard, quotaTask.id, retryAt - 1, true), 'cooldown');
  assert.equal(coord.resumeQuotaBlockedTask(persistedQuotaBoard, quotaTask.id, retryAt, false), 'provider_unavailable');
  assert.equal(persistedQuota.coordination.status, 'blocked');
  assert.equal(coord.resumeQuotaBlockedTask(persistedQuotaBoard, quotaTask.id, retryAt, true), 'resumed');
  assert.equal(persistedQuota.coordination.status, 'assigned'); assert.equal(persistedQuota.status, 'todo');
  assert.equal(persistedQuota.session, 'free-agent:retained-session');
  assert.equal(persistedQuota.coordination.budget.used, 9); assert.equal(persistedQuota.coordination.budget.tokens, 18000);
  assert.equal(persistedQuota.coordination.budget.limit, 12);
  assert.equal(persistedQuota.coordination.retryAt, undefined);
  checks.push('quota exhaustion persists reason/retryAt; resume is user-triggered, waits for cooldown and eligible provider, preserves session/usage, and grants only the bounded remaining request allowance');

  const exhaustedDir = path.join(scratch, 'exhausted-budget-data'); fs.mkdirSync(exhaustedDir);
  const exhaustedBoard = new Board(exhaustedDir), exhaustedTask = exhaustedBoard.addTask('mia', 'Exhausted quota task', 'No budget remains.', 'alex', true);
  exhaustedBoard.beginCoordination(exhaustedTask.id, { coordinator: 'alex', worker: 'mia', criteria: ['stop safely'], budget: { used: 12, tokens: 18000, toolCalls: 2, limit: 12, tokenLimit: 24000, toolLimit: 12 } });
  exhaustedBoard.setCoordination(exhaustedTask.id, { status: 'blocked', error: 'free_quota_exhausted', retryAt: Date.now() - 1, by: 'system' });
  assert.equal(coord.resumeQuotaBlockedTask(exhaustedBoard, exhaustedTask.id, Date.now(), true), 'budget_exhausted');
  assert.equal(exhaustedTask.coordination.status, 'blocked');
  checks.push('quota resume cannot exceed the hard request/token/tool budget');

  const noBudgetDir = path.join(scratch, 'missing-budget-data'); fs.mkdirSync(noBudgetDir);
  const noBudgetBoard = new Board(noBudgetDir), noBudgetTask = noBudgetBoard.addTask('mia', 'Missing saved budget', 'Fail closed.', 'alex', true);
  noBudgetBoard.beginCoordination(noBudgetTask.id, { coordinator: 'alex', worker: 'mia', criteria: ['preserve quota budget'] });
  noBudgetBoard.setCoordination(noBudgetTask.id, { status: 'blocked', error: 'free_quota_exhausted', retryAt: Date.now() - 1, by: 'system' });
  assert.equal(coord.resumeQuotaBlockedTask(noBudgetBoard, noBudgetTask.id, Date.now(), true), 'budget_unavailable');
  assert.equal(noBudgetTask.coordination.status, 'blocked');
  checks.push('quota resume fails closed when historical shared budget is missing');

  const legacyQuotaDir = path.join(scratch, 'legacy-quota-data'); fs.mkdirSync(legacyQuotaDir);
  const legacyQuotaBoard = new Board(legacyQuotaDir), legacyQuota = legacyQuotaBoard.addTask('mia', 'Older quota failure', 'Existing task session.', 'alex', true);
  legacyQuotaBoard.beginCoordination(legacyQuota.id, { coordinator: 'alex', worker: 'mia', criteria: ['continue'], budget: { used: 8, tokens: 12000, toolCalls: 2, limit: 10, tokenLimit: 24000, toolLimit: 12 } });
  legacyQuotaBoard.updateTask(legacyQuota.id, { status: 'blocked', note: 'Task session error: free-agent: free_providers_exhausted' }, 'system');
  legacyQuotaBoard.setCoordination(legacyQuota.id, { status: 'blocked', by: 'system' });
  const migratedQuotaBoard = new Board(legacyQuotaDir); coord.recoverDelegatedTasks(migratedQuotaBoard);
  const migratedQuota = migratedQuotaBoard.tasks[0];
  assert.equal(migratedQuota.coordination.error, 'free_quota_exhausted');
  assert(migratedQuota.coordination.retryAt <= Date.now());assert.equal(migratedQuota.coordination.budget.used, 9);
  assert.equal(coord.resumeQuotaBlockedTask(migratedQuotaBoard, migratedQuota.id, Date.now(), false), 'provider_unavailable');
  checks.push('legacy quota-blocked task migrates without replay and conservatively accounts for its failed inference');

  const cancelDir = path.join(scratch, 'cancel-data'); fs.mkdirSync(cancelDir);
  const cancelBoard = new Board(cancelDir); const cancellable = cancelBoard.addTask('mia', 'Cancel fixture', 'fixture', 'alex');
  cancelBoard.beginCoordination(cancellable.id, { coordinator: 'alex', worker: 'mia', criteria: ['stop safely'] });
  cancelBoard.updateTask(cancellable.id, { status: 'doing' }, 'system'); let stopped = false;
  assert.equal(await coord.cancelDelegatedTask(cancelBoard, cancellable.id, async () => { stopped = true; }), 'cancelled');
  assert(stopped); assert.equal(cancelBoard.tasks[0].coordination.status, 'cancelled'); assert.equal(cancelBoard.tasks[0].status, 'blocked');
  checks.push('cancellation stops the worker before persisting a terminal cancelled state');

  assert.equal(toolNames.includes('Bash'), false); assert.equal(toolNames.includes('mcp__office__assign_task'), false);
  checks.push('runtime delegation exposes no Bash or generic office assignment tool');

  const failedTask = board.addTask('mia', 'Missing result fixture', 'Failure must not be reported as complete.', 'alex', true);
  board.beginCoordination(failedTask.id, { coordinator: 'alex', worker: 'mia', criteria: ['submit structured result'] });
  mia.startTask(failedTask.id, alex); board.setCoordination(failedTask.id, { status: 'running', by: 'system' });
  await waitFor(() => failedTask.coordination.status === 'failed', 'missing worker result failure');
  assert.equal(failedTask.status, 'blocked'); assert.equal(failedTask.coordination.result, undefined);
  checks.push('worker completion without submit_task_result is failed and blocked, never completed');

  const recoveryDir = path.join(scratch, 'request-recovery-data'); fs.mkdirSync(recoveryDir);
  const recoveryBoard = new Board(recoveryDir), recoveryTask = recoveryBoard.addTask('mia', 'Request-capped task', 'preserve the existing session', 'alex', true);
  recoveryBoard.beginCoordination(recoveryTask.id, { coordinator: 'alex', worker: 'mia', criteria: ['verify existing file'], budget: { used: 12, tokens: 13351, toolCalls: 9, limit: 12, tokenLimit: 24000, toolLimit: 12 } });
  recoveryBoard.setCoordination(recoveryTask.id, { status: 'blocked', error: 'request_limit_before_tools', lastAttempt: { agent: 'mia', requestId: 'fixture-request', requestsConsumed: 12, tokensConsumed: 13351, reason: 'request_limit_before_tools', proposedTools: ['submit_task_result'], at: Date.now() }, by: 'system' });
  assert.equal(coord.authorizeInferenceRecovery(recoveryBoard, recoveryTask.id, Date.now(), false), 'confirmation_required');
  assert.equal(coord.authorizeInferenceRecovery(recoveryBoard, recoveryTask.id, Date.now(), true), 'authorized');
  assert.equal(recoveryTask.coordination.budget.used, 12); assert.equal(recoveryTask.coordination.budget.tokens, 13351); assert.equal(recoveryTask.coordination.budget.toolCalls, 9);
  assert.equal(recoveryTask.coordination.budget.limit, 14); assert.equal(recoveryTask.coordination.recovery.requestsAdded, 2); assert.equal(recoveryTask.coordination.recovery.used, 0);
  assert.equal(coord.authorizeInferenceRecovery(recoveryBoard, recoveryTask.id, Date.now(), true), 'not_eligible');
  checks.push('one-time user recovery adds exactly two requests while preserving all consumption and auditing the authorization');

  const tokenExhaustedDir = path.join(scratch, 'token-exhausted-data'); fs.mkdirSync(tokenExhaustedDir);
  const tokenBoard = new Board(tokenExhaustedDir), tokenTask = tokenBoard.addTask('mia', 'Token exhausted', 'stop', 'alex', true);
  tokenBoard.beginCoordination(tokenTask.id, { coordinator: 'alex', worker: 'mia', criteria: ['stop'], budget: { used: 12, tokens: 24000, toolCalls: 2, limit: 12, tokenLimit: 24000, toolLimit: 12 } });
  tokenBoard.setCoordination(tokenTask.id, { status: 'blocked', error: 'request_limit_before_tools', by: 'system' });
  assert.equal(coord.authorizeInferenceRecovery(tokenBoard, tokenTask.id, Date.now(), true), 'token_budget_exhausted');
  const toolExhaustedDir = path.join(scratch, 'tool-exhausted-data'); fs.mkdirSync(toolExhaustedDir);
  const toolBoard = new Board(toolExhaustedDir), toolTask = toolBoard.addTask('mia', 'Tool exhausted', 'stop', 'alex', true);
  toolBoard.beginCoordination(toolTask.id, { coordinator: 'alex', worker: 'mia', criteria: ['stop'], budget: { used: 12, tokens: 20000, toolCalls: 12, limit: 12, tokenLimit: 24000, toolLimit: 12 } });
  toolBoard.setCoordination(toolTask.id, { status: 'blocked', error: 'request_limit_before_tools', by: 'system' });
  assert.equal(coord.authorizeInferenceRecovery(toolBoard, toolTask.id, Date.now(), true), 'tool_budget_exhausted');
  checks.push('recovery fails closed when token or tool ceiling is exhausted');

  const autoDir = path.join(scratch, 'auto-finalization-data'); fs.mkdirSync(autoDir);
  const autoBoard = new Board(autoDir), autoTask = autoBoard.addTask('mia', 'Objective fixture', 'fixture', 'alex', true);
  const autoCriteria = ['The file example.md exists in the workspace.', 'Its content is exactly "# Verified".', 'The first line matches the title.'];
  autoBoard.beginCoordination(autoTask.id, { coordinator: 'alex', worker: 'mia', criteria: autoCriteria });
  autoBoard.setCoordination(autoTask.id, { status: 'running', by: 'mia' });
  autoBoard.setCoordination(autoTask.id, { status: 'review', result: { summary: 'Created and read back example.md.', files: ['example.md'], submittedAt: Date.now() }, operations: [
    { agent: 'mia', requestId: 'write-1', tool: 'Write', path: 'example.md', outcome: 'executed', at: Date.now() },
    { agent: 'mia', requestId: 'read-1', tool: 'Read', path: 'example.md', outcome: 'executed', at: Date.now() },
    { agent: 'mia', requestId: 'submit-1', tool: 'submit_task_result', outcome: 'executed', at: Date.now() },
  ], by: 'mia' });
  autoBoard.updateTask(autoTask.id, { status: 'review' }, 'mia');
  const exactRead = async file => file === 'example.md' ? '# Verified' : undefined;
  assert.equal(await review.autoCompleteStructuredTask(autoBoard, autoTask.id, exactRead, false), 'completed');
  assert.equal(autoTask.coordination.status, 'completed'); assert.equal(autoTask.status, 'done');
  assert.deepEqual(autoTask.coordination.automaticCompletion, { authorizedBy: 'system', mechanism: 'structured_result_and_local_acceptance', completedAt: autoTask.coordination.verification.checkedAt, resultSubmittedAt: autoTask.coordination.result.submittedAt, verifiedAt: autoTask.coordination.verification.checkedAt });
  const completionHistory = autoTask.coordination.history.length;
  assert.equal(await review.autoCompleteStructuredTask(autoBoard, autoTask.id, exactRead, false), 'already_completed');
  assert.equal(autoTask.coordination.history.length, completionHistory);
  checks.push('structured result plus exact local acceptance closes once, records system authorization, and duplicate finalization is idempotent');

  const exactCriteria = ['The file statex-validation-03.md exists in the workspace.', 'Its content is exactly "# StateX HQ — Validation 03".', 'The first line matches the title.'];
  const noNewline = await review.verifyLocalAcceptance(exactCriteria, async file => file === 'statex-validation-03.md' ? '# StateX HQ — Validation 03' : undefined);
  assert.equal(noNewline.status, 'passed'); assert.deepEqual(noNewline.checks.map(c => c.status), ['passed', 'passed', 'passed']);
  const withFinalLF = await review.verifyLocalAcceptance(exactCriteria, async file => file === 'statex-validation-03.md' ? '# StateX HQ — Validation 03\n' : undefined);
  assert.equal(withFinalLF.status, 'failed'); assert.deepEqual(withFinalLF.checks.map(c => c.status), ['passed', 'failed', 'passed']);
  checks.push('exact UTF-8 content is compared byte-for-byte: final LF fails exact-content but not the independent first-line check');

  const waitingDir = path.join(scratch, 'auto-finalization-guards'); fs.mkdirSync(waitingDir);
  const waitingBoard = new Board(waitingDir);
  const makeReviewTask = (title, criteria, result, operations = []) => {
    const task = waitingBoard.addTask('mia', title, 'fixture', 'alex', true);
    waitingBoard.beginCoordination(task.id, { coordinator: 'alex', worker: 'mia', criteria });
    waitingBoard.setCoordination(task.id, { status: 'running', by: 'mia' });
    waitingBoard.setCoordination(task.id, { status: 'review', ...(result ? { result } : {}), operations, by: 'mia' });
    waitingBoard.updateTask(task.id, { status: 'review' }, 'mia'); return task;
  };
  const pendingApproval = makeReviewTask('Pending approval', autoCriteria, { summary: 'done', files: ['example.md'], submittedAt: Date.now() });
  assert.equal(await review.autoCompleteStructuredTask(waitingBoard, pendingApproval.id, exactRead, true), 'pending_approval');
  assert.equal(pendingApproval.coordination.status, 'review');
  const noResult = makeReviewTask('Missing result', autoCriteria, undefined);
  assert.equal(await review.autoCompleteStructuredTask(waitingBoard, noResult.id, exactRead, false), 'not_ready');
  const failedCheck = makeReviewTask('Failed check', autoCriteria, { summary: 'done', files: ['example.md'], submittedAt: Date.now() });
  assert.equal(await review.autoCompleteStructuredTask(waitingBoard, failedCheck.id, async () => '# Wrong\n', false), 'verification_failed');
  assert.equal(failedCheck.coordination.status, 'review');
  const newlineCheck = makeReviewTask('Final newline mismatch', autoCriteria, { summary: 'done', files: ['example.md'], submittedAt: Date.now() });
  assert.equal(await review.autoCompleteStructuredTask(waitingBoard, newlineCheck.id, async () => '# Verified\n', false), 'verification_failed');
  assert.deepEqual(newlineCheck.coordination.verification.checks.map(c => c.status), ['passed', 'failed', 'passed']);
  assert.equal(newlineCheck.coordination.status, 'review');
  const semanticCriteria = [...autoCriteria, 'No other changes are required.'];
  const manualTask = makeReviewTask('Manual criterion', semanticCriteria, { summary: 'done', files: ['example.md'], submittedAt: Date.now() });
  assert.equal(await review.autoCompleteStructuredTask(waitingBoard, manualTask.id, exactRead, false), 'manual_review_required');
  assert.equal(manualTask.coordination.status, 'review');
  const deniedTask = makeReviewTask('Denied operation', autoCriteria, { summary: 'done', files: ['example.md'], submittedAt: Date.now() }, [{ agent: 'mia', requestId: 'deny-1', tool: 'Write', path: 'example.md', outcome: 'denied', at: Date.now() }]);
  assert.equal(await review.autoCompleteStructuredTask(waitingBoard, deniedTask.id, exactRead, false), 'operation_review_required');
  assert.equal(deniedTask.coordination.status, 'review');
  checks.push('auto-finalization fails closed for pending approvals, missing results, failed criteria, manual semantics and denied mutations');

  const reviewDir = path.join(scratch, 'manual-review-data'); fs.mkdirSync(reviewDir);
  const reviewWorkspace = path.join(reviewDir, 'workspace'); fs.mkdirSync(reviewWorkspace);
  fs.writeFileSync(path.join(reviewWorkspace, 'statex-multiagent-test.md'), '# StateX HQ — Multiagent Test\n');
  const reviewBoard = new Board(reviewDir), reviewTask = reviewBoard.addTask('mia', 'statex-multiagent-test.md', 'fixture', 'alex', true);
  const criteria = ['The file statex-multiagent-test.md exists in the workspace.', 'Its first line is exactly "# StateX HQ — Multiagent Test".', 'No other changes are required.'];
  reviewBoard.beginCoordination(reviewTask.id, { coordinator: 'alex', worker: 'mia', criteria, budget: { used: 12, tokens: 13351, toolCalls: 9, limit: 12, tokenLimit: 24000, toolLimit: 12 } });
  reviewBoard.setCoordination(reviewTask.id, { status: 'blocked', error: 'request_limit_before_tools', by: 'system' });
  const workspaceTools = new tools.WorkspaceTools(reviewWorkspace);
  const localVerification = await review.verifyLocalAcceptance(criteria, async file => {
    const value = await workspaceTools.execute('Read', { file_path: file }, new AbortController().signal, async () => false, true);
    return value.startsWith('Error:') ? undefined : value;
  });
  assert.equal(localVerification.status, 'needs_manual_review');
  assert.deepEqual(localVerification.checks.map(c => c.status), ['passed', 'passed', 'manual_review']);
  reviewBoard.setCoordination(reviewTask.id, { verification: localVerification, by: 'user' });
  assert.equal(review.approveManualLocalReview(reviewBoard, reviewTask.id, localVerification, [], true), 'criteria_not_confirmed');
  assert.equal(reviewTask.coordination.status, 'blocked');
  assert.equal(review.approveManualLocalReview(reviewBoard, reviewTask.id, localVerification, [2], true), 'approved');
  assert.equal(reviewTask.coordination.status, 'completed'); assert.equal(reviewTask.status, 'done');
  assert.equal(reviewTask.coordination.result, undefined); assert.equal(reviewTask.coordination.manualReview.approvedBy, 'user');
  assert.equal(reviewTask.coordination.verification.checks[0].status, 'passed');
  checks.push('local verification checks exact criteria without model use; unknown criterion requires explicit user review and records no Mia result');

  const resultReviewDir = path.join(scratch, 'result-manual-review-data'); fs.mkdirSync(resultReviewDir);
  const resultReviewWorkspace = path.join(resultReviewDir, 'workspace'); fs.mkdirSync(resultReviewWorkspace);
  fs.writeFileSync(path.join(resultReviewWorkspace, 'statex-validation-02.md'), '# StateX HQ — Validation 02');
  const resultReviewBoard = new Board(resultReviewDir), resultReviewTask = resultReviewBoard.addTask('mia', 'statex-validation-02.md', 'fixture', 'alex', true);
  const resultCriteria = ['The file statex-validation-02.md exists in the workspace.', 'Its first line is exactly "# StateX HQ — Validation 02".', 'No other changes are required.'];
  resultReviewBoard.beginCoordination(resultReviewTask.id, { coordinator: 'alex', worker: 'mia', criteria: resultCriteria });
  resultReviewBoard.setCoordination(resultReviewTask.id, { status: 'running', by: 'mia' });
  resultReviewBoard.setCoordination(resultReviewTask.id, { status: 'review', result: { summary: 'Created statex-validation-02.md with required title.', files: ['statex-validation-02.md'], submittedAt: Date.now() }, by: 'mia' });
  resultReviewBoard.updateTask(resultReviewTask.id, { status: 'review' }, 'mia');
  const resultTools = new tools.WorkspaceTools(resultReviewWorkspace);
  const resultVerification = await review.verifyLocalAcceptance(resultCriteria, async file => {
    const value = await resultTools.execute('Read', { file_path: file }, new AbortController().signal, async () => false, true);
    return value.startsWith('Error:') ? undefined : value;
  });
  resultReviewBoard.setCoordination(resultReviewTask.id, { verification: resultVerification, by: 'user' });
  assert.equal(resultVerification.status, 'needs_manual_review');
  assert.equal(review.approveManualLocalReview(resultReviewBoard, resultReviewTask.id, resultVerification, [2], true), 'approved');
  assert.equal(resultReviewTask.coordination.result.summary, 'Created statex-validation-02.md with required title.');
  assert.match(resultReviewTask.coordination.manualReview.note, /Structured worker result was present/);
  checks.push('structured result with unresolved semantic criteria stays open until the user explicitly approves matching local verification');
  console.log(`OK ${checks.length} multi-agent integration checks`);
  for (const name of checks) console.log(`- ${name}`);
} finally {
  await Promise.all([alex.dispose(), mia.dispose()]);
  globalThis.fetch = originalFetch;
  fs.rmSync(scratch, { recursive: true, force: true });
}
