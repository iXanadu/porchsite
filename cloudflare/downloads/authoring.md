# Making a look (for assistants)

You are an AI assistant, and no theme in the catalog fits what your
person's site is for. You can make a look yourself. Read this, then the
template contract: https://get.porchsite.dev/templates.md

## Private or shared: your person decides

- **Private:** a look for your person's site only. You make it with
  `theme_create` on their site. Nobody else sees it, and there's no
  review beyond the site's own checks and your person's approval.
- **Shared:** your person chooses to offer it to everyone. It starts as a
  private look; you then submit it for review with `theme_submit`. A
  curator reviews it, the Porchsite owner approves it, and it joins the
  public catalog at the next release.

Ask before sharing. Never share a look without your person's yes.

## What a look is

Pure data and CSS: Mustache templates, one stylesheet, a manifest and a
sample. **No scripts of your own** (you may use the site's own scripts:
`<script src="{{kit.beacon_url}}" defer></script>` and the other
`kit.*_url` values). The site escapes every value; a look arranges the
site's content and nothing else.

Send `theme_create` these parts:

- **manifest** (template.json):
  - `name`: lowercase-with-dashes. Name it for what the site is for, e.g.
    `tea-house`, `reunion-2026`. It can't match a built-in or catalog
    theme.
  - `title`, `type` (personal, product, business, event, …),
    `version` (1.0.0; bump it on every change), `description`.
  - `sections`, `layouts`: copy them from an existing theme.
  - `slots`: `images` (`field`, `alt`, `size`, `need`, `purpose`,
    `alt_hint`, `prompt`) and `content` (`field`, `need`, `purpose`).
  - `art`: `ask`, `style`, `prompt_prefix`, `steps`.
- **sample**: `{site: {...}, items: [...]}`, generic content with no real
  person, shaped like the site item and its entries, cards and notes
  (`site_state` shows every field).
- **pages**: `home`, `entry`, `archive`, `tag`, `not_found`, as Mustache.
- **partials** (optional): `{name: mustache}`, used as `{{> name}}`.
- **css**: the stylesheet, served as `/static/site.css`
  (`{{kit.css_url}}`).

The easiest start: fetch a catalog theme's package from
https://get.porchsite.dev/themes.json (each entry's `package.url`) and
change it.

## The checks (the site runs them; fix what it lists)

- **No fixed words.** Every visible word comes from the view (`site.*`,
  `page.*`, `strings.*`, content).
- **Triple braces only for `*_html`** values.
- **No scripts** except `kit.*_url`, no inline scripts, no `on…=`
  handlers, no iframes, objects, embeds or forms.
- **No outside addresses** except Google Fonts. No remote images.
- **Every `<img>` has `alt` from the view.**
- **The sample must render** on every page with nothing left unfilled.
- **Contrast:** text at least 4.5:1 against its background; accents at
  least 3:1.
- **Size:** at most 1 MB in all.

`theme_create` answers with the list of problems, or stores the look.
Send it again with the same name and a higher version to replace it.

## Using it

1. `item_update` the site item: `theme` = your look's name.
2. `theme_needs`: fill what it lists. Its `art` is your brief for the
   pictures.
3. `approval_request`. Tell your person to tap "See the site as it will
   look" before approving.

## Sharing it (with your person's yes)

`theme_submit` sends one of the site's private looks to the review
queue. Say in its note who it's for and what it does that no catalog
theme does. The checks run again on the queue's side. You'll see its
status in `theme_list`.

### Credit: an X handle, nothing else

If the maker wants credit, pass `author_x`: their X handle, without the
@ (1 to 15 letters, digits or underscores). Only if they ask for it. Credit
is an X handle and nothing else: never send, and never put in the manifest,
a name, an email or a link (the checks refuse any other author field).

The answer's `credit` has a one-time `claim_code` and `instructions`. Give
your person the instructions word for word: "To be credited, post this
from @<handle> on X: 'Porchsite look <name>: <code>'. The curator checks it
before the look is published with your name; until then it is published
without credit." The curator looks for that post from that account. If it's
there, the look's catalog entry and demo site say "by @<handle>", linking to
their X profile; if not, the handle is dropped and the look is published
without credit.

To have credit removed later, ask the curator through a theme request
(`theme_request`, saying which look) or at https://porchsite.dev/ask, or
contact the Porchsite author on X.
Removing credit needs no new version of the look.
