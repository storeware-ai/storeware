# @storeware/theme-schema

The vocabulary a Storeware theme is written in: the 45 sections a shop page is
built from, the settings each one takes, the ten tokens a shop may restyle, and
the parsers that read all three.

```bash
npm install @storeware/theme-schema
```

`zod` is the only runtime dependency, and it is the only one there will ever be.
A change here that needed a database, an environment variable or a network call
would be a change belonging on the other side of the line.

## A theme is data, not code

There is no template language here. No expression syntax, no partials, no
filters, no loops, no `html` field kind and no `css` field kind. A theme is an
array of `{ "type": "hero", ... }` objects and a flat map of tokens, and every
value in it is one of three things: a key into a table this package owns, a
number inside a declared range, or a string that has passed the allow-list in
`css-values.ts`.

So there is nothing in a theme file to sandbox, and nothing in one to review for
what it might execute, because a renderer executes none of it. **That is the
entire security argument**, and it is why this package is public while the
platform it was extracted from is not. A theme cannot reach a database, cannot
read another shop's data, cannot make a request and cannot run. It can only
describe.

Three consequences are worth stating plainly, because each is a place the
argument could have leaked:

**`richtext` is the one kind that carries markup, and this package does not
sanitise it.** It bounds the length at 2,000 characters and stops there.
Sanitising is the host's job, at render, through whatever allow-list its own CMS
pages use. Nothing here puts a merchant's markup on a page, so nothing here can
put the wrong markup on a page, but a renderer that interpolates `body` raw has
invented a hole this format does not have.

**A `url` setting accepts same-origin paths, anchors, `https://` and `mailto:`,
and refuses everything else.** A `javascript:` link a merchant pastes is a script
running on the merchant's own shop, beside their own checkout, so it is not a
link this format can hold.

**The token check is an allow-list rather than a filter.** An accent colour of
`red; } body { display: none` closes the rule, opens another and hides the shop.
One of `red } </style><script>` leaves CSS entirely. A filter has to anticipate
every attack; an allow-list only has to describe the handful of shapes a colour
can legitimately take, which is what `isColour`, `isLength` and `isFontStack` do.

## What is in it

| Module          | What it holds                                                                           |
| --------------- | --------------------------------------------------------------------------------------- |
| `sections.ts`   | The registry: every section type, the pages it may sit on, its settings and its blocks  |
| `layout.ts`     | A page as stored, and the parsers that turn a stored template into sections for a page  |
| `tokens.ts`     | The ten tokens a shop may set, the CSS they render to, and the check each value passes  |
| `presets.ts`    | Named looks a section may be drawn in, folded into the registry as an ordinary `select` |
| `css-values.ts` | `isColour`, `isLength`, `isFontStack`: what a merchant may put in a CSS value           |

A section is declared once and read from everywhere. The admin draws its controls
from `sectionDefinitionViews()`, the storefront reads a stored band with
`parseSection()`, a page's queries come from `dataPlanFor()` so that two bands
wanting the same collection are one read rather than two, and a model writing a
layout is constrained by `blueprintSectionFields()`. There is no second copy of
the list.

## A theme, in full

Every type name, setting name and choice below was checked against the registry.
Copy it and it validates.

```json
{
  "storeware": "theme",
  "version": 2,
  "name": "Harbour",
  "tokens": {
    "bg": "#fbfaf7",
    "surface": "#ffffff",
    "fg": "#17181a",
    "muted": "#6b6f76",
    "line": "#e3e0d8",
    "accent": "oklch(0.52 0.11 244)",
    "accentFg": "#ffffff",
    "radius": "0.5rem",
    "fontSans": "Archivo, system-ui, sans-serif",
    "fontMono": "ui-monospace, monospace"
  },
  "templates": {
    "home": [
      {
        "type": "hero",
        "kicker": "Made in Bristol since 2014",
        "heading": "Waterproofs for weather that means it",
        "subheading": "Taped seams, a two-year guarantee, and a repair shop rather than a landfill.",
        "ctaLabel": "Shop the anoraks",
        "ctaHref": "/collections/anoraks",
        "align": "start",
        "width": "full",
        "preset": "editorial"
      },
      {
        "type": "marquee",
        "speed": "steady",
        "blocks": [
          { "type": "phrase", "text": "Free UK delivery over 75" },
          { "type": "phrase", "text": "Repairs for the life of the coat" },
          { "type": "phrase", "text": "60 days to change your mind" }
        ]
      },
      {
        "type": "featured_collection",
        "kicker": "This season",
        "heading": "The winter rail",
        "collection": "winter",
        "limit": 8
      },
      {
        "type": "multicolumn",
        "heading": "How a coat gets made",
        "preset": "numbered",
        "blocks": [
          {
            "type": "column",
            "heading": "Cut",
            "body": "<p>Rolls come in from a mill in Lancashire.</p>"
          },
          {
            "type": "column",
            "heading": "Tape",
            "body": "<p>Every seam is sealed by hand.</p>"
          },
          {
            "type": "column",
            "heading": "Test",
            "body": "<p>Two hours under the rain rig.</p>",
            "href": "/pages/testing"
          }
        ]
      },
      {
        "type": "figures",
        "heading": "Ten years of it",
        "blocks": [
          { "type": "figure", "value": "12,400", "label": "Coats repaired" },
          { "type": "figure", "value": "2", "label": "Year guarantee" },
          { "type": "figure", "value": "0", "label": "Coats sent to landfill" }
        ]
      },
      {
        "type": "faq",
        "heading": "Before you order",
        "preset": "two_column",
        "blocks": [
          {
            "type": "question",
            "question": "How should I size it?",
            "answer": "<p>Take your usual size. There is room for a jumper.</p>"
          },
          {
            "type": "question",
            "question": "Do you repair coats you did not make?",
            "answer": "<p>Yes, for a fee.</p>"
          }
        ]
      },
      {
        "type": "cta_bar",
        "heading": "Join the repair list",
        "body": "<p>One email a season, when the workshop has space.</p>",
        "buttonLabel": "Sign up",
        "href": "/pages/repairs",
        "sticky": false
      }
    ]
  }
}
```

