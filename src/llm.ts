// Model access. Three ways in:
// - company: Trip.com's Coding Plan gateway, signed in on this Mac with `ada cc`. Same Messages API as Anthropic,
//            Claude models named kr-claude-…; no working web search.
// - gemini:  Google's Gemini API with GEMINI_API_KEY (free tier). Google blocks it from mainland China, so it runs on
//            GitHub's servers. No web search: Google Search is not free on current Gemini models.
// - api:     the Anthropic Messages API with ANTHROPIC_API_KEY.
// - manual:  no key and no spend. Each question is saved to .cache/llm/requests/<key>.json and the run stops;
//           once someone writes the answer to .cache/llm/answers/<key>.json, the next run picks it up.
//           Web search is not available in this mode.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CallUsage } from './types.ts';

export interface ContentBlock {
  type: string;
  text?: string;
  [k: string]: unknown;
}

export interface Message {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
}

export interface MessagesRequest {
  model: string;
  system: string;
  messages: Message[];
  maxTokens: number;
  tools?: unknown[];
}

export interface MessagesResponse {
  content: ContentBlock[];
  stopReason: string;
  usage: { input_tokens: number; output_tokens: number; web_searches: number; credits?: number };
}

export interface Llm {
  readonly mode: 'api' | 'company' | 'gemini' | 'manual';
  messages(req: MessagesRequest): Promise<MessagesResponse>;
  readonly canSearch: boolean;
}

export class LlmUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlmUnavailableError';
  }
}

export class AnswerPendingError extends Error {
  readonly requestPath: string;
  constructor(message: string, requestPath: string) {
    super(message);
    this.name = 'AnswerPendingError';
    this.requestPath = requestPath;
  }
}

type Sleep = (ms: number) => Promise<void>;
const realSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

interface MessagesClient {
  mode: 'api' | 'company';
  baseUrl: string;
  headers: Record<string, string>;
  canSearch: boolean;
  name: string;
  /** What to tell the reader when the login is rejected. */
  onRejected: string;
}

export function apiLlm(apiKey: string, fetchImpl: typeof fetch = fetch, sleep: Sleep = realSleep, baseUrl = 'https://api.anthropic.com'): Llm {
  return messagesLlm(
    { mode: 'api', baseUrl, headers: { 'x-api-key': apiKey }, canSearch: true, name: 'Anthropic API', onRejected: 'Check ANTHROPIC_API_KEY.' },
    fetchImpl,
    sleep,
  );
}

/** The company login `ada cc` saved on this Mac: the gateway address and token Claude Code is set up with. */
export function companyLogin(home = homedir()): { baseUrl: string; token: string } | null {
  const read = (p: string) => {
    try {
      return JSON.parse(readFileSync(p, 'utf8'));
    } catch {
      return null;
    }
  };
  const env = read(join(home, '.claude', 'settings.json'))?.env ?? {};
  const token = process.env.RADAR_COMPANY_TOKEN || env.ANTHROPIC_AUTH_TOKEN || read(join(home, '.ada-cli', 'config.json'))?.apiToken;
  const baseUrl = process.env.RADAR_COMPANY_URL || env.ANTHROPIC_BASE_URL;
  return token && baseUrl ? { baseUrl: String(baseUrl).replace(/\/+$/, ''), token: String(token) } : null;
}

export function companyLlm(login: { baseUrl: string; token: string }, fetchImpl: typeof fetch = fetch, sleep: Sleep = realSleep): Llm {
  const messages = messagesLlm(
    {
      mode: 'company',
      baseUrl: login.baseUrl,
      headers: { authorization: `Bearer ${login.token}` },
      // The gateway answers web-search requests with a Google results link, not articles, so search stays off.
      canSearch: false,
      name: 'Company Coding Plan',
      onRejected: 'The company login has expired. Run `ada refresh` in Terminal and log in again.',
    },
    fetchImpl,
    sleep,
  );
  const responses = companyResponsesLlm(login, fetchImpl, sleep);
  return {
    mode: 'company',
    canSearch: false,
    // GPT-6.1 Sol rejects the Anthropic Messages protocol; route it through the gateway's OpenAI Responses API.
    messages: (req) => /gpt-6\.1-sol/i.test(req.model) ? responses.messages(req) : messages.messages(req),
  };
}


/** Company GPT models that accept only OpenAI's Responses protocol. The rest of Pixel Post still sees the small
    internal `Llm` interface used by every provider. */
