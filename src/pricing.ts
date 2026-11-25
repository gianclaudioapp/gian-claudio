import { locale } from "./i18n";

// API list prices in USD per million tokens (Anthropic first-party, cached
// 2026-11-03). Cache writes follow the standard multipliers: 1.25× input for
// the 5-minute cache, 2× for the 1-hour cache. Cache reads use the listed
// price where one is published, otherwise 0.1× input.

interface Price {
  input: number;
  output: number;
  cacheRead?: number;
}

/** Most specific keys first: matched as substrings of the model id. */
const PRICES: [string, Price][] = [
  ["fable-5-2", { input: 8, output: 40, cacheRead: 0.2 }],
  ["mythos-5-2", { input: 8, output: 40, cacheRead: 0.2 }],
  ["fable-5-1", { input: 10, output: 50 }],
  ["mythos-5-1", { input: 10, output: 50 }],
  ["fable-5", { input: 10, output: 50 }],
  ["opus-5-5", { input: 4, output: 20, cacheRead: 0.2 }],
  ["opus-5", { input: 5, output: 25 }],
  ["opus-4-8", { input: 5, output: 25 }],
  ["opus-4-7", { input: 5, output: 25 }],
  ["opus-4-6", { input: 5, output: 25 }],
  ["opus-4-5", { input: 5, output: 25 }],
  ["opus-4", { input: 15, output: 75 }],
  ["sonnet-5-5", { input: 2, output: 10, cacheRead: 0.1 }],
  ["sonnet-5", { input: 2, output: 10 }],
  ["sonnet-4", { input: 3, output: 15 }],
  ["haiku-5-5", { input: 0.1, output: 0.5 }],
  ["haiku-4-5", { input: 1, output: 5 }],
];

export interface Tokens {
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
  requests: number;
}

export interface SessionUsage {
  sessionId: string;
  byModel: Record<string, Tokens>;
  byDay: Record<string, number>;
  first: string | null;
  last: string | null;
}

export function emptyTokens(): Tokens {
  return { input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, requests: 0 };
}

export function addTokens(a: Tokens, b: Tokens): Tokens {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheWrite5m: a.cacheWrite5m + b.cacheWrite5m,
    cacheWrite1h: a.cacheWrite1h + b.cacheWrite1h,
    cacheRead: a.cacheRead + b.cacheRead,
    requests: a.requests + b.requests,
  };
}

export function totalTokens(t: Tokens): number {
  return t.input + t.output + t.cacheWrite5m + t.cacheWrite1h + t.cacheRead;
}

function priceOf(model: string): Price | null {
  return PRICES.find(([k]) => model.includes(k))?.[1] ?? null;
}

/** Cost in USD of one model's tokens at list price; null when the model has no known price. */
export function costOf(model: string, t: Tokens): number | null {
  const p = priceOf(model);
  if (!p) return null;
  const read = p.cacheRead ?? p.input * 0.1;
  return (
    (t.input * p.input + t.output * p.output + t.cacheWrite5m * p.input * 1.25 + t.cacheWrite1h * p.input * 2 + t.cacheRead * read) /
    1_000_000
  );
}

/** Total cost of usage grouped by model, plus models without a known price. */
export function costByModel(byModel: Record<string, Tokens>): { usd: number; unpriced: string[] } {
  let usd = 0;
  const unpriced: string[] = [];
  for (const [m, t] of Object.entries(byModel)) {
    const c = costOf(m, t);
    if (c === null) unpriced.push(m);
    else usd += c;
  }
  return { usd, unpriced };
}

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toLocaleString(locale(), { maximumFractionDigits: 1 })}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000).toLocaleString(locale())}k`;
  return n.toLocaleString(locale());
}

export function fmtUsd(n: number): string {
  return `$${n.toLocaleString(locale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