Four things that file shows and that are easy to get wrong:

**Every setting is optional.** Not one band above fills in everything its section
offers, and what it leaves out falls back. A required setting would mean a
section a merchant cannot place until they have filled in a form, and it would
also mean a stored band could become invalid because a later release wanted one
more field.

**References are handles, not ids.** `"collection": "winter"` names a collection
by the same handle the shop's own URLs use. A handle that resolves to nothing
renders no band rather than an error.

**Pictures are absent on purpose.** A `media` setting holds a UUID belonging to
one shop's storage, which means nothing in another's, so a theme meant to travel
carries no pictures and the shop importing it chooses its own.

**`storeware`, `version` and `name` are the platform's envelope**, not this
package's. What this package validates is `tokens` and each array under
`templates`.

## Validating one, offline

```ts
import { layoutInput, themeCss, themeTokensInput } from '@storeware/theme-schema';

const file = JSON.parse(await readFile('harbour.theme.json', 'utf8'));

const tokens = themeTokensInput.parse(file.tokens);
const templates = layoutInput.parse(file.templates);
```

`themeTokensInput` refuses a token nobody may set and a value the allow-list does
not recognise, and says which:

```
accent: red; } body { display: none is not a value this can accept.
shadow: shadow is not a token a shop can set.
```

`layoutInput` takes one optional array per page type. Inside an array, a band
whose type this release does not build is an error naming it:

```
home.1: carousel_3d is not a section this platform builds.
```

Turning the ten tokens into a stylesheet block is one call. `themeCss(tokens)`
returns exactly this, and nothing that failed its check appears in it:

```css
:root {
  --sw-bg: #fbfaf7;
  --sw-surface: #ffffff;
  --sw-fg: #17181a;
  --sw-muted: #6b6f76;
  --sw-line: #e3e0d8;
  --sw-accent: oklch(0.52 0.11 244);
  --sw-accent-fg: #ffffff;
  --sw-radius: 0.5rem;
  --sw-font-sans: Archivo, system-ui, sans-serif;
  --sw-font-mono: ui-monospace, monospace;
}
```

### Strict on the way in, lenient on the way out

These are two different jobs, and this package keeps two different functions for
them. It is the single most important thing to copy if you are implementing the
format yourself.

`layoutInput` is for a file somebody is importing or a request somebody is
making. It refuses the whole thing and says why, because there is a person there
to fix it.

`sectionsFor` and `parseTemplate` are for a stored layout on its way to a page a
shopper is looking at. They never throw. A band this release cannot read is
dropped on its own and the rest of the page stands.

```ts
import { parseTemplate, sectionsFor } from '@storeware/theme-schema';

parseTemplate(stored.home, 'home'); // unreadable bands left out, no fallback
sectionsFor(stored, 'home'); // the same, then the page type's default if nothing survives
```

The rule behind it: **the failure a shopper sees must never be worse than the
failure a merchant caused.** That matters most on a rollback, where a deploy that
no longer knows about a band placed last week should lose that band rather than
present as every themed shop reverting at once.

Three failure modes are deliberately not the same size:

| What is wrong                 | What happens                                                               |
| ----------------------------- | -------------------------------------------------------------------------- |
| An unknown section type       | The band is dropped. The page stands.                                      |
| An unreadable `select` value  | The setting falls back to absent and the band renders in its default look. |
| An unreadable media id or URL | The band is dropped.                                                       |

A `select` is decoration, and a shop losing its whole hero because a preset was
renamed is strictly worse than that hero rendering in the look it had before
anybody chose one. A media id that does not parse is not decoration.

## The compatibility promise

**A section type is never renamed or removed. A setting is never removed. A field
kind never changes under a setting. A bound only ever rises. A minimum only ever
falls. A select choice is never withdrawn. A page is never taken off a section's
allow-list. A block maximum only ever rises. The parsers stay passthrough.**

Loosen freely, tighten never. The vocabulary may gain and may widen. It may not
lose or narrow.

### Why it matters

