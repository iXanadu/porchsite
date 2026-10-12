/**
 * Where Sitekeeper's shared services live: the theme catalog, the downloads
 * and the request/submission queue. One place, so a move is one line (and
 * scripts/downloads.sh reads the same value).
 */
export const HOME = "https://get.porchsite.dev";

declare const __RELEASE__: string;
/** The release this build is, set when the install bundle is made ("dev" otherwise). */
export const RELEASE = typeof __RELEASE__ === "string" ? __RELEASE__ : "dev";
