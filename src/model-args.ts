/**
 * /model argument parsing (`<provider>/<model>`).
 *
 * @module @dsh-feishu/dsh-feishu/model-args
 */

import type { ModelSelectionView } from './bridge.js';

/**
 * Parse a `/model` argument into a provider/model selection.
 * @param raw - the raw argument (e.g. `deepseek-official/deepseek-r1`).
 * @returns the selection, or a usage error.
 */
export function parseModelArg(
  raw: string,
): { ok: true; selection: ModelSelectionView } | { ok: false; error: string } {
  const trimmed = raw.trim();
  const slash = trimmed.split('/');
  const parts = slash.length === 2 ? slash : trimmed.split(/\s+/);
  const provider = parts[0]?.trim();
  const model = parts[1]?.trim();
  if (provider === undefined || provider === '' || model === undefined || model === '') {
    return {
      ok: false,
      error: 'usage: /model <provider>/<model> (e.g. /model deepseek-official/deepseek-v4-flash)',
    };
  }
  return { ok: true, selection: { provider, model } };
}