A theme is stored, not compiled. Every themed shop holds its bands as JSON in a
database column, and every theme file an agency ships is the same JSON on disk.
Neither is re-read when this package changes.

So a rename here does not rename anything out there. Renaming `hero` does not
rename it in the `layout` column of every shop that placed one: it makes that
band unparseable, and a band that cannot be parsed disappears from a live page.
The merchant changed nothing, nobody gets an error, and the shop is simply
missing its hero the next time anybody looks.

Made after this package is published, the same edit breaks other people's
products at the same moment, and they will not have read the file that explains
why not to.

### How it is enforced

Not by memory, and not by review. `schema.snapshot.json` is a committed record of
the promised shape, and `compatibility.ts` compares the current registry against
it on **every run of the test suite**. `compatibilityBreaks` returns one entry per
loss, each naming the address and the promise in the words somebody has to act
on.

Two properties of that ratchet were chosen deliberately.

**It is silent about additions.** A new section, a new setting, a new choice, a
raised bound and a new page on an allow-list all return nothing at all. A
snapshot that failed on every addition would be a snapshot people regenerate
without reading, which is worse than no snapshot: it teaches the reflex that the
fix for a red test is `--write`.

**Regenerating cannot wave a removal through.** The snapshot script rewrites the
file only after the ratchet has agreed the change is a widening. A removal has to
be argued in the code, by putting the thing back. The failure names the edit to
make rather than the command to run, for the same reason.

The ratchet itself is mutation-tested. A renamed section, a removed setting, a
changed kind, a lowered bound, a raised minimum, a withdrawn choice, a page taken
off an allow-list, a lowered block maximum and a section that stopped taking
blocks each have a test that mutates the snapshot and asserts the break is
reported. A ratchet nobody has seen fail is a ratchet that might be comparing
nothing.

The passthrough rule is asserted against the source text, because a parser that
strips unknown settings looks identical from the outside until an older deploy
reads a layout a newer one wrote and hands it back shorter, silently deleting the
merchant's settings on their next save.

### Holding us to it yourself

`compatibility` is a subpath export, and so is the snapshot, so you can pin a
copy of the shape you built against and check every later release against it:

```ts
import { compatibilityBreaks, type SchemaSnapshot } from '@storeware/theme-schema/compatibility';

const pinned = JSON.parse(await readFile('theme-schema.0.1.0.json', 'utf8')) as SchemaSnapshot;
const breaks = compatibilityBreaks(pinned);
```

`@storeware/theme-schema/schema.snapshot.json` is the current release's shape,
which is what you copy to start.

## What is exported and what is promised are not the same list

Everything in the entry point is exported because it is pure and useful. What is
**promised** is narrower, and it is exactly the contents of
`schema.snapshot.json`: the section types, their page allow-lists, the name,
kind, bounds and choices of every setting, the block type and maximum of every
section that takes blocks, plus `PAGE_TYPES`, `FIELD_KINDS`, `MAX_HEADING` (120),
`MAX_BODY` (2,000) and `MAX_SECTIONS_PER_PAGE` (12). Those, and the passthrough
behaviour of the parsers.

Everything else is convenience, and much of it exists because our own AI theme
generator needed it. `blueprintSectionTypes`, `blueprintSectionFields`,
`blueprintBlockTypes`, `blueprintBlockFields` and `blueprintMaxBlocks` project
the registry into the flat, nullable shape a model's structured output can fill.
`dataPlanFor` coalesces the data a page's bands need into one plan.
`sectionsJsonLd`, `applySectionCopy`, `translatableFieldsOf`, `DEFAULT_HOME`,
`defaultTemplateFor`, `TITLE_BANDS` and `templateCarriesHeading` each solve a
problem the platform had.

You are welcome to all of it. We do not promise to keep any of it.

Presets are the clearest example of where the line falls. Which preset **values**
a section offers is promised, because a merchant's choice of `image_scrim` is
stored in their layout and withdrawing it would silently change the shape of
their band on the next deploy. What `PRESETS` maps each value **to** is not
promised at all: the layout and emphasis axes behind `image_scrim` are this
platform's design decisions, and they will move.

## Rendering what it describes

This package says what a theme may be. It does not draw one.
[`@storeware/theme-kit`](https://www.npmjs.com/package/@storeware/theme-kit)
carries the other half: the stylesheet the bands are drawn with, and the shape of
the data a renderer fills before it can draw them.

## Licence

MIT. Copyright (c) 2026 Crawlog LLC. The full text is in `LICENSE`.

MIT rather than Apache-2.0, on purpose. This package is a **specification**, and a
specification's value is in how many things speak it. A licence that made a
competitor think twice about implementing it would be protecting exactly the
wrong thing. A competing platform that reads and writes this format makes it the
interchange format for storefront layouts, and a merchant who can take their
shop's design with them is a merchant with a reason to build one at all. That is
worth more than exclusivity over a table of section names.

`theme-kit` is an implementation and is Apache-2.0, for the patent grant. MIT
schema plus Apache kit is the compatible direction; the reverse would not have
been.