function companyResponsesLlm(login: { baseUrl: string; token: string }, fetchImpl: typeof fetch, sleep: Sleep): Llm {
  const inputOf = (message: Message) => ({
    role: message.role,
    content: typeof message.content === 'string'
      ? [{ type: 'input_text', text: message.content }]
      : message.content.flatMap((block) => {
          if (block.type === 'text' && typeof block.text === 'string') return [{ type: 'input_text', text: block.text }];
          if (block.type === 'image') {
            const source = block.source as { type?: string; media_type?: string; data?: string } | undefined;
            if (source?.type === 'base64' && source.media_type && source.data) return [{ type: 'input_image', image_url: `data:${source.media_type};base64,${source.data}` }];
          }
          return [];
        }),
  });
  return {
    mode: 'company',
    canSearch: false,
    async messages(req) {
      if (req.tools?.length) throw new LlmUnavailableError('web search is not set up for Company GPT models');
      for (let attempt = 0; ; attempt++) {
        let res: Response;
        try {
          res = await fetchImpl(`${login.baseUrl}/v1/responses`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${login.token}` },
            body: JSON.stringify({
              model: req.model.replace(/^claude-/, '').replace(/\[1M\]$/, ''),
              instructions: req.system,
              input: req.messages.map(inputOf),
              max_output_tokens: req.maxTokens,
            }),
            signal: AbortSignal.timeout(300_000),
          });
        } catch (err) {
          if (attempt < 3) { await sleep(3000 * 2 ** attempt); continue; }
          throw new Error(`Company Coding Plan unreachable: ${(err as Error).message} (is the laptop on the company network or VPN?)`);
        }
        if ((res.status === 429 || res.status >= 500) && attempt < 3) { await sleep(3000 * 2 ** attempt); continue; }
        const text = await res.text();
        if (res.status === 401 || res.status === 403) throw new LlmUnavailableError(`Company Coding Plan rejected the login (HTTP ${res.status}). The company login has expired. Run \`ada refresh\` and \`ada config claude\` in Terminal.`);
        if (!res.ok) throw new Error(`Company Coding Plan returned HTTP ${res.status}: ${text.slice(0, 400)}`);
        const data = JSON.parse(text) as {
          status?: string;
          output_text?: string;
          output?: { type?: string; content?: { type?: string; text?: string }[] }[];
          usage?: { input_tokens?: number; output_tokens?: number };
          usage_info?: { input_tokens?: number; output_tokens?: number; credit_usage?: number };
          credit_usage?: number;
        };
        const out = data.output_text ?? (data.output ?? []).flatMap((o) => o.content ?? []).filter((c) => c.type === 'output_text').map((c) => c.text ?? '').join('');
        if (!out) throw new Error(`Company Coding Plan returned no text (${data.status ?? 'no status'})`);
        const usage = data.usage ?? data.usage_info ?? {};
        const credits = data.credit_usage ?? data.usage_info?.credit_usage;
        return {
          content: [{ type: 'text', text: out }],
          stopReason: data.status === 'incomplete' ? 'max_tokens' : 'end_turn',
          usage: { input_tokens: usage.input_tokens ?? 0, output_tokens: usage.output_tokens ?? 0, web_searches: 0, ...(typeof credits === 'number' ? { credits } : {}) },
        };
      }
    },
  };
}

function messagesLlm(c: MessagesClient, fetchImpl: typeof fetch, sleep: Sleep): Llm {
  return {
    mode: c.mode,
    canSearch: c.canSearch,
    async messages(req) {
      for (let attempt = 0; ; attempt++) {
        let res: Response;
        try {
          res = await fetchImpl(`${c.baseUrl}/v1/messages`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', ...c.headers },
            body: JSON.stringify({
              model: req.model,
              max_tokens: req.maxTokens,
              system: req.system,
              messages: req.messages,
              ...(req.tools ? { tools: req.tools } : {}),
            }),
            signal: AbortSignal.timeout(300_000),
          });
        } catch (err) {
          if (attempt < 3) {
            await sleep(3000 * 2 ** attempt);
            continue;
          }
          throw new Error(`${c.name} unreachable: ${(err as Error).message}${c.mode === 'company' ? ' (is the laptop on the company network or VPN?)' : ''}`);
        }
        if ((res.status === 429 || res.status === 529 || res.status >= 500) && attempt < 3) {
          await sleep(3000 * 2 ** attempt);
          continue;
        }
        if (res.status === 401 || res.status === 403) {
          const detail = (await res.text()).slice(0, 400);
          // A 403 can mean a valid login but a model that the plan no longer offers. Keep that distinction visible:
          // Ada changed the available model list on 7 Nov 2026, while the old message said the login had expired.
          if (/model is not enabled or allowed/i.test(detail)) {
            throw new LlmUnavailableError(`${c.name} does not allow model ${req.model}. Choose one returned by the gateway's /v1/models endpoint.`);
          }
          throw new LlmUnavailableError(`${c.name} rejected the login (HTTP ${res.status}). ${c.onRejected}`);
        }
        if (!res.ok) throw new Error(`${c.name} returned HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`);
        const data = (await res.json()) as {
          content?: ContentBlock[];
          stop_reason?: string;
          usage?: { input_tokens?: number; output_tokens?: number; credit_usage?: number; server_tool_use?: { web_search_requests?: number } };
        };
        return {
          content: data.content ?? [],
          stopReason: data.stop_reason ?? 'end_turn',
          usage: {
            input_tokens: data.usage?.input_tokens ?? 0,
            output_tokens: data.usage?.output_tokens ?? 0,
            web_searches: data.usage?.server_tool_use?.web_search_requests ?? 0,
            ...(typeof data.usage?.credit_usage === 'number' ? { credits: data.usage.credit_usage } : {}),
          },
        };
      }
    },
  };
}

