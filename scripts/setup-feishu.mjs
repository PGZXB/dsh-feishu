#!/usr/bin/env node
/**
 * Thin launcher for the dsh-feishu quick-setup CLI. The implementation lives
 * in the TypeScript build (lib/setup/cli.js); this launcher only checks that
 * the build exists and forwards argv. Run `pnpm run build` first.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const libCli = fileURLToPath(new URL('../lib/setup/cli.js', import.meta.url));
if (!existsSync(libCli)) {
  process.stderr.write('lib/ is not built. Run `pnpm run build` first, then re-run this command.\n');
  process.exit(1);
}
const { main } = await import(libCli);
await main(process.argv.slice(2));
