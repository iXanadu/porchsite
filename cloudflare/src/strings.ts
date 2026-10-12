/**
 * The words a look uses that aren't the owner's content (TEMPLATES §3
 * `strings`). The owner may override any of them with the site's `strings`
 * (SPEC §3); an empty override keeps the default. Port-matched:
 * server/server/spec/strings.py.
 */
export const BLOCK_STRINGS: Record<string, string> = {
  open_now: "Open now",
  closed_now: "Closed now",
  closed: "Closed",
  until: "until",
  opens: "opens",
  directions: "Get directions",
  call: "Call",
  email: "Email",
  rsvp_by: "RSVP by",
  upcoming: "Coming up",
  earlier: "Earlier",
  changed: "Changed",
  cancelled: "Cancelled",
  hours: "Hours",
  contact: "Contact",
  schedule: "Schedule",
  meets: "When we meet",
  holiday_hours: "Holiday hours",
};

export const STRINGS: Record<string, string> = {
  back_to_top: "Back to top",
  read_full_entry: "Read the full entry",
  last_update: "Last update",
  all: "All",
  all_of: "All of",
  is_separate: "is separate",
  here: "here",
  home: "Home",
  all_writing: "All writing",
  feed: "Feed",
  follow: "Follow",
  on_x: "on X",
  by: "by",
  for: "for",
  also_on: "Also on",
  or_email: "or email",
  filter_projects: "Filter projects",
  tags: "Tags",
  search: "Search writing",
  nothing_yet: "Nothing here yet.",
  not_found_title: "Not found",
  not_found_heading: "Nothing here.",
  not_found_text: "That page doesn't exist.",
  not_found_link: "Back to the start.",
  ...BLOCK_STRINGS,
};

/** The defaults with the owner's non-empty overrides on top. */
export function stringsOf(site: { strings?: Record<string, string> }): Record<string, string> {
  const out = { ...STRINGS };
  for (const [k, v] of Object.entries(site.strings ?? {})) if (v && k in STRINGS) out[k] = v;
  return out;
}
