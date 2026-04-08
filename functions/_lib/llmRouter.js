const MODE_CHAINS = {
  strategy: [
    { provider: "anthropic", model: "claude-sonnet-4-6" },
    { provider: "openai", model: "gpt-4.1-mini" }
  ],
  research: [
    { provider: "gemini", model: "gemini-2.0-pro" },
    { provider: "anthropic", model: "claude-sonnet-4-6" }
  ],
  execution: [
    { provider: "openai", model: "gpt-4.1-mini" },
    { provider: "anthropic", model: "claude-sonnet-4-6" }
  ],
};

const PROVIDER_KEYS = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  gemini: "GEMINI_API_KEY",
};

function normalizeMessages(system, messages = []) {
  const normalized = Array.isArray(messages) ? [...messages] : [];
  if (!normalized.length) {
    normalized.push({ role: "user", content: "" });
  }
  return { system: system || "", messages: normalized.map(formatMessage) };
}

function formatMessage(msg = {}) {
  if (typeof msg === "string") {
    return { role: "user", content: msg };
  }
  return {
    role: msg.role === "assistant" ? "assistant" : "user",
    content: typeof msg.content === "string" ? msg.content : String(msg.content || ""),
  };
}

async function callAnthropic(env, { model, system, messages, maxTokens, temperature }) {
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not configured");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      system,
      messages: messages.map(({ role, content }) => ({ role, content })),
      max_tokens: maxTokens,
      temperature,
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Anthropic ${res.status}: ${detail.slice(0,200)}`);
  }
  const data = await res.json();
  return data?.content?.[0]?.text?.trim() || "";
}

async function callOpenAI(env, { model, system, messages, maxTokens, temperature }) {
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not configured");
  const chatMessages = [];
  if (system) chatMessages.push({ role: "system", content: system });
  messages.forEach((msg) => chatMessages.push(msg));
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature,
      max_tokens: maxTokens,
      messages: chatMessages,
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`OpenAI ${res.status}: ${detail.slice(0,200)}`);
  }
  const data = await res.json();
  return data?.choices?.[0]?.message?.content?.trim() || "";
}

function toGeminiContents(system, messages) {
  const merged = [...messages];
  if (system) {
    merged.unshift({ role: "system", content: system });
  }
  return merged.map(({ role, content }) => ({
    role: role === "assistant" ? "model" : "user",
    parts: [{ text: content }],
  }));
}

async function callGemini(env, { model, system, messages, maxTokens, temperature }) {
  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY not configured");
  const contents = toGeminiContents(system, messages);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents,
      generationConfig: {
        temperature,
        maxOutputTokens: maxTokens,
      },
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Gemini ${res.status}: ${detail.slice(0,200)}`);
  }
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join(" ").trim();
  return text || "";
}

function providerHasKey(env, provider) {
  const keyName = PROVIDER_KEYS[provider];
  return keyName && env[keyName];
}

export async function runLLM({
  env,
  mode = "execution",
  system = "",
  messages = [],
  maxTokens = 800,
  temperature = 0.3,
}) {
  if (!env) throw new Error("env is required");
  const chain = MODE_CHAINS[mode] || MODE_CHAINS.execution;
  const { system: sys, messages: normalized } = normalizeMessages(system, messages);
  let lastError;
  for (const target of chain) {
    if (!providerHasKey(env, target.provider)) continue;
    try {
      if (target.provider === "anthropic") {
        return await callAnthropic(env, { model: target.model, system: sys, messages: normalized, maxTokens, temperature });
      }
      if (target.provider === "openai") {
        return await callOpenAI(env, { model: target.model, system: sys, messages: normalized, maxTokens, temperature });
      }
      if (target.provider === "gemini") {
        return await callGemini(env, { model: target.model, system: sys, messages: normalized, maxTokens, temperature });
      }
    } catch (err) {
      lastError = err;
      console.error(`[LLM Router] ${target.provider} failed:`, err.message);
      continue;
    }
  }
  throw lastError || new Error("No available LLM providers for this mode");
}
