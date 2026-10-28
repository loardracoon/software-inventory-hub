// Jev classifiers behind one interface: Claude (Messages API, structured output, cached system prompt),
// OpenAI (Responses API, strict JSON schema) and a deterministic mock for local runs without a key.
// Runtime-neutral: the Claude client and fetch are passed in, so Vitest can drive them with fakes.

import { answerSchema, parseAnswer, titleMessage, type Answer, type TitleInput } from "./jev-prompt.ts";

export type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number };
export type Classified = Answer & { usage: Usage; latencyMs: number };
export type Classifier = { model: string; classify(title: TitleInput): Promise<Classified> };

export class ClassifyError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number | null,
    readonly usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  ) {
    super(message);
    this.name = "ClassifyError";
  }
}

// The slice of the Anthropic SDK client Jev uses.
export type MessagesClient = {
  messages: {
    create(params: Record<string, unknown>): Promise<{
      content: { type: string; text?: string }[];
      stop_reason: string | null;
      usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null };
    }>;
  };
};

export function claudeClassifier(client: MessagesClient, model: string, system: string, slugs: string[]): Classifier {
  const schema = answerSchema(slugs);
  return {
    model,
    async classify(title) {
      const started = Date.now();
      let response;
      try {
        response = await client.messages.create({
          model,
          max_tokens: 256,
          // The category list is the long, stable part: cache it.
          system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
          messages: [{ role: "user", content: titleMessage(title) }],
          output_config: { format: { type: "json_schema", schema } },
        });
      } catch (error) {
        const e = error as { status?: number; message?: string };
        const status = typeof e.status === "number" ? e.status : null;
        // An exhausted balance comes back as a 400 with a billing message: treat it as 402 (pause).
        const billing = status === 402 || (status === 400 && /credit balance/i.test(e.message ?? ""));
        throw new ClassifyError(`Claude API error${status ? ` ${status}` : ""}: ${(e.message ?? "request failed").slice(0, 200)}`, billing ? 402 : status);
      }
      const usage: Usage = {
        input: response.usage.input_tokens,
        output: response.usage.output_tokens,
        cacheRead: response.usage.cache_read_input_tokens ?? 0,
        cacheWrite: response.usage.cache_creation_input_tokens ?? 0,
      };
      if (response.stop_reason === "refusal") throw new ClassifyError("Claude declined to classify this title", 200, usage);
      const text = response.content.find((b) => b.type === "text")?.text ?? "";
      try {
        return { ...parseAnswer(text, slugs), usage, latencyMs: Date.now() - started };
      } catch (error) {
        throw new ClassifyError((error as Error).message, 200, usage);
      }
    },
  };
}

// OpenAI (Responses API over REST, strict JSON schema). The system prompt goes first as instructions,
// so OpenAI's automatic prompt caching reuses it. Reasoning models (gpt-5 family, o-series) get a low
// reasoning effort; their reasoning tokens are billed as output and included in output_tokens.
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

const OPENAI_URL = "https://api.openai.com/v1/responses";
export const isReasoningModel = (model: string) => /^(gpt-5|o\d)/.test(model);

type OpenAIResponse = {
  status?: string;
  incomplete_details?: { reason?: string } | null;
  output?: { type: string; content?: { type: string; text?: string; refusal?: string }[] }[];
  usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } };
};

