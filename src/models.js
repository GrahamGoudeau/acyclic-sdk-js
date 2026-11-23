// Model adapters. A Model is
//   { provider, model, coveredByBAA, chat({ messages, tools, maxTokens, signal }) ->
//     { content, toolCalls: [{ id, name, args }], usage: { input, output }, finishReason } }
// Messages use one neutral shape:
//   { role: "system" | "user" | "assistant" | "tool", content, toolCalls?, toolCallId? }

import { sigV4 } from "./sigv4.js";

async function post(f, url, headers, body, signal) {
  const res = await f(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = undefined; }
  if (!res.ok) {
    const e = new Error(`model request failed: ${res.status}`);
    e.status = res.status; e.type = String(res.status); e.detail = json?.error?.message ?? json?.message;
    throw e;
  }
  return json;
}

const parseArgs = (s) => { try { return typeof s === "string" ? (s ? JSON.parse(s) : {}) : s ?? {}; } catch { return { __unparsed: s }; } };

// Any OpenAI Chat Completions compatible API: OpenAI, Azure OpenAI, OpenRouter,
// vLLM, Ollama, DeepSeek. extraBody is merged into every request (e.g.
// OpenRouter's provider routing).
export function openAICompatible({ baseUrl = "https://api.openai.com/v1", apiKey, model, coveredByBAA = false, headers = {}, extraBody = {}, fetch: f = (...a) => fetch(...a) }) {
  return {
    provider: "openai", model, coveredByBAA,
    async chat({ messages, tools, maxTokens = 1024, signal }) {
      const body = {
        model, max_tokens: maxTokens, ...extraBody,
        messages: messages.map((m) => m.role === "tool"
          ? { role: "tool", tool_call_id: m.toolCallId, content: m.content }
          : m.role === "assistant" && m.toolCalls?.length
            ? { role: "assistant", content: m.content || null, tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } })) }
            : { role: m.role, content: m.content }),
      };
      if (tools?.length) body.tools = tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } }));
      const j = await post(f, `${baseUrl.replace(/\/$/, "")}/chat/completions`, { authorization: `Bearer ${apiKey}`, ...headers }, body, signal);
      const choice = j.choices?.[0] ?? {};
      const msg = choice.message ?? {};
      return {
        content: msg.content ?? "",
        toolCalls: (msg.tool_calls || []).map((c, i) => ({ id: c.id || `call_${i}`, name: c.function?.name, args: parseArgs(c.function?.arguments) })),
        usage: { input: j.usage?.prompt_tokens, output: j.usage?.completion_tokens },
        finishReason: choice.finish_reason,
      };
    },
  };
}

// Anthropic Messages API.
export function anthropic({ apiKey, model, coveredByBAA = false, baseUrl = "https://api.anthropic.com", fetch: f = (...a) => fetch(...a) }) {
  return {
    provider: "anthropic", model, coveredByBAA,
    async chat({ messages, tools, maxTokens = 1024, signal }) {
      const body = { model, max_tokens: maxTokens, ...toAnthropic(messages) };
      if (tools?.length) body.tools = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema }));
      const j = await post(f, `${baseUrl}/v1/messages`, { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }, body, signal);
      return fromAnthropic(j.content, j.usage?.input_tokens, j.usage?.output_tokens, j.stop_reason);
    },
  };
}

function toAnthropic(messages) {
  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n") || undefined;
  const out = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    let role = m.role === "tool" ? "user" : m.role;
    let blocks;
    if (m.role === "tool") blocks = [{ type: "tool_result", tool_use_id: m.toolCallId, content: m.content }];
    else if (m.role === "assistant") blocks = [...(m.content ? [{ type: "text", text: m.content }] : []), ...(m.toolCalls || []).map((c) => ({ type: "tool_use", id: c.id, name: c.name, input: c.args }))];
    else blocks = [{ type: "text", text: m.content }];
    const last = out[out.length - 1];
    if (last?.role === role) last.content.push(...blocks); else out.push({ role, content: blocks });
  }
  return { system, messages: out };
}

function fromAnthropic(content = [], input, output, stop) {
  return {
    content: content.filter((b) => b.type === "text").map((b) => b.text).join(""),
    toolCalls: content.filter((b) => b.type === "tool_use").map((b) => ({ id: b.id, name: b.name, args: b.input ?? {} })),
    usage: { input, output }, finishReason: stop,
  };
}

// Amazon Bedrock Converse API, signed with SigV4. Bedrock is covered by the
// AWS BAA for eligible accounts; you still set coveredByBAA yourself.
// credentials: { accessKeyId, secretAccessKey, sessionToken? }
export function bedrock({ region = "us-east-1", model, credentials, coveredByBAA = false, fetch: f = (...a) => fetch(...a) }) {
  return {
    provider: "aws.bedrock", model, coveredByBAA,
    async chat({ messages, tools, maxTokens = 1024, signal }) {
      const { system, messages: msgs } = toAnthropic(messages);
      const body = {
        messages: msgs.map((m) => ({ role: m.role, content: m.content.map(toConverse) })),
        inferenceConfig: { maxTokens },
        ...(system ? { system: [{ text: system }] } : {}),
        ...(tools?.length ? { toolConfig: { tools: tools.map((t) => ({ toolSpec: { name: t.name, description: t.description, inputSchema: { json: t.input_schema } } })) } } : {}),
      };
      const url = `https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(model)}/converse`;
      const payload = JSON.stringify(body);
      const headers = await sigV4({ method: "POST", url, region, service: "bedrock", body: payload, credentials, headers: { "content-type": "application/json" } });
      const res = await f(url, { method: "POST", headers, body: payload, signal });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { const e = new Error(`model request failed: ${res.status}`); e.status = res.status; e.type = String(res.status); e.detail = j.message; throw e; }
      const content = (j.output?.message?.content || []).map((c) => c.toolUse ? { type: "tool_use", id: c.toolUse.toolUseId, name: c.toolUse.name, input: c.toolUse.input } : { type: "text", text: c.text ?? "" });
      return fromAnthropic(content, j.usage?.inputTokens, j.usage?.outputTokens, j.stopReason);
    },
  };
}

function toConverse(b) {
  if (b.type === "text") return { text: b.text };
  if (b.type === "tool_use") return { toolUse: { toolUseId: b.id, name: b.name, input: b.input } };
  return { toolResult: { toolUseId: b.tool_use_id, content: [{ text: b.content }] } };
}
