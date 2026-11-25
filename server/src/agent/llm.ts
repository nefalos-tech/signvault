import { randomUUID } from 'node:crypto';
import OpenAI from 'openai';
import type { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat/completions';
import type { LlmPort } from '@signvault/shared';

export interface LlmEnv {
  LLM_BASE_URL?: string;
  LLM_API_KEY?: string;
  LLM_MODEL?: string;
}

const VARS = ['LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL'] as const;

/**
 * An LlmPort over any OpenAI-compatible chat endpoint. It reads the three LLM_ variables and never logs them.
 * `fetch` is for tests, so they never reach a real model.
 */
export function createOpenAiLlm(env: LlmEnv = process.env, options: { fetch?: typeof fetch } = {}): LlmPort {
  const missing = VARS.filter((name) => !env[name]);
  if (missing.length > 0) throw new Error(`Set ${missing.join(', ')} to run the agent with a model.`);
  const model = env.LLM_MODEL!;
  const client = new OpenAI({ baseURL: env.LLM_BASE_URL, apiKey: env.LLM_API_KEY, timeout: 60_000, fetch: options.fetch });

  return {
    async next(messages, tools) {
      const completion = await client.chat.completions.create({
        model,
        messages: messages as ChatCompletionMessageParam[],
        tools: tools as ChatCompletionTool[],
      });
      const message = completion.choices[0]?.message;
      const toolCalls = (message?.tool_calls ?? []).flatMap((c) => c.type === 'function'
        ? [{ id: c.id || `call_${randomUUID()}`, name: c.function.name, args: parseArgs(c.function.arguments) }]
        : []);
      return { ...(message?.content && { text: message.content }), toolCalls };
    },
  };
}

/** Models send arguments as a JSON string. Empty means none. Bad JSON goes through raw, so the tool can answer with an error. */
function parseArgs(raw: string | undefined): unknown {
  if (!raw?.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
