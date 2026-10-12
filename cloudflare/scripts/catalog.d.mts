// Types for scripts/catalog.mjs (used by the tests).
export const X_HANDLE: RegExp;
export function parseCredits(text: string, names: string[]): Record<string, string>;
export function packageManifest(manifest: Record<string, any>): Record<string, any>;
export function catalogEntry(manifest: Record<string, any>, credits: Record<string, string>, previews: unknown[], pkg: unknown): Record<string, any>;
