// Research adapters: Claude (Anthropic SDK, web_search server tool), Gemini (Google Search grounding),
// OpenAI (Responses API, web_search tool) and Grok (xAI, live search), plus a deterministic mock.
// Runtime-neutral: the Claude client and fetch are injected, so Vitest drives them with fakes.
// Gemini, OpenAI and Grok follow the providers' public docs and are NOT yet verified against the live
// APIs (no keys); check the request shapes there before enabling them.

export type ResearchUsage = { input: number; output: number; cacheRead: number; cacheWrite: number };
export type ResearchAnswer = { text: string; usage: ResearchUsage; searches: number; latencyMs: number };
export type ResearchProvider = { provider: string; model: string; research(system: string, message: string): Promise<ResearchAnswer> };
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
type Limits = { maxSearches: number; timeoutSeconds: number };

const NO_USAGE: ResearchUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export class ResearchError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number | null,
    readonly usage: ResearchUsage = NO_USAGE,
    readonly searches = 0,
  ) {
    super(message);
    this.name = "ResearchError";
  }
}

function withTimeout(seconds: number): { signal: AbortSignal; done: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), seconds * 1000);
  return { signal: controller.signal, done: () => clearTimeout(timer) };
}

// The provider's own error message ({ error: { message } } or { error: "..." }), else the start of the body.
export function providerMessage(text: string): string {
  try {
    const j = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
    const message = typeof j.error === "string" ? j.error : (j.error?.message ?? j.message);
    if (message) return message.replace(/\s+/g, " ").trim().slice(0, 300);
  } catch {
    // not JSON
  }
  return text.replace(/\s+/g, " ").trim().slice(0, 200);
}

async function postJson(fetchFn: FetchLike, url: string, headers: Record<string, string>, body: unknown, limits: Limits): Promise<Record<string, unknown>> {
  const t = withTimeout(limits.timeoutSeconds);
  try {
    const res = await fetchFn(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body), signal: t.signal });
    const text = await res.text();
    if (!res.ok) {
      // Only 402 means "no credit" (it pauses the engine at once). A 429 is a rate or quota limit that often
      // clears in a minute (Gemini's message always says "check your plan and billing"): a normal error,
      // which still pauses the engine through the failure-rate rule if it continues.
      throw new ResearchError(`HTTP ${res.status}: ${providerMessage(text)}`, res.status);
    }
    return JSON.parse(text) as Record<string, unknown>;
  } catch (error) {
    if (error instanceof ResearchError) throw error;
    throw new ResearchError((error as Error).name === "AbortError" ? `No answer within ${limits.timeoutSeconds} s` : (error as Error).message, null);
  } finally {
    t.done();
  }
}

// --- Claude ---------------------------------------------------------------------------------------

type ClaudeBlock = { type: string; text?: string };
export type ClaudeClient = {
  messages: {
    create(
      params: Record<string, unknown>,
      options?: { signal?: AbortSignal },
    ): Promise<{
      content: ClaudeBlock[];
      stop_reason: string | null;
      usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null; server_tool_use?: { web_search_requests?: number } | null };
    }>;
  };
};

export function claudeResearch(client: ClaudeClient, model: string, limits: Limits): ResearchProvider {
  // Dynamic-filtering web search on Opus/Sonnet; the basic variant elsewhere.
  const toolType = /^claude-(opus|sonnet)/.test(model) ? "web_search_20260209" : "web_search_20250305";
  return {
    provider: "claude",
    model,
    async research(system, message) {
      const started = Date.now();
      const t = withTimeout(limits.timeoutSeconds);
      const usage = { ...NO_USAGE };
      let searches = 0;
      const messages: { role: string; content: unknown }[] = [{ role: "user", content: message }];
      try {
        // Server tools can pause a long turn (pause_turn); resume it a few times.
        for (let turn = 0; turn < 4; turn++) {
          const r = await client.messages.create(
            { model, max_tokens: 8000, system, messages, tools: [{ type: toolType, name: "web_search", max_uses: limits.maxSearches }] },
            { signal: t.signal },
          );
          usage.input += r.usage.input_tokens;
          usage.output += r.usage.output_tokens;
          usage.cacheRead += r.usage.cache_read_input_tokens ?? 0;
          usage.cacheWrite += r.usage.cache_creation_input_tokens ?? 0;
          searches += r.usage.server_tool_use?.web_search_requests ?? 0;
          if (r.stop_reason === "refusal") throw new ResearchError("Claude declined this research", 200, usage, searches);
          if (r.stop_reason === "pause_turn") {
            messages.push({ role: "assistant", content: r.content });
            continue;
          }
          const text = r.content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
          return { text, usage, searches, latencyMs: Date.now() - started };
        }
        throw new ResearchError("Claude did not finish the research", 200, usage, searches);
      } catch (error) {
        if (error instanceof ResearchError) throw error;
        const e = error as { status?: number; message?: string; name?: string };
        const status = typeof e.status === "number" ? e.status : null;
        const billing = status === 402 || (status === 400 && /credit balance/i.test(e.message ?? ""));
        const msg = e.name === "AbortError" || /abort/i.test(e.message ?? "") ? `No answer within ${limits.timeoutSeconds} s` : `Claude API error${status ? ` ${status}` : ""}: ${(e.message ?? "").slice(0, 200)}`;
        throw new ResearchError(msg, billing ? 402 : status, usage, searches);
      } finally {
        t.done();
      }
    },
  };
}

// --- Gemini (Google Search grounding) -------------------------------------------------------------

