import OpenAI from 'openai';
import { INSTRUCTIONS, LIMITS, WORDING_SCHEMA } from './policy.js';
import type { CopyContext } from './policy.js';

export type GenerationState = 'suggested' | 'unavailable' | 'timeout' | 'refused' | 'incomplete' | 'invalid' | 'error' | 'stale';
export interface ProviderResult { state: 'suggested' | 'refused' | 'incomplete'; value?: unknown }
export type CopyProvider = (context: CopyContext, signal: AbortSignal) => Promise<ProviderResult>;
export interface CopyConfig { enabled: boolean; model: string; provider: 'openai' | 'test_fixture'; generate?: CopyProvider }
export function copyConfig(env: Readonly<Record<string, string | undefined>> = process.env, sdkFetch?: typeof fetch): CopyConfig {
  const model = /^[a-zA-Z0-9._-]{1,80}$/.test(env.OPENAI_COPY_MODEL ?? '') ? env.OPENAI_COPY_MODEL! : 'gpt-6-luna';
  // Fixtures require an explicit server flag AND an isolated browser-test database. Never a silent live fallback.
  if (env.COPY_DRAFT_PROVIDER === 'test_fixture' && env.COPY_DRAFT_TEST_FIXTURE === '1' && /[\\/]\.tmp[\\/]browser-/.test(env.RECOVERY_DB_PATH ?? '')) {
    return { enabled: true, model: 'test-fixture-no-model', provider: 'test_fixture', generate: async context => ({ state: 'suggested',
      value: { subject: context.channel === 'email' ? 'Your Seawolves ticket basket' : null, introduction: 'Take a moment to review your ticket basket whenever you like.' } }) };
  }
  if (env.COPY_DRAFT_ENABLED !== 'true' || !env.OPENAI_API_KEY?.trim() || env.OPENAI_API_KEY.includes('YOUR_')) return { enabled: false, model, provider: 'openai' };
  return { enabled: true, model, provider: 'openai', generate: async (context, signal) => {
    const client = new OpenAI({ apiKey: env.OPENAI_API_KEY, baseURL: 'https://api.openai.com/v1', maxRetries: 0, timeout: LIMITS.timeoutMs, logLevel: 'off', ...(sdkFetch ? { fetch: sdkFetch } : {}) });
    const response = await client.responses.create({ model, store: false, instructions: INSTRUCTIONS,
      input: [{ role: 'user', content: JSON.stringify(context) }], max_output_tokens: LIMITS.outputTokens,
      reasoning: { effort: 'none' }, text: { format: { type: 'json_schema', name: 'ticket_wording', strict: true, schema: WORDING_SCHEMA } } }, { signal });
    if (response.output.some(item => item.type === 'message' && item.content.some(part => part.type === 'refusal'))) return { state: 'refused' };
    if (response.status !== 'completed') return { state: 'incomplete' };
    if (Buffer.byteLength(response.output_text, 'utf8') > LIMITS.responseBytes) throw new Error('Oversize output');
    try { return { state: 'suggested', value: JSON.parse(response.output_text) as unknown }; }
    catch { return { state: 'suggested', value: null }; }
  } };
}