export function openaiClassifier(fetchFn: FetchLike, key: string, model: string, system: string, slugs: string[], timeoutSeconds = 60): Classifier {
  const schema = answerSchema(slugs);
  return {
    model,
    async classify(title) {
      const started = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutSeconds * 1000);
      let res: Response;
      let text: string;
      try {
        res = await fetchFn(OPENAI_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
          body: JSON.stringify({
            model,
            instructions: system,
            input: titleMessage(title),
            // Room for the reasoning tokens as well as the short JSON answer.
            max_output_tokens: isReasoningModel(model) ? 4000 : 256,
            ...(isReasoningModel(model) ? { reasoning: { effort: "low" } } : {}),
            text: { format: { type: "json_schema", name: "jev_answer", strict: true, schema } },
            store: false,
          }),
          signal: controller.signal,
        });
        text = await res.text();
      } catch (error) {
        const aborted = (error as Error).name === "AbortError";
        throw new ClassifyError(aborted ? `No answer from OpenAI within ${timeoutSeconds} s` : `OpenAI request failed: ${(error as Error).message.slice(0, 200)}`, null);
      } finally {
        clearTimeout(timer);
      }

      if (!res.ok) {
        let message = text.replace(/\s+/g, " ").slice(0, 200);
        let code = "";
        try {
          const j = JSON.parse(text) as { error?: { message?: string; code?: string; type?: string } };
          message = (j.error?.message ?? message).slice(0, 300);
          code = j.error?.code ?? j.error?.type ?? "";
        } catch {
          // not JSON
        }
        // No credit left comes back as 429 insufficient_quota: treat it as billing (402, pauses Jev).
        // Any other 429 is a rate limit: a normal error.
        const billing = res.status === 402 || code === "insufficient_quota";
        throw new ClassifyError(`OpenAI API error ${res.status}: ${message}`, billing ? 402 : res.status);
      }

      const r = JSON.parse(text) as OpenAIResponse;
      const cached = r.usage?.input_tokens_details?.cached_tokens ?? 0;
      // OpenAI's input_tokens include the cached ones; the gateway prices them apart.
      const usage: Usage = { input: Math.max((r.usage?.input_tokens ?? 0) - cached, 0), output: r.usage?.output_tokens ?? 0, cacheRead: cached, cacheWrite: 0 };
      const content = (r.output ?? []).filter((o) => o.type === "message").flatMap((o) => o.content ?? []);
      if (content.some((c) => c.type === "refusal")) throw new ClassifyError("OpenAI declined to classify this title", 200, usage);
      if (r.status === "incomplete") throw new ClassifyError(`OpenAI stopped early (${r.incomplete_details?.reason ?? "incomplete"})`, 200, usage);
      const answer = content.filter((c) => c.type === "output_text").map((c) => c.text ?? "").join("");
      try {
        return { ...parseAnswer(answer, slugs), usage, latencyMs: Date.now() - started };
      } catch (error) {
        throw new ClassifyError((error as Error).message, 200, usage);
      }
    },
  };
}

// Deterministic stand-in: keyword rules, simulated token usage (the cached system prompt is "read"
// after the first call). Unknown titles get other/other at 0.4.
const RULES: [RegExp, string, number][] = [
  [/anydesk|teamviewer|rustdesk|chrome remote desktop|splashtop|parsec/i, "remote-access/remote-desktop-and-support", 0.97],
  [/7-zip|winrar|peazip|bandizip/i, "general-business/compression-and-file-utilities", 0.97],
  [/\bgit\b|github cli|svn/i, "developer-tools/clis-and-version-control", 0.96],
  [/visual studio code|notepad\+\+|vim|sublime/i, "developer-tools/ides-and-editors", 0.93],
  [/keeper|bitwarden|1password|lastpass/i, "security-and-identity/password-managers", 0.96],
  [/python|typescript|node\.js|java runtime/i, "developer-tools/language-runtimes-and-sdks", 0.9],
  [/tor browser|psiphon/i, "proxy-and-tunnel/anonymizers", 0.98],
];

export function mockClassifier(slugs: string[], options: { failEvery?: number } = {}): Classifier {
  let calls = 0;
  return {
    model: "mock",
    async classify(title) {
      calls++;
      const usage: Usage = { input: 60, output: 20, cacheRead: calls > 1 ? 4000 : 0, cacheWrite: calls > 1 ? 0 : 4000 };
      if (options.failEvery && calls % options.failEvery === 0) throw new ClassifyError("Mock failure (simulated 529 overloaded)", 529, usage);
      const text = `${title.canonical_name} ${title.vendor ?? ""} ${title.description ?? ""}`;
      const rule = RULES.find(([re, slug]) => re.test(text) && slugs.includes(slug));
      return { category: rule?.[1] ?? "other/other", probability: rule?.[2] ?? 0.4, usage, latencyMs: 5 };
    },
  };
}
