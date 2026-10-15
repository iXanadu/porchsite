/** Local/test observation only: no image bytes, identities or public fields. */
export type UploadPhase = "json" | "preflight" | "decode" | "sniff" | "hash" | "hex" | "d1";
let observer: ((phase: UploadPhase, event: "start" | "end", at: number) => void) | undefined;
export function observeUploadPhases(value?: typeof observer): void { observer = value; }
export function reportUploadPhase(phase: UploadPhase, event: "start" | "end"): void {
  observer?.(phase, event, performance.now());
}
