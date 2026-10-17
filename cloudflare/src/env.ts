import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export interface Env {
  DB: D1Database;
  /** Canonical site origin for prepared public copies; absent keeps live rendering. */
  SITE_URL?: string;
  /** Explicit opt-in; hosted CPU validation is required before default enablement. */
  PUBLIC_ARTIFACTS?: string;
  OAUTH_KV: KVNamespace;
  /** Injected by OAuthProvider into the default handler. */
  OAUTH_PROVIDER: OAuthHelpers;
  /** One-time code that lets the owner claim a fresh site. */
  SETUP_CODE?: string;
}

/** What a granted assistant token carries (set at /authorize). */
export interface AssistantProps {
  client: string;
  clientId: string;
}
