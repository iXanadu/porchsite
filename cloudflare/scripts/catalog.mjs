// The theme catalog's entries (themes.json), shared by scripts/downloads.sh,
// scripts/demo-gen.mjs and the tests. Pure: no files read here.
//
// Credit for a look is an X handle and nothing else, kept in themes/credits.json
// (look name -> handle) by the curator. It lives in the catalog entry, never in
// the immutable package, so adding or removing credit is a catalog rebuild,
// not a new version of the look.

/** An X handle, without the @: X's own rule (1 to 15 letters, digits or underscores). */
export const X_HANDLE = /^[A-Za-z0-9_]{1,15}$/;

/** themes/credits.json, checked: an object of look name -> X handle, every look one that exists. */
export function parseCredits(text, names) {
  let credits;
  try {
    credits = JSON.parse(text);
  } catch (e) {
    throw new Error(`themes/credits.json isn't JSON: ${e.message}`);
  }
  if (!credits || typeof credits !== "object" || Array.isArray(credits)) throw new Error("themes/credits.json is an object of look name -> X handle");
  for (const [name, handle] of Object.entries(credits)) {
    if (!names.includes(name)) throw new Error(`themes/credits.json credits ${name}, which isn't a look under themes/`);
    if (typeof handle !== "string" || !X_HANDLE.test(handle)) throw new Error(`themes/credits.json: ${name}'s credit must be an X handle without the @ (1 to 15 letters, digits or underscores)`);
  }
  return credits;
}

/** The manifest as it goes into the package: without author_x (credit is the catalog's, not the package's). */
export function packageManifest(manifest) {
  const { author_x: _claimed, ...rest } = manifest;
  return rest;
}

/** One themes.json entry: the manifest's description, `author: {x}` only when credited, slots, previews, package. */
export function catalogEntry(manifest, credits, previews, pkg) {
  const { slots, ...about } = packageManifest(manifest);
  const x = Object.prototype.hasOwnProperty.call(credits, about.name) ? credits[about.name] : "";
  return { ...about, ...(x ? { author: { x } } : {}), slots, previews, package: pkg };
}
