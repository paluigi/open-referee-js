export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
}

export interface LLMResponse {
  content: string;
  usage: Usage;
  model: string;
}

/** Fully resolved model reference for a single call. */
export interface ModelSpec {
  provider: string;
  model: string;
  temperature: number;
  maxTokens: number;
  /**
   * Per-call output-budget override (Python ModelSpec.call_max_tokens): set
   * by call sites (two-phase stage 7d), not by role config.
   */
  callMaxTokens?: number;
  /**
   * Reasoning-effort hint where the provider supports it (Python
   * ModelSpec.reasoning_effort). Adapters forward it verbatim when set.
   */
  reasoningEffort?: string;
}

export class LLMError extends Error {
  /** HTTP status when the error came from a response, for programmatic branching. */
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'LLMError';
    this.status = status;
  }
}

/** Optional capability flag: does this endpoint host reasoning models whose
 * thinking can exhaust the output budget before any JSON is emitted? Python
 * keys the two-phase escalation on the exhaustion signature itself (empty
 * content), so the flag only gates whether the escalation ladder is worth
 * trying — default false keeps every existing provider/stub on the single-call
 * path (e2e queues stay stable). */
export interface ReasoningCapable {
  /** Default false everywhere (provider-neutral; Python: provider attribute). */
  readonly supportsReasoning?: boolean;
}

/** Uniform chat interface implemented by every provider. */
export interface ChatProvider extends ReasoningCapable {
  complete(messages: ChatMessage[], spec: ModelSpec): Promise<LLMResponse>;
  close(): void;
}