export function geminiResearch(fetchFn: FetchLike, key: string, model: string, limits: Limits): ResearchProvider {
  return {
    provider: "gemini",
    model,
    async research(system, message) {
      const started = Date.now();
      const r = await postJson(
        fetchFn,
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        { "x-goog-api-key": key },
        { systemInstruction: { parts: [{ text: system }] }, contents: [{ role: "user", parts: [{ text: message }] }], tools: [{ google_search: {} }] },
        limits,
      );
      const candidate = (r.candidates as { content?: { parts?: { text?: string }[] }; groundingMetadata?: { webSearchQueries?: string[] } }[] | undefined)?.[0];
      const meta = r.usageMetadata as { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number; cachedContentTokenCount?: number } | undefined;
      const searches = candidate?.groundingMetadata?.webSearchQueries?.length ?? 0;
      // Thinking tokens (Gemini 2.5 and later) are billed as output.
      const usage = { input: meta?.promptTokenCount ?? 0, output: (meta?.candidatesTokenCount ?? 0) + (meta?.thoughtsTokenCount ?? 0), cacheRead: meta?.cachedContentTokenCount ?? 0, cacheWrite: 0 };
      // Gemini has no per-request search cap: refuse an answer that used more than allowed.
      if (searches > limits.maxSearches) throw new ResearchError(`Gemini ran ${searches} searches (limit ${limits.maxSearches})`, 200, usage, searches);
      return { text: (candidate?.content?.parts ?? []).map((p) => p.text ?? "").join(""), usage, searches, latencyMs: Date.now() - started };
    },
  };
}

// --- OpenAI (Responses API, web_search tool) ------------------------------------------------------

export function openaiResearch(fetchFn: FetchLike, key: string, model: string, limits: Limits): ResearchProvider {
  return {
    provider: "openai",
    model,
    async research(system, message) {
      const started = Date.now();
      const r = await postJson(
        fetchFn,
        "https://api.openai.com/v1/responses",
        { Authorization: `Bearer ${key}` },
        { model, instructions: system, input: message, tools: [{ type: "web_search" }], max_tool_calls: limits.maxSearches },
        limits,
      );
      const output = (r.output as { type: string; content?: { type: string; text?: string }[] }[] | undefined) ?? [];
      const text = output.filter((o) => o.type === "message").flatMap((o) => o.content ?? []).filter((c) => c.type === "output_text").map((c) => c.text ?? "").join("");
      const u = r.usage as { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } } | undefined;
      return {
        text,
        usage: { input: u?.input_tokens ?? 0, output: u?.output_tokens ?? 0, cacheRead: u?.input_tokens_details?.cached_tokens ?? 0, cacheWrite: 0 },
        searches: output.filter((o) => o.type === "web_search_call").length,
        latencyMs: Date.now() - started,
      };
    },
  };
}

// --- Grok (xAI, live search) ----------------------------------------------------------------------

export function grokResearch(fetchFn: FetchLike, key: string, model: string, limits: Limits): ResearchProvider {
  return {
    provider: "grok",
    model,
    async research(system, message) {
      const started = Date.now();
      const r = await postJson(
        fetchFn,
        "https://api.x.ai/v1/chat/completions",
        { Authorization: `Bearer ${key}` },
        {
          model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: message },
          ],
          search_parameters: { mode: "on", max_search_results: limits.maxSearches, return_citations: true },
        },
        limits,
      );
      const choice = (r.choices as { message?: { content?: string } }[] | undefined)?.[0];
      const u = r.usage as { prompt_tokens?: number; completion_tokens?: number; num_sources_used?: number } | undefined;
      return {
        text: choice?.message?.content ?? "",
        usage: { input: u?.prompt_tokens ?? 0, output: u?.completion_tokens ?? 0, cacheRead: 0, cacheWrite: 0 },
        searches: Math.min(u?.num_sources_used ?? 0, limits.maxSearches),
        latencyMs: Date.now() - started,
      };
    },
  };
}

// --- Mock ------------------------------------------------------------------------------------------

// Deterministic dossier with two sourced claims and one without a URL (validation drops it).
export function mockResearch(): ResearchProvider {
  return {
    provider: "mock",
    model: "mock",
    async research(_system, message) {
      const name = /Name: (.*)/.exec(message)?.[1]?.trim() ?? "Unknown";
      const remote = /anydesk|teamviewer|rustdesk|remote desktop/i.test(message);
      const slugName = remote ? "Remote access / Remote desktop and support" : "Other / Other";
      const site = `https://www.example.com/${encodeURIComponent(name.toLowerCase().replace(/\s+/g, "-"))}`;
      const dossier = {
        summary: `${name} is a ${remote ? "remote access tool that lets someone control this computer over the network" : "software title"}. (Mock dossier.)`,
        vendor: null,
        official_url: site,
        store_url: null,
        capabilities: remote ? ["remote_control", "screen_capture"] : [],
        suggested_category: slugName,
        confidence: remote ? "high" : "low",
        agrees_with_jev: /Jev proposed/.test(message) ? remote : null,
        risk_notes: remote ? ["Allows unattended remote control when installed as a service."] : [],
        evidence: [
          { claim: `${name} product page`, url: site },
          { claim: `${name} documentation`, url: `${site}/docs` },
          { claim: "An unsourced claim that validation must drop", url: "" },
        ],
        unknown: false,
      };
      return { text: `Here is the dossier:\n${JSON.stringify(dossier)}`, usage: { input: 900, output: 350, cacheRead: 0, cacheWrite: 0 }, searches: 2, latencyMs: 5 };
    },
  };
}

