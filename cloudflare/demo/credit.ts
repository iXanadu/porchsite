/**
 * The demo bar's credit for a look's maker: " by @handle", linking to their X
 * profile. Credit is an X handle and nothing else (themes/credits.json); a
 * look nobody is credited for, or anything that isn't a handle, shows nothing.
 */
export function creditHtml(x: string | undefined): string {
  if (typeof x !== "string" || !/^[A-Za-z0-9_]{1,15}$/.test(x)) return "";
  return ` by <a style="color:#9fd8c4" href="https://x.com/${x}" rel="noopener noreferrer">@${x}</a>`;
}
