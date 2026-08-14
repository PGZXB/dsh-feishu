/**
 * DSH web tool-row summary derivation (port of the harness's
 * `tool-call-model.ts`): classify a tool call by name into a display
 * variant, pick a one-line summary from its arguments, and label it with
 * the DSH web row title. The card renders one line per tool call —
 * `Title · summary` — exactly like the web's ToolRow collapsed chrome.
 *
 * @module @dsh-feishu/dsh-feishu/cards/tool-summary
 */

/** Tool-call row variants (DSH web `ToolRowVariant`). */
export type ToolRowVariant = 'search' | 'read' | 'bash' | 'write' | 'edit' | 'code' | 'others';

/** DSH web figma row titles per variant. */
const VARIANT_TITLES: Record<ToolRowVariant, string> = {
  search: 'Search',
  read: 'Read',
  bash: 'Bash',
  write: 'Write',
  edit: 'Edit',
  code: 'Code',
  others: 'Tool call',
};

/** Known tool name → variant (DSH web `TOOL_VARIANTS`). */
const TOOL_VARIANTS: Record<string, ToolRowVariant> = {
  bash: 'bash',
  pwsh: 'bash',
  read: 'read',
  web_fetch: 'read',
  web_search: 'search',
  grep: 'search',
  glob: 'search',
  write: 'write',
  edit: 'edit',
  run_code: 'code',
  cordis_package_inspect: 'read',
  cordis_runtime_inspect: 'read',
  cordis_run: 'others',
  cordis_stop: 'others',
  cordis_undefine: 'others',
};

/** Tool-owned titles that refine a variant without replacing it (DSH web). */
const TOOL_TITLES: Record<string, string> = {
  cordis_package_inspect: 'Inspect',
  cordis_runtime_inspect: 'Inspect',
  cordis_run: 'Run Cordis Plugin',
  cordis_stop: 'Stop Cordis Plugin',
  cordis_undefine: 'Remove Cordis Plugin',
  pwsh: 'Pwsh',
};

/** Summary key preference per variant, from the call's args (DSH web). */
const SUMMARY_KEYS: Record<ToolRowVariant, readonly string[]> = {
  bash: ['description', 'command'],
  read: ['path', 'file_path', 'url'],
  search: ['query', 'pattern', 'url'],
  write: ['path', 'file_path'],
  edit: ['path', 'file_path'],
  code: ['description'],
  others: [],
};

/**
 * Classify a tool name into its row variant.
 * @param toolName - wire tool name.
 * @returns matching variant, `others` when unknown.
 */
export function classifyTool(toolName: string): ToolRowVariant {
  return TOOL_VARIANTS[toolName] ?? 'others';
}

/** The DSH web row title for a tool call (`Tool call` for unclassified). */
export function toolRowTitle(toolName: string): string {
  return TOOL_TITLES[toolName] ?? VARIANT_TITLES[classifyTool(toolName)];
}

function firstLine(text: string): string {
  const nl = text.indexOf('\n');
  return nl === -1 ? text : text.slice(0, nl);
}

function parseArgs(argsRaw: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(argsRaw) as unknown;
    if (typeof parsed === 'object' && parsed !== null) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Non-JSON args (mid-stream truncation): summary falls back to the raw string.
  }
  return undefined;
}

function pickString(args: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return undefined;
}

/** Strip a workspace-root prefix for display (paths shown relative to cwd). */
export function relativizeToCwd(text: string, cwd: string | undefined): string {
  if (cwd === undefined || cwd === '') return text;
  const root = cwd.replace(/[/\\]+$/, '');
  if (text.startsWith(`${root}/`) || text.startsWith(`${root}\\`))
    return text.slice(root.length + 1);
  return text;
}

/**
 * Derive the one-line collapsed summary for a tool call, DSH web style:
 * the variant's preferred arg (bash → description/command, read → path/url,
 * search → query/pattern, write/edit → path, code → description), first
 * string arg otherwise, or the raw args as a last resort. Classified
 * `others` calls show `name · <base>` (the tool name rides the summary
 * slot, matching the web's generic row).
 * @param toolName - wire tool name.
 * @param argsRaw - raw JSON arguments string (may be truncated).
 * @param cwd - workspace root; workspace-rooted paths display relative to it.
 * @returns the one-line summary.
 */
export function toolRowSummary(toolName: string, argsRaw: string, cwd?: string): string {
  const variant = classifyTool(toolName);
  const parsed = parseArgs(argsRaw);
  let base: string;
  if (parsed === undefined) {
    base = firstLine(argsRaw);
  } else {
    const picked = pickString(parsed, SUMMARY_KEYS[variant]);
    if (picked !== undefined) {
      base = firstLine(picked);
    } else {
      const firstString = Object.values(parsed).find(
        (value) => typeof value === 'string' && value !== '',
      );
      base = typeof firstString === 'string' ? firstLine(firstString) : firstLine(argsRaw);
    }
  }
  const rel = relativizeToCwd(base, cwd);
  if (variant === 'others' && toolName !== '') {
    const title = TOOL_TITLES[toolName];
    return title === undefined ? `${toolName} · ${rel}` : rel;
  }
  return rel;
}
