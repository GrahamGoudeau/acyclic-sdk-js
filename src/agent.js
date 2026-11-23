// The agent loop: ask the model, run the tools it calls, repeat, with hard
// step, tool-call and token budgets.

import { guard } from "./telemetry.js";
import { randomId } from "./util.js";

export const DEFAULT_SYSTEM = [
  "You are a clinical data assistant working inside an EHR integration.",
  "Use the tools to read the chart. Every tool acts on the one patient bound to this session.",
  "Answer only from tool results. If the chart does not say, say so. Cite dates and values exactly as returned.",
  "Never guess identifiers. Writes need a person's approval; if one is declined, do not retry it.",
].join(" ");

// Synthetic-data mode only talks to known sandbox hosts.
export const SANDBOX_HOSTS = [
  /(^|\.)acyclic\.sh$/, /^fhir\.epic\.com$/, /^fhir-ehr-code\.cerner\.com$/, /^fhir-open\.cerner\.com$/,
  /^api\.preview\.platform\.athenahealth\.com$/, /^localhost$/, /^127\.0\.0\.1$/, /^\[::1\]$/,
];

export class BudgetError extends Error {}

// opts:
//   ehr, session         from connect() / createSession()
//   model                from models.js
//   prompt               the user's request (or messages: prior conversation)
//   dataPolicy           REQUIRED: "baa" (model.coveredByBAA must be true) or
//                        "synthetic" (only sandbox hosts allowed)
//   system               system prompt (default DEFAULT_SYSTEM)
//   maxSteps 8, maxToolCalls 20, maxTokens 60000 total, maxOutputTokens 4096 per call (reasoning models spend output tokens on hidden reasoning)
//   (stop is "done", "max_steps", "max_tokens", "max_tool_calls" or "output_truncated")
//   store                ConversationStore; saves after every step
//   conversationId       resume or name the conversation in the store
//   onEvent(e)           UI hook: { type: "model_request" | "model_response" | "tool_call" | "tool_result" | "done", ... }
//   signal               AbortSignal
export async function runAgent(opts) {
  const { ehr, session, model } = opts;
  checkPolicy(opts.dataPolicy, model, ehr);
  const t = guard(ehr.telemetry);
  const runId = opts.conversationId ?? randomId("run_");
  session.runId = runId;
  const maxSteps = opts.maxSteps ?? 8, maxToolCalls = opts.maxToolCalls ?? 20, maxTokens = opts.maxTokens ?? 60000;
  const emit = (e) => { try { opts.onEvent?.(e); } catch {} };

  let messages = opts.messages ? [...opts.messages] : (await opts.store?.load(runId)) ?? [];
  if (!messages.some((m) => m.role === "system")) messages.unshift({ role: "system", content: opts.system ?? DEFAULT_SYSTEM });
  if (opts.prompt) messages.push({ role: "user", content: opts.prompt });

  const span = t.startSpan("invoke_agent acyclic", {
    "gen_ai.operation.name": "invoke_agent", "gen_ai.provider.name": model.provider, "gen_ai.request.model": model.model,
    "gen_ai.conversation.id": runId, "acyclic.vendor": ehr.vendor.name,
  });
  let used = 0, toolCalls = 0, steps = 0, stop = "done";
  const usage = { input: 0, output: 0 };
  try {
    for (;;) {
      if (steps >= maxSteps) { stop = "max_steps"; break; }
      if (used >= maxTokens) { stop = "max_tokens"; break; }
      steps++;
      const tools = session.definitions();
      emit({ type: "model_request", step: steps, messages, tools });
      const ms = t.startSpan(`chat ${model.model}`, { "gen_ai.operation.name": "chat", "gen_ai.provider.name": model.provider, "gen_ai.request.model": model.model }, span);
      let reply;
      try {
        reply = await model.chat({ messages, tools, maxTokens: opts.maxOutputTokens ?? 4096, signal: opts.signal });
        ms.setAttributes({ "gen_ai.usage.input_tokens": reply.usage.input, "gen_ai.usage.output_tokens": reply.usage.output, "gen_ai.response.finish_reasons": [String(reply.finishReason)] });
        ms.end();
      } catch (e) { ms.setAttributes({ "error.type": e.type ?? "model_error" }); ms.end(e); throw e; }
      usage.input += reply.usage.input ?? 0; usage.output += reply.usage.output ?? 0;
      used = usage.input + usage.output;
      messages.push({ role: "assistant", content: reply.content, toolCalls: reply.toolCalls.length ? reply.toolCalls : undefined });
      emit({ type: "model_response", step: steps, content: reply.content, toolCalls: reply.toolCalls, usage: reply.usage });
      t.log("info", "agent.step", { "gen_ai.conversation.id": runId, "gen_ai.usage.input_tokens": reply.usage.input, "gen_ai.usage.output_tokens": reply.usage.output });

      if (!reply.toolCalls.length) {
        await opts.store?.save(runId, messages);
        // A reply cut off by the output cap is not an answer; say so.
        if (["length", "max_tokens"].includes(reply.finishReason)) stop = "output_truncated";
        break;
      }
      for (const call of reply.toolCalls) {
        let out;
        if (toolCalls >= maxToolCalls) out = { ok: false, error: "tool call budget exhausted for this run", code: "budget" };
        else {
          toolCalls++;
          emit({ type: "tool_call", step: steps, id: call.id, name: call.name, args: call.args });
          out = await session.call(call.name, call.args, { callId: call.id, parent: span });
        }
        emit({ type: "tool_result", step: steps, id: call.id, name: call.name, ...out });
        messages.push({ role: "tool", toolCallId: call.id, name: call.name, content: JSON.stringify(out.ok ? out.result : { error: out.error, code: out.code }) });
      }
      await opts.store?.save(runId, messages);
      if (toolCalls >= maxToolCalls) { stop = "max_tool_calls"; break; }
    }
    t.log("info", "agent.stop", { "gen_ai.conversation.id": runId, "error.type": stop === "done" ? undefined : stop });
    span.end();
  } catch (e) { span.setAttributes({ "error.type": e.type ?? "error" }); span.end(e); throw e; }
  const final = [...messages].reverse().find((m) => m.role === "assistant")?.content ?? "";
  emit({ type: "done", stop, text: final, usage, steps, toolCalls });
  return { text: final, stop, messages, usage, steps, toolCalls, conversationId: runId };
}

function checkPolicy(policy, model, ehr) {
  if (policy === "baa") {
    if (model.coveredByBAA !== true) throw new Error('dataPolicy "baa" needs a model created with coveredByBAA: true');
    return;
  }
  if (policy === "synthetic") {
    const host = new URL(ehr.fhir.baseUrl).hostname;
    if (!SANDBOX_HOSTS.some((re) => re.test(host))) throw new Error(`dataPolicy "synthetic" only allows sandbox hosts, not ${host}`);
    return;
  }
  throw new Error('set dataPolicy: "baa" (real patient data, BAA-covered model) or "synthetic" (sandbox only)');
}

// In-memory ConversationStore. Implement { load(id), save(id, messages),
// delete(id) } over your own database; see the README's Postgres schema.
export function memoryStore() {
  const m = new Map();
  return {
    async load(id) { return m.has(id) ? structuredClone(m.get(id)) : undefined; },
    async save(id, messages) { m.set(id, structuredClone(messages)); },
    async delete(id) { m.delete(id); },
  };
}
