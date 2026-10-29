// If a free-agent test loads Claude SDK at runtime, fail rather than silently using it.
export async function resolve(specifier, context, next) {
  if (specifier.includes('@anthropic-ai/claude-agent-sdk')) throw new Error('SDK_RUNTIME_FORBIDDEN');
  return next(specifier, context);
}
