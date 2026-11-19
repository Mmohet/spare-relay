import { execFile } from 'node:child_process';

/** OpenCode Go: DeepSeek, Kimi and GLM answer the OpenAI chat-completions format here. */
export const opencodeBase = 'https://opencode.ai/inference/go/openai/v1';

export class ModelError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function security(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 3000 }, (error, stdout) => (error ? reject(error) : resolve(String(stdout))));
  });
}

/** The OpenCode key: the keychain item relay-opencode first, PANEL_OPENCODE_KEY second, else null. Never logged. */
export async function readKey({ env = process.env, run = security } = {}) {
  try {
    const key = (await run('/usr/bin/security', ['find-generic-password', '-s', 'relay-opencode', '-a', 'opencode', '-w'])).trim();
    if (key) return key;
  } catch { /* No keychain item: try the environment. */ }
  const fallback = String(env.PANEL_OPENCODE_KEY ?? '').trim();
  return fallback || null;
}

/**
 * A chat-completions client. Errors carry the HTTP status, never the key or the response body.
 * OpenCode Go asks every client to name itself in user-agent and to send one stable id per
 * conversation in x-opencode-session (routing and prompt caching). `effort` is the model's
 * reasoning_effort; deepseek-v4.1-flash takes low, high or max.
 */
export function openCode({ key, model, effort = null, session = null, baseUrl = opencodeBase, fetch = globalThis.fetch, timeout = 120000 }) {
  const headers = {
    authorization: 'Bearer ' + key, 'content-type': 'application/json', 'user-agent': 'relay-zongguan/1.0',
    ...(session ? { 'x-opencode-session': session } : {}),
  };
  return {
    model,
    async complete({ messages, tools = [] }) {
      const request = { model, messages, ...(effort ? { reasoning_effort: effort } : {}), ...(tools.length ? { tools, tool_choice: 'auto' } : {}) };
      let response;
      try {
        response = await fetch(baseUrl + '/chat/completions', {
          method: 'POST',
          headers,
          body: JSON.stringify(request),
          signal: AbortSignal.timeout(timeout),
        });
      } catch (error) {
        throw new ModelError(0, 'OpenCode did not answer (' + (error.name || 'network') + ')');
      }
      if (!response.ok) throw new ModelError(response.status, 'OpenCode answered ' + response.status);
      let data;
      try { data = await response.json(); } catch { throw new ModelError(response.status, 'OpenCode answered without JSON'); }
      const message = data?.choices?.[0]?.message;
      if (!message) throw new ModelError(response.status, 'OpenCode answered without a message');
      return { message, promptTokens: Number(data.usage?.prompt_tokens ?? 0) };
    },
  };
}
