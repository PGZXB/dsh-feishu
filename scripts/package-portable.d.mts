/** Type declarations for the portable-deployment packager (`package-portable.mjs`). */

export interface PackResult {
  readonly dir: string;
  readonly tarPath?: string;
  readonly packageName: string;
  readonly nodeVersion: string;
  readonly sourceSha: string;
}

export function resolveNodeVersion(major?: string): Promise<string>;
export function provideNode(dest: string, version: string): Promise<string>;
export function buildBundle(bundleDir: string): Promise<void>;
export function installDshAnchor(
  anchorDir: string,
  nodeBin: string,
  dshVersion: string,
  bundleDir: string,
  opts?: { readonly cache?: string },
): Promise<string>;
export function installBundleRuntimeDeps(
  bundleDir: string,
  nodeBin: string,
  opts?: { readonly cache?: string },
): Promise<void>;
export function writeTemplateHome(
  homeDir: string,
  bundleDir: string,
  anchorDir: string,
): Promise<void>;
export function bootstrapFiles(): Record<string, string>;
export function buildPortablePackage(opts?: {
  readonly outDir?: string;
  readonly nodeMajor?: string;
  readonly nodeVersion?: string;
  readonly dshVersion?: string;
  readonly packageName?: string;
  readonly skipTarball?: boolean;
}): Promise<PackResult>;
export function main(argv?: readonly string[]): Promise<void>;
