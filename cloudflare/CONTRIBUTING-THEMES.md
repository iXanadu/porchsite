# Making a Porchsite theme

A theme is the look of a Porchsite site and nothing else: logic-less
Mustache templates, a stylesheet, and a manifest that tells an assistant
what the theme needs. The person's assistant writes every word and picture;
the theme only arranges them. The full contract is
[TEMPLATES.md](../spec/TEMPLATES.md).

## Name it for what the site is for

`product-page`, `personal-homepage`, `small-business`, `event`. Not
`midnight` or `swiss`: an assistant asks its person "what's the site for?"
and picks from the answer. The same look in other colours is a palette,
not a new theme.

## The folder

```
themes/<name>/
├── template.json       # manifest: name, title, type, version, description, slots, art
├── sample.json         # generic sample content (no real person) for previews
├── home.mustache       # required pages
├── entry.mustache
├── archive.mustache
├── tag.mustache
├── not_found.mustache
├── partials/*.mustache # optional, used as {{> name}}
└── static/site.css     # required; other scripts and styles go here too
```

Start by copying the theme closest to yours.

## template.json

- `type`: what the site is for (`personal`, `product`, `business`, …).
- `description`: one or two sentences a person can choose by.
- `version`: bump it on every change. A published version never changes.
- `slots.images`: each picture the theme uses, as `{field, alt, size,
  need, purpose, alt_hint, prompt}`. `size` sets the shape and the minimum.
  `prompt` may use `{subject}`.
- `slots.content`: each field the theme reads and what it does with it
  ("`site.hero_caption` prints as the dateline").
- `art`: the brief a designer would give, so an assistant can make the
  pictures on its own: `ask` (what to settle with the person), `style`,
  `prompt_prefix`, and `steps`, including the checks to run before using
  any picture.

## The rules (theme:check enforces them)

- **No fixed words.** Every visible word comes from the view (`site.*`,
  `page.*`, `strings.*`, content). Words in a template are an error.
- **Triple braces only for `*_html`** values (Markdown the site rendered).
- **No inline scripts or event handlers.** Scripts load from `static/`.
- **No outside addresses** except Google Fonts.
- **Every `<img>` takes its `alt` from the view.**
- **Works at 320 px** wide, with text contrast of at least 4.5:1.

## Work on it

```bash
npm install
npm run theme:preview <name>   # render sample.json and open it in your browser
npm run theme:check <name>     # check the rules and render every page
npm test                       # the site's own tests, including the built-in themes
```

## Send it

Open a pull request with the theme folder. A maintainer runs the same
checks locally (every release runs them again), reviews it, and the next release publishes it to the catalog at
`https://get.porchsite.dev/themes.json`, with phone and desktop previews
made from your sample.json. Sites install themes only from the catalog.

## Credit

A theme is credited to its maker's X handle, and nothing else: no name,
email or link, anywhere (theme:check refuses `author`, `email`, `url` and
other author fields in template.json). Credit lives in
`themes/credits.json` (look name to handle), not in the theme, so it can
be added or removed without a new version.

To be credited, say your X handle in the pull request. The reviewer gives
you a one-time claim code; post `Porchsite look <name>: <code>` from that
account. Once the reviewer has seen the post, they add your line to
`themes/credits.json`, and the catalog entry and the theme's demo site say
"by @<handle>", linking to your X profile. Without the post, the theme is
published without credit.

To have credit removed, ask the curator through a theme request or at
https://porchsite.dev/ask, or contact the Porchsite author on X. The next
catalog build drops it.

To ask for a feature, a look or a fix without making it yourself, use the
form at https://porchsite.dev/ask. Porchsite's curator reads it; nothing sent
there is published, and the only contact it takes is an optional X handle.
