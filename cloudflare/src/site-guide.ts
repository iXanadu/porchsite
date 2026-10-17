/** Stateless opt-in guide reuse; dynamic state is always read by the tool. */
import contract from "../../server/server/app/site-state-guide.json";
import { validate } from "./content";
import { fieldGuide, KIND_GUIDE } from "./models";
export const STATES = {
  live: "published, and the current version is what visitors see",
  changed: "published, with a newer version that isn't approved yet",
  new: "never published",
  "removal staged": "published, and removed here; the removal waits for approval",
  removed: "removed and not published",
};
export const GUIDE_REVISION = contract.revision;
export const GUIDE_KEYS = ["states", "kinds", "fields", "site_defaults"] as const;
export function fixedGuide() {
  return { states: STATES, kinds: KIND_GUIDE, fields: fieldGuide(), site_defaults: validate("site", {}) };
}
export function withGuide<T extends Record<string, unknown>>(state:T, request?:{known_revision?:string}):Record<string,unknown> {
  if (request === undefined) return state;
  const included = request.known_revision !== GUIDE_REVISION;
  const answer:Record<string,unknown> = {...state};
  if (!included) for (const key of GUIDE_KEYS) delete answer[key];
  answer.guide = {revision:GUIDE_REVISION,included};
  return answer;
}
