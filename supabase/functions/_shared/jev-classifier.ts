// Jev classifiers behind one interface: Claude (Messages API, structured output, cached system prompt)
// and a deterministic mock for local runs without a key. Runtime-neutral: the Claude client is passed
// in, so Vitest can drive it with a fake.

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
