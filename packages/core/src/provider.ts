import { z } from "zod";

/**
 * Thin provider adapters — plain `fetch`, no agent framework.
 *
 * The engine needs exactly one thing from a model: given a prompt, return
 * text. Everything above that (retries, schema validation, the skeptical
 * default) belongs to us, not to a framework, because those are the parts
 * that carry the product's guarantees.
 */

export interface CompletionRequest {
  system: string;
  user: string;
  maxTokens?: number;
}

export interface CompletionResult {
  text: string;
  /** Logged to instrumentation; null when a provider does not report usage. */
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface ModelProvider {
  readonly name: string;
  readonly model: string;
  complete(request: CompletionRequest): Promise<CompletionResult>;
}

export class ProviderError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "ProviderError";
    this.status = status;
  }
}

const anthropicResponse = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
  usage: z
    .object({ input_tokens: z.number(), output_tokens: z.number() })
    .optional(),
});

export interface AnthropicOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export class AnthropicProvider implements ModelProvider {
  readonly name = "anthropic";
  readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: AnthropicOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model ?? "claude-sonnet-5";
    this.baseUrl = options.baseUrl ?? "https://api.anthropic.com";
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const response = await this.fetchImpl(`${this.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: request.maxTokens ?? 512,
        system: request.system,
        messages: [{ role: "user", content: request.user }],
      }),
    });

    if (!response.ok) {
      throw new ProviderError(
        `anthropic returned ${response.status}: ${await response.text()}`,
        response.status
      );
    }

    const parsed = anthropicResponse.safeParse(await response.json());
    if (!parsed.success) {
      throw new ProviderError(
        "anthropic returned an unrecognized response shape"
      );
    }

    return {
      text: parsed.data.content
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join(""),
      inputTokens: parsed.data.usage?.input_tokens ?? null,
      outputTokens: parsed.data.usage?.output_tokens ?? null,
    };
  }
}

const openAiResponse = z.object({
  choices: z.array(
    z.object({ message: z.object({ content: z.string().nullable() }) })
  ),
  usage: z
    .object({ prompt_tokens: z.number(), completion_tokens: z.number() })
    .optional(),
});

export interface OpenAiOptions {
  apiKey: string;
  model?: string;
  /** Any OpenAI-compatible endpoint: Ollama, vLLM, OpenRouter, Azure. */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export class OpenAiCompatibleProvider implements ModelProvider {
  readonly name = "openai-compatible";
  readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenAiOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model ?? "gpt-4o-mini";
    this.baseUrl = options.baseUrl ?? "https://api.openai.com/v1";
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: request.maxTokens ?? 512,
        messages: [
          { role: "system", content: request.system },
          { role: "user", content: request.user },
        ],
      }),
    });

    if (!response.ok) {
      throw new ProviderError(
        `openai-compatible returned ${
          response.status
        }: ${await response.text()}`,
        response.status
      );
    }

    const parsed = openAiResponse.safeParse(await response.json());
    if (!parsed.success) {
      throw new ProviderError(
        "openai-compatible returned an unrecognized shape"
      );
    }

    return {
      text: parsed.data.choices[0]?.message.content ?? "",
      inputTokens: parsed.data.usage?.prompt_tokens ?? null,
      outputTokens: parsed.data.usage?.completion_tokens ?? null,
    };
  }
}