export function geminiLlm(apiKey: string, fetchImpl: typeof fetch = fetch, sleep: Sleep = realSleep, baseUrl = 'https://generativelanguage.googleapis.com/v1beta'): Llm {
  return {
    mode: 'gemini',
    canSearch: false,
    async messages(req) {
      if (req.tools?.length) throw new LlmUnavailableError('web search is not set up for Gemini');
      const body = JSON.stringify({
        systemInstruction: { parts: [{ text: req.system }] },
        contents: req.messages.map((m) => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: typeof m.content === 'string' ? m.content : textOf(m.content) }],
        })),
        // Thinking tokens count against the output limit, so leave plenty of room.
        generationConfig: { responseMimeType: 'application/json', maxOutputTokens: Math.max(req.maxTokens, 16_000) },
      });
      for (let attempt = 0; ; attempt++) {
        let res: Response;
        try {
          res = await fetchImpl(`${baseUrl}/models/${encodeURIComponent(req.model)}:generateContent`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
            body,
            signal: AbortSignal.timeout(300_000),
          });
        } catch (err) {
          if (attempt < 3) {
            await sleep(3000 * 2 ** attempt);
            continue;
          }
          throw new Error(`Gemini API unreachable: ${(err as Error).message}`);
        }
        // The free tier allows only a few requests a minute; wait and retry.
        if ((res.status === 429 || res.status >= 500) && attempt < 4) {
          await sleep(10_000 * 2 ** attempt);
          continue;
        }
        const text = await res.text();
        if (!res.ok) {
          let msg = text.slice(0, 300);
          try {
            msg = JSON.parse(text).error?.message ?? msg;
          } catch {}
          if (/location is not supported/i.test(msg)) throw new LlmUnavailableError(`Google does not allow Gemini API calls from here (${msg}). Run it on GitHub instead.`);
          if (res.status === 401 || res.status === 403 || /api key/i.test(msg)) throw new LlmUnavailableError(`Gemini rejected the key (HTTP ${res.status}): ${msg} Check GEMINI_API_KEY.`);
          throw new Error(`Gemini API returned HTTP ${res.status}: ${msg}`);
        }
        const data = JSON.parse(text) as {
          candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[];
          promptFeedback?: { blockReason?: string };
          usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
        };
        const c = data.candidates?.[0];
        const out = (c?.content?.parts ?? []).filter((p) => !p.thought).map((p) => p.text ?? '').join('');
        if (!out) throw new Error(`Gemini returned no text (${c?.finishReason ?? data.promptFeedback?.blockReason ?? 'no reason given'})`);
        const u = data.usageMetadata ?? {};
        return {
          content: [{ type: 'text', text: out }],
          stopReason: c?.finishReason === 'MAX_TOKENS' ? 'max_tokens' : 'end_turn',
          usage: { input_tokens: u.promptTokenCount ?? 0, output_tokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0), web_searches: 0 },
        };
      }
    },
  };
}

export function manualLlm(dir: string): Llm {
  return {
    mode: 'manual',
    canSearch: false,
    async messages(req) {
      if (req.tools?.length) throw new LlmUnavailableError('web search needs the API; manual mode skips it');
      const user = req.messages.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n\n');
      const key = createHash('sha256').update(`${req.system}\n\n${user}`).digest('hex').slice(0, 16);
      const answer = join(dir, 'answers', `${key}.json`);
      if (existsSync(answer)) {
        return { content: [{ type: 'text', text: readFileSync(answer, 'utf8') }], stopReason: 'end_turn', usage: { input_tokens: 0, output_tokens: 0, web_searches: 0 } };
      }
      mkdirSync(join(dir, 'requests'), { recursive: true });
      mkdirSync(join(dir, 'answers'), { recursive: true });
      const requestPath = join(dir, 'requests', `${key}.json`);
      writeFileSync(requestPath, JSON.stringify({ key, answer_to: answer, system: req.system, user }, null, 2));
      throw new AnswerPendingError(`waiting for an answer to ${key}`, requestPath);
    },
  };
}

export const textOf = (blocks: ContentBlock[]): string =>
  blocks
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('');

export function usageOf(step: string, model: string, r: MessagesResponse): CallUsage {
  return { step, model, ...r.usage };
}
