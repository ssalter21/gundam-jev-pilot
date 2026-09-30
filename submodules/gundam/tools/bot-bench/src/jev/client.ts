/**
 * Minimal Jev (TypeSafe System One) client over plain fetch.
 *
 * Wire format matches @typesafe-ai/sdk 0.6.0:
 *   POST https://api.typesafe.ai/v1/systemone
 *   Authorization: Bearer $TYPESAFE_API_KEY
 *   { model, state, questions: { name: { type: "choice", instructions, criteria } } }
 */

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface ChoiceQuestion {
  readonly type: "choice";
  readonly instructions: string;
  /** label → description */
  readonly criteria: Record<string, string>;
}

export interface JevRequest {
  readonly state: JsonValue;
  readonly questions: Record<string, ChoiceQuestion>;
}

export interface ChoiceAnswer {
  readonly type: "choice";
  readonly choice: string;
  readonly confidence: number;
  readonly probabilities: Record<string, number>;
}

export interface JevResponse {
  readonly model: string;
  readonly answers: Record<string, ChoiceAnswer>;
  readonly usage?: { input_tokens: number; output_tokens: number };
}

export interface JevClient {
  readonly name: string;
  systemOne(request: JevRequest): Promise<JevResponse>;
}

export class HttpJevClient implements JevClient {
  readonly name: string;
  constructor(
    private readonly apiKey: string,
    private readonly model = "jev-latest",
    private readonly baseUrl = "https://api.typesafe.ai",
    private readonly timeoutMs = 15_000,
  ) {
    this.name = `jev(${model})`;
  }

  async systemOne(request: JevRequest): Promise<JevResponse> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(`${this.baseUrl}/v1/systemone`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ model: this.model, ...request }),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (res.ok) return (await res.json()) as JevResponse;
        const body = await res.text();
        lastError = new Error(`Jev HTTP ${res.status}: ${body.slice(0, 300)}`);
        if (res.status !== 429 && res.status < 500) break; // not retryable
      } catch (err) {
        lastError = err;
      }
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
    throw lastError;
  }
}

/**
 * Offline stand-in for testing the plumbing without an API key.
 *
 * It does NOT understand the game. Given an `oracle` ranking (label order),
 * it answers with probabilities that follow that order, so a mock-driven
 * pilot should play exactly like whatever produced the oracle. Plan
 * questions get the first plan.
 */
export class MockJevClient implements JevClient {
  readonly name = "mock";
  oracle: Record<string, readonly string[]> = {};

  async systemOne(request: JevRequest): Promise<JevResponse> {
    const answers: Record<string, ChoiceAnswer> = {};
    for (const [qName, q] of Object.entries(request.questions)) {
      const labels = Object.keys(q.criteria);
      const order = this.oracle[qName]?.filter((l) => labels.includes(l)) ?? [];
      const ranked = [...order, ...labels.filter((l) => !order.includes(l))];
      const weights = ranked.map((_, i) => 1 / 2 ** i);
      const total = weights.reduce((a, b) => a + b, 0);
      const probabilities = Object.fromEntries(ranked.map((l, i) => [l, weights[i]! / total]));
      answers[qName] = {
        type: "choice",
        choice: ranked[0]!,
        confidence: probabilities[ranked[0]!]!,
        probabilities,
      };
    }
    return { model: "mock", answers };
  }
}
